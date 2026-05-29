import type { SyncExecuteProgress } from "../../types"

export type ExecState =
  | { kind: "idle" }
  | { kind: "running"; events: SyncExecuteProgress[] }
  | { kind: "done"; success: boolean; events: SyncExecuteProgress[]; error?: string }

export type ModalKind = null | "definition" | "history"

export interface SearchHit {
  id: string | number
  name: string | null
}