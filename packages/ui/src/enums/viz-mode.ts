/**
 * AgentViz operating mode.
 *   - Live    — streaming the active run's trace as it happens
 *   - Reflect — replaying a past run selected from history
 */
export const VizMode = {
  Live:    "live",
  Reflect: "reflect",
} as const

export type VizMode = (typeof VizMode)[keyof typeof VizMode]

export const VIZ_MODES: ReadonlyArray<VizMode> = Object.values(VizMode)

export const isVizMode = (value: unknown): value is VizMode =>
  typeof value === "string" && (VIZ_MODES as readonly string[]).includes(value)
