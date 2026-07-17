/**
 * Home / thread transcript layout — scroll column + edge fades.
 *
 * Edge fades are overlay gradients on the column shell, NOT mask-image on
 * the scrollport. Masking the scroll host clips assistant tables (rings /
 * right border) in home chat; widget mode never had masks.
 */

import { HOME_CHAT_COLUMN_CLASS } from "./chatLayout"

/** Scrollport must not use mask fades — they clip structured answer chrome. */
export const FORBIDDEN_HOME_TRANSCRIPT_SCROLL_MASK_CLASSES = [
  "chathome-column-scroll--fade-top",
  "chathome-column-scroll--fade-bottom",
  "chathome-column-scroll--fade-y",
] as const

export const HOME_TRANSCRIPT_COLUMN_SHELL_CLASS =
  `relative flex min-h-0 flex-1 flex-col min-w-0 ${HOME_CHAT_COLUMN_CLASS}`

/** Vertical scroll + horizontal scroll for wide markdown tables. */
export const HOME_TRANSCRIPT_SCROLL_CLASS =
  "relative h-full min-h-0 overflow-y-auto overflow-x-auto min-w-0"

export const HOME_TRANSCRIPT_FADE_TOP_CLASS = "chathome-transcript-fade chathome-transcript-fade--top"
export const HOME_TRANSCRIPT_FADE_BOTTOM_CLASS = "chathome-transcript-fade chathome-transcript-fade--bottom"

export interface TranscriptFadeEdges {
  top: boolean
  bottom: boolean
}

export function homeTranscriptScrollClassName(): string {
  return HOME_TRANSCRIPT_SCROLL_CLASS
}

export function homeTranscriptColumnShellClassName(): string {
  return HOME_TRANSCRIPT_COLUMN_SHELL_CLASS
}

export function transcriptFadeOverlayClass(edge: "top" | "bottom"): string {
  return edge === "top" ? HOME_TRANSCRIPT_FADE_TOP_CLASS : HOME_TRANSCRIPT_FADE_BOTTOM_CLASS
}
