/**
 * driver-bytes.ts — helpers so adapters accept legacy mocks that only
 * implement readText/putText, while production drivers expose binary APIs.
 */

export async function readDriverBytes(
  driver: {
    readBytes?: (path: string) => Promise<Uint8Array>
    readText: (path: string) => Promise<string>
  },
  path: string,
): Promise<Uint8Array> {
  if (typeof driver.readBytes === "function") return driver.readBytes(path)
  return new TextEncoder().encode(await driver.readText(path))
}

export async function putDriverBytes(
  driver: {
    putBytes?: (path: string, mode: "append" | "replace", body: Uint8Array) => Promise<void>
    putText: (path: string, mode: "append" | "replace", body: ReadableStream<Uint8Array>) => Promise<void>
  },
  path: string,
  mode: "append" | "replace",
  body: Uint8Array,
): Promise<void> {
  if (typeof driver.putBytes === "function") {
    await driver.putBytes(path, mode, body)
    return
  }
  await driver.putText(path, mode, ReadableStream.from([body]))
}
