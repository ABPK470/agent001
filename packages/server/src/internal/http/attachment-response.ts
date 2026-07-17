import type { FastifyReply } from "fastify"

/** Stream a file to the user's browser — never persist for "export" intent on server. */
export function sendUserDownload(
  reply: FastifyReply,
  opts: { filename: string; contentType: string; body: string | Buffer },
): FastifyReply {
  const safeName = opts.filename.replace(/[^\w.\-()+ ]/g, "_")
  reply.header("content-type", opts.contentType)
  reply.header("content-disposition", `attachment; filename="${safeName}"`)
  if (typeof opts.body === "string") {
    reply.header("content-length", String(Buffer.byteLength(opts.body, "utf-8")))
  } else {
    reply.header("content-length", String(opts.body.byteLength))
  }
  return reply.send(opts.body)
}
