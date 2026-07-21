/**
 * Sticky user-goal pin geometry — TermChat home vs widget.
 * Pure so stuck detection and pin-slot layout stay regression-tested.
 */

import {
  STICKY_GOAL_HOME_OFFSET_PX,
  STICKY_GOAL_HOME_TOP,
} from "../../components/StickyUserGoal"
import {
  USER_GOAL_COLUMN_CLASS,
  USER_GOAL_PIN_SLOT_CLASS,
  USER_GOAL_TEXT_MAX_CLASS,
} from "../../app/chatLayout"

export type GoalPinProfile = "home" | "widget"

export type GoalPinLayout = {
  stickyOffsetPx: number
  topClass: string
  stuckScrollThreshold: number
}

/** Pin/unpin dot layout — home + thread share one profile; widget has its own. */
export function goalPinLayout(profile: GoalPinProfile): GoalPinLayout {
  if (profile === "widget") {
    // Widget scroll host uses py-5; align sticky + stuck detection with that inset.
    return { stickyOffsetPx: 20, topClass: "top-5", stuckScrollThreshold: 6 }
  }
  return {
    stickyOffsetPx: STICKY_GOAL_HOME_OFFSET_PX,
    topClass: STICKY_GOAL_HOME_TOP,
    stuckScrollThreshold: 20,
  }
}

export type GoalStuckRects = {
  hostTop: number
  hostBottom: number
  scrollTop: number
  sentinelBottom: number
  stickyTop: number
  stickyBottom: number
}

/**
 * Whether the unpin dot should show — mirrors ChatTurn.updateStuck.
 * Widget: sentinel past stick line. Home: sentinel past + sticky visible at line.
 */
export function computeGoalStuck(
  profile: GoalPinProfile,
  layout: GoalPinLayout,
  rects: GoalStuckRects,
): boolean {
  const stickLine = rects.hostTop + layout.stickyOffsetPx
  const scrolled = rects.scrollTop > layout.stuckScrollThreshold
  if (!scrolled) return false

  if (profile === "widget") {
    return rects.sentinelBottom <= stickLine
  }

  const sentinelPast = rects.sentinelBottom < stickLine - 4
  const stickyVisible =
    rects.stickyBottom > rects.hostTop && rects.stickyTop < rects.hostBottom
  const atStickLine = rects.stickyTop <= stickLine + 1
  return sentinelPast && stickyVisible && atStickLine
}

/**
 * Unpinned: text caps at column − pin slot (empty gutter outside the pill).
 * Pinned: pin fills that gutter — text must not shift.
 */
export function userGoalTextClass(showUnpin: boolean): string {
  return showUnpin ? "" : USER_GOAL_TEXT_MAX_CLASS
}

export function userGoalPinSlotClass(): string {
  return USER_GOAL_PIN_SLOT_CLASS
}

export function userGoalColumnClass(): string {
  return USER_GOAL_COLUMN_CLASS
}
