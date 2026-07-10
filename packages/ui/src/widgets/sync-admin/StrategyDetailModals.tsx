import type { JSX } from "react"
import type { EntityRegistryDefinition, EntityRegistryStrategy, EntityRegistryStrategyHistoryEntry } from "../../types"
import { ModalShell } from "./chrome"
import { AdminModalCanvas, AdminModalRoot, FormSectionCard } from "./modal-layout"
import { AdminTable, AdminTd, AdminTh } from "./shared"
import { IDENTITY_OPTIONS } from "./strategy-helpers"

export function StrategyHistoryModal({
  strategy,
  history,
  onClose,
}: {
  strategy: EntityRegistryStrategy
  history: EntityRegistryStrategyHistoryEntry[]
  onClose: () => void
}): JSX.Element {
  return (
    <ModalShell title="Version history" subtitle={strategy.id} size="focus" onClose={onClose}>
      <AdminModalRoot>
        <AdminModalCanvas>
          <FormSectionCard title="Versions">
            <AdminTable>
              <thead>
                <tr>
                  <AdminTh>Ver</AdminTh>
                  <AdminTh>When</AdminTh>
                  <AdminTh>By</AdminTh>
                  <AdminTh>Reason</AdminTh>
                </tr>
              </thead>
              <tbody>
                {history.map((h) => (
                  <tr key={h.version} className={h.version === strategy.version ? "bg-accent/5" : undefined}>
                    <AdminTd className="font-mono">{h.version}</AdminTd>
                    <AdminTd className="font-mono text-text-muted">{h.createdAt.slice(0, 16)}</AdminTd>
                    <AdminTd className="font-mono">{h.createdBy}</AdminTd>
                    <AdminTd>{h.reason}</AdminTd>
                  </tr>
                ))}
              </tbody>
            </AdminTable>
          </FormSectionCard>
        </AdminModalCanvas>
      </AdminModalRoot>
    </ModalShell>
  )
}

export function StrategyEntitiesModal({
  strategyId,
  entities,
  onClose,
}: {
  strategyId: string
  entities: EntityRegistryDefinition[]
  onClose: () => void
}): JSX.Element {
  return (
    <ModalShell title="Entities" subtitle={strategyId} size="focus" onClose={onClose}>
      <AdminModalRoot>
        <AdminModalCanvas>
          {entities.length === 0 ? (
            <p className="text-sm text-text-muted">No references.</p>
          ) : (
            <FormSectionCard title="Entity references">
              <AdminTable>
                <thead>
                  <tr>
                    <AdminTh>Entity</AdminTh>
                    <AdminTh>Pin</AdminTh>
                    <AdminTh>Root</AdminTh>
                  </tr>
                </thead>
                <tbody>
                  {entities.map((d) => (
                    <tr key={d.id}>
                      <AdminTd className="font-mono">{d.id}</AdminTd>
                      <AdminTd className="font-mono">{String(d.scd2.strategyVersion)}</AdminTd>
                      <AdminTd className="font-mono">{d.rootTable}</AdminTd>
                    </tr>
                  ))}
                </tbody>
              </AdminTable>
            </FormSectionCard>
          )}
        </AdminModalCanvas>
      </AdminModalRoot>
    </ModalShell>
  )
}

export function StrategyPolicyModal({ strategy, onClose }: { strategy: EntityRegistryStrategy; onClose: () => void }): JSX.Element {
  const identityLabel = IDENTITY_OPTIONS.find((o) => o.value === strategy.identityHandling)?.label ?? strategy.identityHandling

  return (
    <ModalShell title="Policy document" subtitle={strategy.id} size="focus" onClose={onClose}>
      <AdminModalRoot>
        <AdminModalCanvas>
          <FormSectionCard title="Exclude from diff">
            <p className="font-mono text-sm">{strategy.excludeFromDiff.join(", ") || "—"}</p>
          </FormSectionCard>
          <FormSectionCard title="On insert">
            <pre className="overflow-x-auto font-mono text-xs">{JSON.stringify(strategy.onInsert, null, 2)}</pre>
          </FormSectionCard>
          <FormSectionCard title="On update">
            <pre className="overflow-x-auto font-mono text-xs">{JSON.stringify(strategy.onUpdate, null, 2)}</pre>
          </FormSectionCard>
          <FormSectionCard title="Identity handling">
            <p className="text-sm">{identityLabel}</p>
          </FormSectionCard>
        </AdminModalCanvas>
      </AdminModalRoot>
    </ModalShell>
  )
}

/** @deprecated Use StrategyPolicyModal */
export const StrategyColumnsModal = StrategyPolicyModal
