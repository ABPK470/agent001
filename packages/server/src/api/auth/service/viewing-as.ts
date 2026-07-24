/**
 * Viewing as — whose Personal data this request may see.
 *
 * Me = session.upn. Admins may send X-Viewing-As (or ?viewingAs= for EventSource)
 * to read another user’s Personal data. Platform routes ignore this helper.
 */

import type { FastifyRequest } from "fastify"
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
  readonly status: 401 | 403
  constructor(status: 401 | 403, message: string) {
    super(message)
    this.name = "ViewingAsError"
    this.status = status
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
 * Resolve Viewing as for a Personal request.
 * EventSource cannot set headers — `?viewingAs=` is accepted with the same rules.
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

/** Personal writes only when Viewing as Me. */
export function canMutatePersonal(viewingAs: ViewingAs): boolean {
  return viewingAs.isMe
}

export function requirePersonalWrite(viewingAs: ViewingAs): void {
  if (!viewingAs.isMe) {
    throw new ViewingAsError(403, "Viewing as another user is read-only for Personal data")
  }
}

export type ViewingAsResult =
  | { ok: true; viewingAs: ViewingAs }
  | { ok: false; status: 401 | 403; error: string }

export function tryResolveViewingAs(req: FastifyRequest): ViewingAsResult {
  try {
    return { ok: true, viewingAs: resolveViewingAs(req) }
  } catch (err) {
    if (err instanceof ViewingAsError) {
      return { ok: false, status: err.status, error: err.message }
    }
    throw err
  }
}
