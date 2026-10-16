import { z } from "zod";

export class GmailContentError extends Error {
  readonly reason: "size" | "format";

  constructor(reason: "size" | "format") {
    super(
      reason === "size"
        ? "Gmail content exceeds the size limit"
        : "Gmail MIME content could not be parsed"
    );
    this.name = "GmailContentError";
    this.reason = reason;
  }
}

const reason = z.enum([
  "authError",
  "badRequest",
  "dailyLimitExceeded",
  "domainPolicy",
  "forbidden",
  "rateLimitExceeded",
  "userRateLimitExceeded",
  "backendError",
  "invalid_grant",
  "invalid_client",
  "deleted_client",
]);
const failure = z.object({
  error: z.union([
    z.string(),
    z.object({
      errors: z.array(z.object({ reason: z.string() })).optional(),
    }),
  ]),
});

export class GmailApiError extends Error {
  readonly status: number;
  readonly retryAfter?: number;
  readonly reason?: z.infer<typeof reason>;

  constructor(
    status: number,
    retryAfter?: number,
    cause?: z.infer<typeof reason>
  ) {
    super(`Gmail API request failed (${status})`);
    this.name = "GmailApiError";
    this.status = status;
    this.retryAfter = retryAfter;
    this.reason = cause;
  }
}

export async function readGmailBody(
  response: Response,
  limit: number
): Promise<string> {
  if (!response.body) {
    throw new Error("Missing response body");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new GmailContentError("size");
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks, size).toString("utf8");
  } finally {
    reader.releaseLock();
  }
}

export async function readGmailJson(
  response: Response,
  limit = 40 * 1024 * 1024
): Promise<unknown> {
  if (!response.ok) {
    const header = response.headers.get("retry-after");
    const seconds = header === null ? Number.NaN : Number(header);
    const retryAfter = Number.isFinite(seconds)
      ? Math.max(0, seconds)
      : undefined;
    let cause: z.infer<typeof reason> | undefined;
    try {
      const payload = failure.safeParse(
        JSON.parse(await readGmailBody(response, 65_536))
      );
      if (payload.success) {
        const error = payload.data.error;
        cause = reason.safeParse(
          typeof error === "string" ? error : error.errors?.[0]?.reason
        ).data;
      }
    } catch {
      cause = undefined;
    }
    throw new GmailApiError(response.status, retryAfter, cause);
  }
  const body = await readGmailBody(response, limit);
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new Error("Gmail returned invalid JSON");
  }
}
