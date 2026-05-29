/**
 * BusProtocol — typed message intents on the inter-agent bus.
 *
 * Free-form `topic` strings let agents publish anything (used for
 * domain-specific channels like "research-results"), but every message
 * also carries a `protocol` discriminator so the bus, the parent agent,
 * and the UI can react to coordination intent without parsing prose:
 *
 *   - Status     : a child reporting progress (auto-emitted on iteration boundaries).
 *   - Result     : a child reporting a final answer for its delegated goal.
 *   - Help       : a child explicitly asking for parent intervention.
 *                  Triggers `EventType.AgentHelpRequested` so the UI surfaces it.
 *   - Question   : an agent asking a sibling/parent a question that expects a reply.
 *                  Pairs with `wait_for_response` on the sender side.
 *   - Answer     : a reply to a Question, carries `replyTo = <question.id>`.
 *   - Broadcast  : informational, no expected reply, all-agents fan-out.
 *
 * The set is closed: tools (`send_message`, `wait_for_response`,
 * `check_messages`) only accept these values, and the
 * `agent_messages.protocol` column has a CHECK constraint on the same
 * literals so no legacy / typo'd value can ever land in the DB.
 */

export const BusProtocol = {
  Status:    "status",
  Result:    "result",
  Help:      "help",
  Question:  "question",
  Answer:    "answer",
  Broadcast: "broadcast",
} as const

export type BusProtocol = (typeof BusProtocol)[keyof typeof BusProtocol]

export const BUS_PROTOCOLS: ReadonlyArray<BusProtocol> = Object.values(BusProtocol)

export const isBusProtocol = (value: unknown): value is BusProtocol =>
  typeof value === "string" && (BUS_PROTOCOLS as readonly string[]).includes(value)
