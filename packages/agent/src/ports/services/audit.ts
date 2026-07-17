/**
 * Audit service — immutable log of every action during a run.
 */

import type { AuditRepository, Unsubscribe } from "../../domain/types/interfaces.js"
import type { AuditEntry } from "../../domain/types/run-models.js"
import { createAuditEntry } from "../../domain/types/run-models.js"

type AuditListener = (entry: AuditEntry) => void | Promise<void>

export class AuditService {
  private listeners = new Set<AuditListener>()

  constructor(private readonly repo: AuditRepository) {}

  async log(params: {
    actor: string
    action: string
    resourceType: string
    resourceId: string
    detail?: Record<string, unknown>
  }): Promise<AuditEntry> {
    const entry = createAuditEntry(params)
    await this.repo.append(entry)
    for (const listener of this.listeners) {
      await listener(entry)
    }
    return entry
  }

  subscribe(listener: AuditListener): Unsubscribe {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  async history(resourceType: string, resourceId: string): Promise<AuditEntry[]> {
    return this.repo.listByResource(resourceType, resourceId)
  }
}
