// Shared page scripts and text helpers used by the embedded browser path. The
// expressions run inside the controlled page and always return a JSON string.
// Element and image references carry the id of the document that produced them
// so a reference from before a navigation is rejected instead of resolving
// against whatever element now happens to reuse the id.

import { createHash } from "node:crypto"
import { escapeUntrustedText } from "./envelope"

export interface BrowserTabInfo {
  readonly id: string
  readonly url: string
  readonly title?: string
  readonly active?: boolean
}

export interface BrowserCandidate {
  readonly id: string
  readonly role: string
  readonly name: string
  readonly tag: string
  readonly visible: boolean
  readonly disabled: boolean
  readonly score: number
  readonly rect?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
  readonly center?: { readonly x: number; readonly y: number }
  readonly path?: string
  readonly frame?: string
}

export interface BrowserFindCoverage {
  readonly documentId: string
  readonly framesVisited: number
  readonly framesSkipped: number
  readonly shadowRoots: number
  readonly scanned: number
  readonly truncated: boolean
  readonly complete: boolean
  readonly warning?: string
}

export interface BrowserFindResult {
  readonly candidates: BrowserCandidate[]
  readonly coverage: BrowserFindCoverage
}

export interface BrowserPageText {
  readonly url: string
  readonly title: string
  readonly text: string
  readonly length: number
  readonly hash: string
  readonly offset: number
  readonly totalLength: number
  readonly truncated: boolean
  readonly sourceTruncated?: boolean
  readonly viewport?: { readonly width: number; readonly height: number }
  readonly documentId?: string
  readonly complete?: boolean
  readonly framesVisited?: number
  readonly framesSkipped?: number
  readonly shadowRoots?: number
  readonly warning?: string
}

export interface BrowserStatus {
  readonly running: boolean
  readonly endpoint?: string
  readonly browser?: string
  readonly tabs: number
}

export const BROWSER_TEXT_LIMIT = 20000
export const BROWSER_RAW_TEXT_LIMIT = 200_000

