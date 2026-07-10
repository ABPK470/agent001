import { dot } from "./constants"

/** Tailwind-friendly accent tokens used for sync environment badges. */
export const ENV_COLOR_TOKENS = [
  "slate",
  "blue",
  "teal",
  "indigo",
  "pink",
  "cyan",
  "amber",
  "emerald",
  "rose",
] as const

export type EnvColorToken = (typeof ENV_COLOR_TOKENS)[number]

export function isEnvColorToken(value: string): value is EnvColorToken {
  return (ENV_COLOR_TOKENS as readonly string[]).includes(value)
}

export function envColorDot(token: string): string {
  return dot(isEnvColorToken(token) ? token : "slate")
}
