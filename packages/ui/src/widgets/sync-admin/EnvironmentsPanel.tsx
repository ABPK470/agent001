/**
 * EnvironmentsPanel — DEV/UAT/PROD + any tenant-defined targets.
 *
 * Today environments are file-seeded (`deploy/mssql/sync-environments.json`)
 * and exposed read-only via `GET /api/sync/environments`. This panel
 * surfaces the resolved set so operators can see what's wired up
 * without grepping JSON files.
 *
 * Live editing of environments will land when the admin write-path
 * (currently agent-only) gets HTTP routes.
 */

import { Database, Lock, Shield } from "lucide-react"
import type { JSX } from "react"
import { useEffect, useMemo, useState } from "react"
import { api } from "../../api"
import type { SyncEnvironment } from "../../types"
import { DetailRow, Empty, ListItem, PanelChrome, SplitView } from "./shared"

export function EnvironmentsPanel(): JSX.Element {
  const [items,    setItems]    = useState<SyncEnvironment[]>([])
  const [busy,     setBusy]     = useState(true)
  const [err,      setErr]      = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)

  useEffect(() => { void load() }, [])

  async function load(): Promise<void> {
    setBusy(true); setErr(null)
    try {
      const r = await api.syncEnvironments()
      const sorted = [...r].sort((a, b) => a.ringOrder - b.ringOrder)
      setItems(sorted)
      if (!selected && sorted[0]) setSelected(sorted[0].name)
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }

  const chosen = useMemo(() => items.find((e) => e.name === selected) ?? null, [items, selected])

  return (
    <PanelChrome
      title="Environments"
      subtitle="Source and target databases the sync platform can read or promote to."
      busy={busy} onRefresh={() => void load()} err={err} onClearErr={() => setErr(null)}
    >
      {items.length === 0 ? (
        <Empty title="No environments configured">
          Add entries to <code>deploy/mssql/sync-environments.json</code> and restart the server.
        </Empty>
      ) : (
        <SplitView
          list={items.map((e) => (
            <ListItem key={e.name} active={e.name === selected} onClick={() => setSelected(e.name)}>
              <div className="flex w-full items-center justify-between gap-2">
                <span className="flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-full" style={{ background: e.color || "#888" }} />
                  <span className="font-mono">{e.name}</span>
                </span>
                <RoleBadge role={e.role} />
              </div>
              <span className="text-text-muted">{e.displayName}</span>
              <span className="text-[10px] text-text-faint">ring {e.ringOrder} · {e.syncAllowlist.length} entity{e.syncAllowlist.length === 1 ? "" : "ies"}</span>
            </ListItem>
          ))}
          detail={chosen ? <EnvDetail env={chosen} /> : <Empty title="Pick an environment" />}
        />
      )}
    </PanelChrome>
  )
}

function EnvDetail({ env }: { env: SyncEnvironment }): JSX.Element {
  return (
    <div className="space-y-5 p-5 text-xs">
      <header>
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <span className="h-2.5 w-2.5 rounded-full" style={{ background: env.color || "#888" }} />
          {env.displayName}
        </h3>
        <p className="font-mono text-[11px] text-text-faint">{env.name}</p>
      </header>

      <section className="rounded-lg border border-border-subtle bg-panel p-4">
        <h4 className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-text-muted">
          <Database className="h-3 w-3" /> connection
        </h4>
        <dl className="grid grid-cols-[140px_1fr] gap-x-4 gap-y-1.5 font-mono">
          <DetailRow label="role"             value={<RoleBadge role={env.role} />} />
          <DetailRow label="ringOrder"        value={String(env.ringOrder)} />
          <DetailRow label="allowed targets"  value={env.allowedSyncTargets && env.allowedSyncTargets.length > 0 ? env.allowedSyncTargets.join(", ") : "none"} />
        </dl>
      </section>

      <section className="rounded-lg border border-border-subtle bg-panel p-4">
        <h4 className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-text-muted">
          <Shield className="h-3 w-3" /> sync allowlist
        </h4>
        {env.syncAllowlist.length === 0 ? (
          <p className="text-text-faint">No entities allow-listed for this environment.</p>
        ) : (
          <ul className="flex flex-wrap gap-1.5 font-mono">
            {env.syncAllowlist.map((id) => (
              <li key={id} className="rounded border border-border-subtle bg-overlay-2 px-2 py-0.5 text-[11px]">{id}</li>
            ))}
          </ul>
        )}
      </section>

      <div className="flex items-start gap-2 rounded border border-amber-500/30 bg-amber-500/5 p-2.5 text-[11px] text-text-muted">
        <Lock className="mt-0.5 h-3 w-3 shrink-0 text-amber-300" />
        <span>
          Environment definitions are read-only here. Edit{" "}
          <code className="font-mono">deploy/mssql/sync-environments.json</code> and restart the
          server to change them.
        </span>
      </div>
    </div>
  )
}

function RoleBadge({ role }: { role: "source" | "target" | "both" }): JSX.Element {
  const cls =
    role === "source" ? "bg-sky-500/15    text-sky-200    border-sky-500/40"
  : role === "target" ? "bg-violet-500/15 text-violet-200 border-violet-500/40"
  :                     "bg-emerald-500/15 text-emerald-200 border-emerald-500/40"
  return <span className={`rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wider ${cls}`}>{role}</span>
}
