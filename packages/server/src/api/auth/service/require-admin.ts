/**
 * Platform admin gate — one dialect for control-plane routes.
 * Personal routes use personal.read / personal.write instead.
 */

import type { FastifyReply, FastifyRequest } from "fastify"

export async function requireAdmin(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (!req.session?.isAdmin) {
    reply.code(403)
    return reply.send({ error: "admin only" })
  }
}

/** Route option bundle — declare Platform admin at registration. */
export const admin = {
  preHandler: requireAdmin,
} as const
