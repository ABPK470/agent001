import type { JSX } from "react"

import {
  ENV_COLOR_TOKENS,
  envColorDot,
  isEnvColorToken,
  type EnvColorToken,
} from "../../env-sync/env-colors"
import { FormFieldGroup } from "../form-section"

export function EnvColorPicker({
  value,
  onChange,
  disabled = false,
}: {
  value: string
  onChange: (token: string) => void
  disabled?: boolean
}): JSX.Element {
  const resolved = isEnvColorToken(value) ? value : "slate"

  return (
    <FormFieldGroup label="Color">
      <div className="flex flex-wrap gap-2">
        {ENV_COLOR_TOKENS.map((token) => {
          const active = token === resolved
          return (
            <button
              key={token}
              type="button"
              disabled={disabled}
              onClick={() => onChange(token)}
              className={[
                "h-7 w-7 rounded-full transition-shadow",
                active ? "ring-2 ring-accent ring-offset-2 ring-offset-base" : "ring-1 ring-border-subtle",
                disabled ? "cursor-not-allowed opacity-50" : "hover:ring-accent/60",
              ].join(" ")}
              style={{ background: envColorDot(token) }}
              title={token}
              aria-label={token}
              aria-pressed={active}
            />
          )
        })}
      </div>
    </FormFieldGroup>
  )
}

export function resolveEnvColor(value: string): EnvColorToken {
  return isEnvColorToken(value) ? value : "slate"
}
