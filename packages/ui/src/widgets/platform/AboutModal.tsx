/**
 * AboutModal — personal usage, file access, environments, providers.
 * Typography matches chat body (15px / leading-relaxed).
 */

import {
  BookOpen,
  CheckCircle2,
  CircleAlert,
  Cpu,
  Database,
  FolderLock,
  HardDrive,
  Layers,
  Zap,
} from "lucide-react"
import { useEffect, useState } from "react"
import { api, type AboutDossier } from "../../client/index"
import { ModalShell } from "../entity-registry/ModalShell"
import { MODAL_ADMIN_PANEL } from "../entity-registry/modal-overlay"

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return n.toLocaleString()
}

function formatWhen(iso: string | null): string {
  if (!iso) return "—"
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}

function Section({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode
  title: string
  children: React.ReactNode
}) {
  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <span className="text-text-muted">{icon}</span>
        <h3 className="text-[13px] font-semibold uppercase tracking-[0.12em] text-text-faint">
          {title}
        </h3>
      </div>
      {children}
    </section>
  )
}

function Kv({ label, value, mono = false }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-4 py-1.5">
      <dt className="shrink-0 text-[15px] text-text-muted">{label}</dt>
      <dd
        className={`min-w-0 text-right text-[15px] leading-relaxed text-text ${mono ? "font-mono text-[14px]" : ""}`}
        title={typeof value === "string" ? value : undefined}
      >
        {value}
      </dd>
    </div>
  )
}

function Stat({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <div className="rounded-xl border border-border-subtle bg-overlay-2 px-3 py-2.5">
      <div className="text-[12px] uppercase tracking-[0.1em] text-text-faint">{label}</div>
      <div className="mt-1 font-mono text-[15px] font-semibold tabular-nums text-text">{value}</div>
      {hint ? <div className="mt-0.5 text-[13px] text-text-faint">{hint}</div> : null}
    </div>
  )
}

function Pill({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-full border border-border-subtle bg-overlay-2 px-2.5 py-0.5 text-[13px] font-medium text-text-secondary">
      {children}
    </span>
  )
}

