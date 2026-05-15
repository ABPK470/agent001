/**
 * IOE (Operator Environment) tab / panel identifiers. These were previously
 * declared as bare string-union types in `widgets/ioe/constants.ts`; promoted
 * to enums so any new section/tab is forced to land in one place and switch
 * arms can be checked exhaustively.
 */

/** Sidebar (left rail) section. */
export const SidebarSection = {
  Runs:    "runs",
  Compare: "compare",
  Details: "details",
} as const

export type SidebarSection = (typeof SidebarSection)[keyof typeof SidebarSection]

export const SIDEBAR_SECTIONS: ReadonlyArray<SidebarSection> = Object.values(SidebarSection)

export const isSidebarSection = (value: unknown): value is SidebarSection =>
  typeof value === "string" && (SIDEBAR_SECTIONS as readonly string[]).includes(value)

/** Main editor area tab. */
export const EditorTab = {
  ToolTimeline: "tool-timeline",
  LlmCalls:     "llm-calls",
  Map:          "map",
} as const

export type EditorTab = (typeof EditorTab)[keyof typeof EditorTab]

export const EDITOR_TABS: ReadonlyArray<EditorTab> = Object.values(EditorTab)

export const isEditorTab = (value: unknown): value is EditorTab =>
  typeof value === "string" && (EDITOR_TABS as readonly string[]).includes(value)

/** Bottom-bar tab. */
export const BottomTab = {
  Output:   "output",
  Audit:    "audit",
  Problems: "problems",
} as const

export type BottomTab = (typeof BottomTab)[keyof typeof BottomTab]

export const BOTTOM_TABS: ReadonlyArray<BottomTab> = Object.values(BottomTab)

export const isBottomTab = (value: unknown): value is BottomTab =>
  typeof value === "string" && (BOTTOM_TABS as readonly string[]).includes(value)

/** Side a resizable panel docks to. */
export const PanelSide = {
  Left:  "left",
  Right: "right",
} as const

export type PanelSide = (typeof PanelSide)[keyof typeof PanelSide]

export const PANEL_SIDES: ReadonlyArray<PanelSide> = Object.values(PanelSide)

export const isPanelSide = (value: unknown): value is PanelSide =>
  typeof value === "string" && (PANEL_SIDES as readonly string[]).includes(value)
