import { AlertTriangle, History, Loader2, Ship, Upload, XCircle } from "lucide-react"
import type { ReactNode } from "react"

import { EmptyState } from "../../components/EmptyState"
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

export function Empty({
  envs,
  blocker,
  srcEnv,
  tgtEnv,
  hasDefinitions,
  publishArmed,
}: {
  envs: SyncEnvironment[]
  blocker: string | null
  srcEnv: SyncEnvironment | null
  tgtEnv: SyncEnvironment | null
  hasDefinitions: boolean
  /** Tip ahead of published bundle — Publish is armed in Entity Registry. */
  publishArmed?: boolean
}) {
  const readyCount = envs.filter((env) => env.connectorReady === true).length

  if (envs.length < 2) {
    return (
      <EmptyState
        icon={AlertTriangle}
        message="Need at least 2 sync environments."
        detail={
          <>
            Add them in{" "}
            <span className="text-text">Entity Registry → Configuration → Environments</span>
            , each linked to an enabled MSSQL connector.
          </>
        }
        className="[&_svg]:text-warning [&_svg]:opacity-60"
      />
    )
  }

  if (readyCount < 2) {
    return (
      <EmptyState
        icon={AlertTriangle}
        message="Need at least 2 environments with ready connectors."
        detail={
          <>
            Enable MSSQL connectors in{" "}
            <span className="text-text">Connectors</span>
            , and ensure each environment’s connector is linked and enabled.
          </>
        }
        className="[&_svg]:text-warning [&_svg]:opacity-60"
      />
    )
  }

  // Sync preview/execute reads the published bundle — tip-only config is not enough.
  if (!hasDefinitions) {
    return (
      <EmptyState
        icon={Upload}
        message="Publish required before Sync can run."
        detail={
          <>
            Sync uses the published catalog bundle. Open{" "}
            <span className="text-text">Entity Registry → Publish</span>
            {publishArmed ? " (armed — tip is ahead of the published contract)." : "."}
          </>
        }
        className="[&_svg]:text-warning [&_svg]:opacity-60"
      />
    )
  }

  if (publishArmed && (blocker?.toLowerCase().includes("publish") ?? false)) {
    return (
      <EmptyState
        icon={Upload}
        message={blocker ?? "Publish required"}
        detail={
          <>
            Catalog tip is ahead of the published contract. Publish from{" "}
            <span className="text-text">Entity Registry</span> before previewing this entity.
          </>
        }
        className="[&_svg]:text-warning [&_svg]:opacity-60"
      />
    )
  }

  return (
    <EmptyState
      icon={Ship}
      message={blocker ?? "Select entity and click Preview"}
      detail={
        <>
          {srcEnv && tgtEnv && !blocker && (
            <p className="font-mono">
              {srcEnv.displayName} → {tgtEnv.displayName}
            </p>
          )}
        </>
      }
    />
  )
}

export function EmptyHistory({
  message = "No sync history yet",
  action,
}: {
  message?: string
  action?: ReactNode
}) {
  return <EmptyState icon={History} message={message} action={action} />
}
