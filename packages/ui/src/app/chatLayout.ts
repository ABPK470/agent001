/**
 * Shared layout tokens for home chat — login intro, ChatHomePage, TermChat
 * mode=home, and thread-rail alignment must stay in sync.
 */

export const HOME_CHAT_MAX_WIDTH_PX = 960
export const HOME_CHAT_WIDTH_RATIO = 0.94

/** Transcript column, hero copy, and docked input bar share this width. */
export const HOME_CHAT_COLUMN_CLASS = "w-[94%] max-w-[960px] mx-auto"

/** Horizontal inset on scroll + input dock (matches TermChat home). */
export const HOME_CHAT_GUTTER_X_CLASS = "px-6"

/** Bottom input dock wrapper (matches TermChat when transcript is non-empty). */
export const HOME_CHAT_INPUT_DOCK_CLASS = "relative shrink-0 px-6 pb-4 pt-2"

/**
 * User goal row — hug content, cap at 82% of the transcript column.
 * `w-fit` keeps short goals tight; long goals grow up to the cap.
 */
export const USER_GOAL_COLUMN_CLASS = "w-fit max-w-[82%] min-w-0"

/** Pin-slot width; must match the appendage button in UserGoalBubble. */
export const USER_GOAL_PIN_SLOT_CLASS = "w-10"

/** Bubble shell inside the goal column — never force full column width. */
export const USER_GOAL_TEXT_MAX_CLASS = "w-fit max-w-full"

export function homeChatColumnWidthPx(viewportWidth: number): number {
  return Math.min(viewportWidth * HOME_CHAT_WIDTH_RATIO, HOME_CHAT_MAX_WIDTH_PX)
}
