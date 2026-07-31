import type { ButtonHTMLAttributes, ReactNode } from "react"

/** Chat chrome square — solid plate, no border. */
export const CHAT_CHROME_BTN =
  "flex h-9 w-9 items-center justify-center rounded-lg bg-panel text-text transition-colors hover:bg-[var(--hover-fill)] hover:text-text"

/**
 * Chat chrome pill — same material as CHAT_CHROME_BTN, for icon + label rows.
 * Always `items-center` + `leading-none` so Lucide marks sit on the text midline.
 */
export const CHAT_CHROME_PILL =
  "flex h-9 w-auto max-w-[16rem] shrink-0 items-center gap-1.5 rounded-lg bg-panel px-2.5 text-[13px] leading-none text-text transition-colors hover:bg-[var(--hover-fill)]"
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
