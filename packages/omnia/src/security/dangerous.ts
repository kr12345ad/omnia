import type { AccessMode, DangerClassification, OperationInput } from "./types"

const normalize = (value: string) => value.trim().toLowerCase().replaceAll("\\", "/")

const hasAny = (values: readonly string[], patterns: readonly RegExp[]) =>
  patterns.some((pattern) => values.some((value) => pattern.test(normalize(value))))

const actionPatterns = (action: string) => {
  const value = normalize(action)
  return {
    delete: /(^|[:_.-])(delete|remove|unlink|destroy|drop|truncate|rm|rmdir|erase|purge)([:_.-]|$)/.test(value),
    recursiveDelete: /(^|[:_.-])(recursive[_-]?delete|delete[_-]?recursive|rm|rmdir)([:_.-]|$)/.test(value),
    write: /(^|[:_.-])(write|edit|patch|modify|replace|save|create|move|rename|copy)([:_.-]|$)/.test(value),
    permission: /(^|[:_.-])(chmod|chown|chgrp|setfacl|acl|permission|ownership)([:_.-]|$)/.test(value),
    shell: /(^|[:_.-])(shell|bash|sh|zsh|exec|execute|command|spawn|process|run)([:_.-]|$)/.test(value),
    network: /(^|[:_.-])(fetch|http|https|network|download|upload|curl|wget|request|browse|web)([:_.-]|$)/.test(value),
    credential: /(^|[:_.-])(credential|secret|token|password|passwd|api[_-]?key|private[_-]?key|cookie|auth)([:_.-]|$)/.test(value),
    package: /(^|[:_.-])(install|uninstall|publish|package|dependency|npm|pnpm|yarn|pip|cargo|gem|apt|brew)([:_.-]|$)/.test(value),
    vcs: /(^|[:_.-])(git|github|gitlab|push|commit|merge|rebase|reset|checkout|clean|release)([:_.-]|$)/.test(value),
    database: /(^|[:_.-])(database|sql|migration|schema|query|transaction)([:_.-]|$)/.test(value),
    privilege: /(^|[:_.-])(sudo|su|root|admin|privilege|service|daemon)([:_.-]|$)/.test(value),
    process: /(^|[:_.-])(kill|terminate|signal|stop|restart|shutdown)([:_.-]|$)/.test(value),
  }
}

const pathPatterns = (resources: readonly string[]) => ({
  secret: hasAny(resources, [
    /(?:^|\/)\.env(?:\.|$)/,
    /(?:^|\/)(?:id_rsa|id_dsa|id_ecdsa|id_ed25519)(?:$|\.)/,
    /(?:^|\/)(?:credentials?|secrets?|private[-_]?key|token)(?:$|[./])/,
    /\.(?:pem|key|p12|pfx|keystore)$/,
  ]),
  system: hasAny(resources, [
    /^\/(?:etc|root|proc|sys|dev|boot|var\/lib|var\/log)(?:\/|$)/,
    /^\/(?:usr|bin|sbin|lib|lib64)(?:\/|$)/,
    /^[a-z]:\\(?:windows|program files|users)(?:\\|$)/i,
  ]),
  external: hasAny(resources, [/^(?:\/|\.\.\/|file:\/\/|https?:\/\/)/]),
})

const levelRank = (level: DangerClassification["level"]) =>
  level === "critical" ? 4 : level === "high" ? 3 : level === "medium" ? 2 : level === "low" ? 1 : 0

const classification = (
  kind: DangerClassification["kind"],
  level: DangerClassification["level"],
  reasons: readonly string[],
  irreversible = false,
): DangerClassification =>
  Object.freeze({
    dangerous: level !== "none",
    level,
    risk: level,
    kind,
    requiresApproval: level === "high" || level === "critical",
    requiresExplicitApproval: level === "high" || level === "critical",
    irreversible,
    reasons: Object.freeze([...new Set(reasons)]),
  })

export interface DangerInput extends Partial<OperationInput> {
  readonly type?: string
}

