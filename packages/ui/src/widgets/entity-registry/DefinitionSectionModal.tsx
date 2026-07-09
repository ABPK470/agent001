import type { JSX } from "react"
import type { EntityRegistryDefinition, SyncDefinitionAdminItem } from "../../types"
import { PANEL } from "./chrome"
import { DetailField, DetailGrid, DetailSection } from "./DetailField"
import { EntityTablesExplorer } from "./EntityTablesExplorer"
import {
  buildDefinitionSections,
  provenanceLabel,
  type DefinitionRunSummary,
  type DefinitionSectionId,
} from "./definition-helpers"
import { ModalShell } from "./ModalShell"
import { PhasedStepList } from "./PhasedStepList"

function IdentitySection({ def }: { def: EntityRegistryDefinition }): JSX.Element {
  return (
    <div className="space-y-1">
      <DetailGrid>
        <DetailField label="Display name" value={def.displayName} />
        <DetailField label="Entity id" value={def.id} mono />
        <DetailField label="Root table" value={def.rootTable} mono />
        <DetailField label="ID column" value={def.idColumn} mono />
        <DetailField label="Label column" value={def.labelColumn} mono />
        <DetailField label="Self-join column" value={def.selfJoinColumn} mono />
        <DetailField label="Tenant" value={def.tenantId} mono />
        <DetailField label="Revision" value={String(def.version)} />
        {def.description?.trim() && (
          <DetailField label="Description" value={def.description} span={2} />
        )}
      </DetailGrid>
      <DetailSection>
        <DetailGrid>
          <DetailField label="Provenance" value={provenanceLabel(def.provenance)} />
          <DetailField label="Created by" value={def.createdBy} mono />
          <DetailField label="Created at" value={new Date(def.createdAt).toLocaleString()} />
          <DetailField label="Last reason" value={def.reason} />
          {def.retiredAt && (
            <DetailField label="Retired at" value={new Date(def.retiredAt).toLocaleString()} />
          )}
          {def.legacyEntrySproc && (
            <DetailField label="Legacy entry sproc" value={def.legacyEntrySproc} mono span={2} />
          )}
        </DetailGrid>
      </DetailSection>
      {def.discrepancies.length > 0 && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
          <p className="mb-2 text-xs font-medium uppercase tracking-wider text-amber-600">
            Discrepancies
          </p>
          <ul className="space-y-1 text-xs text-text-muted">
            {def.discrepancies.map((item) => (
              <li key={item} className="font-mono">{item}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

function Scd2Section({ def }: { def: EntityRegistryDefinition }): JSX.Element {
  const override = def.scd2.entityOverride
  return (
    <div className="space-y-1">
      <DetailGrid>
        <DetailField label="Strategy" value={def.scd2.strategyId} mono />
        <DetailField
          label="Version"
          value={def.scd2.strategyVersion === "latest" ? "latest" : `v${def.scd2.strategyVersion}`}
        />
      </DetailGrid>
      {override ? (
        <DetailSection title="Entity override">
          <DetailGrid>
            <DetailField label="Valid from" value={override.validFromCol} mono />
            <DetailField label="Valid to" value={override.validToCol} mono />
            <DetailField label="Is locked" value={override.isLockedCol} mono />
            <DetailField label="Sync date" value={override.syncDateCol} mono />
            <DetailField label="Deploy date" value={override.deployDateCol} mono />
            <DetailField label="Identity handling" value={override.identityHandling} mono />
          </DetailGrid>
        </DetailSection>
      ) : (
        <DetailSection>
          <p className="text-sm text-text-muted">No entity-level SCD2 override.</p>
        </DetailSection>
      )}
    </div>
  )
}

function PoliciesSection({ def }: { def: EntityRegistryDefinition }): JSX.Element {
  const freezes = def.policies.freezeWindowIds
  return (
    <div className="space-y-3">
      <p className="text-sm text-text-muted">
        When active, these windows block sync execute unless overridden.
      </p>
      <div className="modal-detail-field">
        <span className="modal-detail-field__label">Freeze windows</span>
        {freezes.length === 0 ? (
          <p className="modal-detail-field__value text-xs text-text-muted">None configured.</p>
        ) : (
          <ul className={PANEL}>
            {freezes.map((id) => (
              <li
                key={id}
                className="border-b border-border-subtle px-3 py-2 font-mono text-xs text-text last:border-b-0"
              >
                {id}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

function TablesSection({ def }: { def: EntityRegistryDefinition }): JSX.Element {
  return <EntityTablesExplorer tables={def.tables} />
}

function LineageSection({ def }: { def: EntityRegistryDefinition }): JSX.Element {
  return (
    <ol className={PANEL}>
      {def.lineageRefs.map((ref, index) => (
        <li key={`${ref.object}-${index}`} className="border-b border-border-subtle px-3 py-2.5 last:border-b-0">
          <p className="font-mono text-xs text-text">{ref.object}</p>
          <p className="mt-0.5 text-sm text-text-muted">
            {ref.kind}
            {ref.note?.trim() ? ` · ${ref.note}` : ""}
          </p>
        </li>
      ))}
    </ol>
  )
}

function RunSection({ runConfig }: { runConfig: SyncDefinitionAdminItem | null }): JSX.Element {
  if (!runConfig) {
    return (
      <p className="text-sm text-text-muted">
        No run binding yet. Use <span className="font-medium text-text">⋯ → Edit → Run</span> to pick a flow, service, and environment.
      </p>
    )
  }

  return (
    <div className="space-y-3">
      <DetailGrid>
        <DetailField label="Flow" value={runConfig.flowTemplateId} mono />
        <DetailField label="Service" value={runConfig.serviceProfileRef} mono />
        <DetailField label="Environment" value={runConfig.environmentPolicyRef} mono />
        <DetailField label="Steps" value={runConfig.executionSteps.length} />
      </DetailGrid>
      {runConfig.executionSteps.length > 0 ? (
        <>
          <p className="text-sm text-text-muted">
            Steps resolved from flow <span className="font-mono text-text">{runConfig.flowTemplateId}</span>.
          </p>
          <PhasedStepList steps={runConfig.executionSteps} />
        </>
      ) : (
        <p className="text-xs text-text-muted">Flow has no steps — add them in Configuration → Flows.</p>
      )}
    </div>
  )
}

const SECTION_TITLES: Record<DefinitionSectionId, string> = {
  identity: "Identity",
  scd2: "SCD2 strategy",
  policies: "Freeze windows",
  tables: "Tables",
  run: "Run",
  lineage: "Lineage",
}

export function DefinitionSectionModal({
  sectionId,
  def,
  runConfig,
  onClose,
}: {
  sectionId: DefinitionSectionId
  def: EntityRegistryDefinition
  runConfig: SyncDefinitionAdminItem | null
  onClose: () => void
}): JSX.Element {
  const runSummary: DefinitionRunSummary | null = runConfig
    ? {
        flowTemplateId: runConfig.flowTemplateId,
        serviceProfileRef: runConfig.serviceProfileRef,
        environmentPolicyRef: runConfig.environmentPolicyRef,
        stepCount: runConfig.executionSteps.length,
      }
    : null
  const section = buildDefinitionSections(def, runSummary).find((item) => item.id === sectionId)

  return (
    <ModalShell
      title={SECTION_TITLES[sectionId]}
      subtitle={section?.subtitle}
      size="focus"
      onClose={onClose}
    >
      <div className="entity-registry modal-detail-body flex min-h-0 flex-1 flex-col overflow-auto p-5">
        {sectionId === "identity" && <IdentitySection def={def} />}
        {sectionId === "scd2" && <Scd2Section def={def} />}
        {sectionId === "policies" && <PoliciesSection def={def} />}
        {sectionId === "tables" && <TablesSection def={def} />}
        {sectionId === "run" && <RunSection runConfig={runConfig} />}
        {sectionId === "lineage" && <LineageSection def={def} />}
      </div>
    </ModalShell>
  )
}
