import { NetworkError, ValidationError } from "@chat-adapter/shared";
import type { StateAdapter } from "chat";
import {
  GmailApiError,
  type GmailApiOptions,
  GmailContentError,
  type GmailHistory,
  type GmailMessage,
  type GmailReference,
  getGmailMessage,
  getGmailMessageMetadata,
  getGmailProfile,
  getGmailThread,
  listGmailHistory,
  listGmailMessages,
  watchGmailMailbox,
} from "./api";
import { type GmailEmail, parseGmailMessage } from "./format";
import { gmailChannel } from "./ids";
import { historyId } from "./schema";

export class GmailSynchronizer {
  private readonly key: string;
  private readonly api: GmailApiOptions;
  private readonly labelId: string;
  private readonly state: StateAdapter;
  private readonly dispatch: (email: GmailEmail) => Promise<void>;
  private readonly report?: (
    message: GmailReference,
    reason: "size" | "format" | "handler"
  ) => void;

  constructor(
    api: GmailApiOptions,
    labelId: string,
    state: StateAdapter,
    dispatch: (email: GmailEmail) => Promise<void>,
    report?: (
      message: GmailReference,
      reason: "size" | "format" | "handler"
    ) => void
  ) {
    this.api = api;
    this.labelId = labelId;
    this.state = state;
    this.dispatch = dispatch;
    this.report = report;
    this.key = `${gmailChannel(api.mailbox)}:sync:${labelId}`;
  }

  private async exclusive<T>(
    run: (api: GmailApiOptions, guard: () => void) => Promise<T>
  ): Promise<T> {
    const lock = await this.state.acquireLock(this.key, 60_000);
    if (!lock) {
      throw new NetworkError(
        "gmail",
        "Mailbox synchronization is already running"
      );
    }
    const controller = new AbortController();
    let renewal: Promise<void> | undefined;
    const guard = () => {
      if (controller.signal.aborted) {
        throw new NetworkError(
          "gmail",
          "Mailbox synchronization lost its lease"
        );
      }
    };
    const timer = setInterval(() => {
      if (renewal) {
        return;
      }
      renewal = this.state
        .extendLock(lock, 60_000)
        .then((extended) => {
          if (!extended) {
            controller.abort();
          }
        })
        .catch(() => controller.abort())
        .finally(() => {
          renewal = undefined;
        });
    }, 15_000);
    timer.unref();
    try {
      return await run({ ...this.api, signal: controller.signal }, guard);
    } finally {
      clearInterval(timer);
      await renewal;
      await this.state.releaseLock(lock);
    }
  }

  watch(topicName: string) {
    return this.exclusive(async (api, guard) => {
      const profile = await getGmailProfile(api);
      if (profile.emailAddress !== api.mailbox) {
        throw new ValidationError(
          "gmail",
          "Configured Gmail mailbox does not match the authenticated account"
        );
      }
      const result = await watchGmailMailbox(
        { topicName, labelId: this.labelId },
        api
      );
      guard();
      await this.state.setIfNotExists(`${this.key}:cursor`, result.historyId);
      await this.state.set(`${this.key}:expiration`, result.expiration);
      return result;
    });
  }

  sync(): Promise<void> {
    return this.exclusive(async (api, guard) => {
      const saved = await this.state.get<string>(`${this.key}:cursor`);
      if (!saved) {
        throw new ValidationError(
          "gmail",
          "Call adapter.watch() before synchronizing Gmail"
        );
      }
      const startHistoryId = historyId.parse(saved);
      let pageToken: string | undefined;
      const pages = new Set<string>();
      const messages = new Map<string, GmailReference>();
      let cursor = startHistoryId;
      do {
        let result: GmailHistory;
        try {
          result = await listGmailHistory(
            { startHistoryId, pageToken, labelId: this.labelId },
            api
          );
        } catch (error) {
          if (error instanceof GmailApiError && error.status === 404) {
            await this.rescan(api, guard);
            return;
          }
          throw error;
        }
        for (const change of result.history) {
          for (const added of change.messagesAdded) {
            messages.set(added.message.id, added.message);
          }
          for (const added of change.labelsAdded) {
            if (added.labelIds.includes(this.labelId)) {
              messages.set(added.message.id, added.message);
            }
          }
        }
        cursor = result.historyId;
        pageToken = result.nextPageToken;
        if (pageToken) {
          if (pages.has(pageToken)) {
            throw new NetworkError(
              "gmail",
              "Gmail history pagination repeated a cursor"
            );
          }
          pages.add(pageToken);
        }
      } while (pageToken);
      await this.handoff([...messages.values()], api, guard);
      guard();
      await this.state.set(`${this.key}:cursor`, cursor);
    });
  }

