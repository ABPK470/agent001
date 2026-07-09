/**
 * Shared subheader / body wrappers for Run and Definition tabs.
 */

import type { ReactNode } from "react"
import { TAB_BODY, TAB_BODY_INNER, TAB_PANEL_HEADER, TAB_SHELL, TAB_SUBHEADER } from "./chrome"

export function TabShell({ children }: { children: ReactNode }) {
  return <div className={TAB_SHELL}>{children}</div>
}

export function TabSubheader({ children }: { children: ReactNode }) {
  return <div className={TAB_SUBHEADER}>{children}</div>
}

export function TabPanelHeader({ children }: { children: ReactNode }) {
  return <div className={TAB_PANEL_HEADER}>{children}</div>
}

export function TabBody({ children }: { children: ReactNode }) {
  return (
    <div className={TAB_BODY}>
      <div className={TAB_BODY_INNER}>{children}</div>
    </div>
  )
}
