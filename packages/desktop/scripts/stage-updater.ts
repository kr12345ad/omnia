#!/usr/bin/env bun
// Stage an electron-updater feed atomically. The manifest is published last so
// no client can receive a checksum for an artifact that is not ready to fetch.
import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { copyFile, mkdir, rename, stat } from "node:fs/promises"
import { basename, join } from "node:path"

const [source, target, manifestName = "latest-linux.yml"] = Bun.argv.slice(2)
if (!source || !target) throw new Error("Usage: stage-updater.ts <electron-builder-dist> <feed-dir> [manifest]")
if (manifestName !== basename(manifestName)) throw new Error("Manifest must be a filename")

type Artifact = { name: string; sha512: string; size: number }

function artifacts(manifest: string) {
  const output: Artifact[] = []
  let current: Partial<Artifact> | undefined
  const flush = () => {
    if (!current) return
    if (!current.name || !current.sha512 || current.size === undefined) throw new Error("Invalid electron-updater manifest")
    if (current.name !== basename(current.name) || current.name === "." || current.name === "..")
      throw new Error(`Manifest artifact must be a local filename: ${current.name}`)
    output.push(current as Artifact)
    current = undefined
  }

  for (const line of manifest.split(/\r?\n/)) {
    const trim = line.trim()
    if (trim.startsWith("- url:")) {
      flush()
      current = { name: trim.slice("- url:".length).trim() }
      continue
    }
    if (!current || !line.startsWith("    ")) continue
    if (trim.startsWith("sha512:")) current.sha512 = trim.slice("sha512:".length).trim()
    if (trim.startsWith("size:")) current.size = Number(trim.slice("size:".length).trim())
  }
  flush()
  if (!output.length) throw new Error("Manifest does not list any artifacts")
  return output
}

async function sha512(path: string) {
  const hash = createHash("sha512")
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path)
    stream.on("data", (chunk) => hash.update(chunk))
    stream.on("end", resolve)
    stream.on("error", reject)
  })
  return hash.digest("base64")
}

async function stage(from: string, to: string) {
  const temporary = `${to}.${process.pid}.tmp`
  await copyFile(from, temporary)
  await rename(temporary, to)
}

const manifest = await Bun.file(join(source, manifestName)).text()
const files = artifacts(manifest)
await mkdir(target, { recursive: true })

for (const artifact of files) {
  const path = join(source, artifact.name)
  const info = await stat(path)
  if (info.size !== artifact.size) throw new Error(`Size mismatch for ${artifact.name}`)
  if ((await sha512(path)) !== artifact.sha512) throw new Error(`SHA-512 mismatch for ${artifact.name}`)
  await stage(path, join(target, artifact.name))
}

await stage(join(source, manifestName), join(target, manifestName))
console.log(`staged ${files.length} artifact(s) and ${manifestName}`)
