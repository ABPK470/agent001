/**
 * F1.8 — HMAC-SHA256 signer (dev / single-instance on-prem).
 *
 * Suitable when only one server instance verifies; the secret never
 * leaves the host. NOT suitable when third-parties need to verify
 * without sharing the secret — use `file-rsa` or `kms` for those.
 */

import { hmacSha256Hex } from "@mia/sync"
import { Signer } from "../signer.js"

export interface HmacSignerOptions {
  id:     string
  secret: string
}

export function buildHmacSigner(o: HmacSignerOptions): Signer {
  if (o.secret.length < 32) {
    throw new Error("HMAC signer secret must be ≥ 32 chars (EVIDENCE_HMAC_SECRET)")
  }
  return {
    id:  o.id,
    alg: "HMAC-SHA256",
    async sign(bytes) {
      return Buffer.from(hmacSha256Hex(o.secret, bytes), "hex").toString("base64url")
    },
    async verify(bytes, sig) {
      try {
        const expected = Buffer.from(hmacSha256Hex(o.secret, bytes), "hex").toString("base64url")
        return constantTimeEqualString(expected, sig)
      } catch { return false }
    },
  }
}

function constantTimeEqualString(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let r = 0
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return r === 0
}
