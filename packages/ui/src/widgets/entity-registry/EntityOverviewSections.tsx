/**
 * Catalog entity overview — accordion sections with inline detail panels.
 */

import { ChevronDown } from "lucide-react"
import { useEffect, useState, type JSX } from "react"
import { api } from "../../client/index"
import type { EntityRegistryDefinition, SyncDefinitionAdminItem } from "../../types"
import { buildEntityOverviewSections, type EntityOverviewSectionId } from "./entity-overview-helpers"
import { EntityOverviewSectionDetail } from "./EntityOverviewSectionDetail"

export interface EntityOverviewSectionsProps {
  def: EntityRegistryDefinition
}

export function EntityOverviewSections({ def }: EntityOverviewSectionsProps): JSX.Element {
  const [expanded, setExpanded] = useState<Set<EntityOverviewSectionId>>(() => new Set())
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

  function toggle(sectionId: EntityOverviewSectionId): void {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(sectionId)) next.delete(sectionId)
      else next.add(sectionId)
      return next
    })
  }

  return (
    <ol className="entity-accordion-list">
      {sections.map((section) => {
        const isExpanded = expanded.has(section.id)
        return (
          <li
            key={section.id}
            className={[
              "entity-accordion__item",
              isExpanded ? "entity-accordion__item--expanded" : "",
            ]
              .filter(Boolean)
              .join(" ")}
          >
            <button
              type="button"
              onClick={() => toggle(section.id)}
              aria-expanded={isExpanded}
              className="entity-accordion__header entity-accordion__header--overview"
            >
              <span className="entity-accordion__main">
                <span className="entity-accordion__name">{section.title}</span>
                <span className="entity-accordion__subtitle">{section.subtitle}</span>
              </span>
              <span className="entity-accordion__meta">
                {section.badge && (
                  <span className="entity-accordion__badge">{section.badge}</span>
                )}
                <ChevronDown
                  className={[
                    "entity-accordion__chevron",
                    isExpanded ? "entity-accordion__chevron--open" : "",
                  ].join(" ")}
                  aria-hidden
                />
              </span>
            </button>

            {isExpanded && (
              <div className="entity-accordion__panel entity-accordion__panel--overview">
                <EntityOverviewSectionDetail
                  sectionId={section.id}
                  def={def}
                  runConfig={runConfig}
                />
              </div>
            )}
          </li>
        )
      })}
    </ol>
  )
}
