/**
 * Overview tab — read-only summary with optional YAML/JSON source view.
 */

import type { JSX } from "react"
import { useState } from "react"
import { api } from "../../api"
import type { EntityRegistryDefinition } from "../../types"
import { DefinitionExportMenu } from "./DefinitionExportMenu"
import { DefinitionOverview } from "./DefinitionOverview"
import { PANEL, TAB_ERROR } from "./chrome"
import { SegmentToggle } from "./SegmentToggle"
import { TabBody, TabPanelHeader, TabShell } from "./TabChrome"

export type DefinitionView = "overview" | "yaml" | "json"

export interface EntityYamlProps {
  yaml: string
  def: EntityRegistryDefinition
  entityId: string
  isAdmin: boolean
}

export function EntityYaml({ yaml, def, entityId, isAdmin }: EntityYamlProps): JSX.Element {
  const [bundleBusy, setBundleBusy] = useState(false)
  const [bundleError, setBundleError] = useState<string | null>(null)
  const [view, setView] = useState<DefinitionView>("overview")

  const content = view === "yaml" ? yaml : `${JSON.stringify(def, null, 2)}\n`

  function doCopy() {
    void navigator.clipboard.writeText(view === "overview" ? yaml : content)
  }

  function doDownload() {
    const format = view === "json" ? "json" : "yaml"
    const body = view === "json" ? content : yaml
    const blob = new Blob([body], { type: format === "yaml" ? "application/yaml" : "application/json" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `${entityId}.${format}`
    a.click()
    URL.revokeObjectURL(url)
  }

  async function loadBundle(): Promise<{ text: string; fileName: string }> {
    setBundleBusy(true)
    setBundleError(null)
    try {
      const result = await api.getEntityRegistrySyncDefinitionScaffold(entityId)
      return {
        text: `${JSON.stringify(result.definition, null, 2)}\n`,
        fileName: result.suggestedPath.split("/").at(-1) ?? `${entityId}.json`,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setBundleError(message)
      throw error
    } finally {
      setBundleBusy(false)
    }
  }

  async function copyBundle() {
    const { text } = await loadBundle()
    await navigator.clipboard.writeText(text)
  }

  return (
    <TabShell>
      {bundleError && <div className={TAB_ERROR}>{bundleError}</div>}

      <TabBody>
        <div className={`${PANEL} flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-elevated/20`}>
          <TabPanelHeader>
            <DefinitionExportMenu
              isAdmin={isAdmin}
              bundleBusy={bundleBusy}
              onCopy={doCopy}
              onDownload={doDownload}
              onCopyBundle={() => void copyBundle()}
            />
            <SegmentToggle
              value={view}
              options={[
                { value: "overview", label: "Overview" },
                { value: "yaml", label: "YAML" },
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
                {content || "…"}
              </pre>
            )}
          </div>
        </div>
      </TabBody>
    </TabShell>
  )
}
