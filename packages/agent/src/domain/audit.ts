/**
 * Audit service — immutable log of every action during a run.
 */

import type { AuditRepository } from "./interfaces.js"
import type { AuditEntry } from "./models.js"
import { createAuditEntry } from "./models.js"

export class AuditService {
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
    return entry
  }

  async history(resourceType: string, resourceId: string): Promise<AuditEntry[]> {
    return this.repo.listByResource(resourceType, resourceId)
  }
}
