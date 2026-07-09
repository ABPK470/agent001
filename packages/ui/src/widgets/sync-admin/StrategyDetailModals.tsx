import type { JSX } from "react"
import type { EntityRegistryDefinition, EntityRegistryStrategy, EntityRegistryStrategyHistoryEntry } from "../../types"
import { ModalShell } from "./chrome"
import { AdminModalCanvas, AdminModalRoot, FormSectionCard } from "./modal-layout"
import { AdminTable, AdminTd, AdminTh } from "./shared"

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

export function StrategyColumnsModal({ strategy, onClose }: { strategy: EntityRegistryStrategy; onClose: () => void }): JSX.Element {
  const rows: [string, string][] = [
    ["validFrom", strategy.validFromCol ?? "—"],
    ["validTo", strategy.validToCol ?? "—"],
    ["isLocked", strategy.isLockedCol ?? "—"],
    ["syncDate", strategy.syncDateCol ?? "—"],
    ["deployDate", strategy.deployDateCol ?? "—"],
    ["identity", strategy.identityHandling],
    ["excluded", strategy.excludedFromDiffCols.join(", ") || "—"],
  ]

  return (
    <ModalShell title="Column map" subtitle={strategy.id} size="focus" onClose={onClose}>
      <AdminModalRoot>
        <AdminModalCanvas>
          <FormSectionCard title="Column mapping">
            <dl className="grid grid-cols-[10rem_1fr] gap-x-4 gap-y-2 text-sm font-mono">
              {rows.map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="text-text-muted">{k}</dt>
                  <dd>{v}</dd>
                </div>
              ))}
            </dl>
          </FormSectionCard>
        </AdminModalCanvas>
      </AdminModalRoot>
    </ModalShell>
  )
}
