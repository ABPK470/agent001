/**
 * Lightweight global keybind dispatcher.
 *
 * Linux/vim-style: Ctrl is the universal modifier on every platform
 * (no Cmd magic, no glyphs). Bindings are spelled `Ctrl+<key>` in
 * the help bar and `ev.ctrlKey` in code.
 *
 * Conventions:
 *   Ctrl+1 / Ctrl+2   focus stream / log pane
 *   Ctrl+R            open run picker
 *   Ctrl+F            focus log filter
 *   Ctrl+I            focus goal input
 *   Ctrl+L            clear log filter
 *   Esc               blur active input
 *
 * Slash commands (typed in the prompt):
 *   /admin            open admin login
 *   /runs             open run picker
 *   /logs             focus log pane
 *   /stream           focus stream pane
 *   /quit             sign out / switch user
 */

import { useEffect } from "react"

export type KeybindHandler = (key: string, ev: KeyboardEvent) => boolean | void

export function useGlobalKeybinds(handler: KeybindHandler): void {
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const handled = handler(ev.key, ev)
      if (handled) ev.preventDefault()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [handler])
}

/** Universal modifier check — Ctrl on all platforms (linux convention). */
export function isMeta(ev: KeyboardEvent): boolean {
  return ev.ctrlKey
}

/** Plain-text label for the meta key (used by HelpBar). */
export const META_LABEL = "Ctrl"
