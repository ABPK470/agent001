import type { ReactNode } from "react"
import type { AppShellMode } from "./types"

export type ShellStagePhase = "chat" | "workspace" | "to-workspace" | "to-chat"

interface Props {
  phase: ShellStagePhase
  chat: ReactNode
  workspace: ReactNode
}

/**
 * Persistent chat + workspace panes. Steady state shows one; mitosis
 * animates both in place — no remount, no second ASCII canvas.
 */
export function ShellModeStage({ phase, chat, workspace }: Props) {
  return (
    <div className={`shell-stage shell-stage--${phase}`}>
      <div className="shell-stage-pane shell-stage-pane--chat">{chat}</div>
      <div className="shell-stage-pane shell-stage-pane--workspace">{workspace}</div>
    </div>
  )
}

export function shellStagePhase(
  mode: AppShellMode,
  transition: { to: AppShellMode } | null,
): ShellStagePhase {
  if (transition?.to === "workspace") return "to-workspace"
  if (transition?.to === "chat") return "to-chat"
  return mode
}
