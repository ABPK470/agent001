/**
 * Fail loudly when a step returns an outcome the orchestrator does not handle.
 *
 * Includes the full route payload so queue / agent logs are not flying blind.
 */

export class UnhandledStepOutcomeError extends Error {
  readonly step: string
  readonly route: unknown

  constructor(step: string, route: unknown) {
    const outcome =
      route && typeof route === "object" && "outcome" in route
        ? String((route as { outcome?: unknown }).outcome)
        : "(missing outcome)"
    super(
      `Unhandled ${step} outcome "${outcome}". Full route state: ${safeJson(route)}`
    )
    this.name = "UnhandledStepOutcomeError"
    this.step = step
    this.route = route
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

export function assertUnhandled(step: string, route: unknown): never {
  throw new UnhandledStepOutcomeError(step, route)
}
