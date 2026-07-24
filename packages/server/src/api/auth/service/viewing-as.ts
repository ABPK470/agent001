/**
 * Viewing as — shell-owned Personal scope.
 *
 * Composition root for “whose Personal data may this request see?”.
 * Personal routes declare `personal.read` / `personal.write` preHandlers.
 * Handlers consume `viewingAsOf(req)` — they never resolve the header.
 * Platform routes never register these preHandlers and never read Viewing as.
 *
 * Transport: X-Viewing-As on fetch; ?viewingAs= for EventSource (no custom headers).
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import { findUserByUpn } from "../../../infra/persistence/db/users.js"
import type { CurrentSession } from "../../../ports/session.js"

export const VIEWING_AS_HEADER = "x-viewing-as"

export type ViewingAs = {
  /** Personal data owner for this request. */
  viewingAsUpn: string
  /** True when viewingAsUpn === session.upn. */
  isMe: boolean
  session: CurrentSession
}

export class ViewingAsError extends Error {
  readonly statusCode: 401 | 403
  constructor(statusCode: 401 | 403, message: string) {
    super(message)
    this.name = "ViewingAsError"
    this.statusCode = statusCode
  }
}

declare module "fastify" {
  interface FastifyRequest {
    /**
     * Set only by personal.read / personal.write preHandlers.
     * Platform routes leave this undefined — do not read it there.
     */
    viewingAs: ViewingAs | undefined
  }
}

function sameUpn(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}

function headerViewingAs(req: FastifyRequest): string | undefined {
  const raw = req.headers[VIEWING_AS_HEADER]
  const value = Array.isArray(raw) ? raw[0] : raw
  const trimmed = typeof value === "string" ? value.trim() : ""
  return trimmed || undefined
}

function queryViewingAs(req: FastifyRequest): string | undefined {
  const q = req.query as Record<string, unknown> | undefined
  const raw = q?.["viewingAs"]
  const trimmed = typeof raw === "string" ? raw.trim() : ""
  return trimmed || undefined
}

/**
 * Pure resolve — owned by this module and its tests.
 * Routes declare `personal.read` / `personal.write`; handlers use `viewingAsOf`.
 */
export function resolveViewingAs(req: FastifyRequest): ViewingAs {
  const session = req.session
  if (!session?.upn?.trim()) {
    throw new ViewingAsError(401, "Authentication required")
  }

  const requested = headerViewingAs(req) ?? queryViewingAs(req)
  if (!requested || sameUpn(requested, session.upn)) {
    return { viewingAsUpn: session.upn, isMe: true, session }
  }

  if (!session.isAdmin) {
    throw new ViewingAsError(403, "Viewing as another user requires admin")
  }

  const target = findUserByUpn(requested)
  if (!target) {
    throw new ViewingAsError(403, "Viewing as: user not found")
  }

  return {
    viewingAsUpn: target.upn,
    isMe: sameUpn(target.upn, session.upn),
    session,
  }
}

/** Owner UPN must match Viewing as (Personal read). */
export function canAccessOwned(
  viewingAs: ViewingAs,
  ownerUpn: string | null | undefined,
): boolean {
  const owner = ownerUpn?.trim()
  if (!owner) return false
  return sameUpn(owner, viewingAs.viewingAsUpn)
}

export function canMutatePersonal(viewingAs: ViewingAs): boolean {
  return viewingAs.isMe
}

export function requirePersonalWrite(viewingAs: ViewingAs): void {
  if (!viewingAs.isMe) {
    throw new ViewingAsError(403, "Viewing as another user is read-only for Personal data")
  }
}

/** Handler accessor — Personal preHandler must have run. */
export function viewingAsOf(req: FastifyRequest): ViewingAs {
  const viewingAs = req.viewingAs
  if (!viewingAs) {
    throw new Error("Personal route missing personal.read / personal.write preHandler")
  }
  return viewingAs
}

/** Personal GET / list / stream — resolve Viewing as onto the request. */
export async function personalRead(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  req.viewingAs = resolveViewingAs(req)
}

/** Personal POST / PATCH / DELETE — resolve Viewing as and require Me. */
export async function personalWrite(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  req.viewingAs = resolveViewingAs(req)
  requirePersonalWrite(req.viewingAs)
}

/** Route option bundles — declare Personal class at registration. */
export const personal = {
  read: { preHandler: personalRead },
  write: { preHandler: personalWrite },
} as const

/** Decorate request; call once from HTTP composition root after identity. */
export function registerViewingAs(app: FastifyInstance): void {
  app.decorateRequest("viewingAs", undefined)
}
