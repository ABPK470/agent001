import type { JSX } from "react"
import type { EntityRegistryDefinition, EntityRegistryStrategy, EntityRegistryStrategyHistoryEntry } from "../../../types"
import { ModalShell } from "../ModalShell"
import { AdminModalCanvas, AdminModalRoot, FormSectionCard } from "../governance/modal-layout"
import { AdminTable, AdminTd, AdminTh } from "../../sync-admin/shared"
import { IDENTITY_OPTIONS } from "./strategy-helpers"

export function StrategyHistoryModal({
  strategy,
  history,
  stackLevel = 1,
  onClose,
}: {
  strategy: EntityRegistryStrategy
  history: EntityRegistryStrategyHistoryEntry[]
  stackLevel?: number
  onClose: () => void
}): JSX.Element {
  return (
    <ModalShell title="Version history" subtitle={strategy.id} size="focus" stackLevel={stackLevel} onClose={onClose}>
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
                {history.map((entry) => (
                  <tr key={entry.version} className={entry.version === strategy.version ? "bg-accent/5" : undefined}>
                    <AdminTd className="font-mono">{entry.version}</AdminTd>
                    <AdminTd className="font-mono text-text-muted">{entry.createdAt.slice(0, 16)}</AdminTd>
                    <AdminTd className="font-mono">{entry.createdBy}</AdminTd>
                    <AdminTd>{entry.reason}</AdminTd>
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
  stackLevel = 1,
  onClose,
}: {
  strategyId: string
  entities: EntityRegistryDefinition[]
  stackLevel?: number
  onClose: () => void
}): JSX.Element {
  return (
    <ModalShell title="Entities" subtitle={strategyId} size="focus" stackLevel={stackLevel} onClose={onClose}>
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
                  {entities.map((definition) => (
                    <tr key={definition.id}>
                      <AdminTd className="font-mono">{definition.id}</AdminTd>
                      <AdminTd className="font-mono">{String(definition.scd2.strategyVersion)}</AdminTd>
                      <AdminTd className="font-mono">{definition.rootTable}</AdminTd>
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

export function StrategyPolicyModal({
  strategy,
  stackLevel = 1,
  onClose,
}: {
  strategy: EntityRegistryStrategy
  stackLevel?: number
  onClose: () => void
}): JSX.Element {
  const identityLabel = IDENTITY_OPTIONS.find((option) => option.value === strategy.identityHandling)?.label
    ?? strategy.identityHandling

  return (
    <ModalShell title="Policy document" subtitle={strategy.id} size="focus" stackLevel={stackLevel} onClose={onClose}>
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

export const StrategyColumnsModal = StrategyPolicyModal
