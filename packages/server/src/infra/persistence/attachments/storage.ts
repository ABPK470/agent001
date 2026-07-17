/**
 * Attachment storage — durable bytes for user uploads.
 *
 * Bytes live under the data directory in a content-addressed layout
 * (`<root>/attachments/<aa>/<bb>/<sha256>`). Two attachments with identical
 * content share a single on-disk blob; the `attachments` table holds the
 * per-upload metadata. Sandbox imports always copy bytes out; the durable
 * blob is never opened for writing by tools.
 *
 * Path resolution honours the same env override as the SQLite database
 * (`MIA_DATA_DIR`), so a deployment can move data, attachments, and the
 * DB together with one variable.
 */

import { createHash } from "node:crypto"
import { mkdir, readFile, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { resolveServerDataDir } from "../server-data-dir.js"

export function getAttachmentRoot(): string {
  return join(resolveServerDataDir(), "attachments")
}

/** Compute the SHA-256 of the given bytes as a lowercase hex string. */
export function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

/**
 * Storage URI is the relative path under the attachment root. We store the
 * relative form so the absolute root can move with the data directory.
 */
export function storageUriFromHash(hash: string): string {
  return join("blobs", hash.slice(0, 2), hash.slice(2, 4), hash)
}

export function resolveStorageUri(uri: string): string {
  return join(getAttachmentRoot(), uri)
}

/**
 * Persist bytes content-addressed. Idempotent: returns the existing blob
 * path when the same content already exists.
 */
export async function writeAttachmentBlob(
  bytes: Uint8Array
): Promise<{ hash: string; storageUri: string; sizeBytes: number }> {
  const hash = hashBytes(bytes)
  const storageUri = storageUriFromHash(hash)
  const abs = resolveStorageUri(storageUri)
  await mkdir(join(abs, ".."), { recursive: true })
  try {
    const info = await stat(abs)
    return { hash, storageUri, sizeBytes: info.size }
  } catch {
    await writeFile(abs, bytes)
    return { hash, storageUri, sizeBytes: bytes.byteLength }
  }
}

export async function readAttachmentBlob(storageUri: string): Promise<Buffer> {
  return readFile(resolveStorageUri(storageUri))
}
