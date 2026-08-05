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
 * Shared composer chrome — login intro + TermChat home.
 * Fill/border owned by `.chathome-chrome-pill` CSS (light = chat `--panel`).
 * One perimeter only — no extra ring (rings read as a second frame).
 */
export const CHAT_INPUT_PILL_CLASS =
  "chathome-chrome-pill border border-border transition-colors focus-within:border-border-strong"

/**
 * Widget tile already owns the surface — composer sits flush inside.
 * Dock still needs a top hairline so transcript and input don't merge.
 */
export const CHAT_INPUT_WIDGET_CLASS =
  "border-0 bg-transparent shadow-none ring-0 focus-within:border-0"

/** Widget input dock — gutters around the same bordered pill as home chat. */
export const WIDGET_CHAT_INPUT_DOCK_CLASS =
  "widget-content-gutter pb-3 pt-2 sm:pb-4"

/**
 * User goal row in the transcript — full width of the sticky row (capped).
 * The pin appendage shares this cap: the unpinned pill uses
 * `USER_GOAL_TEXT_MAX_CLASS` so the left pin slot is reserved *outside*
 * the pill (empty gutter), and text never shifts when the pin appears.
 * The pill itself is `w-fit` (hugs text); only long goals hit the max.
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

/**
 * Cursor/Copilot-style air under the last turn — content never sits flush
 * on the composer. Height owned by `.chat-transcript-bottom-paper` in CSS.
 */
export const CHAT_TRANSCRIPT_BOTTOM_PAPER_CLASS = "chat-transcript-bottom-paper"

/** Matches the paper clamp mid (`38vh`) — used for stick / fade near-bottom. */
export const CHAT_TRANSCRIPT_BOTTOM_PAPER_RATIO = 0.38

/** Minimum near-bottom slack when the scroll host is short. */
export const CHAT_TRANSCRIPT_NEAR_BOTTOM_MIN_PX = 120

/**
 * Hysteresis: leave "following" as soon as the user is this far from the floor.
 * Re-engage only inside the paper band (see near-bottom threshold) or Jump.
 */
export const CHAT_SCROLL_INTERRUPT_AWAY_PX = 40

/** Pixels from the scroll end that still count as following (within the paper). */
export function chatTranscriptNearBottomThresholdPx(hostClientHeight: number): number {
  return Math.max(
    CHAT_TRANSCRIPT_NEAR_BOTTOM_MIN_PX,
    Math.round(hostClientHeight * CHAT_TRANSCRIPT_BOTTOM_PAPER_RATIO),
  )
}

/** Distance from the content floor (0 = hard bottom). */
export function chatScrollDistanceFromBottom(host: {
  scrollHeight: number
  scrollTop: number
  clientHeight: number
}): number {
  return host.scrollHeight - host.scrollTop - host.clientHeight
}

export function homeChatColumnWidthPx(viewportWidth: number): number {
  return Math.min(viewportWidth * HOME_CHAT_WIDTH_RATIO, HOME_CHAT_MAX_WIDTH_PX)
}
