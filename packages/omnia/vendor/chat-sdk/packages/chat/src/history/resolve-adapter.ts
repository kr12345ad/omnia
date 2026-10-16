import type { Adapter } from "../types";
import type { AdapterResolver } from "./types";

/**
 * Resolve the adapter embedded in a thread or channel ID prefix
 * (`{adapter}:...`), throwing a descriptive error when the prefix is missing
 * or no adapter is registered under that name.
 *
 * A typo'd or unregistered adapter must fail loudly here — falling through to
 * an empty result would let callers (including AI tools) mistake a
 * misconfiguration for an empty conversation.
 *
 * @internal
 */
export function requireAdapter(
  getAdapter: AdapterResolver,
  id: string,
  scope: string
): Adapter {
  const adapterName = id.split(":")[0];
  if (!adapterName) {
    throw new Error(
      `${scope}: cannot resolve adapter from ID "${id}" — expected format "{adapter}:..."`
    );
  }
  const adapter = getAdapter(adapterName);
  if (!adapter) {
    throw new Error(
      `${scope}: no adapter registered with name "${adapterName}"`
    );
  }
  return adapter;
}

/**
 * Whether an adapter's message history lives in the SDK-side
 * `ThreadHistoryCache` rather than on the platform (e.g. Telegram, WhatsApp).
 * Mirrors the gating `Chat` uses when wiring the cache into threads.
 *
 * @internal
 */
export function persistsHistory(adapter: Adapter): boolean {
  return Boolean(adapter.persistThreadHistory || adapter.persistMessageHistory);
}
