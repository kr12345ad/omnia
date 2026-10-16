import type { Message } from "../message";
import type { FetchOptions, FetchResult, ThreadHistoryApi } from "../types";
import { persistsHistory, requireAdapter } from "./resolve-adapter";
import type { AdapterResolver, ThreadHistoryCollectOptions } from "./types";

/**
 * Per-thread message history implementation.
 *
 * The `list()` method satisfies the {@link ThreadHistoryApi} interface and
 * delegates to `adapter.fetchMessages`.
 *
 * The extended methods `collect()` and `append()` are not part of the
 * interface but are available on the concrete class:
 * - `collect()` — async generator that paginates through all thread messages
 * - `append()` — appends to a {@link ThreadHistoryCache}-backed store (for
 *   adapters with `persistThreadHistory: true`, accessed via the optional
 *   `cache` argument on the constructor)
 *
 * Adapter resolution: the adapter name is derived from the thread ID prefix
 * (`{adapter}:{channel}:{thread}`). An unknown prefix throws rather than
 * returning an empty result.
 *
 * Cache fallback: reserved for adapters whose history lives in the SDK-side
 * store (`persistThreadHistory` / legacy `persistMessageHistory`). For every
 * other adapter, the platform response is authoritative — an empty page is a
 * real empty page, not a cue to substitute cached data.
 */
export class ThreadHistoryApiImpl implements ThreadHistoryApi {
  private readonly getAdapter: AdapterResolver;
  private readonly cache: ThreadHistoryCacheLike | undefined;

  constructor(getAdapter: AdapterResolver, cache?: ThreadHistoryCacheLike) {
    this.getAdapter = getAdapter;
    this.cache = cache;
  }

  /**
   * Fetch a single page of messages from a thread.
   *
   * Uses `adapter.fetchMessages`, falling back to the SDK-side cache only
   * for adapters that persist history there — and never on a continuation
   * page (an empty page mid-pagination means the thread is exhausted).
   *
   * @throws if the adapter embedded in the thread ID is not registered
   */
  async list(threadId: string, options?: FetchOptions): Promise<FetchResult> {
    const adapter = requireAdapter(this.getAdapter, threadId, "history.thread");
    const result = await adapter.fetchMessages(threadId, options);

    if (
      result.messages.length === 0 &&
      result.nextCursor === undefined &&
      options?.cursor === undefined &&
      this.cache &&
      persistsHistory(adapter)
    ) {
      const messages = await this.readCachedWindow(threadId, options);
      return { messages, nextCursor: undefined };
    }

    return result;
  }

  /**
   * Async generator that yields all messages in the thread in chronological
   * order, handling pagination automatically. With a `limit`, yields the
   * oldest N messages on both the adapter and cache paths.
   *
   * Falls back to the `ThreadHistoryCache` (if one was provided at
   * construction time) for adapters that persist history in the SDK-side
   * store — e.g. Telegram/WhatsApp.
   */
  async *collect(
    threadId: string,
    options?: ThreadHistoryCollectOptions
  ): AsyncIterable<Message> {
    const adapter = requireAdapter(this.getAdapter, threadId, "history.thread");
    const limit = options?.limit;
    let collected = 0;

    if (limit === 0) {
      return;
    }

    let cursor: string | undefined;
    let yieldedAny = false;
    while (true) {
      const remaining = limit !== undefined ? limit - collected : undefined;
      if (remaining !== undefined && remaining <= 0) {
        return;
      }
      const fetchLimit =
        remaining !== undefined ? Math.max(1, Math.min(100, remaining)) : 100;
      const result: FetchResult = await adapter.fetchMessages(threadId, {
        direction: "forward",
        cursor,
        limit: fetchLimit,
      });
      for (const message of result.messages) {
        yieldedAny = true;
        yield message;
        collected++;
        if (limit !== undefined && collected >= limit) {
          return;
        }
      }
      // Same guard as ThreadImpl.allMessages: an empty page ends pagination
      // even when the adapter echoes a cursor back, so a misbehaving adapter
      // cannot send us into an unbounded fetch loop.
      if (!result.nextCursor || result.messages.length === 0) {
        break;
      }
      cursor = result.nextCursor;
    }

    if (yieldedAny || !this.cache || !persistsHistory(adapter)) {
      return;
    }

    // Cache fallback for adapters whose history lives in the SDK-side store.
    // Slice from the front so a `limit` means "oldest N", matching the
    // adapter path above.
    const all = await this.cache.getMessages(threadId);
    const messages = limit !== undefined ? all.slice(0, limit) : all;
    for (const message of messages) {
      yield message;
    }
  }

  /**
   * Append a message to the SDK-side per-thread history cache.
   *
   * Only available when a `ThreadHistoryCache` was passed at construction
   * time. Used by adapters that set `persistThreadHistory: true`.
   */
  async append(threadId: string, message: Message): Promise<void> {
    if (!this.cache) {
      throw new Error(
        "history.thread.append: no ThreadHistoryCache was provided at construction"
      );
    }
    await this.cache.append(threadId, message);
  }

  /**
   * Read a `list()`-shaped window from the cache: `direction: "forward"`
   * yields the oldest N, the default backward direction the newest N — the
   * same windows the adapter path serves.
   */
  private async readCachedWindow(
    threadId: string,
    options?: FetchOptions
  ): Promise<Message[]> {
    if (!this.cache) {
      return [];
    }
    if (options?.direction === "forward") {
      const all = await this.cache.getMessages(threadId);
      return options?.limit !== undefined ? all.slice(0, options.limit) : all;
    }
    return this.cache.getMessages(threadId, options?.limit);
  }
}

/**
 * Minimal shape of the `ThreadHistoryCache` needed by this module.
 * Avoids a hard import of `ThreadHistoryCache` to keep the module testable.
 *
 * @internal
 */
export interface ThreadHistoryCacheLike {
  append(threadId: string, message: Message): Promise<void>;
  getMessages(threadId: string, limit?: number): Promise<Message[]>;
}
