// Callback-data codec for buttons rendered by this adapter. Lives outside
// cards.ts so the runtime-light webhook subpath can use it without pulling
// in the chat package or @chat-adapter/shared.
const CALLBACK_DATA_PREFIX = "chat:";

interface TwilioCardActionPayload {
  a: string;
  v?: string;
}

export function isTwilioChatCallback(data: string): boolean {
  return data.startsWith(CALLBACK_DATA_PREFIX);
}

export function encodeTwilioCallbackData(
  actionId: string,
  value?: string
): string {
  const payload: TwilioCardActionPayload = { a: actionId };
  if (typeof value === "string") {
    payload.v = value;
  }
  return `${CALLBACK_DATA_PREFIX}${JSON.stringify(payload)}`;
}

export function decodeTwilioCallbackData(data?: string): {
  actionId: string;
  value: string | undefined;
} {
  if (!data) {
    return { actionId: "twilio_callback", value: undefined };
  }

  if (!isTwilioChatCallback(data)) {
    return { actionId: data, value: data };
  }

  try {
    const decoded = JSON.parse(
      data.slice(CALLBACK_DATA_PREFIX.length)
    ) as TwilioCardActionPayload;

    if (typeof decoded.a === "string" && decoded.a) {
      return {
        actionId: decoded.a,
        value: typeof decoded.v === "string" ? decoded.v : undefined,
      };
    }
  } catch {
    // Malformed JSON — fall back to passthrough.
  }

  return { actionId: data, value: data };
}
