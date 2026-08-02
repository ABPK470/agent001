/**
 * Skip global hotkeys when the user is typing in an editable field.
 */

export function isEditableKeyboardTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true
  if (target.isContentEditable) return true
  if (target.closest(".widget-content input, .widget-content textarea, .widget-content [contenteditable='true']")) {
    return true
  }
  return false
}
