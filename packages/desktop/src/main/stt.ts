import { app, BrowserWindow, ipcMain } from "electron"
import { join } from "node:path"

const MODEL = process.env.OMNIA_STT_MODEL?.trim() || "onnx-community/whisper-base"
const TARGET_RATE = 16_000

type Transcriber = (audio: Float32Array, options?: Record<string, unknown>) => Promise<{ text?: string } | { text?: string }[]>

let transcriber: Transcriber | undefined
let loading: Promise<Transcriber> | undefined
let lastError: string | undefined

export function registerSttIpcHandlers(): void {
  ipcMain.handle("stt-status", () => status())
  ipcMain.handle("stt-load", async () => {
    try {
      await ensureTranscriber()
      return status()
    } catch (error) {
      lastError = messageOf(error)
      return status()
    }
  })
  ipcMain.handle("stt-transcribe", async (_event, input: unknown) => {
    try {
      const wav = toBuffer(input)
      if (!wav) throw new Error("No audio was provided.")
      const { samples, sampleRate } = decodeWav(wav)
      const audio = sampleRate === TARGET_RATE ? samples : resample(samples, sampleRate, TARGET_RATE)
      const run = await ensureTranscriber()
      const result = await run(audio, { chunk_length_s: 30, stride_length_s: 5, return_timestamps: false })
      const text = Array.isArray(result) ? result.map((item) => item.text ?? "").join(" ") : result.text ?? ""
      return { ok: true, text: text.trim(), model: MODEL }
    } catch (error) {
      lastError = messageOf(error)
      return { ok: false, message: lastError, model: MODEL }
    }
  })
}

export async function primeStt(): Promise<void> {
  try {
    await ensureTranscriber()
  } catch (error) {
    lastError = messageOf(error)
  }
}

export function sttStatus() {
  return status()
}

function status() {
  return {
    ok: true,
    ready: Boolean(transcriber),
    loading: Boolean(loading) && !transcriber,
    model: MODEL,
    ...(lastError ? { message: lastError } : {}),
  }
}

async function ensureTranscriber(): Promise<Transcriber> {
  if (transcriber) return transcriber
  if (loading) return loading
  loading = (async () => {
    const { pipeline, env } = await import("@huggingface/transformers")
    env.cacheDir = join(app.getPath("userData"), "stt-models")
    env.allowRemoteModels = true
    env.allowLocalModels = true
    const options = {
      device: "cpu" as const,
      dtype: "q8" as const,
      progress_callback: (progress: unknown) => broadcast(progress),
    }
    let created: unknown
    try {
      created = await pipeline("automatic-speech-recognition", MODEL, options)
    } catch {
      created = await pipeline("automatic-speech-recognition", MODEL, {
        device: "cpu",
        progress_callback: (progress: unknown) => broadcast(progress),
      })
    }
    transcriber = created as Transcriber
    lastError = undefined
    broadcast({ status: "ready", model: MODEL })
    return transcriber
  })()
  loading.catch((error) => {
    lastError = messageOf(error)
    loading = undefined
    broadcast({ status: "error", message: lastError })
  })
  return loading
}

function broadcast(progress: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue
    win.webContents.send("stt-progress", { ...(typeof progress === "object" && progress ? progress : {}), model: MODEL })
  }
}

function toBuffer(input: unknown): Buffer | undefined {
  if (input instanceof ArrayBuffer) return Buffer.from(input)
  if (ArrayBuffer.isView(input)) return Buffer.from(input.buffer, input.byteOffset, input.byteLength)
  if (Array.isArray(input)) return Buffer.from(input)
  return undefined
}

function decodeWav(buffer: Buffer): { samples: Float32Array; sampleRate: number } {
  if (buffer.length < 44 || buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("Audio must be a WAV file.")
  }
  let offset = 12
  let format = 1
  let channels = 1
  let sampleRate = TARGET_RATE
  let bits = 16
  let dataOffset = -1
  let dataLength = 0
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4)
    const size = buffer.readUInt32LE(offset + 4)
    const body = offset + 8
    if (id === "fmt " && size >= 16) {
      format = buffer.readUInt16LE(body)
      channels = buffer.readUInt16LE(body + 2)
      sampleRate = buffer.readUInt32LE(body + 4)
      bits = buffer.readUInt16LE(body + 14)
    } else if (id === "data") {
      dataOffset = body
      dataLength = Math.min(size, buffer.length - body)
    }
    offset = body + size + (size % 2)
  }
  if (dataOffset < 0) throw new Error("WAV file has no audio data.")
  if (format !== 1 || bits !== 16) throw new Error("Only 16-bit PCM WAV is supported.")
  const frames = Math.floor(dataLength / (2 * channels))
  const samples = new Float32Array(frames)
  for (let frame = 0; frame < frames; frame += 1) {
    let sum = 0
    for (let channel = 0; channel < channels; channel += 1) {
      sum += buffer.readInt16LE(dataOffset + (frame * channels + channel) * 2) / 32768
    }
    samples[frame] = sum / channels
  }
  return { samples, sampleRate }
}

function resample(input: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return input
  const length = Math.max(1, Math.round((input.length * to) / from))
  const output = new Float32Array(length)
  const ratio = from / to
  for (let index = 0; index < length; index += 1) {
    const position = index * ratio
    const left = Math.floor(position)
    const right = Math.min(input.length - 1, left + 1)
    const weight = position - left
    output[index] = (input[left] ?? 0) * (1 - weight) + (input[right] ?? 0) * weight
  }
  return output
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
