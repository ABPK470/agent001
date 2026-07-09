/**
 * Grouped toolbar controls — shared track for listboxes, toggles, icon buttons.
 */

import type { JSX, ReactNode } from "react"
import { TAB_SEGMENT_TRACK, TOOLBAR_TRACK_DIVIDER } from "./chrome"

export function ToolbarTrack({ children }: { children: ReactNode }): JSX.Element {
  return <div className={TAB_SEGMENT_TRACK}>{children}</div>
}

export function ToolbarTrackDivider(): JSX.Element {
  return <span className={TOOLBAR_TRACK_DIVIDER} aria-hidden />
}
