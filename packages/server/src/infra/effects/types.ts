import { EffectKind, EffectStatus } from "../../internal/enums/effects.js"
// ── Types ────────────────────────────────────────────────────────

export { EffectKind, EffectStatus }

export interface Effect {
  id: string
  runId: string
  seq: number
  kind: EffectKind
  tool: string
  target: string
  preHash: string | null
  postHash: string | null
  status: EffectStatus
  metadata: Record<string, unknown>
  createdAt: string
}

export interface FileSnapshot {
  id: string
  effectId: string
  runId: string
  filePath: string
  content: string | null
  hash: string | null
  createdAt: string
}

export interface RollbackResult {
  total: number
  compensated: number
  skipped: number
  failed: Array<{ effectId: string; target: string; reason: string }>
}

export interface RollbackPreview {
  wouldCompensate: Array<{ effectId: string; target: string; kind: EffectKind; hasSnapshot: boolean }>
  wouldSkip: Array<{ effectId: string; target: string; reason: string }>
  wouldFail: Array<{ effectId: string; target: string; reason: string }>
}
