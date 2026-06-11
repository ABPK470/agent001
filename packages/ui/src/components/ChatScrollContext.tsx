import { createContext, useContext, type ReactNode, type RefObject } from "react"
import { preserveScrollAnchor } from "../lib/chatScroll"

interface ChatScrollContextValue {
  pauseAutoScroll: () => void
  preserveToggle: (button: HTMLButtonElement | null, toggle: () => void) => void
  scrollHostRef: RefObject<HTMLDivElement | null>
  hydrateRunTrace?: (runId: string) => Promise<void>
}

const ChatScrollContext = createContext<ChatScrollContextValue | null>(null)

export function ChatScrollProvider({
  pauseAutoScroll,
  scrollHostRef,
  hydrateRunTrace,
  children,
}: {
  pauseAutoScroll: () => void
  scrollHostRef: RefObject<HTMLDivElement | null>
  hydrateRunTrace?: (runId: string) => Promise<void>
  children: ReactNode
}) {
  const value: ChatScrollContextValue = {
    pauseAutoScroll,
    scrollHostRef,
    hydrateRunTrace,
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
      scrollHostRef: { current: null },
    }
  }
  return ctx
}
