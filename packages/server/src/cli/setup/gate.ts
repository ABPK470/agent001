import { formatSetupReport, hasBlockingErrors, runSetupChecks } from "./checks.js"
import { resolveSetupLayout } from "./layout.js"

export interface GateOptions {
  /** CI / tests — skip all setup checks. */
  readonly skip?: boolean
  /** Treat warnings as blocking (strict production gate). */
  readonly strict?: boolean
}

export function ensureSetupReady(opts: GateOptions = {}): void {
  if (opts.skip || process.env.MIA_SKIP_SETUP === "1" || process.env.MIA_SKIP_SETUP === "true") {
    return
  }

  const layout = resolveSetupLayout()
  const report = runSetupChecks(layout)
  const strict = opts.strict || process.env.MIA_SETUP_STRICT === "1"

  if (report.checks.every((c) => c.severity === "ok")) {
    return
  }

  const blocked =
    hasBlockingErrors(report) || (strict && report.checks.some((c) => c.severity === "warn"))

  const text = formatSetupReport(report)

  if (blocked) {
    console.error(text)
    console.error("")
    console.error("Server startup blocked.")
    console.error("  Fix the issues above, or run:  npm run setup")
    process.exit(1)
  }

  console.warn(text)
  console.warn("")
}

export function runSetupCheckOnly(): number {
  const report = runSetupChecks(resolveSetupLayout())
  console.log(formatSetupReport(report))
  if (hasBlockingErrors(report)) return 1
  return 0
}
