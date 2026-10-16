import type {
  ChannelHistoryApi,
  FetchOptions,
  FetchResult,
  ListThreadsOptions,
  ListThreadsResult,
  ThreadHistoryApi,
} from "../types";
import { persistsHistory, requireAdapter } from "./resolve-adapter";
import type { ThreadHistoryCacheLike } from "./thread";
import type {
  AdapterResolver,
  ListThreadsWithMessagesOptions,
  ListThreadsWithMessagesResult,
  ThreadWithMessages,
} from "./types";

const DEFAULT_MAX_THREADS = 5;

/** Upper bound on concurrent per-thread fetches in listThreadsWithMessages. */
const THREAD_FETCH_CONCURRENCY = 4;

/**
 * Channel-level history implementation.
 *
 * The `listMessages()` and `listThreads()` methods satisfy the
 * {@link ChannelHistoryApi} interface and delegate to the appropriate adapter
 * method.
 *
 * The extended method `listThreadsWithMessages()` is not part of the interface
 * but provides a convenient way to retrieve threads together with their
 * messages in a single call.
 *
 * Adapter resolution: the adapter name is derived from the channel ID prefix
 * (`{adapter}:{channel}`).
 */
export class ChannelHistoryApiImpl implements ChannelHistoryApi {
  private readonly getAdapter: AdapterResolver;
  private readonly threadHistory: Pick<ThreadHistoryApi, "list">;
  private readonly cache: ThreadHistoryCacheLike | undefined;

  constructor(
    getAdapter: AdapterResolver,
    threadHistory: Pick<ThreadHistoryApi, "list">,
    cache?: ThreadHistoryCacheLike
  ) {
    this.getAdapter = getAdapter;
    this.threadHistory = threadHistory;
    this.cache = cache;
  }

  /**
   * Fetch top-level messages in a channel (not thread replies).
   *
   * Uses `adapter.fetchChannelMessages` when available. Adapters that persist
   * history in the SDK-side store (`persistThreadHistory`) are served from
   * the channel-keyed cache instead — `Chat` appends inbound messages under
   * the channel ID for exactly this purpose. Every other adapter without
   * `fetchChannelMessages` throws a capability error rather than guessing.
   *
   * @throws if the adapter for the channel ID is not registered, or does not
   * support fetching channel messages
   */
  async listMessages(
    channelId: string,
    options?: FetchOptions
  ): Promise<FetchResult> {
    const adapter = requireAdapter(
      this.getAdapter,
      channelId,
      "history.channel"
    );

    if (adapter.fetchChannelMessages) {
      return adapter.fetchChannelMessages(channelId, options);
    }

    if (this.cache && persistsHistory(adapter)) {
      const all = await this.cache.getMessages(channelId);
      const limit = options?.limit;
      let messages = all;
      if (limit !== undefined) {
        messages =
          options?.direction === "forward"
            ? all.slice(0, limit)
            : all.slice(Math.max(0, all.length - limit));
      }
      return { messages, nextCursor: undefined };
    }

    throw new Error(
      `history.channel.listMessages: adapter "${adapter.name}" does not support fetching channel messages`
    );
  }

  /**
   * List threads in a channel.
   *
   * Delegates to `adapter.listThreads`.
   *
   * @throws if the adapter does not implement `listThreads`
   */
  async listThreads(
    channelId: string,
    options?: ListThreadsOptions
  ): Promise<ListThreadsResult> {
    const adapter = requireAdapter(
      this.getAdapter,
      channelId,
      "history.channel"
    );

    if (!adapter.listThreads) {
      throw new Error(
        `history.channel.listThreads: adapter "${adapter.name}" does not implement listThreads`
      );
    }

    return adapter.listThreads(channelId, options);
  }

  /**
   * Convenience method: list threads and fetch a page of messages for each.
   *
   * Fetches up to `maxThreads` (default 5) threads, then retrieves
   * `messagesPerThread` messages for each through `history.thread.list`
   * (so per-thread reads share its cache-fallback semantics), at most
   * {@link THREAD_FETCH_CONCURRENCY} threads at a time to stay inside
   * platform rate limits.
   *
   * @throws if the adapter does not implement `listThreads`
   */
  async listThreadsWithMessages(
    channelId: string,
    options?: ListThreadsWithMessagesOptions
  ): Promise<ListThreadsWithMessagesResult> {
    const maxThreads = options?.maxThreads ?? DEFAULT_MAX_THREADS;
    const messagesPerThread = options?.messagesPerThread;

    const threadsResult = await this.listThreads(channelId, {
      cursor: options?.cursor,
      limit: maxThreads,
    });

    const summaries = threadsResult.threads;
    const threads: ThreadWithMessages[] = [];
    for (let i = 0; i < summaries.length; i += THREAD_FETCH_CONCURRENCY) {
      const batch = summaries.slice(i, i + THREAD_FETCH_CONCURRENCY);
      const results = await Promise.all(
        batch.map(async (summary) => {
          const result = await this.threadHistory.list(
            summary.id,
            messagesPerThread !== undefined
              ? { limit: messagesPerThread }
              : undefined
          );
          return { threadId: summary.id, messages: result.messages };
        })
      );
      threads.push(...results);
    }

    return {
      threads,
      nextCursor: threadsResult.nextCursor,
    };
  }
}
