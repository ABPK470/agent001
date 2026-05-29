/**
 * StrategiesPanel — SCD2 strategy catalogue (bundled + custom).
 *
 * What a strategy actually is, in plain language:
 *   When the sync engine writes rows into a target table, it needs to
 *   know which columns are "system meta" (timestamps, lock flags, etc.)
 *   so it can (a) ignore them when comparing rows for diffs and
 *   (b) stamp them automatically on insert/update. A strategy is the
 *   little manifest that names those columns.
 *
 * What the runtime actually consumes today (audited):
 *   - The diff engine ignores a HARDCODED set of meta columns
 *     {validFrom, validTo, isLocked, syncDate, deployDate}. The
 *     strategy's `excludedFromDiffCols` is not yet read.
 *   - The executor checks if the target table has columns literally
 *     named `validFrom` / `validTo`; if so it stamps GETUTCDATE() /
 *     NULL on insert and update. Other strategy fields
 *     (`onInsert`, `onUpdate`, `identityHandling`, `isLockedCol`,
 *     `syncDateCol`, `deployDateCol`) are stored and surfaced for
 *     future expansion but are not consumed by the engine today.
 *
 * This panel reflects that honestly: a one-screen summary of what
 * the strategy will *actually* do at runtime, plus a YAML editor for
 * the full document (which is what you'd hand-tune anyway).
 */

import { GitFork } from "lucide-react"
import type { JSX } from "react"
import { useEffect, useMemo, useState } from "react"
import { api } from "../../api"
import { useMe } from "../../hooks/useMe"
import { useStore } from "../../store"
import type { EntityRegistryStrategy } from "../../types"
import { Empty, ListItem, PanelChrome, SplitView } from "./shared"
import { StrategyEditorModal } from "./StrategyEditorModal"

export function StrategiesPanel(): JSX.Element {
  const { me } = useMe()
  const isAdmin = me?.isAdmin ?? false

  const [items,    setItems]    = useState<EntityRegistryStrategy[]>([])
  const [busy,     setBusy]     = useState(true)
  const [err,      setErr]      = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [editing,  setEditing]  = useState<EntityRegistryStrategy | null>(null)

  const sseNonce = useStore((s) =>
    s.sseEventLog.filter((e) => typeof e.type === "string" && e.type.startsWith("entity_registry.")).length,
  )
  useEffect(() => { void load() }, [sseNonce])

  async function load(): Promise<void> {
    setBusy(true); setErr(null)
    try {
      const r = await api.listEntityRegistryStrategies()
      setItems(r.items)
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }

  const chosen = useMemo(() => items.find((s) => s.id === selected) ?? null, [items, selected])
  const groups = useMemo(() => {
    const by: Record<string, EntityRegistryStrategy[]> = {}
    for (const s of items) (by[s.provenance.kind] ??= []).push(s)
    return by
  }, [items])

  return (
    <PanelChrome
      title="SCD2 strategies"
      subtitle="Which columns the sync engine treats as system meta — ignored when comparing rows, stamped automatically on insert/update."
      busy={busy} onRefresh={() => void load()} err={err} onClearErr={() => setErr(null)}
    >
      <SplitView
        list={
          items.length === 0
            ? <Empty title="No strategies loaded" />
            : <>{Object.entries(groups).map(([kind, list]) => (
                <section key={kind}>
                  <h3 className="px-3 pt-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-text-faint">{kind}</h3>
                  {list.map((s) => (
                    <ListItem key={s.id + ":" + s.version} active={s.id === selected}
                      onClick={() => setSelected(s.id)}>
                      <span className="font-mono">{s.id}</span>
                      <span className="text-text-muted">{s.displayName}</span>
                      <span className="text-[10px] text-text-faint">v{s.version}</span>
                    </ListItem>
                  ))}
                </section>
              ))}</>
        }
        detail={chosen
          ? <StrategyDetail s={chosen} isAdmin={isAdmin} onEdit={() => setEditing(chosen)} />
          : <Empty title="Pick a strategy" />
        }
      />

      {editing && (
        <StrategyEditorModal
          seed={editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); void load() }}
        />
      )}
    </PanelChrome>
  )
}

// ── Detail ────────────────────────────────────────────────────────

