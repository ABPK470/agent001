import { useEffect, useRef } from "react"

import { useStore } from "../store"

/** Initial load + silent reload when matching SSE events arrive. */
export function useLiveReload(
  load: () => void | Promise<void>,
  match: (eventType: string) => boolean,
): void {
  const tick = useStore((s) => s.sseEventLog.filter((e) => match(String(e.type))).length)
  const lastRef = useRef<number | null>(null)

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (lastRef.current === null) {
      lastRef.current = tick
      return
    }
    if (tick === lastRef.current) return
    lastRef.current = tick
    void load()
  }, [tick, load])
}
