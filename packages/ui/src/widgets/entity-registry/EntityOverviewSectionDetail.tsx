/**
 * Overview section bodies — accordion drawer panels (meta grid, not form fields).
 */

import type { JSX } from "react"
import { CodeBlock } from "../../components/CodeBlock"
import type { EntityRegistryDefinition, SyncDefinitionAdminItem } from "../../types"
import {
  AccordionDetailBlock,
  AccordionMetaField,
  AccordionMetaGrid,
} from "./entity-accordion-detail"
import { EntityTablesExplorer } from "./EntityTablesExplorer"
import { provenanceLabel, type EntityOverviewSectionId } from "./entity-overview-helpers"
import { PhasedStepList } from "./PhasedStepList"

function IdentitySection({ def }: { def: EntityRegistryDefinition }): JSX.Element {
  return (
    <div className="entity-accordion-detail">
      <AccordionDetailBlock title="Properties">
        <AccordionMetaGrid>
          <AccordionMetaField label="Display name" value={def.displayName} />
          <AccordionMetaField label="Entity id" value={def.id} mono />
          <AccordionMetaField label="Root table" value={def.rootTable} mono />
          <AccordionMetaField label="ID column" value={def.idColumn} mono />
          <AccordionMetaField label="Label column" value={def.labelColumn} mono />
          <AccordionMetaField label="Self-join column" value={def.selfJoinColumn} mono />
          <AccordionMetaField label="Tenant" value={def.tenantId} mono />
          <AccordionMetaField label="Revision" value={String(def.version)} />
        </AccordionMetaGrid>
      </AccordionDetailBlock>

      {def.description?.trim() && (
        <AccordionDetailBlock title="Description">
          <p className="entity-accordion-detail__prose">{def.description.trim()}</p>
        </AccordionDetailBlock>
      )}

      <AccordionDetailBlock title="Provenance">
        <AccordionMetaGrid>
          <AccordionMetaField label="Provenance" value={provenanceLabel(def.provenance)} />
          <AccordionMetaField label="Created by" value={def.createdBy} mono />
          <AccordionMetaField label="Created at" value={new Date(def.createdAt).toLocaleString()} />
          <AccordionMetaField label="Last reason" value={def.reason} />
          {def.retiredAt && (
            <AccordionMetaField label="Retired at" value={new Date(def.retiredAt).toLocaleString()} />
          )}
          {def.legacyEntrySproc && (
            <AccordionMetaField label="Legacy entry sproc" value={def.legacyEntrySproc} mono />
          )}
        </AccordionMetaGrid>
      </AccordionDetailBlock>

      {def.discrepancies.length > 0 && (
        <AccordionDetailBlock title="Discrepancies">
          <ul className="entity-accordion-detail__list">
            {def.discrepancies.map((item) => (
              <li key={item} className="entity-accordion-detail__list-item entity-accordion-detail__list-item--mono">
                {item}
              </li>
            ))}
          </ul>
        </AccordionDetailBlock>
      )}
    </div>
  )
}

function Scd2Section({ def }: { def: EntityRegistryDefinition }): JSX.Element {
  const override = def.scd2.entityOverride
  return (
    <div className="entity-accordion-detail">
      <AccordionDetailBlock title="Strategy">
        <AccordionMetaGrid>
          <AccordionMetaField label="Strategy" value={def.scd2.strategyId} mono />
          <AccordionMetaField
            label="Version"
            value={def.scd2.strategyVersion === "latest" ? "latest" : `v${def.scd2.strategyVersion}`}
          />
        </AccordionMetaGrid>
      </AccordionDetailBlock>

      {override ? (
        <>
          <AccordionDetailBlock title="Entity override">
            <AccordionMetaGrid>
              <AccordionMetaField
                label="Exclude from diff"
                value={override.excludeFromDiff?.join(", ") ?? "—"}
                mono
              />
              <AccordionMetaField label="Identity handling" value={override.identityHandling} mono />
            </AccordionMetaGrid>
          </AccordionDetailBlock>
          {override.onInsert && Object.keys(override.onInsert).length > 0 && (
            <AccordionDetailBlock title="onInsert">
              <CodeBlock code={JSON.stringify(override.onInsert, null, 2)} lang="json" embedded maxHeight={180} />
            </AccordionDetailBlock>
          )}
          {override.onUpdate && Object.keys(override.onUpdate).length > 0 && (
            <AccordionDetailBlock title="onUpdate">
              <CodeBlock code={JSON.stringify(override.onUpdate, null, 2)} lang="json" embedded maxHeight={180} />
            </AccordionDetailBlock>
          )}
        </>
      ) : (
        <p className="entity-accordion-detail__empty">No entity-level SCD2 override.</p>
      )}
    </div>
  )
}

