import { describe, expect, it } from "vitest"
import {
  WIDGET_LOG_INSET_CLASS,
  WIDGET_LOG_SHELL_CLASS,
  WIDGET_LOG_STACK_CLASS,
} from "./widget-toolbar"

describe("widget log chrome (Event Stream / Pipelines / Sync)", () => {
  it("shares the same inset and toolbar→body gap", () => {
    expect(WIDGET_LOG_INSET_CLASS).toContain("pt-3")
    expect(WIDGET_LOG_INSET_CLASS).toContain("px-3")
    expect(WIDGET_LOG_INSET_CLASS).toContain("pb-1")
    expect(WIDGET_LOG_SHELL_CLASS).toContain(WIDGET_LOG_INSET_CLASS)
    expect(WIDGET_LOG_STACK_CLASS).toContain("gap-3")
  })
})