function StrategyDetail({ s, isAdmin, onEdit }: {
  s: EntityRegistryStrategy; isAdmin: boolean; onEdit: () => void
}): JSX.Element {
  const bundled = s.provenance.kind === "bundled"
  const stampsValidFrom = !!s.validFromCol
  const stampsValidTo   = !!s.validToCol

  return (
    <div className="space-y-5 p-5 text-xs">
      <header className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">{s.displayName}</h3>
          <p className="font-mono text-[11px] text-text-faint">{s.id} · v{s.version} · {s.provenance.kind}</p>
        </div>
        {isAdmin && (
          <button
            onClick={onEdit}
            className="flex items-center gap-1 rounded border border-border-subtle bg-canvas px-2.5 py-1 text-[11px] hover:bg-overlay-2"
          >
            <GitFork className="h-3 w-3" /> {bundled ? "fork to custom" : "edit → new version"}
          </button>
        )}
      </header>

      {s.description && <p className="text-text-muted">{s.description}</p>}

      {/* ── What this strategy does at runtime ─────────────────── */}
      <section className="rounded-lg border border-border-subtle bg-panel p-4">
        <h4 className="mb-2.5 text-[10px] font-semibold uppercase tracking-wider text-text-muted">
          What this does
        </h4>
        <ul className="space-y-1.5 leading-relaxed">
          <Bullet active={stampsValidFrom}>
            On insert/update, stamps <Code>{s.validFromCol || "validFrom"}</Code> = <Code>GETUTCDATE()</Code>
            {!stampsValidFrom && <span className="text-text-faint"> (disabled — no validFromCol set)</span>}
          </Bullet>
          <Bullet active={stampsValidTo}>
            On insert/update, sets <Code>{s.validToCol || "validTo"}</Code> = <Code>NULL</Code>
            {!stampsValidTo && <span className="text-text-faint"> (disabled — no validToCol set)</span>}
          </Bullet>
          <Bullet active>
            Diff engine ignores meta columns: <Code>validFrom</Code>, <Code>validTo</Code>, <Code>isLocked</Code>,{" "}
            <Code>syncDate</Code>, <Code>deployDate</Code>
          </Bullet>
        </ul>
      </section>

      {/* ── Reference metadata (documented but not yet consumed) ─ */}
      <section className="rounded-lg border border-border-subtle bg-panel/60 p-4">
        <h4 className="mb-2.5 flex items-baseline gap-2 text-[10px] font-semibold uppercase tracking-wider text-text-muted">
          Reference metadata
          <span className="text-[10px] font-normal normal-case tracking-normal text-text-faint">
            stored on the strategy but not consumed by the engine today
          </span>
        </h4>
        <div className="overflow-x-auto">
          <dl className="grid min-w-[340px] grid-cols-[160px_1fr] gap-x-4 gap-y-1.5 font-mono text-text-faint">
            <Ref label="isLockedCol"          value={s.isLockedCol} />
            <Ref label="syncDateCol"          value={s.syncDateCol} />
            <Ref label="deployDateCol"        value={s.deployDateCol} />
            <Ref label="identityHandling"     value={s.identityHandling === "none" ? null : s.identityHandling} />
            <Ref label="excludedFromDiffCols" value={s.excludedFromDiffCols.length === 0 ? null : s.excludedFromDiffCols.join(", ")} />
            <Ref label="onInsert"             value={objCount(s.onInsert)} />
            <Ref label="onUpdate"             value={objCount(s.onUpdate)} />
          </dl>
        </div>
      </section>
    </div>
  )
}

// ── Small display helpers ─────────────────────────────────────────

function Bullet({ active, children }: { active: boolean; children: JSX.Element | (JSX.Element | string | false)[] | string }): JSX.Element {
  return (
    <li className="flex items-start gap-2">
      <span className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${active ? "bg-success" : "bg-text-faint/40"}`} />
      <span className={active ? "text-text" : "text-text-muted"}>{children}</span>
    </li>
  )
}

function Code({ children }: { children: string }): JSX.Element {
  return <code className="rounded bg-overlay-2 px-1 py-0.5 font-mono text-[10.5px]">{children}</code>
}

function Ref({ label, value }: { label: string; value: string | null }): JSX.Element {
  return (
    <>
      <dt>{label}</dt>
      <dd className="text-text-faint">{value ?? "—"}</dd>
    </>
  )
}

function objCount(o: Record<string, string> | null | undefined): string | null {
  if (!o) return null
  const n = Object.keys(o).length
  return n === 0 ? null : `${n} column${n === 1 ? "" : "s"}`
}
