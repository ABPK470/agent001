export type CheckSeverity = "error" | "warn" | "ok"

export interface SetupCheck {
  readonly id: string
  readonly label: string
  readonly severity: CheckSeverity
  readonly message: string
  readonly hint?: string
}

export interface SetupLayout {
  readonly projectRoot: string
  readonly envPath: string
  readonly envExamplePath: string
  readonly packaged: boolean
  readonly isProduction: boolean
}

export interface SetupReport {
  readonly layout: SetupLayout
  readonly checks: readonly SetupCheck[]
}
