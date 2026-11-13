import { createSignal, onCleanup } from "solid-js"

type SttStatus = { ok: boolean; ready: boolean; loading?: boolean; model: string; message?: string }
type SttResult = { ok: true; text: string; model: string } | { ok: false; message: string; model: string }
type SttApi = {
  status(): Promise<SttStatus>
  load(): Promise<SttStatus>
  transcribe(wav: ArrayBuffer): Promise<SttResult>
  onProgress(cb: (progress: unknown) => void): () => void
}

type VoiceState = "idle" | "recording" | "transcribing"

function sttApi(): SttApi | undefined {
  const api = (window as unknown as { api?: { stt?: SttApi } }).api
  return api?.stt
}

export function createVoiceInput(options: { onText: (text: string) => void; onError: (message: string) => void }) {
  const api = sttApi()
  const [state, setState] = createSignal<VoiceState>("idle")
  const [modelLoading, setModelLoading] = createSignal(false)
  let recorder: MediaRecorder | undefined
  let stream: MediaStream | undefined
  let chunks: Blob[] = []
  let stopProgress: (() => void) | undefined

  async function prime() {
    if (!api) return
    stopProgress ??= api.onProgress((progress) => {
      const value = progress as { status?: string }
      setModelLoading(value.status !== "ready" && value.status !== "error")
    })
    const status = await api.status().catch(() => undefined)
    setModelLoading(Boolean(status?.loading))
  }

  async function start() {
    if (!api) return
    try {
      await prime()
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      })
      chunks = []
      const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg"].find((type) => MediaRecorder.isTypeSupported(type))
      recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined)
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data)
      }
      recorder.start(250)
      setState("recording")
    } catch (error) {
      setState("idle")
      options.onError(error instanceof Error ? error.message : "Microphone access failed.")
    }
  }

  async function stop() {
    const active = recorder
    if (!active) return
    setState("transcribing")
    const done = new Promise<Blob>((resolve) => {
      active.onstop = () => resolve(new Blob(chunks, { type: active.mimeType || "audio/webm" }))
    })
    if (active.state !== "inactive") active.stop()
    stream?.getTracks().forEach((track) => track.stop())
    stream = undefined
    recorder = undefined
    try {
      const blob = await done
      const wav = await toWav(blob)
      const result = await api!.transcribe(wav.buffer as ArrayBuffer)
      if (result.ok && result.text.trim()) options.onText(result.text.trim())
      else if (!result.ok) options.onError(result.message)
    } catch (error) {
      options.onError(error instanceof Error ? error.message : "Could not transcribe the recording.")
    } finally {
      setState("idle")
      setModelLoading(false)
    }
  }

  function toggle() {
    if (!api) return
    if (state() === "recording") void stop()
    else if (state() === "idle") void start()
  }

  onCleanup(() => {
    stream?.getTracks().forEach((track) => track.stop())
    stopProgress?.()
  })

  return {
    available: Boolean(api),
    state,
    modelLoading,
    toggle,
  }
}

async function toWav(blob: Blob): Promise<Uint8Array> {
  const context = new AudioContext()
  let decoded: AudioBuffer
  try {
    decoded = await context.decodeAudioData(await blob.arrayBuffer())
  } finally {
    await context.close().catch(() => {})
  }
  const rate = 16_000
  const frames = Math.max(1, Math.ceil(decoded.duration * rate))
  const offline = new OfflineAudioContext(1, frames, rate)
  const source = offline.createBufferSource()
  source.buffer = decoded
  source.connect(offline.destination)
  source.start()
  const rendered = await offline.startRendering()
  const samples = rendered.getChannelData(0)
  const buffer = new ArrayBuffer(44 + samples.length * 2)
  const view = new DataView(buffer)
  const write = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index += 1) view.setUint8(offset + index, text.charCodeAt(index))
  }
  write(0, "RIFF")
  view.setUint32(4, 36 + samples.length * 2, true)
  write(8, "WAVE")
  write(12, "fmt ")
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, rate, true)
  view.setUint32(28, rate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  write(36, "data")
  view.setUint32(40, samples.length * 2, true)
  let offset = 44
  for (let index = 0; index < samples.length; index += 1) {
    const value = Math.max(-1, Math.min(1, samples[index] ?? 0))
    view.setInt16(offset, value < 0 ? value * 0x8000 : value * 0x7fff, true)
    offset += 2
  }
  return new Uint8Array(buffer)
}
