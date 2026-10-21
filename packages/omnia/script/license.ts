#!/usr/bin/env bun
// Issues offline licenses for self-hosted Omnia Enterprise deployments.
//
// The server verifies `omnia_lic_<payload>.<signature>` against an Ed25519
// public key and never phones home, so this script is the vendor side: it holds
// the private key, signs the claims, and writes the token an operator installs.
// The public key is the only half a deployment needs.

import { createPrivateKey, generateKeyPairSync, randomUUID, sign } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { verifyLicense } from "../src/enterprise/license"
import type { LicenseClaims } from "../src/enterprise/types"

const HELP = `omnia license issuer

Usage:
  bun script/license.ts keys [--keys <dir>] [--force]
  bun script/license.ts issue --org <name> [options]
  bun script/license.ts inspect <file> [--keys <dir>]

Commands:
  keys       Create the Ed25519 signing pair (default ~/.omnia-license)
  issue      Sign a license token and write it to a file
  inspect    Verify a license with the local public key

Options:
  --org <name>        Organization name on the license (required for issue)
  --plan <plan>       business or enterprise (default enterprise)
  --seats <n>         Seats the license allows (default 25)
  --days <n>          Days until expiry (default 365)
  --id <id>           License id (default a random one)
  --features <list>   Comma-separated feature names
  --keys <dir>        Signing key directory (default ${join(homedir(), ".omnia-license")})
  --out <file>        Where to write the token (default ./omnia.license)
  --force             Replace an existing key pair (keys only)
`

interface Parsed {
  command: string
  positional: string[]
  flags: Map<string, string | boolean>
}

export function keyFiles(dir: string) {
  const at = resolve(dir)
  return { at, privateKey: join(at, "private.pem"), publicKey: join(at, "public.pem") }
}

export function createKeys(dir: string, force: boolean) {
  const files = keyFiles(dir)
  if (existsSync(files.privateKey) && existsSync(files.publicKey) && !force) {
    return { created: false, ...files }
  }
  mkdirSync(files.at, { recursive: true, mode: 0o700 })
  const pair = generateKeyPairSync("ed25519")
  writeFileSync(files.privateKey, pair.privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 })
  chmodSync(files.privateKey, 0o600)
  writeFileSync(files.publicKey, pair.publicKey.export({ format: "pem", type: "spki" }), { mode: 0o644 })
  return { created: true, ...files }
}

export function signLicense(input: {
  org: string
  plan: "business" | "enterprise"
  seats: number
  days: number
  id?: string
  features?: string[]
  now?: number
  privateKeyPem: string
}) {
  const issuedAt = input.now ?? Date.now()
  const claims: LicenseClaims = {
    version: 1,
    id: input.id ?? `lic_${randomUUID()}`,
    org: input.org,
    plan: input.plan,
    seats: input.seats,
    issuedAt,
    expiresAt: issuedAt + input.days * 24 * 60 * 60 * 1000,
    ...(input.features === undefined || input.features.length === 0 ? {} : { features: input.features }),
  }
  // The payload is signed exactly as transmitted: raw JSON bytes.
  const payload = Buffer.from(JSON.stringify(claims))
  const signature = sign(null, payload, createPrivateKey(input.privateKeyPem))
  return { token: `omnia_lic_${payload.toString("base64url")}.${signature.toString("base64url")}`, claims }
}

function parse(argv: string[]): Parsed {
  const positional: string[] = []
  const flags = new Map<string, string | boolean>()
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!
    if (arg === "-h" || arg === "--help") {
      flags.set("help", true)
      continue
    }
    if (!arg.startsWith("--")) {
      positional.push(arg)
      continue
    }
    const body = arg.slice(2)
    const equals = body.indexOf("=")
    if (equals > 0) {
      flags.set(body.slice(0, equals), body.slice(equals + 1))
      continue
    }
    const next = argv[index + 1]
    if (next !== undefined && !next.startsWith("--")) {
      flags.set(body, next)
      index += 1
      continue
    }
    flags.set(body, true)
  }
  return { command: positional.shift() ?? "help", positional, flags }
}

function flag(parsed: Parsed, name: string): string | undefined {
  const value = parsed.flags.get(name)
  return typeof value === "string" ? value : undefined
}

function bool(parsed: Parsed, name: string): boolean {
  return parsed.flags.get(name) === true
}

function integer(name: string, raw: string | undefined, fallback: number, { min = 1, max }: { min?: number; max?: number } = {}) {
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < min || (max !== undefined && value > max)) return undefined
  return value
}

