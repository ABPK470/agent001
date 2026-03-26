import type { DomainEvent } from "../domain/events.js"
import type { EventBus } from "../ports/services.js"

type Handler = (event: DomainEvent) => Promise<void>

export class MemoryEventBus implements EventBus {
  private handlers = new Map<string, Handler[]>()
  private _history: DomainEvent[] = []

  subscribe(eventType: string, handler: Handler): void {
    const list = this.handlers.get(eventType) ?? []
    list.push(handler)
    this.handlers.set(eventType, list)
  }

  async publish(event: DomainEvent): Promise<void> {
    this._history.push(event)
    const list = this.handlers.get(event.type) ?? []
    for (const handler of list) {
      try {
        await handler(event)
      } catch (err) {
        console.error(`Event handler error for ${event.type}:`, err)
      }
    }
  }

  get history(): readonly DomainEvent[] {
    return this._history
  }
}
