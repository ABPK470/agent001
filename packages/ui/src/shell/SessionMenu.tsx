/**
 * SessionMenu — identity + session actions behind a single burger control.
 */

import { Activity, Brain, Database, LogOut, Scale, Shield, Terminal } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { AgentEditor } from "../components/AgentEditor"
import { AuditModal } from "../components/AuditModal"
import { ConnectionsModal } from "../components/ConnectionsModal"
import { PolicyEditor } from "../components/PolicyEditor"
import { UsageModal } from "../components/UsageModal"
import type { Me } from "../hooks/useMe"
import { accountDisplayName, accountRoleLabel, accountSubtitle } from "./account"
import { AsciiMicroField } from "./AsciiMicroField"
import { CHAT_CHROME_BTN } from "./ChatChrome"
import { SessionMenuIcon } from "./SessionMenuIcon"
import { SessionThemeSwitch } from "./SessionThemeSwitch"

interface Props {
  me: Me
  onSignOut: () => void
  onSwitchUi?: () => void
  /** Chat shell: plain frosted control like workspace — no admin ASCII texture. */
  chromeVariant?: "default" | "chat"
}

function menuItemClass(destructive = false): string {
  return [
    "flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm transition-colors",
    destructive
      ? "text-error hover:bg-error/10"
      : "text-text-secondary hover:bg-overlay-hover hover:text-text",
  ].join(" ")
}

export function SessionMenu({ me, onSignOut, onSwitchUi, chromeVariant = "default" }: Props) {
  const [open, setOpen] = useState(false)
  const [agentOpen, setAgentOpen] = useState(false)
  const [policyOpen, setPolicyOpen] = useState(false)
  const [usageOpen, setUsageOpen] = useState(false)
  const [auditOpen, setAuditOpen] = useState(false)
  const [connectionsOpen, setConnectionsOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  const displayName = accountDisplayName(me)
  const subtitle = accountSubtitle(me)
  const role = accountRoleLabel(me)
  const showTerminalItem = me.isAdmin && Boolean(onSwitchUi)
  const showAdminSection = me.isAdmin
  const hasMenuActions = showTerminalItem || showAdminSection

  useEffect(() => {
    if (!open) return
    function handleClick(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener("mousedown", handleClick)
    return () => document.removeEventListener("mousedown", handleClick)
  }, [open])

  const close = () => setOpen(false)

  const triggerClass =
    chromeVariant === "chat"
      ? CHAT_CHROME_BTN
      : me.isAdmin
        ? "session-menu-trigger session-menu-trigger--admin flex h-9 w-9 items-center justify-center overflow-hidden rounded-lg text-text-muted transition-colors hover:bg-overlay-hover hover:text-text"
        : "session-menu-trigger flex h-9 w-9 items-center justify-center overflow-hidden rounded-lg text-text-muted transition-colors hover:bg-overlay-hover hover:text-text"

  const showAsciiAccent = me.isAdmin && chromeVariant !== "chat"

  return (
    <>
      <div className="relative" ref={menuRef}>
        <button
          type="button"
          className={triggerClass}
          onClick={() => setOpen((value) => !value)}
          title={me.isAdmin ? `${displayName} · admin` : displayName}
          aria-label={me.isAdmin ? "Session menu · admin" : "Session menu"}
          aria-expanded={open}
          aria-haspopup="menu"
        >
          {showAsciiAccent && <AsciiMicroField paused={open} clearCenter={{ w: 18, h: 18 }} />}
          <span className="relative z-[1] flex items-center justify-center">
            <SessionMenuIcon />
          </span>
        </button>

        {open && (
          <div
            role="menu"
            className="session-menu-panel absolute right-0 top-full z-50 mt-1.5 w-[17rem] overflow-hidden rounded-xl border border-border bg-panel-2 py-1 shadow-xl shadow-black/40"
          >
            <div className="px-4 py-3.5">
              <p className="truncate text-[15px] font-semibold leading-snug text-text">{displayName}</p>
              {subtitle && (
                <p className="mt-1 truncate font-mono text-[11px] leading-snug text-text-muted" title={me.upn}>
                  {subtitle}
                </p>
              )}
              <p className="mt-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-text-faint">{role}</p>
            </div>

            {hasMenuActions && <div className="session-menu-divider" />}

            {showTerminalItem && (
              <button
                type="button"
                role="menuitem"
                className={menuItemClass()}
                onClick={() => {
                  onSwitchUi!()
                  close()
                }}
              >
                <Terminal size={15} className="shrink-0 text-text-muted" />
                Terminal UI
              </button>
            )}

            {showAdminSection && (
              <>
                <p className="px-4 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-text-faint">
                  Administration
                </p>
                <button
                  type="button"
                  role="menuitem"
                  className={menuItemClass()}
                  onClick={() => {
                    setConnectionsOpen(true)
                    close()
                  }}
                >
                  <Database size={15} className="shrink-0 text-text-muted" />
                  Connections
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className={menuItemClass()}
                  onClick={() => {
                    setAgentOpen(true)
                    close()
                  }}
                >
                  <Brain size={15} className="shrink-0 text-text-muted" />
                  Agents
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
                    setPolicyOpen(true)
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

            {hasMenuActions && <div className="session-menu-divider" />}
            <SessionThemeSwitch />

            <div className="session-menu-divider" />
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

      {agentOpen && <AgentEditor onClose={() => setAgentOpen(false)} />}
      {policyOpen && <PolicyEditor onClose={() => setPolicyOpen(false)} />}
      {usageOpen && <UsageModal onClose={() => setUsageOpen(false)} />}
      {auditOpen && <AuditModal onClose={() => setAuditOpen(false)} />}
      {connectionsOpen && <ConnectionsModal onClose={() => setConnectionsOpen(false)} />}
    </>
  )
}
