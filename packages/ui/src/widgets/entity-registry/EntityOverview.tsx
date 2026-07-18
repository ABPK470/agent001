/**
 * Overview tab — read-only summary with optional JSON source view.
 */

import type { JSX } from "react"
import { useEffect, useState } from "react"
import { api } from "../../client/index"
import type { EntityRegistryDefinition } from "../../types"
import { PANEL, TAB_ERROR } from "./chrome"
import { DefinitionExportMenu } from "./DefinitionExportMenu"
import { DefinitionOverview } from "./DefinitionOverview"
import { EntityRegistryJsonImportGate } from "./EntityRegistryJsonImportGate"
import { SegmentToggle } from "./SegmentToggle"
import { TabBody, TabPanelHeader, TabShell } from "./TabChrome"

export type DefinitionView = "overview" | "json"

export interface EntityYamlProps {
  def: EntityRegistryDefinition
  jsonText: string
  entityId: string
  isAdmin?: boolean
  onImported?: () => void
}

export function EntityYaml({ def, jsonText, entityId, isAdmin, onImported }: EntityYamlProps): JSX.Element {
  const [exportBusy, setExportBusy] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)
  const [view, setView] = useState<DefinitionView>("overview")
  const [registryJson, setRegistryJson] = useState(jsonText)
  const [importOpen, setImportOpen] = useState(false)

  useEffect(() => {
    setRegistryJson(jsonText)
  }, [jsonText])

  async function loadRegistryJson(): Promise<string> {
    setExportBusy(true)
    setExportError(null)
    try {
      const next = await api.getEntityRegistryJson(entityId)
      setRegistryJson(next)
      return next
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setExportError(message)
      throw error
    } finally {
      setExportBusy(false)
    }
  }

  async function copyRegistryJson(): Promise<void> {
    const text = registryJson.trim() ? registryJson : await loadRegistryJson()
    await navigator.clipboard.writeText(text)
  }

  async function downloadRegistryJson(): Promise<void> {
    const text = registryJson.trim() ? registryJson : await loadRegistryJson()
    downloadText(`${entityId}.registry.json`, text)
  }

  return (
    <TabShell>
      {exportError && <div className={TAB_ERROR}>{exportError}</div>}
      {importOpen && (
        <EntityRegistryJsonImportGate
          entityId={entityId}
          onClose={() => setImportOpen(false)}
          onImported={() => {
            setImportOpen(false)
            onImported?.()
          }}
        />
      )}

      <TabBody>
        <div className={`${PANEL} flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-elevated/20`}>
          <TabPanelHeader>
            <DefinitionExportMenu
              exportBusy={exportBusy}
              onCopyRegistryJson={() => void copyRegistryJson()}
              onDownloadRegistryJson={() => void downloadRegistryJson()}
              onImportRegistryJson={isAdmin ? () => setImportOpen(true) : undefined}
            />
            <SegmentToggle
              value={view}
              options={[
                { value: "overview", label: "Overview" },
                { value: "json", label: "JSON" },
              ]}
              onChange={setView}
              ariaLabel="Definition view"
            />
          </TabPanelHeader>

          <div className="min-h-0 flex-1 overflow-auto p-3">
            {view === "overview" ? (
              <DefinitionOverview def={def} />
            ) : (
              <pre className="entity-registry-definition__code m-0 font-mono text-xs leading-relaxed text-text">
                {registryJson || "…"}
              </pre>
            )}
          </div>
        </div>
      </TabBody>
    </TabShell>
  )
}

function downloadText(filename: string, text: string): void {
  const blob = new Blob([text], { type: "application/json" })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}
