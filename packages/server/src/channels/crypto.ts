/**
 * Shared HMAC-SHA256 signature validation for Meta webhook payloads.
 *
 * Both WhatsApp and Messenger sign webhook payloads the same way:
 * X-Hub-Signature-256: sha256=<hex-hmac-sha256>
 */

import { createHmac, timingSafeEqual } from "node:crypto"

export function validateHmacSignature(
  payload: Buffer,
  signature: string,
  secret: string,
): boolean {
  const expected = "sha256=" + createHmac("sha256", secret)
    .update(payload)
    .digest("hex")

  if (signature.length !== expected.length) return false
  return timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
}
