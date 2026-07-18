/**
 * Shared impact summary for platform import / entity-source apply gates.
 */

import { AlertTriangle, CheckCircle2 } from "lucide-react"
import type { JSX } from "react"
import type { PlatformImportGateResult } from "@mia/shared-types"

export function ImportImpactPanel({ result }: { result: PlatformImportGateResult }): JSX.Element {
  const { impact } = result
  return (
    <div
      className={`rounded-lg border p-3 text-sm ${
        result.ok ? "border-success/30 bg-success/5" : "border-error/30 bg-error/5"
      }`}
    >
      <div className="flex items-center gap-2 font-medium">
        {result.ok ? (
          <CheckCircle2 size={16} className="text-success" />
        ) : (
          <AlertTriangle size={16} className="text-error" />
        )}
        {result.dryRun ? "Validation" : "Import"} {result.ok ? "passed" : "failed"}
        {result.applied ? " · applied" : ""}
      </div>
      {result.errors.length > 0 && (
        <ul className="mt-2 list-disc pl-5 text-error">
          {result.errors.map((error) => (
            <li key={error}>{error}</li>
          ))}
        </ul>
      )}
      {result.warnings.length > 0 && (
        <ul className="mt-2 list-disc pl-5 text-text-muted">
          {result.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      )}
      {result.ok && (
        <div className="mt-2 space-y-1 text-text-muted">
          {impact.creates.length > 0 && (
            <p>
              <span className="font-medium text-text">Creates</span>: {impact.creates.join(", ")}
            </p>
          )}
          {impact.updates.length > 0 && (
            <p>
              <span className="font-medium text-text">Updates / overwrites</span>:{" "}
              {impact.updates.join(", ")}
            </p>
          )}
          {impact.retires.length > 0 && (
            <p>
              <span className="font-medium text-text">Retires</span>: {impact.retires.join(", ")}
            </p>
          )}
          {impact.deletes.length > 0 && (
            <p>
              <span className="font-medium text-text">Deletes</span>: {impact.deletes.join(", ")}
            </p>
          )}
          {impact.skips.length > 0 && (
            <p>
              <span className="font-medium text-text">Skips</span>:{" "}
              {impact.skips.map((s) => `${s.id} (${s.reason})`).join(", ")}
            </p>
          )}
          {Object.keys(result.counts).length > 0 && (
            <p className="text-xs">
              Counts:{" "}
              {Object.entries(result.counts)
                .map(([key, value]) => `${key} ${value}`)
                .join(" · ")}
            </p>
          )}
          {result.version && (
            <p className="text-xs">Catalog version {result.version.version}</p>
          )}
        </div>
      )}
    </div>
  )
}
