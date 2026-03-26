import { approvalResolved } from "../domain/events.js"
import type { ApprovalRequest } from "../domain/models.js"
import { approveRequest, rejectRequest } from "../domain/models.js"
import type { ApprovalRepository } from "../ports/repositories.js"
import type { EventBus } from "../ports/services.js"

export class ApprovalService {
  constructor(
    private readonly approvals: ApprovalRepository,
    private readonly bus: EventBus,
  ) {}

  async listPending(runId?: string): Promise<ApprovalRequest[]> {
    return this.approvals.listPending(runId)
  }

  async resolve(
    approvalId: string,
    approved: boolean,
    user: string,
  ): Promise<ApprovalRequest> {
    const req = await this.approvals.get(approvalId)
    if (!req) throw new Error(`Approval '${approvalId}' not found`)

    if (approved) {
      approveRequest(req, user)
    } else {
      rejectRequest(req, user)
    }

    await this.approvals.save(req)
    await this.bus.publish(approvalResolved(req.id, approved, user))
    return req
  }
}
