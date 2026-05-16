#!/usr/bin/env node
/**
 * Offline evidence verifier (F1.8).
 *
 * Usage:
 *   node scripts/verify-evidence.mjs <envelope.json> [--secret <hmac-secret>]
 *                                                   [--public-key <pem>]
 *
 * The script chooses a signer matching the envelope's `signature.alg`:
 *   - HMAC-SHA256              → requires --secret (or EVIDENCE_HMAC_SECRET)
 *   - RSASSA-PKCS1-v1_5-SHA256 → requires --public-key (or EVIDENCE_RSA_PUBLIC_PATH)
 *   - KMS/*                    → not supported offline (use the server route)
 *
 * Exit codes mirror VerificationCode:
 *    0 — verified
 *   10 — hash chain mismatch
 *   20 — signature did not verify
 *   30 — JSON parse / structural failure
 *   40 — IO / configuration failure (signer unavailable, file missing)
 */

import { createHash, createHmac, createPublicKey, createVerify } from "node:crypto"
import { readFile } from "node:fs/promises"

const VerificationCode = { Ok: 0, HashChain: 10, Signature: 20, Parse: 30, Io: 40 }

const SECTIONS = ["envelope","proposal","annotation","plan","approval","execution","verification","audit"]

function canonicalJsonStringify(v) {
  if (v === null) return "null"
  if (typeof v === "boolean") return v ? "true" : "false"
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error("non-finite number")
    return JSON.stringify(v)
  }
  if (typeof v === "string") return JSON.stringify(v)
  if (typeof v === "bigint") return JSON.stringify(v.toString())
  if (Array.isArray(v))      return "[" + v.map(canonicalJsonStringify).join(",") + "]"
  if (typeof v === "object") {
    const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort()
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalJsonStringify(v[k])).join(",") + "}"
  }
  throw new Error(`unsupported value: ${typeof v}`)
}

function envelopeBodyBytes(env) {
  const body = { ...env }
  delete body.signature
  return Buffer.from(canonicalJsonStringify(body), "utf-8")
}

function recomputeChain(env) {
  const failed = []
  for (let i = 0; i < SECTIONS.length; i++) {
    const s = SECTIONS[i]
    const expected = env.hashChain?.[i]
    const actual = "sha256:" + createHash("sha256").update(canonicalJsonStringify(env[s])).digest("hex")
    if (expected !== actual) failed.push(s)
  }
  return failed
}

function constantTimeEqualString(a, b) {
  if (a.length !== b.length) return false
  let r = 0
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return r === 0
}

function verifyHmac(bytes, sig, secret) {
  try {
    const expected = Buffer.from(createHmac("sha256", secret).update(bytes).digest("hex"), "hex").toString("base64url")
    return constantTimeEqualString(expected, sig)
  } catch { return false }
}

function verifyRsa(bytes, sig, publicPem) {
  try {
    const key = createPublicKey(publicPem)
    const v = createVerify("RSA-SHA256")
    v.update(bytes); v.end()
    return v.verify(key, Buffer.from(sig, "base64url"))
  } catch { return false }
}

function parseArgs(argv) {
  const out = { path: null, secret: null, publicKeyPath: null, json: false }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--secret")      out.secret        = argv[++i] ?? null
    else if (a === "--public-key") out.publicKeyPath = argv[++i] ?? null
    else if (a === "--json")   out.json = true
    else if (!a.startsWith("--") && !out.path) out.path = a
  }
  return out
}

async function main() {
  const args = parseArgs(process.argv)
  if (!args.path) {
    console.error("usage: verify-evidence.mjs <envelope.json> [--secret <hmac>] [--public-key <pem>] [--json]")
    process.exit(VerificationCode.Io)
  }
  let raw
  try { raw = await readFile(args.path, "utf-8") }
  catch (e) {
    fail(args.json, VerificationCode.Io, `read failed: ${e.message}`)
  }
  let env
  try { env = JSON.parse(raw) }
  catch (e) { fail(args.json, VerificationCode.Parse, `JSON parse: ${e.message}`) }

  const sig = env.signature
  if (!sig) fail(args.json, VerificationCode.Parse, "envelope is unsigned")

  const chain = recomputeChain(env)
  if (chain.length > 0) {
    fail(args.json, VerificationCode.HashChain, `hash chain mismatch: ${chain.join(", ")}`, { failed: chain })
  }

  const bytes = envelopeBodyBytes(env)
  let valid = false
  if (sig.alg === "HMAC-SHA256") {
    const secret = args.secret ?? process.env.EVIDENCE_HMAC_SECRET
    if (!secret) fail(args.json, VerificationCode.Io, "HMAC-SHA256 envelope requires --secret or EVIDENCE_HMAC_SECRET")
    valid = verifyHmac(bytes, sig.value, secret)
  } else if (sig.alg === "RSASSA-PKCS1-v1_5-SHA256") {
    const pubPath = args.publicKeyPath ?? process.env.EVIDENCE_RSA_PUBLIC_PATH
    if (!pubPath) fail(args.json, VerificationCode.Io, "RSA envelope requires --public-key or EVIDENCE_RSA_PUBLIC_PATH")
    let pem
    try { pem = await readFile(pubPath, "utf-8") }
    catch (e) { fail(args.json, VerificationCode.Io, `cannot read public key: ${e.message}`) }
    valid = verifyRsa(bytes, sig.value, pem)
  } else if (sig.alg.startsWith("KMS/")) {
    fail(args.json, VerificationCode.Io, `${sig.alg} envelopes must be verified via the server route, not offline`)
  } else {
    fail(args.json, VerificationCode.Io, `unsupported signature alg: ${sig.alg}`)
  }
  if (!valid) fail(args.json, VerificationCode.Signature, "signature did not verify")
  ok(args.json, sig)
}

function ok(json, sig) {
  if (json) console.log(JSON.stringify({ ok: true, code: 0, signerId: sig.signerId, alg: sig.alg, contentHash: sig.contentHash }))
  else      console.log(`OK — verified (signer=${sig.signerId} alg=${sig.alg})`)
  process.exit(VerificationCode.Ok)
}

function fail(json, code, message, extra = {}) {
  if (json) console.log(JSON.stringify({ ok: false, code, message, ...extra }))
  else      console.error(`FAIL [code=${code}] ${message}`)
  process.exit(code)
}

main().catch((e) => fail(false, VerificationCode.Io, e?.message ?? String(e)))
