#!/usr/bin/env bun
import { createHash, randomUUID } from "node:crypto"
import { parse, type ParseError } from "jsonc-parser"
import { fileURLToPath } from "node:url"

// Source dependency inventory, not a claim about which packages are reachable
// in a particular platform artifact. Preserve the lock key for every version.
const root = fileURLToPath(new URL("../../../", import.meta.url))
const source = await Bun.file(`${root}bun.lock`).text()
const errors: ParseError[] = []
const lock = parse(source, errors, { allowTrailingComma: true }) as { packages?: Record<string, unknown> }
if (errors.length || !lock.packages) throw new Error("Cannot generate an inventory from an invalid Bun lockfile.")
const components = Object.entries(lock.packages).map(([key, entry]) => {
  if (!Array.isArray(entry) || typeof entry[0] !== "string") throw new Error(`Invalid package entry: ${key}`)
  const match = /^(@[^/]+\/[^@]+|[^@]+)@(.+)$/.exec(entry[0])
  if (!match) throw new Error(`Cannot identify locked package: ${key}`)
  const integrity = entry.find((value): value is string => typeof value === "string" && /^sha512-/.test(value))
  return {
    type: "library",
    "bom-ref": `bun:${key}`,
    name: match[1],
    version: match[2],
    ...(integrity === undefined ? {} : { hashes: [{ alg: "SHA-512", content: Buffer.from(integrity.slice(7), "base64").toString("hex") }] }),
  }
})
const output = Bun.argv[2]
if (!output) throw new Error("Usage: security-sbom.ts <output.cdx.json>")
await Bun.write(output, JSON.stringify({
  bomFormat: "CycloneDX",
  specVersion: "1.6",
  serialNumber: `urn:uuid:${randomUUID()}`,
  version: 1,
  metadata: {
    timestamp: new Date().toISOString(),
    properties: [
      { name: "omnia:inventory-scope", value: "repository lockfile; includes build and optional dependencies" },
      { name: "omnia:lockfile-sha256", value: createHash("sha256").update(source).digest("hex") },
    ],
  },
  components,
}, null, 2))
console.log(`Generated ${components.length} locked components in ${output}`)
