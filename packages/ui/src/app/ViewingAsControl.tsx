/**
 * Header control: quiet Me ▾ | solid Viewing as {name}.
 * When not Me, this control is the sole “must know” identity lock.
 */

import { ChevronDown, Undo2, View } from "lucide-react"
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { api } from "../client/index"
import { useMe } from "../hooks/useMe"
import { useViewingAs } from "../hooks/useViewingAs"
import { CHAT_CHROME_PILL } from "./ChatChrome"

type UserOption = {
  upn: string
  displayName: string
}

/** Lucide marks in header pills — block so they center on the text midline, not the baseline. */
const HEADER_ICON = "block shrink-0"

function matchesUserFilter(user: UserOption, query: string): boolean {
  if (!query) return true
  const q = query.toLowerCase()
  return user.displayName.toLowerCase().includes(q) || user.upn.toLowerCase().includes(q)
}

export function ViewingAsControl({
  chromeVariant = "default",
}: {
  /** Match chat shell frosted buttons when in chat header. */
  chromeVariant?: "default" | "chat"
} = {}): ReactNode {
  const { me } = useMe()
  const { canViewAs, isMe, displayName, setViewingAs, clearViewingAs } = useViewingAs()
  const [open, setOpen] = useState(false)
  const [users, setUsers] = useState<UserOption[]>([])
  const [loading, setLoading] = useState(false)
  const [filter, setFilter] = useState("")
  const rootRef = useRef<HTMLDivElement>(null)
  const filterRef = useRef<HTMLInputElement>(null)
  const selfUpn = me?.upn?.trim().toLowerCase() ?? ""

  useEffect(() => {
    if (!open || !canViewAs) return
    let cancelled = false
    setLoading(true)
    api.adminUsers()
      .then((res) => {
        if (cancelled) return
        setUsers(
          res.users
            .filter((row) => typeof row.upn === "string" && row.upn.trim())
            .map((row) => ({
              upn: row.upn!.trim(),
              displayName: (row.displayName?.trim() || row.upn!.trim()),
            }))
            // Signed-in admin is Me — pick via Back to Me / Me, not the list.
            .filter((row) => !selfUpn || row.upn.toLowerCase() !== selfUpn),
        )
      })
      .catch((err: unknown) => {
        console.warn("[mia] Viewing as user list failed", err)
        if (!cancelled) setUsers([])
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, canViewAs, selfUpn])

  useEffect(() => {
    if (!open) {
      setFilter("")
      return
    }
    const id = window.requestAnimationFrame(() => filterRef.current?.focus())
    return () => window.cancelAnimationFrame(id)
  }, [open])

  useEffect(() => {
    if (!open) return
    function onPointerDown(event: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener("mousedown", onPointerDown)
    return () => document.removeEventListener("mousedown", onPointerDown)
  }, [open])

  const filtered = useMemo(
    () => users.filter((user) => matchesUserFilter(user, filter.trim())),
    [users, filter],
  )

  if (!canViewAs) return null

  const label = isMe ? "Me" : (displayName ?? "…")

  // Pill (not square chrome): icon + label share one midline via items-center + leading-none.
  const triggerClass = isMe
    ? chromeVariant === "chat"
      ? CHAT_CHROME_PILL
      : "flex h-9 max-w-[16rem] shrink-0 items-center gap-1.5 rounded-lg border border-border bg-transparent px-2.5 text-[13px] leading-none text-text-muted transition-colors hover:bg-[var(--hover-fill)] hover:text-text"
    : chromeVariant === "chat"
      ? "viewing-as-trigger--other flex h-9 max-w-[18rem] w-auto shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-[13px] leading-none"
      : "viewing-as-trigger--other flex h-9 max-w-[18rem] shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-[13px] leading-none"

  return (
    <div ref={rootRef} className="relative z-[1]">
      <button
        type="button"
        className={triggerClass}
        aria-label={isMe ? "View as — currently Me" : `Viewing as ${label} — not your account`}
        title={isMe ? "View as someone else" : `Viewing as ${label}`}
        onClick={() => setOpen((v) => !v)}
      >
        <View size={15} strokeWidth={2} className={HEADER_ICON} aria-hidden />
        {isMe ? (

          <span className="truncate font-medium leading-none text-text">Me</span>
        ) : (
          <span className="flex min-w-0 items-center gap-1.5 leading-none">
            <span className="shrink-0 opacity-80">Viewing as</span>
            <span className="truncate font-semibold tracking-tight">{label}</span>
          </span>
        )}
        <ChevronDown size={14} strokeWidth={2} className={`${HEADER_ICON} opacity-70`} aria-hidden />
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 flex w-72 max-h-80 flex-col overflow-hidden rounded-xl border border-border bg-elevated shadow-2xl">
          {!isMe && (
            <div className="shrink-0 border-b border-border p-2">
              <button
                type="button"
                className="viewing-as-back-to-me flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm font-medium leading-none"
                onClick={() => {
                  clearViewingAs()
                  setOpen(false)
                }}
              >
                <Undo2 size={15} className={HEADER_ICON} aria-hidden />
                Back to Me
              </button>
            </div>
          )}
          <div className="shrink-0 border-b border-border px-2 py-2">
            <input
              ref={filterRef}
              type="text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter by name or UPN…"
              aria-label="Filter users"
              className="w-full rounded-lg border border-border-subtle bg-overlay-2 px-2.5 py-1.5 text-[13px] text-text placeholder:text-text-faint focus:border-border-strong focus:outline-none"
            />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto py-1">
            {isMe && (
              <>
                <button
                  type="button"
                  className="flex w-full items-center bg-overlay-2 px-3 py-2 text-left text-sm leading-none text-text"
                  onClick={() => {
                    clearViewingAs()
                    setOpen(false)
                  }}
                >
                  Me
                </button>
                <div className="my-1 border-t border-border" />
              </>
            )}
            {loading && (
              <div className="px-3 py-2 text-xs text-text-muted">Loading…</div>
            )}
            {!loading && filtered.length === 0 && (
              <div className="px-3 py-2 text-xs text-text-muted">
                {users.length === 0 ? "No users" : "No matches"}
              </div>
            )}
            {!loading && filtered.map((user) => (
              <button
                key={user.upn}
                type="button"
                className="flex w-full flex-col px-3 py-2 text-left hover:bg-overlay-hover"
                onClick={() => {
                  setViewingAs({ upn: user.upn, displayName: user.displayName })
                  setOpen(false)
                }}
              >
                <span className="truncate text-sm text-text">{user.displayName}</span>
                <span className="truncate text-[11px] text-text-muted">{user.upn}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
