/**
 * Top-level App lifecycle phase. Drives the boot/login/logout transitions
 * in `App.tsx`.
 *
 *   - Loading — initial whoami fetch in flight; blank screen
 *   - Login   — not authenticated; <WelcomeFlow/> renders intro + form
 *   - Shell   — authenticated; dashboard visible
 *   - Outro   — logout in progress; mosaic covers inward, then logout
 *               fires and we land back on Login (which plays intro)
 */
export const AppPhase = {
  Loading: "loading",
  Login:   "login",
  Shell:   "shell",
  Outro:   "outro",
} as const

export type AppPhase = (typeof AppPhase)[keyof typeof AppPhase]

export const APP_PHASES: ReadonlyArray<AppPhase> = Object.values(AppPhase)

export const isAppPhase = (value: unknown): value is AppPhase =>
  typeof value === "string" && (APP_PHASES as readonly string[]).includes(value)
