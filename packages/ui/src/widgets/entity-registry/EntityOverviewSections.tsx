/**
 * Catalog entity overview — read-only section list with detail modals.
 */

import { useEffect, useState } from "react"
import type { JSX } from "react"
import { api } from "../../client/index"
import type { EntityRegistryDefinition, SyncDefinitionAdminItem } from "../../types"
import { PANEL } from "./chrome"
import { buildEntityOverviewSections, type EntityOverviewSectionId } from "./entity-overview-helpers"
import { EntitySectionModal } from "./EntitySectionModal"
import { ChevronRight } from "lucide-react"

export interface EntityOverviewSectionsProps {
  def: EntityRegistryDefinition
}

export function EntityOverviewSections({ def }: EntityOverviewSectionsProps): JSX.Element {
  const [openSection, setOpenSection] = useState<EntityOverviewSectionId | null>(null)
  const [runConfig, setRunConfig] = useState<SyncDefinitionAdminItem | null>(null)

  useEffect(() => {
    void api.listSyncDefinitionConfigs()
      .then((configs) => setRunConfig(configs.find((item) => item.id === def.id) ?? null))
      .catch(() => setRunConfig(null))
  }, [def.id, def.version])

  const flowId = def.flowId?.trim() || runConfig?.flowTemplateId || ""
  const sections = buildEntityOverviewSections(
    def,
    flowId
      ? {
          flowId,
          stepCount: runConfig?.executionSteps.length ?? 0,
        }
      : null,
  )

  return (
    <>
      <ol className={PANEL}>
        {sections.map((section) => (
          <li key={section.id} className="border-b border-border-subtle last:border-b-0">
            <button
              type="button"
              onClick={() => setOpenSection(section.id)}
              className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-elevated/50"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-medium text-text">
                  {section.title}
                </span>
                <span className="mt-0.5 block truncate text-sm text-text-muted">
                  {section.subtitle}
                </span>
              </span>
              {section.badge && (
                <span className="shrink-0 rounded border border-border-subtle bg-panel px-1.5 py-0.5 text-xs font-medium text-text-muted">
                  {section.badge}
                </span>
              )}
              <ChevronRight className="h-3.5 w-3.5 shrink-0 text-text-faint" />
            </button>
          </li>
        ))}
      </ol>

      {openSection && (
        <EntitySectionModal
          sectionId={openSection}
          def={def}
          runConfig={runConfig}
          onClose={() => setOpenSection(null)}
        />
      )}
    </>
  )
}