export function compactBrowserText(text: string): string {
  return text
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

export function hashBrowserText(text: string): string {
  return createHash("sha1").update(text, "utf8").digest("hex").slice(0, 16)
}

// Element identity lives in script-side maps so a find/click pair resolves the
// same element even when the page has no stable attributes to select on.
// Refs are bound to the document generation that produced them: a ref is only
// valid in its producing document. Resolving a ref from a prior document (or
// a bare id with no document binding) refuses as stale and never falls back
// to a lookalike querySelector re-point.
//
// The state below is only trustworthy because the runtime evaluates these
// scripts in an isolated world (see CdpRuntime.isolatedContext): the page
// shares the DOM with an isolated world but never its window properties, so it
// can neither read the document id nor replace the element map. Ids are also
// shape-validated before use, so a page-chosen string can never reach a
// selector, a map key, or the document comparison. The cost of the world is
// that scripted DOM events reach page listeners with this realm's prototypes;
// the trusted CDP input path (Input.insertText, dispatchMouseEvent) is
// unaffected.
const REF_HELPERS = `
  const omniaRefIdPattern = /^(omnia-\\d+|img-\\d+)$/;
  const omniaDocumentIdPattern = /^[A-Za-z0-9_-]{1,64}$/;
  const omniaDocumentId = () => {
    const existing = window.__omniaDocumentId;
    if (typeof existing === "string" && omniaDocumentIdPattern.test(existing)) return existing;
    const created = "d" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    window.__omniaDocumentId = created;
    return created;
  };
  const omniaParseRef = (ref) => {
    const value = String(ref || "");
    const marker = value.lastIndexOf("@");
    if (marker <= 0) return { id: value, documentId: "" };
    return { id: value.slice(0, marker), documentId: value.slice(marker + 1) };
  };
  const omniaIsWellFormedRef = (parsed) =>
    omniaRefIdPattern.test(parsed.id) && omniaDocumentIdPattern.test(parsed.documentId);
  const omniaRef = (id) => id + "@" + omniaDocumentId();
  const omniaIsStaleRef = (ref) => {
    const parsed = omniaParseRef(ref);
    if (!parsed.documentId) return true;
    if (!omniaIsWellFormedRef(parsed)) return true;
    return parsed.documentId !== omniaDocumentId();
  };
`
const ELEMENT_HELPERS = `
  ${REF_HELPERS}
  const omniaState = () => {
    const existing = window.__omniaElementState;
    if (existing && existing.elements && existing.byId) return existing;
    const state = { seq: 0, elements: new WeakMap(), byId: new Map() };
    window.__omniaElementState = state;
    return state;
  };
  const omniaElementId = (el) => {
    const state = omniaState();
    let id = state.elements.get(el);
    if (!id) { state.seq += 1; id = "omnia-" + state.seq; state.elements.set(el, id); }
    state.byId.set(id, el);
    return id;
  };
  // Resolution only ever consults the script-side map. There is deliberately no
  // attribute fallback: a page that sets data-omnia-id on its own element must
  // not be able to re-point a find/click pair at it.
  const omniaElementById = (ref) => {
    if (omniaIsStaleRef(ref)) return undefined;
    const parsed = omniaParseRef(ref);
    const tracked = omniaState().byId.get(parsed.id);
    return tracked && tracked.isConnected ? tracked : undefined;
  };
  const omniaIsSecret = (el) => {
    if (!(el instanceof HTMLInputElement)) return false;
    const type = String(el.type || el.getAttribute("type") || "").toLowerCase();
    const autocomplete = String(el.autocomplete || el.getAttribute("autocomplete") || "").toLowerCase();
    return type === "password" || autocomplete === "current-password" || autocomplete === "new-password";
  };
`

// Perception coverage: same-origin frames and open shadow roots are traversed
// where possible. Cross-origin / inaccessible frames are counted as skipped so
// callers can report an explicit completeness warning instead of claiming a
// complete page. Kept defensive (try/catch + feature checks) so the same code
// runs in the controlled page and in the page-script test seams.
const SCOPE_HELPERS = `
  const omniaFrameLabel = (frame, fallback) => {
    try {
      if (frame && typeof frame.getAttribute === "function") {
        const named = frame.getAttribute("name") || frame.getAttribute("id") || frame.getAttribute("src") || "";
        if (typeof named === "string" && named.length > 0) return String(named).slice(0, 80);
      }
    } catch (e) {}
    return fallback;
  };
  const omniaCollectScopes = () => {
    const scopes = [{ root: document, framePath: "main" }];
    const seen = new Set();
    try { seen.add(document); } catch (e) {}
    let framesSkipped = 0;
    for (let i = 0; i < scopes.length && scopes.length < 16; i++) {
      const current = scopes[i];
      let frames = [];
      try {
        if (current.root && typeof current.root.querySelectorAll === "function") {
          frames = Array.from(current.root.querySelectorAll("iframe,frame")).filter((candidate) => {
            try {
              const tag = String(candidate.tagName || "").toLowerCase();
              return tag === "iframe" || tag === "frame";
            } catch (e) { return false; }
          });
        }
      } catch (e) { frames = []; }
      for (let f = 0; f < frames.length && scopes.length < 16; f++) {
        const frame = frames[f];
        let child = null;
        try { child = (frame.contentDocument || (frame.contentWindow && frame.contentWindow.document)) || null; } catch (e) { child = null; }
        if (child && typeof child.querySelectorAll === "function" && !seen.has(child)) {
          seen.add(child);
          scopes.push({ root: child, framePath: current.framePath + ">" + omniaFrameLabel(frame, "frame-" + f) });
        } else if (!child) {
          framesSkipped += 1;
        }
      }
    }
    const expanded = [];
    let shadowRoots = 0;
    const visitScopeShadows = (scope, depth) => {
      expanded.push(scope);
      if (depth >= 4 || expanded.length >= 32) return;
      let all = [];
      try {
        if (scope.root && typeof scope.root.querySelectorAll === "function") {
          all = Array.from(scope.root.querySelectorAll("*")).slice(0, 2000);
        }
      } catch (e) { all = []; }
      for (const el of all) {
        if (expanded.length >= 32) break;
        let shadow = null;
        try { shadow = el.shadowRoot || null; } catch (e) { shadow = null; }
        if (shadow && typeof shadow.querySelectorAll === "function") {
          shadowRoots += 1;
          visitScopeShadows({ root: shadow, framePath: scope.framePath + "#shadow" }, depth + 1);
        }
      }
    };
    for (const scope of scopes) {
      if (expanded.length >= 32) break;
      // Each document scope contributes itself plus its shadow subtrees. The
      // visited-set above already dedupes documents; shadows are new scopes.
      const before = expanded.length;
      visitScopeShadows(scope, 0);
      // visitScopeShadows pushes scope itself; no further dedupe needed.
      void before;
    }
    return { scopes: expanded, framesSkipped, shadowRoots };
  };
  const omniaPathOf = (el) => {
    const parts = [];
    let current = el;
    for (let depth = 0; depth < 4 && current; depth++) {
      try {
        const tag = String((current.tagName || "element")).toLowerCase();
        let part = tag;
        const id = current.getAttribute ? current.getAttribute("id") : null;
        if (typeof id === "string" && id.length > 0) {
          part += "#" + id.slice(0, 40);
        } else {
          const cls = current.getAttribute ? current.getAttribute("class") : null;
          if (typeof cls === "string" && cls.length > 0) {
            const first = cls.trim().split(/\\s+/)[0];
            if (first) part += "." + String(first).slice(0, 40);
          }
        }
        parts.unshift(part);
        const parent = current.parentElement || null;
        if (!parent) {
          try {
            const rootNode = current.getRootNode ? current.getRootNode() : null;
            const host = rootNode && rootNode.host ? rootNode.host : null;
            if (host && host !== current) { current = host; continue; }
          } catch (e) {}
          break;
        }
        current = parent;
        if (!current || current === document || current === document.body) break;
      } catch (e) { break; }
    }
    return parts.join(" > ").slice(0, 200);
  };
  const omniaScopeText = (scope) => {
    try {
      const root = scope.root;
      if (!root) return "";
      if (root.body) {
        const inner = root.body.innerText;
        if (typeof inner === "string" && inner.length > 0) return inner;
        const fallback = root.body.textContent;
        if (typeof fallback === "string") return fallback;
        return "";
      }
      if (typeof root.innerText === "string" && root.innerText.length > 0) return root.innerText;
      if (typeof root.textContent === "string") return root.textContent;
    } catch (e) {}
    return "";
  };
`

export function buildFindExpression(query: string, role: string | undefined, limit: number): string {
  return `(() => {
    ${ELEMENT_HELPERS}
    ${SCOPE_HELPERS}
    const query = ${JSON.stringify(query)}.toLowerCase();
    const roleFilter = ${role === undefined ? "null" : JSON.stringify(role.toLowerCase())};
    const limit = ${Math.max(1, Math.min(50, limit))};
    const maxScan = 4000;
    const documentId = omniaDocumentId();
    const roleMap = { a: "link", button: "button", textarea: "textbox", select: "combobox", summary: "button", label: "label" };
    const inputRole = (el) => el.type === "checkbox" ? "checkbox" : el.type === "radio" ? "radio" : (el.type === "submit" || el.type === "button" || el.type === "reset") ? "button" : "textbox";
    const roleOf = (el) => { try { return el.getAttribute("role") || (String(el.tagName || "").toLowerCase() === "input" ? inputRole(el) : roleMap[String(el.tagName || "").toLowerCase()] || String(el.tagName || "element").toLowerCase()); } catch (e) { return "element"; } };
    const nameOf = (el) => { try { return (el.getAttribute("aria-label") || el.getAttribute("title") || el.getAttribute("placeholder") || el.getAttribute("alt") || el.getAttribute("value") || (el.labels && el.labels[0] ? el.labels[0].innerText : "") || (omniaIsSecret(el) ? "" : el.value) || (String(el.tagName || "").toLowerCase() === "input" && el.type === "file" ? "file input" : "") || (typeof el.id === "string" && el.id.length > 0 ? "#" + el.id : "") || el.innerText || el.textContent || "").trim().replace(/\\s+/g, " ").slice(0, 120); } catch (e) { return ""; } };
    const visible = (el) => {
      try {
        const rect = el.getBoundingClientRect();
        if (!(rect.width > 0) || !(rect.height > 0)) return false;
        const style = getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || style.opacity === "0") return false;
        if (el.inert === true) return false;
        try { if (el.closest && el.closest("[inert]") !== null) return false; } catch (e) {}
        return true;
      } catch (e) { return false; }
    };
    const score = (name) => { const value = name.toLowerCase(); if (value === query) return 1; if (value.startsWith(query)) return 0.9; if (value.includes(query)) return 0.75; const words = query.split(/\\s+/).filter(Boolean); const hits = words.filter((word) => value.includes(word)).length; return hits > 0 ? (0.5 * hits) / words.length : 0; };
    const selector = 'a,button,input,textarea,select,option,summary,details,label,[role],div[id],span[id],[contenteditable],[contenteditable="true"],[onclick],[tabindex],[aria-label],[aria-labelledby],img[alt],audio,video,[data-action]';
    const collected = omniaCollectScopes();
    const candidates = [];
    let scanned = 0;
    let truncated = false;
    for (const scope of collected.scopes) {
      let nodes = [];
      try { nodes = Array.from(scope.root.querySelectorAll(selector)); } catch (e) { nodes = []; }
      for (const el of nodes) {
        if (scanned >= maxScan || candidates.length >= limit * 8) { truncated = true; break; }
        scanned += 1;
        const name = nameOf(el);
        if (!name) continue;
        const role = roleOf(el);
        if (roleFilter && role !== roleFilter) continue;
        const value = score(name);
        if (value <= 0) continue;
        const id = omniaElementId(el);
        // Written for a human reading the page markup only. Resolution never
        // reads it (see omniaElementById): a page can set the same attribute on
        // its own element and gain nothing.
        try { el.setAttribute("data-omnia-id", id); } catch (e) {}
        let box = { left: 0, top: 0, width: 0, height: 0 };
        try { box = el.getBoundingClientRect(); } catch (e) {}
        const isVisible = visible(el);
        candidates.push({ id: omniaRef(id), role, name, tag: String(el.tagName || "element").toLowerCase(), visible: isVisible, disabled: el.disabled === true, score: value, rect: { x: Math.round(box.left), y: Math.round(box.top), width: Math.round(box.width), height: Math.round(box.height) }, center: { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) }, path: omniaPathOf(el), frame: scope.framePath });
      }
      if (truncated) break;
    }
    candidates.sort((a, b) => ((b.visible ? 1 : 0) - (a.visible ? 1 : 0)) || b.score - a.score);
    const ranked = candidates.slice(0, limit);
    const complete = collected.framesSkipped === 0 && !truncated;
    const coverage = { documentId, framesVisited: collected.scopes.length, framesSkipped: collected.framesSkipped, shadowRoots: collected.shadowRoots, scanned, truncated, complete };
    if (!complete) {
      const reasons = [];
      if (collected.framesSkipped > 0) reasons.push(collected.framesSkipped + " frame(s) not accessible");
      if (truncated) reasons.push("scan truncated at " + scanned + " nodes");
      coverage.warning = "Partial element results: " + reasons.join("; ") + ". Content may be incomplete.";
    }
    return JSON.stringify({ candidates: ranked, coverage });
  })()`
}

export function buildRectExpression(id: string): string {
  return `(() => {
    ${ELEMENT_HELPERS}
    const ref = ${JSON.stringify(id)};
    if (omniaIsStaleRef(ref)) return JSON.stringify({ ok: false, reason: "stale_element_reference" });
    const el = omniaElementById(ref);
    if (!el) return JSON.stringify({ ok: false, reason: "element_not_found" });
    el.scrollIntoView({ behavior: "instant", block: "center", inline: "center" });
    const rect = el.getBoundingClientRect();
    if (!(rect.width > 0) || !(rect.height > 0)) return JSON.stringify({ ok: false, reason: "element_not_visible" });
    const name = (el.getAttribute("aria-label") || (omniaIsSecret(el) ? "" : el.innerText) || (omniaIsSecret(el) ? "" : el.value) || "").trim().replace(/\\s+/g, " ").slice(0, 120);
    const role = el.getAttribute("role") || el.tagName.toLowerCase();
    const linkTarget = el.tagName === "A" ? (el.getAttribute("target") || "") : "";
    const linkHref = el.tagName === "A" && typeof el.href === "string" ? el.href : "";
    return JSON.stringify({ ok: true, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, name, role, disabled: el.disabled === true, ...(linkHref.length === 0 ? {} : { href: linkHref, target: linkTarget }) });
  })()`
}

export function buildTypeExpression(id: string, text: string): string {
  return `(() => {
    ${ELEMENT_HELPERS}
    const ref = ${JSON.stringify(id)};
    if (omniaIsStaleRef(ref)) return JSON.stringify({ ok: false, reason: "stale_element_reference" });
    const el = omniaElementById(ref);
    if (!el) return JSON.stringify({ ok: false, reason: "element_not_found" });
    el.scrollIntoView({ behavior: "instant", block: "center", inline: "center" });
    el.focus();
    const value = ${JSON.stringify(text)};
    const emit = (event) => { try { el.dispatchEvent(event); } catch (e) {} };
    const key = (type) => { try { emit(new KeyboardEvent(type, { bubbles: true, cancelable: true, key: "Unidentified" })); } catch (e) {} };
    const beforeInput = () => { try { emit(new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data: value })); } catch (e) {} };
    if (el.isContentEditable) {
      try {
        const range = document.createRange();
        range.selectNodeContents(el);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
      } catch (e) {}
      key("keydown");
      beforeInput();
      el.textContent = value;
      emit(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
      key("keyup");
      emit(new Event("change", { bubbles: true }));
    } else {
      try { if (typeof el.setSelectionRange === "function") el.setSelectionRange(0, String(el.value === undefined ? "" : el.value).length); } catch (e) {}
      key("keydown");
      beforeInput();
      const prototype = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
      if (descriptor && descriptor.set) descriptor.set.call(el, value);
      else el.value = value;
      emit(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
      key("keyup");
      emit(new Event("change", { bubbles: true }));
    }
    if (omniaIsSecret(el)) return JSON.stringify({ ok: true, sensitive: true });
    return JSON.stringify({ ok: true, value: (el.value !== undefined ? el.value : el.textContent || "").slice(0, 200) });
  })()`
}

// Focuses the field and selects its current contents so a trusted CDP text
// insertion replaces the value the way a user typing over a selection would.
export function buildTypeFocusExpression(id: string): string {
  return `(() => {
    ${ELEMENT_HELPERS}
    const ref = ${JSON.stringify(id)};
    if (omniaIsStaleRef(ref)) return JSON.stringify({ ok: false, reason: "stale_element_reference" });
    const el = omniaElementById(ref);
    if (!el) return JSON.stringify({ ok: false, reason: "element_not_found" });
    el.scrollIntoView({ behavior: "instant", block: "center", inline: "center" });
    el.focus();
    const tag = String(el.tagName || "").toLowerCase();
    const editable = el.isContentEditable === true || tag === "input" || tag === "textarea";
    if (el.isContentEditable) {
      try {
        const range = document.createRange();
        range.selectNodeContents(el);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
      } catch (e) {}
    } else {
      try { if (typeof el.setSelectionRange === "function") el.setSelectionRange(0, String(el.value === undefined ? "" : el.value).length); } catch (e) {}
    }
    return JSON.stringify({ ok: true, editable, sensitive: omniaIsSecret(el) });
  })()`
}

export function buildValueExpression(id: string): string {
  return `(() => {
    ${ELEMENT_HELPERS}
    const ref = ${JSON.stringify(id)};
    if (omniaIsStaleRef(ref)) return JSON.stringify({ ok: false, reason: "stale_element_reference" });
    const el = omniaElementById(ref);
    if (!el) return JSON.stringify({ ok: false, reason: "element_not_found" });
    if (omniaIsSecret(el)) return JSON.stringify({ ok: true, sensitive: true });
    return JSON.stringify({ ok: true, value: (el.value !== undefined ? String(el.value) : (el.textContent || "")).slice(0, 200) });
  })()`
}

export function buildReadExpression(options: { maxCharacters?: number } = {}): string {
  const maxCharacters = Math.max(
    1,
    Math.min(BROWSER_RAW_TEXT_LIMIT, Math.floor(options.maxCharacters ?? BROWSER_RAW_TEXT_LIMIT)),
  )
  return `(() => {
    ${REF_HELPERS}
    ${SCOPE_HELPERS}
    const documentId = omniaDocumentId();
    const collected = omniaCollectScopes();
    const parts = [];
    for (const scope of collected.scopes) {
      const chunk = omniaScopeText(scope);
      if (chunk && chunk.length > 0) {
        parts.push(scope.framePath === "main" ? chunk : "[" + scope.framePath + "]\\n" + chunk);
      }
    }
    const joined = parts.join("\\n\\n");
    const sourceTruncated = joined.length > ${maxCharacters};
    const text = joined.slice(0, ${maxCharacters});
    const complete = collected.framesSkipped === 0 && !sourceTruncated;
    const payload = { url: location.href, title: document.title, text, viewport: { width: window.innerWidth, height: window.innerHeight }, documentId, framesVisited: collected.scopes.length, framesSkipped: collected.framesSkipped, shadowRoots: collected.shadowRoots, sourceTruncated, complete };
    if (!complete) {
      const reasons = [];
      if (collected.framesSkipped > 0) reasons.push(collected.framesSkipped + " frame(s) not accessible");
      if (sourceTruncated) reasons.push("source truncated at ${maxCharacters} characters");
      payload.warning = "Partial page text: " + reasons.join("; ") + ". Content may be incomplete.";
    }
    return JSON.stringify(payload);
  })()`
}

export function buildSelectExpression(id: string, options: { value?: string; text?: string } = {}): string {
  return `(() => {
    ${ELEMENT_HELPERS}
    const ref = ${JSON.stringify(id)};
    if (omniaIsStaleRef(ref)) return JSON.stringify({ ok: false, reason: "stale_element_reference" });
    const el = omniaElementById(ref);
    if (!el) return JSON.stringify({ ok: false, reason: "element_not_found" });
    if (String(el.tagName || "").toLowerCase() !== "select") return JSON.stringify({ ok: false, reason: "not_a_select" });
    const wantedValue = ${JSON.stringify(options.value ?? null)};
    const wantedText = ${JSON.stringify(options.text ?? null)};
    if (wantedValue === null && wantedText === null) return JSON.stringify({ ok: false, reason: "missing_option" });
    const choices = Array.from(el.options || []);
    const match = choices.find((option) =>
      wantedValue !== null
        ? option.value === wantedValue
        : (option.text || "").trim() === String(wantedText).trim() || (option.label || "") === wantedText,
    );
    if (!match) return JSON.stringify({ ok: false, reason: "option_not_found" });
    el.value = match.value;
    const emit = (event) => { try { el.dispatchEvent(event); } catch (e) {} };
    emit(new Event("input", { bubbles: true }));
    emit(new Event("change", { bubbles: true }));
    return JSON.stringify({ ok: true, value: el.value });
  })()`
}

export function buildViewportExpression(): string {
  return `JSON.stringify({ width: window.innerWidth, height: window.innerHeight })`
}

export function buildScrollPositionExpression(): string {
  return `JSON.stringify({ x: window.scrollX, y: window.scrollY })`
}

export function buildDocumentIdExpression(): string {
  return `(() => {
    ${REF_HELPERS}
    return omniaDocumentId();
  })()`
}

export interface BrowserImage {
  readonly id: string
  readonly src: string
  readonly alt: string
  readonly width: number
  readonly height: number
  readonly naturalWidth: number
  readonly naturalHeight: number
  readonly visible: boolean
  readonly rect?: { x: number; y: number; width: number; height: number }
  readonly link?: string
}

export interface BrowserImageTarget {
  readonly tabId?: string
  readonly id?: string
  readonly url?: string
  readonly query?: string
}

function parseCandidateItem(item: unknown): BrowserCandidate | undefined {
  if (typeof item !== "object" || item === null) return undefined
  const record = item as Record<string, unknown>
  const rect =
    typeof record.rect === "object" && record.rect !== null ? (record.rect as Record<string, unknown>) : undefined
  const center =
    typeof record.center === "object" && record.center !== null
      ? (record.center as Record<string, unknown>)
      : undefined
  return {
    id: escapeUntrustedText(String(record.id ?? "")),
    role: escapeUntrustedText(String(record.role ?? "element")),
    name: escapeUntrustedText(String(record.name ?? "")),
    tag: escapeUntrustedText(String(record.tag ?? "")),
    visible: record.visible === true,
    disabled: record.disabled === true,
    score: typeof record.score === "number" ? record.score : 0,
    ...(rect === undefined || typeof rect.width !== "number"
      ? {}
      : {
          rect: {
            x: typeof rect.x === "number" ? rect.x : 0,
            y: typeof rect.y === "number" ? rect.y : 0,
            width: rect.width,
            height: typeof rect.height === "number" ? rect.height : 0,
          },
        }),
    ...(center === undefined || typeof center.x !== "number" || typeof center.y !== "number"
      ? {}
      : { center: { x: center.x, y: center.y } }),
    ...(typeof record.path === "string" && record.path.length > 0
      ? { path: escapeUntrustedText(record.path) }
      : {}),
    ...(typeof record.frame === "string" && record.frame.length > 0
      ? { frame: escapeUntrustedText(record.frame) }
      : {}),
  }
}

function candidateListOf(value: unknown): BrowserCandidate[] {
  if (!Array.isArray(value)) return []
  const out: BrowserCandidate[] = []
  for (const item of value) {
    const parsed = parseCandidateItem(item)
    if (parsed !== undefined) out.push(parsed)
  }
  return out
}

export function parseBrowserCandidates(raw: unknown): BrowserCandidate[] {
  // New shape is { candidates, coverage }; legacy shape is a bare array.
  const list =
    typeof raw === "object" &&
    raw !== null &&
    Array.isArray((raw as Record<string, unknown>).candidates)
      ? candidateListOf((raw as Record<string, unknown>).candidates)
      : candidateListOf(raw)
  // Hidden controls are kept with an explicit visible:false flag instead of
  // being discarded: perception reports its limits, callers decide.
  return list.sort((a, b) => (b.visible ? 1 : 0) - (a.visible ? 1 : 0) || b.score - a.score)
}

export function parseFindCoverage(raw: unknown): BrowserFindCoverage | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined
  const record = raw as Record<string, unknown>
  const coverage = record.coverage
  if (typeof coverage !== "object" || coverage === null) return undefined
  const cover = coverage as Record<string, unknown>
  if (typeof cover.documentId !== "string") return undefined
  const framesSkipped = typeof cover.framesSkipped === "number" ? cover.framesSkipped : 0
  const truncated = cover.truncated === true
  const complete =
    typeof cover.complete === "boolean" ? cover.complete && framesSkipped === 0 && !truncated : framesSkipped === 0 && !truncated
  return {
    documentId: cover.documentId,
    framesVisited: typeof cover.framesVisited === "number" ? cover.framesVisited : 1,
    framesSkipped,
    shadowRoots: typeof cover.shadowRoots === "number" ? cover.shadowRoots : 0,
    scanned: typeof cover.scanned === "number" ? cover.scanned : 0,
    truncated,
    complete,
    ...(typeof cover.warning === "string" && cover.warning.length > 0 ? { warning: cover.warning } : {}),
  }
}

