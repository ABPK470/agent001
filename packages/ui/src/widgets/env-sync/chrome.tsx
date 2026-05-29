import { AlertTriangle, History, Loader2, Ship, X, XCircle } from "lucide-react"
import type { ReactNode } from "react"
import { createPortal } from "react-dom"

import type { SyncEnvironment } from "../../types"

export function ModalShell({ title, subtitle, icon, onClose, children }: { title: string; subtitle?: string; icon?: ReactNode; onClose: () => void; children: ReactNode }) {
  return createPortal(
    <div className="fixed inset-0 z-[200] bg-scrim flex items-center justify-center p-2 sm:p-4" onClick={onClose}>
      <div className="w-full h-full max-w-5xl sm:max-h-[85vh] bg-surface flex flex-col shadow-2xl overflow-hidden rounded-xl sm:rounded-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-border-subtle shrink-0">
          <div className="flex items-center gap-2.5">
            {icon}
            <h2 className="text-lg font-semibold text-text">{title}</h2>
            {subtitle && <span className="text-sm text-text-muted font-mono">{subtitle}</span>}
          </div>
          <button onClick={onClose} className="text-text-muted hover:text-text p-1.5 rounded-lg hover:bg-overlay-3 transition-colors"><X size={18} /></button>
        </div>
        <div className="flex-1 overflow-y-auto">{children}</div>
      </div>
    </div>,
    document.body,
  )
}

export function Err({ children }: { children: ReactNode }) {
  return (
    <div className="px-4 py-3 m-3 text-sm text-error bg-error/10 border border-error/30 rounded flex items-start gap-2 min-w-0">
      <XCircle size={14} className="mt-0.5 shrink-0" />
      <span className="font-mono whitespace-pre-wrap break-all min-w-0">{children}</span>
    </div>
  )
}

export function Loading({ children }: { children: ReactNode }) {
  return <div className="flex-1 flex items-center justify-center gap-2 text-text-muted text-sm"><Loader2 size={14} className="animate-spin" />{children}</div>
}

export function Empty({ envs, blocker, srcEnv, tgtEnv, hasDefinitions }: {
  envs: SyncEnvironment[]
  blocker: string | null
  srcEnv: SyncEnvironment | null
  tgtEnv: SyncEnvironment | null
  hasDefinitions: boolean
}) {
  if (envs.length < 2) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="max-w-md px-6 text-sm text-text-muted text-center space-y-2">
          <AlertTriangle size={20} className="mx-auto text-warning opacity-60" />
          <p>Need at least 2 environments.</p>
          <p className="text-xs">Add another to <span className="font-mono text-text">MSSQL_DATABASES</span> in <span className="font-mono text-text">.env</span>.</p>
        </div>
      </div>
    )
  }
  return (
    <div className="flex-1 flex flex-col items-center justify-center text-center gap-3">
      <Ship size={20} className="text-text-muted opacity-40" />
      <p className="text-sm text-text-muted">{blocker ?? "Select entity and click Preview"}</p>
      {!hasDefinitions && <p className="text-xs text-warning">No published definitions loaded</p>}
      {srcEnv && tgtEnv && !blocker && (
        <p className="text-xs text-text-muted font-mono">{srcEnv.displayName} → {tgtEnv.displayName}</p>
      )}
    </div>
  )
}

export function EmptyHistory() {
  return (
    <div className="flex flex-col items-center justify-center min-h-[200px] text-text-muted gap-2 py-12">
      <History size={20} className="opacity-40" />
      <p className="text-sm">No sync history yet</p>
    </div>
  )
}