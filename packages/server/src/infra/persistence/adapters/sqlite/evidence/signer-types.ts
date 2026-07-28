export const SignerKind = {
  Hmac: "hmac",
  FileRsa: "file-rsa",
  Kms: "kms"
} as const
export type SignerKind = (typeof SignerKind)[keyof typeof SignerKind]

export interface Signer {
  readonly id: string
  readonly alg: string
  sign(bytes: Uint8Array): Promise<string>
  verify(bytes: Uint8Array, sig: string): Promise<boolean>
}
