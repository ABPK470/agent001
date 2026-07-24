/**
 * Header control: Viewing as Me | {name}
 */

import { ChevronDown, Eye } from "lucide-react"
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { api } from "../client/index"
import { useViewingAs } from "../hooks/useViewingAs"
import { CHAT_CHROME_BTN } from "./ChatChrome"

type UserOption = {
  upn: string
  displayName: string
}

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
  const { canViewAs, isMe, displayName, setViewingAs, clearViewingAs } = useViewingAs()
  const [open, setOpen] = useState(false)
  const [users, setUsers] = useState<UserOption[]>([])
  const [loading, setLoading] = useState(false)
  const [filter, setFilter] = useState("")
  const rootRef = useRef<HTMLDivElement>(null)
  const filterRef = useRef<HTMLInputElement>(null)

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
            })),
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
  }, [open, canViewAs])

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

  const triggerClass =
    chromeVariant === "chat"
      ? [
          CHAT_CHROME_BTN,
          "w-auto max-w-[16rem] gap-1.5 px-3 text-[13px]",
          isMe ? "" : "bg-amber-500/15 text-amber-200 hover:bg-amber-500/20 hover:text-amber-100",
        ].filter(Boolean).join(" ")
      : [
          "flex h-9 max-w-[16rem] shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-[13px] transition-colors",
          isMe
            ? "text-text-muted hover:bg-overlay-hover hover:text-text"
            : "bg-amber-500/10 text-amber-200 hover:bg-amber-500/15",
        ].join(" ")

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        className={triggerClass}
        aria-label={`Viewing as ${label}`}
        title={`Viewing as: ${label}`}
        onClick={() => setOpen((v) => !v)}
      >
        <Eye size={15} strokeWidth={2} className="shrink-0" />
        <span className="truncate">
          Viewing as: <span className={`font-medium ${isMe ? "text-text" : ""}`}>{label}</span>
        </span>
        <ChevronDown size={14} strokeWidth={2} className="shrink-0 opacity-70" />
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 flex w-72 max-h-80 flex-col overflow-hidden rounded-xl border border-border bg-elevated shadow-2xl">
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
            <button
              type="button"
              className={[
                "flex w-full items-center px-3 py-2 text-left text-sm",
                isMe ? "bg-overlay-2 text-text" : "text-text-secondary hover:bg-overlay-hover",
              ].join(" ")}
              onClick={() => {
                clearViewingAs()
                setOpen(false)
              }}
            >
              Me
            </button>
            <div className="my-1 border-t border-border" />
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
