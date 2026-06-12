/**
 * Threads widget — pick the active thread and run for all chat widgets.
 */

import { ThreadRunsPanel } from "../features/threads/ThreadRunsPanel"

export function ThreadNav() {
  return (
    <div className="h-full min-h-0 flex flex-col bg-panel">
      <ThreadRunsPanel variant="widget" />
    </div>
  )
}
