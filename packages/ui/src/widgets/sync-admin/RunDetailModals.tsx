import type { JSX } from "react"
import type { SyncPlan } from "../../types"
import { ModalShell } from "./chrome"
import { AdminModalCanvas, AdminModalRoot, FormSectionCard } from "./modal-layout"
import {
  readAllowedSchemas,
  readExecutionContractSteps,
  readExecutionContractVersion,
} from "./plan-contract"

export function PlanDetailModal({ plan, onClose }: { plan: SyncPlan; onClose: () => void }): JSX.Element {
  const contract = plan.executionContract
  const steps = contract ? readExecutionContractSteps(contract) : []
  const version = contract ? readExecutionContractVersion(contract) : "—"
  const schemas = contract ? readAllowedSchemas(contract) : []

  return (
    <ModalShell title="Compiled plan" subtitle={contract?.definitionId} size="focus" onClose={onClose}>
      <AdminModalRoot>
        <AdminModalCanvas>
          <FormSectionCard title="Contract" emphasized>
            <dl className="grid grid-cols-[7rem_1fr] gap-x-4 gap-y-1.5 text-sm">
              <dt className="text-text-muted">version</dt>
              <dd className="font-mono">{version}</dd>
              <dt className="text-text-muted">schemas</dt>
              <dd className="font-mono">{schemas.join(", ") || "—"}</dd>
            </dl>
          </FormSectionCard>
          <FormSectionCard title="Steps" description="Ordered execution phases from the compiled contract.">
            <ol className="space-y-2 text-sm">
              {steps.map((step, i) => (
                <li key={step.id} className="rounded-lg border border-border-subtle px-3 py-2">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs text-text-faint">{i + 1}</span>
                    <span className="font-medium">{step.title}</span>
                    <span className="ml-auto text-xs uppercase text-text-muted">{step.phase}</span>
                  </div>
                  {step.description && <p className="mt-1 text-xs text-text-muted">{step.description}</p>}
                </li>
              ))}
            </ol>
          </FormSectionCard>
        </AdminModalCanvas>
      </AdminModalRoot>
    </ModalShell>
  )
}

export function GovernanceDetailModal({ plan, onClose }: { plan: SyncPlan; onClose: () => void }): JSX.Element {
  const g = plan.governanceDecision
  if (!g) {
    return (
      <ModalShell title="Governance" size="focus" onClose={onClose}>
        <AdminModalRoot>
          <AdminModalCanvas>
            <p className="text-sm text-text-muted">No governance data.</p>
          </AdminModalCanvas>
        </AdminModalRoot>
      </ModalShell>
    )
  }
  const warnings = g.warnings ?? []
  const freezeIds = g.governance?.freezeWindowIds ?? []

  return (
    <ModalShell title="Governance" size="focus" onClose={onClose}>
      <AdminModalRoot>
        <AdminModalCanvas>
          <FormSectionCard title="Decision">
            <dl className="grid grid-cols-[7rem_1fr] gap-x-4 gap-y-1.5 text-sm">
              <dt className="text-text-muted">target role</dt>
              <dd>{g.targetEnvironment.role}</dd>
              <dt className="text-text-muted">freeze refs</dt>
              <dd className="font-mono">{freezeIds.join(", ") || "none"}</dd>
            </dl>
          </FormSectionCard>
          {warnings.length > 0 && (
            <FormSectionCard title="Warnings">
              <ul className="space-y-1 text-xs text-warning">
                {warnings.map((w) => <li key={w}>• {w}</li>)}
              </ul>
            </FormSectionCard>
          )}
        </AdminModalCanvas>
      </AdminModalRoot>
    </ModalShell>
  )
}

export function DecisionLogModal({ plan, onClose }: { plan: SyncPlan; onClose: () => void }): JSX.Element {
  const log = plan.decisionLog ?? []

  return (
    <ModalShell title="Decision log" subtitle={`${log.length} entries`} size="focus" onClose={onClose}>
      <AdminModalRoot>
        <AdminModalCanvas>
          {log.length === 0 ? (
            <p className="text-sm text-text-muted">No entries.</p>
          ) : (
            <div className="space-y-2 text-sm">
              {log.map((d) => (
                <div key={d.id} className="rounded-lg border border-border-subtle px-3 py-2">
                  <div className="flex items-center gap-2">
                    <span className="text-xs uppercase text-text-muted">{d.severity}</span>
                    <span className="font-medium">{d.title}</span>
                    <span className="ml-auto text-xs text-text-faint">{d.category}</span>
                  </div>
                  <p className="mt-1 text-xs text-text-muted">{d.summary}</p>
                </div>
              ))}
            </div>
          )}
        </AdminModalCanvas>
      </AdminModalRoot>
    </ModalShell>
  )
}
