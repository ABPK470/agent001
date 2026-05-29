/**
 * F1.8 — Cloud KMS signer (adapter facade).
 *
 * This is a *facade* with a clear contract — the cloud-specific call is
 * delegated to an `adapter` indirection so we can swap AWS-KMS,
 * Azure-Key-Vault, GCP-KMS, or HashiCorp-Vault by replacing one file
 * (or wiring in a custom adapter from main).
 *
 * The bundled "noop" adapter throws on `sign()` with a clear
 * configuration message — operators must register a real adapter before
 * choosing `EVIDENCE_SIGNER_KIND=kms`. Tests and dev environments
 * should default to `hmac`.
 */

import { Signer } from "../signer.js"

export interface KmsAdapter {
  readonly providerId: string
  readonly alg:        string
  sign(bytes: Buffer):   Promise<string>
  verify(bytes: Buffer, sig: string): Promise<boolean>
}

let registeredAdapter: KmsAdapter | null = null

/**
 * Register a cloud KMS adapter. Call this from server bootstrap if
 * `EVIDENCE_SIGNER_KIND=kms` is configured.
 */
export function registerKmsAdapter(adapter: KmsAdapter): void {
  registeredAdapter = adapter
}

export interface KmsSignerOptions {
  id:  string
  env: NodeJS.ProcessEnv
}

export function buildKmsSigner(o: KmsSignerOptions): Signer {
  if (!registeredAdapter) {
    // Eager-failing surrogate. We return a Signer whose sign/verify
    // throws a structured error so the route handler can render a
    // clear "configure KMS adapter" 500.
    return {
      id:  o.id,
      alg: "kms/unconfigured",
      async sign() {
        throw new Error(
          "EVIDENCE_SIGNER_KIND=kms requires registerKmsAdapter(...) to be called " +
          "during server bootstrap. No adapter is currently registered.",
        )
      },
      async verify() { return false },
    }
  }
  const adapter = registeredAdapter
  return {
    id:  o.id,
    alg: `KMS/${adapter.providerId}/${adapter.alg}`,
    sign:   (bytes) => adapter.sign(bytes),
    verify: (bytes, sig) => adapter.verify(bytes, sig),
  }
}