export function parseFindResult(raw: unknown): { candidates: BrowserCandidate[]; coverage?: BrowserFindCoverage } {
  const coverage = parseFindCoverage(raw)
  return {
    candidates: parseBrowserCandidates(raw),
    ...(coverage === undefined ? {} : { coverage }),
  }
}

export function parseBrowserImages(raw: unknown): BrowserImage[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((item): BrowserImage[] => {
    if (typeof item !== "object" || item === null) return []
    const record = item as Record<string, unknown>
    if (typeof record.src !== "string" || typeof record.id !== "string") return []
    const rect =
      typeof record.rect === "object" && record.rect !== null ? (record.rect as Record<string, unknown>) : undefined
    return [
      {
        id: escapeUntrustedText(record.id),
        src: escapeUntrustedText(record.src),
        alt: typeof record.alt === "string" ? escapeUntrustedText(record.alt) : "",
        width: typeof record.width === "number" ? record.width : 0,
        height: typeof record.height === "number" ? record.height : 0,
        naturalWidth: typeof record.naturalWidth === "number" ? record.naturalWidth : 0,
        naturalHeight: typeof record.naturalHeight === "number" ? record.naturalHeight : 0,
        visible: record.visible === true,
        ...(rect === undefined
          ? {}
          : {
              rect: {
                x: typeof rect.x === "number" ? rect.x : 0,
                y: typeof rect.y === "number" ? rect.y : 0,
                width: typeof rect.width === "number" ? rect.width : 0,
                height: typeof rect.height === "number" ? rect.height : 0,
              },
            }),
        ...(typeof record.link === "string" ? { link: escapeUntrustedText(record.link) } : {}),
      },
    ]
  })
}

