/**
 * Shell chrome — chat and workspace must share one top-bar geometry.
 */

import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import {
  SHELL_CHROME_GAP,
  SHELL_CHROME_GAP_SM,
  SHELL_CHROME_HEADER_CHAT_CLASS,
  SHELL_CHROME_HEADER_CLASS,
  SHELL_CHROME_HEADER_H,
  SHELL_CHROME_HEADER_WORKSPACE_CLASS,
  SHELL_CHROME_PAD_X,
  SHELL_CHROME_PAD_X_SM,
  SHELL_CHROME_ROW_H,
} from "./shell-chrome"

const here = dirname(fileURLToPath(import.meta.url))

function readApp(rel: string): string {
  return readFileSync(resolve(here, rel), "utf8")
}

describe("shell chrome SOT", () => {
  it("exports one header height / row / inset for all modes", () => {
    expect(SHELL_CHROME_HEADER_H).toBe("3.5rem")
    expect(SHELL_CHROME_ROW_H).toBe("2.25rem")
    expect(SHELL_CHROME_PAD_X).toBe("1rem")
    expect(SHELL_CHROME_PAD_X_SM).toBe("1.5rem")
    expect(SHELL_CHROME_GAP).toBe("0.5rem")
    expect(SHELL_CHROME_GAP_SM).toBe("1rem")
  })

  it("workspace header extends the shared class (does not replace it)", () => {
    expect(SHELL_CHROME_HEADER_WORKSPACE_CLASS).toContain(SHELL_CHROME_HEADER_CLASS)
    expect(SHELL_CHROME_HEADER_WORKSPACE_CLASS).toContain("shell-chrome-header--workspace")
    expect(SHELL_CHROME_HEADER_WORKSPACE_CLASS).toContain("toolbar-shell")
    expect(SHELL_CHROME_HEADER_CHAT_CLASS).toBe(SHELL_CHROME_HEADER_CLASS)
  })

  it("chat home and workspace toolbar both import the shared header class", () => {
    const chat = readApp("home/ChatHomePage.tsx")
    const toolbar = readApp("workspace/Toolbar.tsx")
    const threads = readApp("../widgets/threads/ThreadHomePage.tsx")

    expect(chat).toContain("SHELL_CHROME_HEADER_CHAT_CLASS")
    expect(chat).toContain('from "../shell-chrome"')
    expect(toolbar).toContain("SHELL_CHROME_HEADER_WORKSPACE_CLASS")
    expect(toolbar).toContain('from "../shell-chrome"')
    expect(threads).toContain("SHELL_CHROME_HEADER_CHAT_CLASS")
    expect(threads).toContain('from "../../app/shell-chrome"')

    // Guard against drifting back to one-off Tailwind header geometry.
    expect(chat).not.toMatch(/className="relative z-20 flex h-14/)
    expect(toolbar).not.toMatch(/items-start gap-2 px-1 pt-2/)
    expect(threads).not.toMatch(/chathome-thread-chrome relative flex h-14/)
  })

  it("CSS wires the same token values onto .shell-chrome-header", () => {
    const css = readFileSync(resolve(here, "../boot/index.css"), "utf8")
    expect(css).toContain(`--shell-chrome-header-h: ${SHELL_CHROME_HEADER_H}`)
    expect(css).toContain(`--shell-chrome-row-h: ${SHELL_CHROME_ROW_H}`)
    expect(css).toContain(`--shell-chrome-pad-x: ${SHELL_CHROME_PAD_X}`)
    expect(css).toContain(`--shell-chrome-pad-x-sm: ${SHELL_CHROME_PAD_X_SM}`)
    expect(css).toMatch(/\.shell-chrome-header\s*\{/)
    // Workspace page frame — minimal breathe (sheet owns the viewport).
    expect(css).toContain("padding: 0.5rem")
    // One paper sheet (rail + stage) — no attached-tab silhouette / orphan gap.
    expect(css).toContain(".workspace-sheet")
    expect(css).not.toContain("workspace-sheet-outline")
    expect(css).not.toContain("--toolbar-stage-gap")
    expect(css).not.toContain("--stage-gap:")
  })
})
