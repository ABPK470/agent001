import { useCallback, useMemo, useRef, useState } from "react"
import type { CommandConsoleApi, CommandConsoleLine } from "./commandConsoleModel"
import { helpEntriesFromCommands } from "./commandConsoleModel"

function withIds(blocks: Omit<CommandConsoleLine, "id">[]): CommandConsoleLine[] {
  return blocks.map((block, index) => ({ ...block, id: `cmd-${index}` }))
}

export function useCommandConsole() {
  const [lines, setLines] = useState<CommandConsoleLine[]>([])
  const [pinnedOpen, setPinnedOpen] = useState(false)
  const batchRef = useRef<Omit<CommandConsoleLine, "id">[] | null>(null)

  const commit = useCallback((blocks: Omit<CommandConsoleLine, "id">[]) => {
    setLines(withIds(blocks))
    setPinnedOpen(blocks.length > 0)
  }, [])

  const push = useCallback((block: Omit<CommandConsoleLine, "id">) => {
    if (batchRef.current) {
      batchRef.current.push(block)
      return
    }
    commit([block])
  }, [commit])

  const beginBatch = useCallback(() => {
    batchRef.current = []
  }, [])

  const endBatch = useCallback(() => {
    if (!batchRef.current) return
    const blocks = batchRef.current
    batchRef.current = null
    commit(blocks)
  }, [commit])

  const api: CommandConsoleApi = useMemo(
    () => ({
      open: () => setPinnedOpen(true),
      beginBatch,
      endBatch,
      logInput: () => {},
      logText: (text) => push({ kind: "text", text }),
      logSuccess: (text) => push({ kind: "success", text }),
      logError: (text) => push({ kind: "error", text }),
      logHelp: (commands) =>
        push({ kind: "help", help: helpEntriesFromCommands(commands) }),
      logRows: (rows) => push({ kind: "rows", rows }),
      logList: (list) => push({ kind: "list", list }),
    }),
    [beginBatch, endBatch, push],
  )

  const clear = useCallback(() => {
    batchRef.current = null
    setLines([])
    setPinnedOpen(false)
  }, [])

  const dismiss = useCallback(() => {
    setPinnedOpen(false)
  }, [])

  return {
    lines,
    pinnedOpen,
    api,
    clear,
    dismiss,
    setPinnedOpen,
  }
}

export type CommandConsoleState = ReturnType<typeof useCommandConsole>
