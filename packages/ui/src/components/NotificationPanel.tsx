/**
 * NotificationPanel — bell icon + dropdown panel for system notifications.
 *
 * Shows run completions, failures, approval requests, and auto-recovery
 * alerts. Each notification can have action buttons (resume, view, etc.)
 * that navigate to the relevant widget — opening as a modal if needed.
 */

import { Bell, CheckCircle2, RotateCcw, ShieldAlert, XCircle } from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"
import { api } from "../api"
import { useStore } from "../store"
import type { Notification, NotificationAction } from "../types"

function timeAgo(date: string): string {
  const seconds = Math.floor((Date.now() - new Date(date).getTime()) / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  return `${days}d`
}

const TYPE_ICON: Record<string, typeof Bell> = {
  "run.completed": CheckCircle2,
  "run.failed": XCircle,
  "run.recovered": RotateCcw,
  "approval.required": ShieldAlert,
}

const TYPE_COLOR: Record<string, string> = {
  "run.completed": "var(--color-success)",
  "run.failed": "var(--color-error)",
  "run.recovered": "var(--color-accent)",
  "approval.required": "var(--color-warning)",
}

export function NotificationPanel() {
  const [open, setOpen] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)
  const notifications = useStore((s) => s.notifications)
  const unreadCount = useStore((s) => s.unreadCount)
  const setNotifications = useStore((s) => s.setNotifications)
  const markNotificationRead = useStore((s) => s.markNotificationRead)
  const markAllRead = useStore((s) => s.markAllRead)
  const setActiveRun = useStore((s) => s.setActiveRun)
  const openModalWidget = useStore((s) => s.openModalWidget)

  // Load notifications on mount
  useEffect(() => {
    api.listNotifications(50).then(setNotifications).catch(() => {})
  }, [setNotifications])

  // Close on outside click
  useEffect(() => {
    if (!open) return
    function handleClick(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener("mousedown", handleClick)
    return () => document.removeEventListener("mousedown", handleClick)
  }, [open])

  const handleAction = useCallback(async (notification: Notification, action: NotificationAction) => {
    // Mark as read
    markNotificationRead(notification.id)
    api.markNotificationRead(notification.id).catch(() => {})

    switch (action.action) {
      case "view-run": {
        const runId = action.data?.runId as string | undefined
        if (runId) {
          setActiveRun(runId)
          // Check if run-status widget is in the current view — if not, open as modal
          const { views, activeViewId } = useStore.getState()
          const view = views.find((v) => v.id === activeViewId)
          const hasRunStatus = view?.widgets.some((w) => w.type === "run-status")
          if (!hasRunStatus) {
            openModalWidget("run-status", runId)
          }
        }
        setOpen(false)
        break
      }

      case "resume-run": {
        const runId = action.data?.runId as string | undefined
        if (runId) {
          try {
            const result = await api.resumeRun(runId)
            if (result.runId) setActiveRun(result.runId)
          } catch { /* handled by notification */ }
        }
        setOpen(false)
        break
      }

      case "rollback-run": {
        const runId = action.data?.runId as string | undefined
        if (runId) {
          try {
            await api.rollbackRun(runId)
          } catch { /* swallow */ }
        }
        setOpen(false)
        break
      }

      case "apply-run-diff": {
        const runId = action.data?.runId as string | undefined
        if (runId) {
          try {
            await api.applyRunWorkspaceDiff(runId)
            setActiveRun(runId)
          } catch {
            /* swallow */
          }
        }
        setOpen(false)
        break
      }

      case "open-policies": {
        // This action is handled by the parent — we just close the panel
        // The PolicyEditor modal will be opened by the parent
        setOpen(false)
        break
      }

      default:
        setOpen(false)
    }
  }, [markNotificationRead, setActiveRun, openModalWidget])

  const handleMarkAllRead = useCallback(() => {
    markAllRead()
    api.markAllNotificationsRead().catch(() => {})
  }, [markAllRead])

  return (
    <div className="relative" ref={panelRef}>
      {/* Bell icon */}
      <button
        className="relative flex items-center justify-center w-9 h-9 rounded-lg text-text-muted hover:text-white hover:bg-white/[0.06] transition-colors"
        onClick={() => setOpen((v) => !v)}
        title="Notifications"
      >
        <Bell size={18} />
        {unreadCount > 0 && (
          <span
            className="absolute -top-0.5 -right-0.5 flex items-center justify-center min-w-[18px] h-[18px] text-[10px] font-bold text-white rounded-full px-1"
            style={{ background: "var(--color-error)" }}
          >
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        )}
      </button>

      {/* Dropdown panel */}
      {open && (
        <div
          className="absolute right-0 top-full mt-1.5 w-80 max-h-[480px] bg-elevated border border-border rounded-xl shadow-xl shadow-black/40 z-50 flex flex-col overflow-hidden"
        >
          {/* Header */}
          <div className="flex items-center justify-between px-4 pt-3 pb-2.5 border-b border-border shrink-0">
            <span className="text-sm font-semibold text-text">Notifications</span>
            {unreadCount > 0 && (
              <button
                className="text-[12px] text-accent hover:text-accent-hover transition-colors"
                onClick={handleMarkAllRead}
              >
                Mark all read
              </button>
            )}
          </div>

          {/* List */}
          <div className="flex-1 overflow-y-auto">
            {notifications.length === 0 ? (
              <div className="flex items-center justify-center py-12 text-text-muted text-sm">
                No notifications
              </div>
            ) : (
              notifications.map((n) => {
                const Icon = TYPE_ICON[n.type] ?? Bell
                const color = TYPE_COLOR[n.type] ?? "var(--color-text-muted)"

                return (
                  <div
                    key={n.id}
                    className={`px-4 py-3 border-b border-border/50 transition-colors ${
                      n.read ? "opacity-60" : "bg-white/[0.02]"
                    }`}
                  >
                    <div className="flex gap-3">
                      <Icon
                        size={18}
                        className="shrink-0 mt-0.5"
                        style={{ color }}
                      />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-[13px] font-medium text-text truncate">
                            {n.title}
                          </span>
                          <span className="text-[11px] text-text-muted shrink-0">
                            {timeAgo(n.createdAt)}
                          </span>
                        </div>
                        <p className="text-[12px] text-text-secondary mt-0.5 leading-relaxed line-clamp-2">
                          {n.message}
                        </p>

                        {/* Actions */}
                        {n.actions.length > 0 && (
                          <div className="flex gap-2 mt-2">
                            {n.actions.map((action, i) => (
                              <button
                                key={i}
                                className="text-[11px] px-2.5 py-1 rounded-md text-accent bg-accent/10 hover:bg-accent/20 transition-colors"
                                onClick={() => handleAction(n, action)}
                              >
                                {action.label}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                )
              })
            )}
          </div>
        </div>
      )}
    </div>
  )
}
