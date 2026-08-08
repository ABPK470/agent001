/**
 * SessionMenu — identity + session actions behind a single burger control.
 * Header: name · role · theme (same shape as before — identity left, theme right).
 */

import {
  Activity,
  ArrowRightLeft,
  BookOpen,
  LayoutGrid,
  LogOut,
  MessageSquare,
  Scale,
  Shield,
} from "lucide-react"
import { useEffect, useRef, useState } from "react"
import type { Me } from "../hooks/useMe"
import { useStore } from "../state/store"
import { BridgeModal } from "../widgets/bridge/BridgeModal"
import { ConnectorsModal } from "../widgets/connectors/ConnectorsModal"
import { CONNECTOR_ICON } from "../widgets/connectors/kind-icon"
import { AboutModal } from "../widgets/platform/AboutModal"
import { AuditModal } from "../widgets/platform/AuditModal"
import { UsageModal } from "../widgets/platform/UsageModal"
import { accountDisplayName, accountRoleLabel, accountSubtitle } from "./account"
import { CHAT_CHROME_BTN } from "./ChatChrome"
import { SessionMenuIcon } from "./SessionMenuIcon"
import { SessionThemeSwitch } from "./SessionThemeSwitch"
import { shellModeToggleHint } from "./types"

interface Props {
  me: Me
  onSignOut: () => void
  /** Chat shell: plain frosted control like workspace. */
  chromeVariant?: "default" | "chat"
  /** Chat → workspace (header icon removed; ⌘⌥ / Ctrl+Alt still works in App). */
  onOpenWorkspace?: () => void
  /** Workspace → chat (header icon removed; shortcut still works in App). */
  onOpenChat?: () => void
}

function menuItemClass(destructive = false): string {
  return destructive ? "session-menu-item session-menu-item--danger" : "session-menu-item"
}

/** ⌘⌥ — same platform face as Dispatch ⌘K so weights match. */
function ShellShortcutHint({ hint }: { hint: string }) {
  if (hint === "⌘⌥") {
    return (
      <span className="session-menu-shortcut" aria-label={hint}>
        <span>⌘</span>
        <span>⌥</span>
      </span>
    )
  }
  return <span className="session-menu-shortcut">{hint}</span>
}

