import { FileJson, UploadCloud } from "lucide-react"
import type { JSX } from "react"
import { useEffect, useMemo, useState } from "react"

import { api } from "../../api"
import { useMe } from "../../hooks/useMe"
import type { PublishedSyncDefinition } from "../../types"
import { Empty, ListItem, PanelChrome, SplitView } from "./shared"

export function DefinitionsPanel(): JSX.Element {
  const { me } = useMe()
  const isAdmin = me?.isAdmin ?? false

  const [items, setItems] = useState<PublishedSyncDefinition[]>([])
  const [busy, setBusy] = useState(true)
  const [publishing, setPublishing] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [ok, setOk] = useState<string | null>(null)

  useEffect(() => { void load() }, [])

  async function load(): Promise<void> {
    setBusy(true)
    setErr(null)
    try {
      const definitions = await api.syncDefinitions()
      setItems(definitions)
      setSelected((current) => current && definitions.some((item) => item.id === current) ? current : (definitions[0]?.id ?? null))
    } catch (error) {
      setErr(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  async function publish(): Promise<void> {
    setPublishing(true)
    setErr(null)
    setOk(null)
    try {
      const result = await api.publishSyncDefinitions()
      await load()
      const warningCount = result.stderr.length
      setOk(`Published ${result.definitionCount} definition${result.definitionCount === 1 ? "" : "s"} · ${result.publishedVersion}${warningCount > 0 ? ` · ${warningCount} warning${warningCount === 1 ? "" : "s"}` : ""}`)
    } catch (error) {
      setErr(error instanceof Error ? error.message : String(error))
    } finally {
      setPublishing(false)
    }
  }

  const selectedDefinition = useMemo(
    () => items.find((item) => item.id === selected) ?? null,
    [items, selected],
  )
  const publishedVersion = items[0]?.publishedVersion ?? null

  return (
    <PanelChrome
      title="Runtime definitions"
      subtitle="Published sync-definition bundle used by preview and execute. Publish recompiles the repo-authored definitions into live runtime state."
      busy={busy || publishing}
      onRefresh={() => void load()}
      err={err}
      ok={ok}
      onClearErr={() => setErr(null)}
      actions={isAdmin ? (
        <button
          type="button"
          onClick={() => void publish()}
          disabled={publishing}
          className="flex items-center gap-1 rounded border border-border-subtle px-2 py-1 text-[11px] text-text-muted hover:bg-overlay-2 hover:text-text disabled:opacity-50"
        >
          <UploadCloud className="h-3 w-3" /> publish runtime bundle
        </button>
      ) : undefined}
    >
      {items.length === 0 ? (
        <Empty title="No published sync definitions">
          Publish the authored definitions to create the runtime bundle.
        </Empty>
      ) : (
        <SplitView
          list={
            <div>
              <div className="border-b border-border-subtle px-3 py-3 text-[11px] text-text-muted">
                <div>{items.length} published definition{items.length === 1 ? "" : "s"}</div>
                <div className="mt-1 break-all font-mono text-text-faint">{publishedVersion ?? "unknown version"}</div>
              </div>
              {items.map((item) => (
                <ListItem key={item.id} active={item.id === selected} onClick={() => setSelected(item.id)}>
                  <span className="font-mono text-text">{item.id}</span>
                  <span className="text-text-muted">{item.displayName}</span>
                  <span className="text-[10px] text-text-faint">{item.metadata.tables.length} tbl · {item.executionFlow.steps.length} step{item.executionFlow.steps.length === 1 ? "" : "s"}</span>
                </ListItem>
              ))}
            </div>
          }
          detail={selectedDefinition ? <DefinitionDetail definition={selectedDefinition} /> : <Empty title="Pick a definition" />}
        />
      )}
    </PanelChrome>
  )
}

function DefinitionDetail({ definition }: { definition: PublishedSyncDefinition }): JSX.Element {
  return (
    <div className="space-y-4 p-5 text-xs">
      <header className="space-y-1">
        <div className="flex items-center gap-2">
          <FileJson className="h-4 w-4 text-text-muted" />
          <h3 className="text-sm font-semibold text-text">{definition.displayName}</h3>
        </div>
        <div className="font-mono text-[11px] text-text-faint">{definition.id}</div>
      </header>

      <section className="rounded-lg border border-border-subtle bg-panel px-4 py-3">
        <div className="grid gap-2 sm:grid-cols-2">
          <Detail label="Published version" value={definition.publishedVersion} />
          <Detail label="Published at" value={definition.publishedAt} />
          <Detail label="Root table" value={definition.rootTable} />
          <Detail label="ID column" value={definition.idColumn} />
          <Detail label="Tables" value={String(definition.metadata.tables.length)} />
          <Detail label="Steps" value={String(definition.executionFlow.steps.length)} />
          <Detail label="Review" value={definition.ownership.reviewStatus} />
          <Detail label="Source" value={definition.provenance.sourceArtifact ?? "manual"} />
        </div>
      </section>

      <section className="rounded-lg border border-border-subtle bg-panel px-4 py-3">
        <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-text-muted">Runtime contract</div>
        <div className="mt-2 space-y-2 text-sm leading-6 text-text-muted">
          <div>This published definition is what runtime preview and execute read.</div>
          <div>Publish here after updating the repo-authored definition files to make runtime observe the new bundle without restart.</div>
        </div>
      </section>
    </div>
  )
}

function Detail({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-[0.18em] text-text-muted">{label}</div>
      <div className="mt-1 break-all text-text">{value}</div>
    </div>
  )
}