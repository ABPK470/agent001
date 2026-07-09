import type { SyncExecuteProgress } from "../../types"

export type ExecState =
  | { kind: "idle" }
  | { kind: "running"; events: SyncExecuteProgress[]; startedAt: number; lastEventAt: number }
  | { kind: "done"; success: boolean; skipped?: boolean; events: SyncExecuteProgress[]; error?: string; message?: string }

export type ModalKind = null | "definition" | "history"

export interface SearchHit {
  id: string | number
  name: string | null
}