// Shared page-side helpers: images are keyed in the script-side map so a later
// save or copy resolves the exact element the model picked. Image refs are
// document-bound like element refs: a prior-document image id refuses as stale
// and never falls back to a lookalike URL/label match.
const IMAGE_HELPERS = `
  ${REF_HELPERS}
  ${SCOPE_HELPERS}
  const omniaImageState = () => {
    const existing = window.__omniaImageState;
    if (existing && existing.images && existing.byId) return existing;
    const state = { seq: 0, images: new WeakMap(), byId: new Map() };
    window.__omniaImageState = state;
    return state;
  };
  const omniaImageId = (el) => {
    const state = omniaImageState();
    let id = state.images.get(el);
    if (!id) { state.seq += 1; id = "img-" + state.seq; state.images.set(el, id); }
    state.byId.set(id, el);
    return id;
  };
  const omniaImageRef = (id) => id + "@" + omniaDocumentId();
  const omniaImageById = (ref) => {
    if (omniaIsStaleRef(ref)) return undefined;
    const parsed = omniaParseRef(ref);
    const tracked = omniaImageState().byId.get(parsed.id);
    return tracked && tracked.isConnected ? tracked : undefined;
  };
  const omniaBackgroundSrc = (el) => {
    try {
      const value = getComputedStyle(el).backgroundImage || "";
      const match = value.match(/url\\(["']?([^"')]+)["']?\\)/);
      return match ? match[1] : "";
    } catch (e) { return ""; }
  };
  const omniaImageSrc = (el) => { try { return el instanceof HTMLImageElement ? (el.currentSrc || el.src || "") : omniaBackgroundSrc(el); } catch (e) { return ""; } };
  const omniaImageNodes = () => {
    const collected = omniaCollectScopes();
    const out = [];
    for (const scope of collected.scopes) {
      let found = [];
      try { found = Array.from(scope.root.querySelectorAll("img, [style*='background-image'], [class*='image'], picture img")); } catch (e) { found = []; }
      for (const el of found) {
        try { if (el instanceof HTMLElement) out.push(el); else out.push(el); } catch (e) { out.push(el); }
      }
    }
    return out;
  };
  const omniaImageLabel = (el) => { try { return (el.getAttribute("alt") || el.getAttribute("title") || el.getAttribute("aria-label") || "").trim(); } catch (e) { return ""; } };
  const omniaImageRect = (el) => { try { const r = el.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) }; } catch (e) { return { x: 0, y: 0, width: 0, height: 0 }; } };
`

