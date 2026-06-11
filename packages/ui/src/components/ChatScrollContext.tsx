import { createContext, useContext, type ReactNode, type RefObject } from "react"
import { preserveScrollAnchor } from "../lib/chatScroll"

interface ChatScrollContextValue {
  pauseAutoScroll: () => void
  preserveToggle: (button: HTMLButtonElement | null, toggle: () => void) => void
  scrollHostRef: RefObject<HTMLDivElement | null>
  hydrateRunTrace?: (runId: string) => Promise<void>
  /** When false, only the latest turn may load trace data (open-at-bottom UX). */
  historyHydrationEnabled: boolean
}

const ChatScrollContext = createContext<ChatScrollContextValue | null>(null)

export function ChatScrollProvider({
  pauseAutoScroll,
  scrollHostRef,
  hydrateRunTrace,
  historyHydrationEnabled = false,
  children,
}: {
  pauseAutoScroll: () => void
  scrollHostRef: RefObject<HTMLDivElement | null>
  hydrateRunTrace?: (runId: string) => Promise<void>
  historyHydrationEnabled?: boolean
  children: ReactNode
}) {
  const value: ChatScrollContextValue = {
    pauseAutoScroll,
    scrollHostRef,
    hydrateRunTrace,
    historyHydrationEnabled,
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
      historyHydrationEnabled: true,
    }
  }
  return ctx
}
