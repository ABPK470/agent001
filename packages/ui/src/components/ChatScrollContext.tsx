import { createContext, useContext, type ReactNode } from "react"
import { preserveScrollAnchor } from "../lib/chatScroll"

interface ChatScrollContextValue {
  pauseAutoScroll: () => void
  preserveToggle: (button: HTMLButtonElement | null, toggle: () => void) => void
}

const ChatScrollContext = createContext<ChatScrollContextValue | null>(null)

export function ChatScrollProvider({
  pauseAutoScroll,
  children,
}: {
  pauseAutoScroll: () => void
  children: ReactNode
}) {
  const value: ChatScrollContextValue = {
    pauseAutoScroll,
    preserveToggle: (button, toggle) => preserveScrollAnchor(button, toggle, pauseAutoScroll),
  }
  return <ChatScrollContext.Provider value={value}>{children}</ChatScrollContext.Provider>
}

export function useChatScroll(): ChatScrollContextValue {
  const ctx = useContext(ChatScrollContext)
  if (!ctx) {
    return {
      pauseAutoScroll: () => { /* no-op outside provider */ },
      preserveToggle: (button, toggle) => preserveScrollAnchor(button, toggle),
    }
  }
  return ctx
}
