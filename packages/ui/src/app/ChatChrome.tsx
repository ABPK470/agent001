import type { ButtonHTMLAttributes, ReactNode } from "react"

/** Frosted control used on the chat shell — present but quiet. */
export const CHAT_CHROME_BTN =
  "flex h-10 w-10 items-center justify-center rounded-lg bg-panel/72 text-text-muted backdrop-blur transition-colors hover:bg-overlay-hover hover:text-text"

interface ChatChromeButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  children: ReactNode
}

export function ChatChromeButton({ className = "", children, ...props }: ChatChromeButtonProps) {
  return (
    <button type="button" className={[CHAT_CHROME_BTN, className].filter(Boolean).join(" ")} {...props}>
      {children}
    </button>
  )
}
