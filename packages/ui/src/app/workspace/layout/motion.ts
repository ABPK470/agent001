export function entranceClassName(isEntering: boolean): string {
  return isEntering ? "workspace-tile-entering" : "workspace-tile-entered"
}

export const ENTRANCE_STYLE = {
  entering: { transform: "translateY(12px)", opacity: 0.85 },
  entered: { transform: "translateY(0)", opacity: 1 },
} as const
