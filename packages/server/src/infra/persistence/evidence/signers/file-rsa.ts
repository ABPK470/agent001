/**
 * F1.8 — File-RSA signer (on-prem; PEM-encoded keypair).
 *
 * Signs with RSASSA-PKCS1-v1_5-SHA256. The private key is read once at
 * boot from disk and held in memory; the public key is published as a
 * sibling file so verifier consumers can validate without the secret.
 *
 * Operators rotate by:
 *   1. issuing a new keypair into a versioned subfolder
 *   2. bumping `EVIDENCE_SIGNER_ID` (e.g. "rsa-2026q1")
 *   3. restarting the server.
 * Old envelopes verify against their historical public key (the verifier
 * resolves the file by `signature.signerId`).
 */

import { createPrivateKey, createPublicKey, createSign, createVerify } from "node:crypto"
import { readFileSync } from "node:fs"
import { Signer } from "../signer-types.js"

export interface FileRsaSignerOptions {
  id: string
  privateKeyPath: string
  publicKeyPath: string
}

export function buildFileRsaSigner(o: FileRsaSignerOptions): Signer {
  const privatePem = readFileSync(o.privateKeyPath, "utf-8")
  const publicPem = readFileSync(o.publicKeyPath, "utf-8")
  const privateKey = createPrivateKey(privatePem)
  const publicKey = createPublicKey(publicPem)

  return {
    id: o.id,
    alg: "RSASSA-PKCS1-v1_5-SHA256",
    async sign(bytes) {
      const signer = createSign("RSA-SHA256")
      signer.update(bytes)
      signer.end()
      return signer.sign(privateKey).toString("base64url")
    },
    async verify(bytes, sig) {
      try {
        const verifier = createVerify("RSA-SHA256")
        verifier.update(bytes)
        verifier.end()
        return verifier.verify(publicKey, Buffer.from(sig, "base64url"))
      } catch {
        return false
      }
    }
  }
}
