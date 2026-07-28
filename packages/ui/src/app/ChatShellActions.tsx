import { LogOut } from "lucide-react"
import type { Me } from "../hooks/useMe"
import { ChatChromeButton } from "./ChatChrome"
import { SessionMenu } from "./SessionMenu"
import { ViewingAsControl } from "./ViewingAsControl"
import type { AppShellMode } from "./types"

interface Props {
  onModeChange: (mode: AppShellMode) => void
  onSignOut: () => void
  me?: Me | null
}

export function ChatShellActions({ onModeChange, onSignOut, me }: Props) {
  return (
    <div className="flex shrink-0 items-center gap-1">
      <ViewingAsControl chromeVariant="chat" />
      {me ? (
        <SessionMenu
          me={me}
          onSignOut={onSignOut}
          chromeVariant="chat"
          onOpenWorkspace={() => onModeChange("workspace")}
        />
      ) : (
        <ChatChromeButton onClick={onSignOut} title="Sign out" aria-label="Sign out">
          <LogOut size={15} className="block shrink-0" aria-hidden />
        </ChatChromeButton>
      )}
    </div>
  )
}