function PoliciesSection({ def }: { def: EntityRegistryDefinition }): JSX.Element {
  const freezes = def.policies.freezeWindowIds
  return (
    <div className="entity-accordion-detail">
      <p className="entity-accordion-detail__hint">
        When active, these windows block sync execute unless overridden.
      </p>
      <AccordionDetailBlock title="Freeze windows">
        {freezes.length === 0 ? (
          <p className="entity-accordion-detail__empty">None configured.</p>
        ) : (
          <ul className="entity-accordion-detail__list">
            {freezes.map((id) => (
              <li key={id} className="entity-accordion-detail__list-item entity-accordion-detail__list-item--mono">
                {id}
              </li>
            ))}
          </ul>
        )}
      </AccordionDetailBlock>
    </div>
  )
}

function LineageSection({ def }: { def: EntityRegistryDefinition }): JSX.Element {
  return (
    <ul className="entity-accordion-detail__list entity-accordion-detail__list--rich">
      {def.lineageRefs.map((ref, index) => (
        <li key={`${ref.object}-${index}`} className="entity-accordion-detail__list-item">
          <span className="entity-accordion-detail__list-primary">{ref.object}</span>
          <span className="entity-accordion-detail__list-secondary">
            {ref.kind}
            {ref.note?.trim() ? ` · ${ref.note}` : ""}
          </span>
        </li>
      ))}
    </ul>
  )
}

function FlowSection({
  flowId,
  runConfig,
}: {
  flowId: string | null
  runConfig: SyncDefinitionAdminItem | null
}): JSX.Element {
  if (!flowId) {
    return (
      <p className="entity-accordion-detail__empty">
        No flow associated yet. Use <span className="font-medium text-text">⋯ → Edit → Flow</span> to pick one.
      </p>
    )
  }

  const steps = runConfig?.executionSteps ?? []

  return (
    <div className="entity-accordion-detail">
      <AccordionDetailBlock title="Flow">
        <AccordionMetaGrid>
          <AccordionMetaField label="Flow" value={flowId} mono />
          <AccordionMetaField label="Steps" value={steps.length} />
        </AccordionMetaGrid>
      </AccordionDetailBlock>
      {steps.length > 0 ? (
        <AccordionDetailBlock title="Execution steps">
          <PhasedStepList steps={steps} />
        </AccordionDetailBlock>
      ) : (
        <p className="entity-accordion-detail__empty">Flow has no steps — add them in Configuration → Flows.</p>
      )}
    </div>
  )
}

export function EntityOverviewSectionDetail({
  sectionId,
  def,
  runConfig,
}: {
  sectionId: EntityOverviewSectionId
  def: EntityRegistryDefinition
  runConfig: SyncDefinitionAdminItem | null
}): JSX.Element {
  const flowId = def.flowId?.trim() || runConfig?.flowTemplateId || null

  switch (sectionId) {
    case "identity":
      return <IdentitySection def={def} />
    case "scd2":
      return <Scd2Section def={def} />
    case "policies":
      return <PoliciesSection def={def} />
    case "tables":
      return <EntityTablesExplorer tables={def.tables} embedded />
    case "flow":
      return <FlowSection flowId={flowId} runConfig={runConfig} />
    case "lineage":
      return <LineageSection def={def} />
  }
}