export function classifyDanger(input: OperationInput | DangerInput | string): DangerClassification {
  const operation: OperationInput =
    typeof input === "string"
      ? { action: input }
      : {
          action: input.action ?? ("type" in input ? input.type : undefined) ?? "",
          ...(input.resources === undefined ? {} : { resources: input.resources }),
          ...(input.resource === undefined ? {} : { resource: input.resource }),
          ...(input.access === undefined ? {} : { access: input.access }),
          ...(input.mode === undefined ? {} : { mode: input.mode }),
          ...(input.paths === undefined ? {} : { paths: input.paths }),
          ...(input.command === undefined ? {} : { command: input.command }),
          ...(input.recursive === undefined ? {} : { recursive: input.recursive }),
          ...(input.explicitDangerous === undefined ? {} : { explicitDangerous: input.explicitDangerous }),
          ...(input.dangerous === undefined ? {} : { dangerous: input.dangerous }),
          ...(input.destructive === undefined ? {} : { destructive: input.destructive }),
          ...(input.requiresApproval === undefined ? {} : { requiresApproval: input.requiresApproval }),
          ...(input.scope === undefined ? {} : { scope: input.scope }),
          ...(input.permissionScope === undefined ? {} : { permissionScope: input.permissionScope }),
          ...(input.followSymlinks === undefined ? {} : { followSymlinks: input.followSymlinks }),
          ...(input.realpath === undefined ? {} : { realpath: input.realpath }),
          ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
          ...(input.provenance === undefined ? {} : { provenance: input.provenance }),
        }
  const action = normalize(operation.action ?? "")
  const resources = [...(operation.resources ?? []), ...(operation.paths ?? [])]
  if (operation.resource !== undefined) resources.push(operation.resource)
  const patterns = actionPatterns(action)
  const paths = pathPatterns(resources)
  const command = normalize(operation.command ?? resources.join(" "))
  const commandDelete = /\b(?:rm|rmdir|del|remove|unlink|delete|erase|purge)\b/i.test(command)
  const commandNetwork = /\b(?:curl|wget|http|https|nc|ssh|scp|ftp|powershell|invoke-webrequest)\b/i.test(command)
  const commandCredential = /\b(?:secret|token|password|credential|private[-_]?key|api[-_]?key)\b/i.test(command)
  const commandPackage = /\b(?:npm|pnpm|yarn|pip|cargo|gem|apt|brew|install|publish)\b/i.test(command)
  const commandVcs = /\b(?:git|gh|gitlab|github)\b/i.test(command)
  const commandDatabase = /\b(?:psql|mysql|sqlite|sql|migration)\b/i.test(command)
  const commandRecursive =
    /(?:^|\s)-{1,2}(?:[a-z]*r[a-z]*f|f[a-z]*r|recursive)(?:\s|$)/.test(command) ||
    /\b(?:rm|remove|delete)\b[^\n]*(?:\*|--recursive|\.\.)/i.test(command)
  const recursive = operation.recursive === true || commandRecursive
  const reasons: string[] = []
  let kind: DangerClassification["kind"] = "none"
  let level: DangerClassification["level"] = "none"
  let irreversible = false

  const elevate = (nextKind: DangerClassification["kind"], nextLevel: DangerClassification["level"], reason: string, nextIrreversible = false) => {
    reasons.push(reason)
    const nextRank = levelRank(nextLevel)
    const currentRank = levelRank(level)
    if (nextRank > currentRank) {
      kind = nextKind
      level = nextLevel
    } else if (nextRank === currentRank && kind === "none") {
      kind = nextKind
    }
    irreversible = irreversible || nextIrreversible
  }

  if (operation.explicitDangerous === true || operation.dangerous === true) elevate("unknown", "critical", "explicitly marked dangerous")
  if (operation.requiresApproval === true) elevate("unknown", "high", "operation requires approval")
  if (operation.destructive === true) elevate("delete", "critical", "explicitly marked destructive", true)
  const access = operation.access ?? operation.mode
  if (access === "delete") {
    if (recursive || resources.some((resource) => resource === "*" || resource === "**" || resource.includes(".."))) {
      elevate("recursive_delete", "critical", "broad delete access", true)
    } else {
      elevate("delete", "high", "delete access", true)
    }
  }
  if (access === "execute") elevate("shell", "high", "execute access")
  if (access === "admin") elevate("permission_change", "high", "administrative access", true)
  if (access === "write" || access === "create") elevate("write", "medium", "mutating access")
  if (patterns.recursiveDelete || commandRecursive || (patterns.delete && recursive) || (commandDelete && recursive)) {
    elevate("recursive_delete", "critical", "recursive or broad deletion", true)
  } else if (patterns.delete || commandDelete) {
    elevate("delete", "high", "destructive deletion", true)
  }
  if (patterns.permission) elevate("permission_change", "high", "permission or ownership change", true)
  if (patterns.shell) elevate("shell", "high", "arbitrary command execution")
  if (patterns.network || commandNetwork) elevate("network", "high", "network or remote side effect")
  if (patterns.credential || commandCredential) elevate("credential", "critical", "credential or secret access", true)
  if (paths.secret) elevate("credential", "critical", "secret-like file access", true)
  if (paths.system) elevate("external_path", "critical", "system or host path access", true)
  if (paths.external && !operation.scope && !operation.permissionScope) elevate("external_path", "high", "path outside an explicit scope")
  if (patterns.package || commandPackage) elevate("package", "high", "package or dependency mutation")
  if (patterns.vcs || commandVcs) elevate("vcs", "high", "version-control publication or history mutation")
  if (patterns.database || commandDatabase) elevate("database", "critical", "database mutation", true)
  if (patterns.privilege) elevate("privilege", "critical", "privilege or service mutation", true)
  if (patterns.process) elevate("process", "high", "process lifecycle mutation", true)
  if (patterns.write && levelRank(level) < levelRank("medium")) {
    elevate("write", "medium", "mutating operation")
  }
  if (recursive && patterns.delete === false && levelRank(level) < levelRank("high")) {
    elevate(kind, "high", "recursive operation")
  }
  if (!action && resources.length === 0) return classification("unknown", "medium", ["missing operation description"])
  if (level === "none") return classification("read", "none", [])
  return classification(kind, level, reasons, irreversible)
}

