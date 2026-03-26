/**
 * In-process work queue — synchronous pass-through.
 *
 * For single-process mode: jobs are processed inline immediately.
 *
 * The scaling path: swap this for RedisQueue / RabbitMQQueue / SQSQueue.
 * Workers become separate processes that consume from the shared queue
 * and write results back to the shared RunRepository.
 */

import type { StepJob, WorkQueue } from "../ports/services.js"

export class MemoryQueue implements WorkQueue {
  private handler: ((job: StepJob) => Promise<void>) | null = null

  process(handler: (job: StepJob) => Promise<void>): void {
    this.handler = handler
  }

  async enqueue(job: StepJob): Promise<void> {
    if (this.handler) {
      await this.handler(job)
    }
  }
}
