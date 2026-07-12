import { AlertTriangle, History, Loader2, Ship, XCircle } from "lucide-react"
import type { ReactNode } from "react"

import type { SyncEnvironment } from "../../types"
import {
  ModalShell as RegistryModalShell,
  type ModalShellScrim,
  type ModalShellSize,
} from "../entity-registry/ModalShell"

export type { ModalShellSize, ModalShellScrim }

export function ModalShell({
  title,
  subtitle,
  icon,
  onClose,
  children,
  footer,
  size = "default",
  scrim,
  stackLevel = 0,
  panelClassName,
}: {
  title: string
  subtitle?: string
  icon?: ReactNode
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  size?: ModalShellSize
  scrim?: ModalShellScrim
  stackLevel?: number
  /** @deprecated Prefer size="default" | "focus" — overrides panel width when set. */
  panelClassName?: string
}) {
  return (
    <RegistryModalShell
      title={title}
      subtitle={subtitle}
      icon={icon}
      onClose={onClose}
      size={size}
      scrim={scrim}
      stackLevel={stackLevel}
      widthClass={panelClassName}
      footer={footer}
    >
      {children}
    </RegistryModalShell>
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

export function EmptyHistory({
  message = "No sync history yet",
  action,
}: {
  message?: string
  action?: ReactNode
}) {
  return (
    <div className="flex flex-col items-center justify-center min-h-[200px] text-text-muted gap-2 py-12">
      <History size={20} className="opacity-40" />
      <p className="text-sm">{message}</p>
      {action}
    </div>
  )
}
