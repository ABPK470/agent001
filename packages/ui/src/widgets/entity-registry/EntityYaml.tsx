/**
 * Overview tab — read-only summary with optional JSON source view.
 */

import type { JSX } from "react"
import { useEffect, useState } from "react"
import { api } from "../../api"
import { DefinitionExportMenu } from "./DefinitionExportMenu"
import { DefinitionOverview } from "./DefinitionOverview"
import { PANEL, TAB_ERROR } from "./chrome"
import { SegmentToggle } from "./SegmentToggle"
import { TabBody, TabPanelHeader, TabShell } from "./TabChrome"

export type DefinitionView = "overview" | "json"

export interface EntityYamlProps {
  jsonText: string
  entityId: string
}

export function EntityYaml({ jsonText, entityId }: EntityYamlProps): JSX.Element {
  const [exportBusy, setExportBusy] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)
  const [view, setView] = useState<DefinitionView>("overview")
  const [exportJson, setExportJson] = useState(jsonText)

  useEffect(() => {
    setExportJson(jsonText)
  }, [jsonText])

  async function loadExportJson(): Promise<string> {
    setExportBusy(true)
    setExportError(null)
    try {
      const next = await api.getEntityRegistryJson(entityId)
      setExportJson(next)
      return next
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setExportError(message)
      throw error
    } finally {
      setExportBusy(false)
    }
  }

  async function copyJson(): Promise<void> {
    const text = exportJson.trim() ? exportJson : await loadExportJson()
    await navigator.clipboard.writeText(text)
  }

  async function downloadJson(): Promise<void> {
    const text = exportJson.trim() ? exportJson : await loadExportJson()
    const blob = new Blob([text], { type: "application/json" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `${entityId}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <TabShell>
      {exportError && <div className={TAB_ERROR}>{exportError}</div>}

      <TabBody>
        <div className={`${PANEL} flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-elevated/20`}>
          <TabPanelHeader>
            <DefinitionExportMenu
              exportBusy={exportBusy}
              onCopyJson={() => void copyJson()}
              onDownloadJson={() => void downloadJson()}
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
                {exportJson || "…"}
              </pre>
            )}
          </div>
        </div>
      </TabBody>
    </TabShell>
  )
}
