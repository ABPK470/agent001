/**
 * Visible-browser handoff registry.
 *
 * When the agent encounters CAPTCHA or non-TOTP 2FA it can mint a
 * handoff token and present the noVNC URL to the user. The user
 * completes the human-only step in their browser; the agent waits for
 * `resume(handoffId)` (or polls `await(handoffId)`) before continuing.
 *
 * Storage is **in-process only** by design — handoff URLs are short-lived
 * (default 10 min) and shouldn't survive a server restart. Token bytes
 * are URL-safe base64 of 32 random bytes (256-bit, unguessable).
 *
 * Tenant boundary: every read enforces `ownerUpn`. Cross-tenant lookups
 * return null. Anonymous sessions cannot mint handoffs.
 *
 * @module
 */

import { randomBytes } from "node:crypto"

import { HumanHandoffReason } from "@mia/agent"

import { HandoffStatus } from "../enums/browser.js"

export interface HandoffRecord {
  id: string
  /** URL-safe token; opaque to callers. */
  token: string
  ownerUpn: string
  /** Browser session id from `browse_web` (so the host can wire the right xvfb display). */
  browserSessionId: string
  reason: HumanHandoffReason
  /** Path the UI hits to open the noVNC viewer (`/browser/handoff/<token>`). */
  url: string
  status: HandoffStatus
  createdAt: number
  expiresAt: number
  resolvedAt: number | null
}

const TTL_MS_DEFAULT = 10 * 60 * 1000
const records = new Map<string, HandoffRecord>()
const tokenIndex = new Map<string, string>() // token → id
const waiters = new Map<string, Array<(rec: HandoffRecord) => void>>()

function urlSafeB64(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function pruneExpired(now = Date.now()): void {
  for (const rec of records.values()) {
    if (rec.status === HandoffStatus.Pending && rec.expiresAt <= now) {
      rec.status = HandoffStatus.Expired
      rec.resolvedAt = now
      const ws = waiters.get(rec.id)
      if (ws) {
        for (const fn of ws) fn(rec)
        waiters.delete(rec.id)
      }
    }
  }
}

export function mintHandoff(input: {
  ownerUpn: string
  browserSessionId: string
  reason: HandoffRecord["reason"]
  ttlMs?: number
}): HandoffRecord {
  pruneExpired()
  const id = urlSafeB64(randomBytes(12))
  const token = urlSafeB64(randomBytes(32))
  const now = Date.now()
  const rec: HandoffRecord = {
    id,
    token,
    ownerUpn: input.ownerUpn,
    browserSessionId: input.browserSessionId,
    reason: input.reason,
    url: `/browser/handoff/${token}`,
    status: HandoffStatus.Pending,
    createdAt: now,
    expiresAt: now + (input.ttlMs ?? TTL_MS_DEFAULT),
    resolvedAt: null,
  }
  records.set(id, rec)
  tokenIndex.set(token, id)
  return rec
}

export function getHandoff(ownerUpn: string, id: string): HandoffRecord | null {
  pruneExpired()
  const rec = records.get(id)
  if (!rec || rec.ownerUpn !== ownerUpn) return null
  return rec
}

export function getHandoffByToken(token: string): HandoffRecord | null {
  pruneExpired()
  const id = tokenIndex.get(token)
  if (!id) return null
  return records.get(id) ?? null
}

export function listHandoffs(ownerUpn: string): HandoffRecord[] {
  pruneExpired()
  return Array.from(records.values()).filter((r) => r.ownerUpn === ownerUpn)
}

/** Mark the handoff as completed (called by UI when user clicks "I'm done"). */
export function completeHandoff(ownerUpn: string, id: string): boolean {
  const rec = records.get(id)
  if (!rec || rec.ownerUpn !== ownerUpn) return false
  if (rec.status !== HandoffStatus.Pending) return false
  rec.status = HandoffStatus.Completed
  rec.resolvedAt = Date.now()
  const ws = waiters.get(id)
  if (ws) {
    for (const fn of ws) fn(rec)
    waiters.delete(id)
  }
  return true
}

export function revokeHandoff(ownerUpn: string, id: string): boolean {
  const rec = records.get(id)
  if (!rec || rec.ownerUpn !== ownerUpn) return false
  if (rec.status !== HandoffStatus.Pending) return false
  rec.status = HandoffStatus.Revoked
  rec.resolvedAt = Date.now()
  const ws = waiters.get(id)
  if (ws) {
    for (const fn of ws) fn(rec)
    waiters.delete(id)
  }
  return true
}

/** Block until the handoff resolves (completed/expired/revoked). */
export function awaitHandoff(id: string): Promise<HandoffRecord> {
  pruneExpired()
  const rec = records.get(id)
  if (!rec) return Promise.reject(new Error(`handoff ${id} not found`))
  if (rec.status !== HandoffStatus.Pending) return Promise.resolve(rec)
  return new Promise<HandoffRecord>((resolve) => {
    const list = waiters.get(id) ?? []
    list.push(resolve)
    waiters.set(id, list)
  })
}

/** @internal — for tests only. */
export function _resetHandoffs(): void {
  records.clear()
  tokenIndex.clear()
  waiters.clear()
}
