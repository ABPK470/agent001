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
 * User goal row in the transcript — full width of the sticky row (capped).
 * The pin appendage shares this cap: text is limited to
 * `USER_GOAL_TEXT_MAX_CLASS` so the left pin slot is reserved *outside*
 * the unpinned pill (empty gutter), and text never shifts when the pin appears.
 */
export const USER_GOAL_COLUMN_CLASS = "w-full max-w-[82%] min-w-0"

/** Pin-slot width; must match the appendage button in UserGoalBubble. */
export const USER_GOAL_PIN_SLOT_CLASS = "w-10"

/** Text-area cap inside USER_GOAL_COLUMN_CLASS (100% − pin slot). */
export const USER_GOAL_TEXT_MAX_CLASS = "max-w-[calc(100%-2.5rem)]"

/**
 * Vertical gap between the user goal pill and the agent response / status
 * (answer, error, cancelled, …). Shared by home chat and the MI:A Chat
 * widget — use as `flex flex-col` + this gap (not margin) so sticky
 * goals cannot collapse the spacing.
 */
export const USER_GOAL_TO_RESPONSE_GAP_CLASS = "gap-6"

export function homeChatColumnWidthPx(viewportWidth: number): number {
  return Math.min(viewportWidth * HOME_CHAT_WIDTH_RATIO, HOME_CHAT_MAX_WIDTH_PX)
}