export function AboutModal({ onClose }: { onClose: () => void }) {
  const [data, setData] = useState<AboutDossier | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    api
      .getAbout()
      .then((d) => {
        if (!cancelled) {
          setData(d)
          setLoading(false)
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load about")
          setLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <ModalShell
      title="About"
      subtitle="Your usage, file access, and what this instance exposes to you."
      icon={<BookOpen size={20} className="text-text-muted" />}
      onClose={onClose}
      widthClass={MODAL_ADMIN_PANEL}
      size="default"
    >
      {loading ? (
        <div className="flex flex-1 items-center justify-center py-12 text-[15px] text-text-muted">
          Loading…
        </div>
      ) : error || !data ? (
        <div className="flex flex-1 items-center justify-center py-12 text-[15px] text-error">
          {error ?? "Failed to load about"}
        </div>
      ) : (
        <div className="min-h-0 flex-1 space-y-7 overflow-y-auto px-6 py-4 [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <div className="flex items-baseline gap-2">
              <span className="font-mono text-[18px] font-bold tracking-[0.08em] text-text">
                {data.product.name}
              </span>
              <span className="font-mono text-[14px] text-text-muted">v{data.product.version}</span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Pill>{data.runtime.env}</Pill>
              <Pill>{data.viewer.role}</Pill>
              <Pill>{data.runtime.node}</Pill>
            </div>
          </div>

          <Section icon={<Zap size={15} />} title="Your usage">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Stat
                label="Runs"
                value={formatNumber(data.myUsage.runs.total)}
                hint={`${data.myUsage.runs.completed} ok · ${data.myUsage.runs.failed} failed`}
              />
              <Stat
                label="Tokens"
                value={formatNumber(data.myUsage.tokens.total)}
                hint={`${formatNumber(data.myUsage.tokens.llmCalls)} LLM calls`}
              />
              <Stat
                label="Prompt / completion"
                value={`${formatNumber(data.myUsage.tokens.prompt)} / ${formatNumber(data.myUsage.tokens.completion)}`}
              />
              <Stat label="Sync runs" value={formatNumber(data.myUsage.syncRuns.total)} hint="as actor" />
            </div>
          </Section>

          <Section icon={<FolderLock size={15} />} title="File access">
            <ul className="space-y-2 text-[15px] leading-relaxed">
              {data.access.directories.allowed.map((item) => (
                <li key={item} className="flex gap-2 text-text">
                  <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-success" />
                  <span>{item}</span>
                </li>
              ))}
              {data.access.directories.denied.map((item) => (
                <li key={item} className="flex gap-2 text-text-secondary">
                  <CircleAlert size={16} className="mt-0.5 shrink-0 text-warning" />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
            {data.access.notes.length > 0 && (
              <ul className="space-y-1 text-[15px] leading-relaxed text-text-muted">
                {data.access.notes.map((note) => (
                  <li key={note}>· {note}</li>
                ))}
              </ul>
            )}
          </Section>

          <Section icon={<Layers size={15} />} title="Environments">
            {data.environments.length === 0 ? (
              <p className="text-[15px] text-text-muted">No sync environments configured.</p>
            ) : (
              <div className="space-y-2">
                {data.environments.map((env) => (
                  <div
                    key={env.name}
                    className="rounded-xl border border-border-subtle px-3 py-2.5"
                  >
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <div className="min-w-0">
                        <span className="text-[15px] font-medium text-text">{env.displayName}</span>
                        <span className="ml-2 font-mono text-[13px] text-text-faint">{env.name}</span>
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        <Pill>{env.role}</Pill>
                        <Pill>{env.defaultAccessMode}</Pill>
                        {env.denyDml && <Pill>no DML</Pill>}
                        {env.denyDdl && <Pill>no DDL</Pill>}
                      </div>
                    </div>
                    <div className="mt-1.5 text-[15px] leading-relaxed text-text-muted">
                      Sync targets:{" "}
                      {env.allowedSyncTargets == null
                        ? "unrestricted"
                        : env.allowedSyncTargets.length === 0
                          ? "none"
                          : env.allowedSyncTargets.join(", ")}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Section>

          <Section icon={<Cpu size={15} />} title="Model providers">
            <dl className="rounded-xl border border-border-subtle px-4 py-2">
              <Kv
                label="Active"
                value={`${data.providers.available.find((p) => p.id === data.providers.active.id)?.label ?? data.providers.active.id} · ${data.providers.active.model}`}
                mono
              />
              <Kv
                label="Credentials"
                value={data.providers.active.configured ? "configured" : "missing"}
              />
            </dl>
            <div className="space-y-1.5">
              <div className="text-[15px] text-text-muted">Available on this instance</div>
              {data.providers.available.map((p) => (
                <div
                  key={p.id}
                  className={`flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-[15px] ${
                    p.id === data.providers.active.id
                      ? "border-accent/30 bg-accent/5 text-text"
                      : "border-border-subtle text-text-secondary"
                  }`}
                >
                  <span>{p.label}</span>
                  <span className="font-mono text-[13px] text-text-faint">{p.defaultModel}</span>
                </div>
              ))}
            </div>
          </Section>

          <Section icon={<HardDrive size={15} />} title="Workspace & execution">
            <dl className="rounded-xl border border-border-subtle px-4 py-2">
              {data.workspace.mode === "sandbox" ? (
                <div className="py-1.5">
                  <div className="text-[15px] text-text-muted">Workspace</div>
                  <p className="mt-1 text-[15px] leading-relaxed text-text">
                    Each of your agent runs gets its own temporary folder. The agent can
                    only read and write files there — not the project source tree or the
                    MI:A install.
                  </p>
                </div>
              ) : (
                <Kv label="Workspace" value={data.workspace.path || "—"} mono />
              )}
              <Kv label="Sandbox mode" value={data.execution.sandboxMode} mono />
              <Kv label="Hosted mode" value={data.execution.hostedMode ? "on" : "off"} />
              <Kv
                label="Isolated workspaces"
                value={data.execution.isolatedWorkspace ? "on" : "off"}
              />
              <Kv
                label="Max concurrent runs"
                value={data.execution.maxConcurrentRuns ?? "default"}
              />
            </dl>
          </Section>

          <Section icon={<Database size={15} />} title="Data plane">
            <dl className="rounded-xl border border-border-subtle px-4 py-2">
              <Kv
                label="MSSQL"
                value={
                  data.dataPlane.mssql.configured
                    ? data.dataPlane.mssql.connections.length
                      ? data.dataPlane.mssql.connections.join(", ")
                      : data.dataPlane.mssql.summary
                    : "not configured"
                }
              />
              <Kv
                label="Schema catalog"
                value={
                  data.dataPlane.catalog.available
                    ? data.dataPlane.catalog.detail ?? "available"
                    : "missing"
                }
              />
              <Kv
                label="Entity definitions"
                value={`${data.dataPlane.entities.count}${data.dataPlane.entities.valid ? "" : " · validation issues"}`}
              />
              <Kv
                label="Published sync defs"
                value={
                  data.dataPlane.publish.definitionCount > 0
                    ? `${data.dataPlane.publish.definitionCount}${
                        data.dataPlane.publish.publishedVersion
                          ? ` · ${data.dataPlane.publish.publishedVersion}`
                          : ""
                      }`
                    : "none published"
                }
              />
              <Kv label="Last publish" value={formatWhen(data.dataPlane.publish.publishedAt)} />
            </dl>
            {data.dataPlane.hints.length > 0 && data.viewer.isAdmin && (
              <ul className="space-y-1.5 rounded-xl border border-warning/25 bg-warning/5 px-3 py-2.5 text-[15px] leading-relaxed text-text-secondary">
                {data.dataPlane.hints.map((hint) => (
                  <li key={hint} className="flex gap-2">
                    <CircleAlert size={15} className="mt-0.5 shrink-0 text-warning" />
                    <span>{hint}</span>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </div>
      )}
    </ModalShell>
  )
}
