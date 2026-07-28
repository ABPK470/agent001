import type { ButtonHTMLAttributes, ReactNode } from "react"

/** Frosted square control — same footprint as workspace toolbar (`h-9 w-9`). */
export const CHAT_CHROME_BTN =
  "flex h-9 w-9 items-center justify-center rounded-lg bg-panel/72 text-text-muted backdrop-blur transition-colors hover:bg-overlay-hover hover:text-text"

/**
 * Frosted pill — same height/material as CHAT_CHROME_BTN, for icon + label rows.
 * Always `items-center` + `leading-none` so Lucide marks sit on the text midline.
 */
export const CHAT_CHROME_PILL =
  "flex h-9 w-auto max-w-[16rem] shrink-0 items-center gap-1.5 rounded-lg bg-panel/72 px-2.5 text-[13px] leading-none text-text-muted backdrop-blur transition-colors hover:bg-overlay-hover hover:text-text"

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