export function SessionMenu({
  me,
  onSignOut,
  chromeVariant = "default",
  onOpenWorkspace,
  onOpenChat,
}: Props) {
  const [open, setOpen] = useState(false)
  const setPolicyEditorOpen = useStore((s) => s.setPolicyEditorOpen)
  const [usageOpen, setUsageOpen] = useState(false)
  const [auditOpen, setAuditOpen] = useState(false)
  const [connectorsOpen, setConnectorsOpen] = useState(false)
  const [bridgeOpen, setBridgeOpen] = useState(false)
  const [aboutOpen, setAboutOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  const displayName = accountDisplayName(me)
  const subtitle = accountSubtitle(me)
  const role = accountRoleLabel(me)
  const shellShortcut = onOpenWorkspace || onOpenChat ? shellModeToggleHint() : null

  useEffect(() => {
    if (!open) return
    // Capture phase — widgets/tiles often stopPropagation on bubble.
    function onPointerDown(event: PointerEvent) {
      if (menuRef.current?.contains(event.target as Node)) return
      setOpen(false)
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false)
    }
    document.addEventListener("pointerdown", onPointerDown, true)
    document.addEventListener("keydown", onKeyDown)
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true)
      document.removeEventListener("keydown", onKeyDown)
    }
  }, [open])

  const close = () => setOpen(false)

  const shellSwitchItem = onOpenWorkspace ? (
    <button
      type="button"
      role="menuitem"
      className={menuItemClass()}
      onClick={() => {
        onOpenWorkspace()
        close()
      }}
    >
      <LayoutGrid size={15} className="shrink-0 text-text-muted" />
      <span className="min-w-0 flex-1">Workspace</span>
      {shellShortcut && <ShellShortcutHint hint={shellShortcut} />}
    </button>
  ) : onOpenChat ? (
    <button
      type="button"
      role="menuitem"
      className={menuItemClass()}
      onClick={() => {
        onOpenChat()
        close()
      }}
    >
      <MessageSquare size={15} className="shrink-0 text-text-muted" />
      <span className="min-w-0 flex-1">Chat</span>
      {shellShortcut && <ShellShortcutHint hint={shellShortcut} />}
    </button>
  ) : null

  const triggerClass =
    chromeVariant === "chat"
      ? CHAT_CHROME_BTN
      : "relative z-[1] flex h-9 w-9 items-center justify-center rounded-lg border border-border bg-transparent text-text-muted transition-colors hover:bg-[var(--hover-fill)] hover:text-text"

  return (
    <>
      <div className={open ? "relative z-[80]" : "relative z-[1]"} ref={menuRef}>
        <button
          type="button"
          className={triggerClass}
          onClick={() => setOpen((value) => !value)}
          title={open ? undefined : me.isAdmin ? `${displayName} · admin` : displayName}
          aria-label={me.isAdmin ? "Session menu · admin" : "Session menu"}
          aria-expanded={open}
          aria-haspopup="menu"
        >
          <SessionMenuIcon />
        </button>

        {open && (
          <div
            role="menu"
            className="menu-panel session-menu-panel absolute right-0 top-full mt-2 w-[16.5rem] overflow-hidden rounded-xl py-1"
          >
            <div className="session-menu-header">
              <div className="session-menu-identity">
                <p className="truncate text-[14px] font-semibold leading-snug text-text">{displayName}</p>
                <p className="mt-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-text-faint">
                  {role}
                </p>
                {subtitle && (
                  <p className="mt-0.5 truncate font-mono text-[11px] leading-snug text-text-muted" title={me.upn}>
                    {subtitle}
                  </p>
                )}
              </div>
              <SessionThemeSwitch className="mt-0.5" />
            </div>

            {shellSwitchItem && (
              <>
                <div className="session-menu-divider" />
                {shellSwitchItem}
              </>
            )}

            {me.isAdmin && (
              <>
                <div className="session-menu-divider" />
                <button
                  type="button"
                  role="menuitem"
                  className={menuItemClass()}
                  onClick={() => {
                    setConnectorsOpen(true)
                    close()
                  }}
                >
                  <CONNECTOR_ICON size={15} className="shrink-0 text-text-muted" />
                  Connectors
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className={menuItemClass()}
                  onClick={() => {
                    setBridgeOpen(true)
                    close()
                  }}
                >
                  <ArrowRightLeft size={15} className="shrink-0 text-text-muted" />
                  Bridge
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className={menuItemClass()}
                  onClick={() => {
                    setUsageOpen(true)
                    close()
                  }}
                >
                  <Activity size={15} className="shrink-0 text-text-muted" />
                  Usage
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className={menuItemClass()}
                  onClick={() => {
                    setPolicyEditorOpen(true)
                    close()
                  }}
                >
                  <Shield size={15} className="shrink-0 text-text-muted" />
                  Policies
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className={menuItemClass()}
                  onClick={() => {
                    setAuditOpen(true)
                    close()
                  }}
                >
                  <Scale size={15} className="shrink-0 text-text-muted" />
                  Audit
                </button>
              </>
            )}

            <div className="session-menu-divider" />
            <button
              type="button"
              role="menuitem"
              className={menuItemClass()}
              onClick={() => {
                setAboutOpen(true)
                close()
              }}
            >
              <BookOpen size={15} className="shrink-0 text-text-muted" />
              About
            </button>
            <button
              type="button"
              role="menuitem"
              className={menuItemClass(true)}
              onClick={() => {
                onSignOut()
                close()
              }}
            >
              <LogOut size={15} className="shrink-0" />
              Sign out
            </button>
          </div>
        )}
      </div>

      {usageOpen && <UsageModal onClose={() => setUsageOpen(false)} />}
      {auditOpen && <AuditModal onClose={() => setAuditOpen(false)} />}
      {connectorsOpen && <ConnectorsModal onClose={() => setConnectorsOpen(false)} />}
      {bridgeOpen && <BridgeModal onClose={() => setBridgeOpen(false)} />}
      {aboutOpen && <AboutModal onClose={() => setAboutOpen(false)} />}
    </>
  )
}
