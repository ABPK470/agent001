import { LayoutGrid, LogOut } from "lucide-react"
import type { Me } from "../hooks/useMe"
import { ChatChromeButton } from "./ChatChrome"
import { SessionMenu } from "./SessionMenu"
import type { AppShellMode } from "./types"

interface Props {
  onModeChange: (mode: AppShellMode) => void
  onSignOut: () => void
  onSwitchUi?: () => void
  me?: Me | null
}

export function ChatShellActions({ onModeChange, onSignOut, onSwitchUi, me }: Props) {
  return (
    <div className="relative z-10 flex shrink-0 items-center gap-2">
      <ChatChromeButton
        onClick={() => onModeChange("workspace")}
        title="Workspace"
        aria-label="Open workspace"
      >
        <LayoutGrid size={17} />
      </ChatChromeButton>
      {me ? (
        <SessionMenu me={me} onSignOut={onSignOut} onSwitchUi={onSwitchUi} chromeVariant="chat" />
      ) : (
        <ChatChromeButton onClick={onSignOut} title="Sign out" aria-label="Sign out">
          <LogOut size={16} />
        </ChatChromeButton>
      )}
    </div>
  )
}
