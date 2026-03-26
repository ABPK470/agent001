/**
 * Action handler registry + step executor.
 *
 * Action handlers are the plugin points of the platform.
 * Register any handler by name; the executor looks it up at runtime.
 */

import { randomUUID } from "node:crypto"
import { ActionNotFoundError } from "../domain/errors.js"
import type { ExecutionRecord } from "../domain/models.js"

export interface ExecutionContext {
  runId: string
  stepId: string
}

export interface ActionHandler {
  readonly name: string
  execute(
    input: Record<string, unknown>,
    ctx: ExecutionContext,
  ): Promise<Record<string, unknown>>
}

export class ActionRegistry {
  private handlers = new Map<string, ActionHandler>()

  register(handler: ActionHandler): void {
    this.handlers.set(handler.name, handler)
  }

  unregister(name: string): void {
    this.handlers.delete(name)
  }

  get(name: string): ActionHandler {
    const h = this.handlers.get(name)
    if (!h) throw new ActionNotFoundError(name)
    return h
  }

  listNames(): string[] {
    return [...this.handlers.keys()]
  }
}

export class StepExecutor {
  constructor(private readonly registry: ActionRegistry) {}

  async execute(
    action: string,
    input: Record<string, unknown>,
    ctx: ExecutionContext,
  ): Promise<Record<string, unknown>> {
    const handler = this.registry.get(action)
    return handler.execute(input, ctx)
  }

  async executeAndRecord(
    action: string,
    input: Record<string, unknown>,
    ctx: ExecutionContext,
  ): Promise<ExecutionRecord> {
    const start = performance.now()
    try {
      const result = await this.execute(action, input, ctx)
      return {
        id: randomUUID(),
        runId: ctx.runId,
        stepId: ctx.stepId,
        action,
        success: true,
        durationMs: Math.round(performance.now() - start),
        result,
        error: null,
        recordedAt: new Date(),
      }
    } catch (err) {
      return {
        id: randomUUID(),
        runId: ctx.runId,
        stepId: ctx.stepId,
        action,
        success: false,
        durationMs: Math.round(performance.now() - start),
        result: {},
        error: err instanceof Error ? err.message : String(err),
        recordedAt: new Date(),
      }
    }
  }
}