export const classifyOperation = classifyDanger
export const classifyDangerousOperation = classifyDanger

export function isDangerousOperation(input: OperationInput | DangerInput | string): boolean {
  return classifyDanger(input).dangerous
}

export function requiresDangerousApproval(input: OperationInput | DangerInput | string): boolean {
  return classifyDanger(input).requiresApproval
}

export function isIrreversibleOperation(input: OperationInput | DangerInput | string): boolean {
  return classifyDanger(input).irreversible
}

export function dangerAtLeast(
  input: OperationInput | DangerInput | string,
  level: DangerClassification["level"],
): boolean {
  return levelRank(classifyDanger(input).level) >= levelRank(level)
}

export const dangerousAtLeast = dangerAtLeast
export const classifyDangerousAction = classifyDanger
export const classifyRisk = classifyDanger
export const isDestructiveOperation = (input: OperationInput | DangerInput | string) => {
  const result = classifyDanger(input)
  return result.irreversible || result.kind === "delete" || result.kind === "recursive_delete"
}
export const requiresExplicitApproval = requiresDangerousApproval
export const isHighRiskOperation = (input: OperationInput | DangerInput | string) => dangerAtLeast(input, "high")

export function accessModeForAction(action: string): AccessMode {
  const value = normalize(action)
  if (/delete|remove|unlink|destroy|drop|truncate|rm/.test(value)) return "delete"
  if (/create|make|mkdir|touch/.test(value)) return "create"
  if (/write|edit|patch|modify|save|move|rename|copy/.test(value)) return "write"
  if (/execute|exec|run|spawn|shell|bash|sh/.test(value)) return "execute"
  if (/list|readdir|directory/.test(value)) return "list"
  if (/search|find|grep|glob/.test(value)) return "search"
  if (/admin|manage|permission|chmod|chown/.test(value)) return "admin"
  return "read"
}
