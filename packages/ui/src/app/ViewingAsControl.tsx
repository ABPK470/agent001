/**
 * Header control: Viewing as Me | {name}
 */

import { ChevronDown, Eye } from "lucide-react"
import { useEffect, useRef, useState, type ReactNode } from "react"
import { api } from "../client/index"
import { useViewingAs } from "../hooks/useViewingAs"

type UserOption = {
  upn: string
  displayName: string
}

export function ViewingAsControl(): ReactNode {
  const { canViewAs, isMe, displayName, setViewingAs, clearViewingAs } = useViewingAs()
  const [open, setOpen] = useState(false)
  const [users, setUsers] = useState<UserOption[]>([])
  const [loading, setLoading] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

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
    if (!open) return
    function onPointerDown(event: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener("mousedown", onPointerDown)
    return () => document.removeEventListener("mousedown", onPointerDown)
  }, [open])

  if (!canViewAs) return null

  const label = isMe ? "Me" : (displayName ?? "…")

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        className={[
          "flex items-center gap-1.5 max-w-[14rem] rounded-lg px-2.5 py-1.5 text-xs transition-colors",
          isMe
            ? "text-text-muted hover:text-text hover:bg-overlay-hover"
            : "text-amber-200 bg-amber-500/10 hover:bg-amber-500/15",
        ].join(" ")}
        aria-label={`Viewing as ${label}`}
        title={`Viewing as: ${label}`}
        onClick={() => setOpen((v) => !v)}
      >
        <Eye size={13} className="shrink-0 opacity-80" />
        <span className="truncate">
          Viewing as: <span className="font-medium text-text">{label}</span>
        </span>
        <ChevronDown size={12} className="shrink-0 opacity-60" />
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 w-64 max-h-72 overflow-y-auto rounded-xl border border-border bg-elevated py-1 shadow-2xl">
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
          {!loading && users.length === 0 && (
            <div className="px-3 py-2 text-xs text-text-muted">No users</div>
          )}
          {users.map((user) => (
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
      )}
    </div>
  )
}
