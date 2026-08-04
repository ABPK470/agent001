import { IntroAsciiField } from "./home/IntroAsciiField"

/** Full-viewport ASCII curtain slides off left → right; shell swaps underneath. */
export function ShellModeSweep() {
  return (
    <div className="shell-mode-sweep absolute inset-0 z-10 overflow-hidden pointer-events-none">
      <div className="shell-mode-sweep-curtain" aria-hidden="true">
        <IntroAsciiField boost surface="home" />
      </div>
    </div>
  )
}
