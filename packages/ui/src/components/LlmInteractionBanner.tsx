import { ExternalLink } from "lucide-react"
import type { JSX } from "react"

import type { LlmInteraction } from "../hooks/useLlmInteraction"

export function LlmInteractionBanner({
  interaction,
  onDismiss,
}: {
  interaction: LlmInteraction
  onDismiss?: () => void
}): JSX.Element {
  const providerLabel = interaction.provider.replace(/-/g, " ")

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-accent/20 bg-accent/5 px-3 py-2.5 text-sm text-text">
      <span className="text-text-muted">
        {interaction.title}
        <span className="text-text-muted/60"> · {providerLabel}</span>
      </span>
      {interaction.message && (
        <span className="text-text-muted">{interaction.message}</span>
      )}
      {interaction.url && (
        <a
          href={interaction.url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 font-medium text-accent hover:underline"
        >
          {interaction.kind === "device_auth" ? "Open authorization" : "Open link"}
          <ExternalLink size={14} />
        </a>
      )}
      {interaction.code && (
        <span className="font-mono text-base tracking-wider text-text">{interaction.code}</span>
      )}
      {onDismiss && (
        <button type="button" onClick={onDismiss} className="ml-auto text-sm text-text-muted hover:text-text">
          Hide
        </button>
      )}
    </div>
  )
}