export function buildImagesExpression(limit = 24): string {
  return `(() => {
    ${IMAGE_HELPERS}
    const images = [];
    for (const el of omniaImageNodes()) {
      const src = omniaImageSrc(el);
      if (!src || src.startsWith("data:image/svg")) continue;
      const rect = omniaImageRect(el);
      if (rect.width < 8 || rect.height < 8) continue;
      const naturalWidth = el instanceof HTMLImageElement ? el.naturalWidth : rect.width;
      const naturalHeight = el instanceof HTMLImageElement ? el.naturalHeight : rect.height;
      if (naturalWidth < 8 || naturalHeight < 8) continue;
      const id = omniaImageId(el);
      try { el.setAttribute("data-omnia-image-id", id); } catch (e) {}
      const anchor = el.closest("a");
      images.push({
        id: omniaImageRef(id),
        src,
        alt: omniaImageLabel(el),
        width: rect.width,
        height: rect.height,
        naturalWidth,
        naturalHeight,
        visible: rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth,
        rect,
        ...(anchor && anchor.href ? { link: anchor.href } : {}),
      });
      if (images.length >= ${Math.max(1, Math.floor(limit))}) break;
    }
    return JSON.stringify(images);
  })()`
}

export function buildImageResolveExpression(target: BrowserImageTarget): string {
  const id = JSON.stringify(target.id ?? null)
  const url = JSON.stringify(target.url ?? null)
  const query = JSON.stringify((target.query ?? "").toLowerCase())
  return `(() => {
    ${IMAGE_HELPERS}
    const id = ${id};
    const url = ${url};
    const query = ${query};
    if (id && omniaIsStaleRef(id)) return JSON.stringify({ ok: false, reason: "stale_image_reference" });
    const nodes = omniaImageNodes().filter((el) => omniaImageSrc(el));
    const described = (el) => {
      const src = omniaImageSrc(el);
      const alt = omniaImageLabel(el);
      const rect = omniaImageRect(el);
      return { id: omniaImageRef(omniaImageId(el)), src, alt, width: rect.width, height: rect.height, visible: rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth };
    };
    const ambiguous = (count) => JSON.stringify({ ok: false, reason: "image_ambiguous", count });
    const byExactUrl = (candidate) => omniaImageSrc(candidate) === url;
    const byPartialUrl = (candidate) => omniaImageSrc(candidate).includes(url);
    const byExactLabel = (candidate) => omniaImageLabel(candidate).toLowerCase() === query;
    const byPartialLabel = (candidate) => omniaImageLabel(candidate).toLowerCase().includes(query);
    const byPartialSrc = (candidate) => omniaImageSrc(candidate).toLowerCase().includes(query);
    const uniqueMatch = (predicate) => {
      const matches = nodes.filter(predicate);
      if (matches.length > 1) return ambiguous(matches.length);
      return matches[0] || undefined;
    };
    let match;
    if (id) match = omniaImageById(id) || undefined;
    if (id && !match) return JSON.stringify({ ok: false, reason: "image_not_found" });
    if (!match && url) match = uniqueMatch(byExactUrl);
    if (match && typeof match === "string") return match;
    if (!match && url) match = uniqueMatch(byPartialUrl);
    if (match && typeof match === "string") return match;
    if (!match && query) match = uniqueMatch(byExactLabel);
    if (match && typeof match === "string") return match;
    if (!match && query) match = uniqueMatch(byPartialLabel);
    if (match && typeof match === "string") return match;
    if (!match && query) match = uniqueMatch(byPartialSrc);
    if (match && typeof match === "string") return match;
    if (!match && !id && !url && !query) match = nodes.find((el) => described(el).visible);
    if (!match) return JSON.stringify({ ok: false, reason: "image_not_found" });
    return JSON.stringify({ ok: true, ...described(match) });
  })()`
}

// A page-supplied image src is untrusted input: only http(s) sources are
// fetched at all (blob:/file:/data: never reach the network), and the decoded
// size is capped so a hostile page cannot hand back an unbounded body. The
// caller applies the navigation allowlist to the src before building this
// expression, so this is the second gate, not the only one.
export const MAX_FETCHED_IMAGE_BYTES = 32 * 1024 * 1024

export function buildImageFetchExpression(src: string): string {
  return `(async () => {
    const target = new URL(${JSON.stringify(src)}, location.href);
    if (target.protocol !== "http:" && target.protocol !== "https:") {
      return JSON.stringify({ reason: "unsupported_scheme" });
    }
    const sameOrigin = target.origin === location.origin;
    const response = await fetch(target.href, { credentials: sameOrigin ? "include" : "omit" });
    if (!response.ok) throw new Error("HTTP " + response.status);
    const blob = await response.blob();
    if (blob.size > ${MAX_FETCHED_IMAGE_BYTES}) return JSON.stringify({ reason: "too_large" });
    const data = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error("read_failed"));
      reader.readAsDataURL(blob);
    });
    return JSON.stringify({ data, mimeType: blob.type, bytes: blob.size });
  })()`
}
