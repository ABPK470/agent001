import { LayoutGrid, LogOut } from "lucide-react"
import type { Me } from "../hooks/useMe"
import { ChatChromeButton } from "./ChatChrome"
import { SessionMenu } from "./SessionMenu"
import { shellModeToggleHint, type AppShellMode } from "./types"

interface Props {
  onModeChange: (mode: AppShellMode) => void
  onSignOut: () => void
  me?: Me | null
}

export function ChatShellActions({ onModeChange, onSignOut, me }: Props) {
  const shortcut = shellModeToggleHint()
  return (
    <div className="relative z-10 flex shrink-0 items-center gap-2">
      <ChatChromeButton
        onClick={() => onModeChange("workspace")}
        title={`Workspace (${shortcut})`}
        aria-label={`Open workspace (${shortcut})`}
      >
        <LayoutGrid size={17} />
      </ChatChromeButton>
      {me ? (
        <SessionMenu me={me} onSignOut={onSignOut} chromeVariant="chat" />
      ) : (
        <ChatChromeButton onClick={onSignOut} title="Sign out" aria-label="Sign out">
          <LogOut size={16} />
        </ChatChromeButton>
      )}
    </div>
  )
}