function keysCommand(parsed: Parsed): number {
  const files = createKeys(flag(parsed, "keys") ?? join(homedir(), ".omnia-license"), bool(parsed, "force"))
  if (files.created) console.log(`Created the signing pair in ${files.at}`)
  else console.log(`Using the existing signing pair in ${files.at}`)
  console.log(`  Private key  ${files.privateKey} (0600, never share)`)
  console.log(`  Public key   ${files.publicKey}`)
  return 0
}

function issueCommand(parsed: Parsed): number {
  const org = flag(parsed, "org")
  if (org === undefined || org.trim().length === 0) {
    console.error("--org is required.")
    return 1
  }
  const planFlag = flag(parsed, "plan") ?? "enterprise"
  if (planFlag !== "business" && planFlag !== "enterprise") {
    console.error("--plan must be business or enterprise.")
    return 1
  }
  const seats = integer("seats", flag(parsed, "seats"), 25, { min: 1 })
  const days = integer("days", flag(parsed, "days"), 365, { min: 1, max: 3650 })
  if (seats === undefined) {
    console.error("--seats must be a positive integer.")
    return 1
  }
  if (days === undefined) {
    console.error("--days must be an integer between 1 and 3650.")
    return 1
  }
  const files = keyFiles(flag(parsed, "keys") ?? join(homedir(), ".omnia-license"))
  if (!existsSync(files.privateKey) || !existsSync(files.publicKey)) {
    console.error(`No signing pair in ${files.at}. Run \`bun script/license.ts keys\` first.`)
    return 1
  }
  const features = flag(parsed, "features")
    ?.split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
  const signed = signLicense({
    org: org.trim(),
    plan: planFlag,
    seats,
    days,
    ...(flag(parsed, "id") === undefined ? {} : { id: flag(parsed, "id")! }),
    ...(features === undefined || features.length === 0 ? {} : { features }),
    privateKeyPem: readFileSync(files.privateKey, "utf8"),
  })
  // Sign, then prove the token verifies with the matching public key before it
  // can be handed to a deployment.
  const verified = verifyLicense(signed.token, readFileSync(files.publicKey, "utf8"), Date.now())
  if (!verified.valid) {
    console.error(`The signed license did not verify: ${verified.error}`)
    return 1
  }
  const out = resolve(flag(parsed, "out") ?? "omnia.license")
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, `${signed.token}\n`, { mode: 0o600 })
  chmodSync(out, 0o600)
  console.log(`Wrote ${out} (0600)`)
  console.log(`  License  ${signed.claims.id}`)
  console.log(`  Org      ${signed.claims.org}`)
  console.log(`  Plan     ${signed.claims.plan}`)
  console.log(`  Seats    ${signed.claims.seats}`)
  console.log(`  Expires  ${new Date(signed.claims.expiresAt).toISOString()}`)
  if (signed.claims.features !== undefined) console.log(`  Features ${signed.claims.features.join(", ")}`)
  console.log(`\nActivate it on the deployment:`)
  console.log(`  omnia-server license activate ${out}`)
  return 0
}

function inspectCommand(parsed: Parsed): number {
  const path = parsed.positional[0]
  if (path === undefined) {
    console.error("Usage: bun script/license.ts inspect <file>")
    return 1
  }
  const files = keyFiles(flag(parsed, "keys") ?? join(homedir(), ".omnia-license"))
  if (!existsSync(files.publicKey)) {
    console.error(`No public key at ${files.publicKey}.`)
    return 1
  }
  const result = verifyLicense(readFileSync(path, "utf8").trim(), readFileSync(files.publicKey, "utf8"), Date.now())
  if (!result.valid) {
    console.error(`License does not verify: ${result.error}`)
    return 1
  }
  console.log(`License  ${result.claims!.id}`)
  console.log(`Org      ${result.claims!.org}`)
  console.log(`Plan     ${result.claims!.plan}`)
  console.log(`Seats    ${result.claims!.seats}`)
  console.log(`Expires  ${new Date(result.claims!.expiresAt).toISOString()}`)
  return 0
}

function main(): number {
  const parsed = parse(Bun.argv.slice(2))
  if (bool(parsed, "help") || parsed.command === "help") {
    console.log(HELP)
    return 0
  }
  if (parsed.command === "keys") return keysCommand(parsed)
  if (parsed.command === "issue") return issueCommand(parsed)
  if (parsed.command === "inspect") return inspectCommand(parsed)
  console.error(`Unknown command: ${parsed.command}\n`)
  console.log(HELP)
  return 1
}

if (import.meta.main) process.exit(main())
