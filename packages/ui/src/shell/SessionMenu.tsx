/**
 * SessionMenu — identity + session actions behind a single burger control.
 */

import {
  Activity,
  ArrowRightLeft,
  BookOpen,
  Brain,
  LogOut,
  Scale,
  Shield,
} from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { AboutModal } from "../components/AboutModal"
import { AgentEditor } from "../components/AgentEditor"
import { AuditModal } from "../components/AuditModal"
import { UsageModal } from "../components/UsageModal"
import type { Me } from "../hooks/useMe"
import { useStore } from "../store"
import { ConnectorsModal } from "../widgets/connectors/ConnectorsModal"
import { CONNECTOR_ICON } from "../widgets/connectors/kind-icon"
import { DataMovementModal } from "../widgets/data-movement/DataMovementModal"
import { accountDisplayName, accountRoleLabel, accountSubtitle } from "./account"
import { AsciiMicroField } from "./AsciiMicroField"
import { CHAT_CHROME_BTN } from "./ChatChrome"
import { SessionMenuIcon } from "./SessionMenuIcon"
import { SessionThemeSwitch } from "./SessionThemeSwitch"

interface Props {
  me: Me
  onSignOut: () => void
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

export function SessionMenu({ me, onSignOut, chromeVariant = "default" }: Props) {
  const [open, setOpen] = useState(false)
  const [agentOpen, setAgentOpen] = useState(false)
  const setPolicyEditorOpen = useStore((s) => s.setPolicyEditorOpen)
  const [usageOpen, setUsageOpen] = useState(false)
  const [auditOpen, setAuditOpen] = useState(false)
  const [connectorsOpen, setConnectorsOpen] = useState(false)
  const [dataMovementOpen, setDataMovementOpen] = useState(false)
  const [aboutOpen, setAboutOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  const displayName = accountDisplayName(me)
  const subtitle = accountSubtitle(me)
  const role = accountRoleLabel(me)
  const showAdminSection = me.isAdmin
  const hasMenuActions = showAdminSection

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
            className={`session-menu-panel absolute right-0 top-full z-50 mt-1.5 overflow-hidden rounded-xl border border-border bg-panel-2 shadow-xl shadow-black/40 ${
              me.isAdmin ? "w-[17rem] py-1" : "w-[15.5rem] py-1.5"
            }`}
          >
            {me.isAdmin ? (
              <>
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
                        setDataMovementOpen(true)
                        close()
                      }}
                    >
                      <ArrowRightLeft size={15} className="shrink-0 text-text-muted" />
                      Data movement
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

                {hasMenuActions && <div className="session-menu-divider" />}
                <SessionThemeSwitch />

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
              </>
            ) : (
              <>
                <div className="px-3.5 pb-2 pt-2.5">
                  <div className="flex min-w-0 items-baseline justify-between gap-2">
                    <p className="truncate text-[14px] font-semibold leading-snug text-text">{displayName}</p>
                    <span className="shrink-0 text-[10px] font-semibold uppercase tracking-[0.12em] text-text-faint">
                      {role}
                    </span>
                  </div>
                  {subtitle && (
                    <p className="mt-0.5 truncate font-mono text-[11px] leading-snug text-text-muted" title={me.upn}>
                      {subtitle}
                    </p>
                  )}
                </div>

                <SessionThemeSwitch compact />

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
              </>
            )}
          </div>
        )}
      </div>

      {agentOpen && <AgentEditor onClose={() => setAgentOpen(false)} />}
      {usageOpen && <UsageModal onClose={() => setUsageOpen(false)} />}
      {auditOpen && <AuditModal onClose={() => setAuditOpen(false)} />}
      {connectorsOpen && <ConnectorsModal onClose={() => setConnectorsOpen(false)} />}
      {dataMovementOpen && <DataMovementModal onClose={() => setDataMovementOpen(false)} />}
      {aboutOpen && <AboutModal onClose={() => setAboutOpen(false)} />}
    </>
  )
}