  private async rescan(api: GmailApiOptions, guard: () => void): Promise<void> {
    const profile = await getGmailProfile(api);
    let pageToken: string | undefined;
    const pages = new Set<string>();
    const messages: GmailReference[] = [];
    do {
      const result = await listGmailMessages(
        { labelId: this.labelId, pageToken },
        api
      );
      messages.push(...result.messages);
      pageToken = result.nextPageToken;
      if (pageToken) {
        if (pages.has(pageToken)) {
          throw new NetworkError(
            "gmail",
            "Gmail message pagination repeated a cursor"
          );
        }
        pages.add(pageToken);
      }
    } while (pageToken);
    await this.handoff(messages, api, guard);
    guard();
    await this.state.set(`${this.key}:cursor`, profile.historyId);
  }

  private async handoff(
    messages: GmailReference[],
    api: GmailApiOptions,
    guard: () => void
  ): Promise<void> {
    const threads = new Map<string, Set<string>>();
    for (const message of messages) {
      guard();
      if (await this.handled(message.id)) {
        continue;
      }
      const selected = threads.get(message.threadId) ?? new Set<string>();
      selected.add(message.id);
      threads.set(message.threadId, selected);
    }
    for (const [threadId, selected] of threads) {
      let ordered = [...selected];
      if (ordered.length > 1) {
        const thread = await getGmailThread(threadId, api).catch(
          (error: unknown) => {
            if (error instanceof GmailApiError && error.status === 404) {
              return undefined;
            }
            throw error;
          }
        );
        if (!thread) {
          continue;
        }
        ordered = thread.messages
          .map((message) => message.id)
          .filter((id) => selected.has(id));
      }
      for (let index = ordered.length - 1; index >= 0; index--) {
        if (await this.deliver({ id: ordered[index], threadId }, api, guard)) {
          for (const id of ordered.slice(0, index)) {
            guard();
            await this.state.set(`${this.key}:delivered:${id}`, true);
          }
          break;
        }
      }
    }
  }

  private async deliver(
    reference: GmailReference,
    api: GmailApiOptions,
    guard: () => void
  ): Promise<boolean> {
    guard();
    const { id } = reference;
    const receipt = `${this.key}:delivered:${id}`;
    if (await this.handled(id)) {
      return false;
    }
    let message: GmailMessage;
    try {
      const metadata = await getGmailMessageMetadata(id, api);
      if (!this.selected(metadata.labelIds)) {
        return false;
      }
      guard();
      message = await getGmailMessage(id, api);
    } catch (error) {
      if (error instanceof GmailApiError && error.status === 404) {
        return false;
      }
      if (error instanceof GmailContentError) {
        return this.fail(reference, error.reason, guard);
      }
      throw error;
    }
    if (!this.selected(message.labelIds)) {
      return false;
    }
    let email: GmailEmail;
    try {
      email = await parseGmailMessage(message);
    } catch (error) {
      if (error instanceof GmailContentError) {
        return this.fail(reference, error.reason, guard);
      }
      throw error;
    }
    guard();
    try {
      await this.dispatch(email);
    } catch {
      return this.fail(reference, "handler", guard);
    }
    guard();
    await this.state.set(receipt, true);
    return true;
  }

  private async handled(id: string): Promise<boolean> {
    return Boolean(
      (await this.state.get(`${this.key}:delivered:${id}`)) ||
        (await this.state.get(`${this.key}:failed:${id}`))
    );
  }

  private async fail(
    message: GmailReference,
    reason: "size" | "format" | "handler",
    guard: () => void
  ): Promise<boolean> {
    guard();
    await this.state.set(`${this.key}:failed:${message.id}`, reason);
    this.report?.(message, reason);
    return true;
  }

  private selected(labels: string[]): boolean {
    return (
      labels.includes(this.labelId) &&
      !["SENT", "DRAFT", "TRASH", "SPAM"].some((label) =>
        labels.includes(label)
      )
    );
  }
}
