import { Logo } from "../components/Logo"
import { CHAT_BRAND_LOGO_SIZE } from "./brand"

interface Props {
  connected: boolean
  className?: string
}

export function ChatBrand({ connected, className = "" }: Props) {
  return (
    <div className={`toolbar-brand flex h-9 shrink-0 items-center text-text ${className}`.trim()}>
      <Logo size={CHAT_BRAND_LOGO_SIZE} online={connected} className="toolbar-brand-logo" />
    </div>
  )
}
