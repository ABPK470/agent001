/**
 * WebSocket manager — real-time event broadcasting.
 *
 * All connected clients receive every agent event as it happens:
 * run starts, steps execute, tools fire, audit entries log.
 * This is how the dashboard stays live.
 */

import type { WebSocket } from "@fastify/websocket"

export interface WsEvent {
  type: string
  data: Record<string, unknown>
  timestamp: string
}

const clients = new Set<WebSocket>()

export function addClient(ws: WebSocket): void {
  clients.add(ws)
  ws.on("close", () => clients.delete(ws))
  ws.on("error", () => clients.delete(ws))

  // Welcome message
  send(ws, {
    type: "connected",
    data: { version: "0.1.0", clients: clients.size },
    timestamp: new Date().toISOString(),
  })
}

export function broadcast(event: Omit<WsEvent, "timestamp">): void {
  const msg: WsEvent = {
    ...event,
    timestamp: new Date().toISOString(),
  }
  const json = JSON.stringify(msg)
  for (const client of clients) {
    if (client.readyState === 1) {
      client.send(json)
    }
  }
}

export function clientCount(): number {
  return clients.size
}

function send(ws: WebSocket, event: WsEvent): void {
  if (ws.readyState === 1) {
    ws.send(JSON.stringify(event))
  }
}
