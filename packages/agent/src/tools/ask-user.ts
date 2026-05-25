/**
 * ask_user tool — pause the agent and request input from the human operator.
 *
 * This is the human-in-the-loop primitive. When the agent needs information
 * only the user can provide (credentials, choices, confirmation), it calls
 * this tool and blocks until the user responds through the UI.
 *
 * The actual blocking/WS-broadcasting is handled by a resolver function
 * injected by the orchestrator at runtime. The tool itself is a thin shell.
 */

import type { AgentHost } from "../host/index.js"
import type { Tool } from "../types.js"

/**
 * Resolver function injected by the orchestrator.
 * Called with the question + options, returns the user's response.
 * The Promise blocks until the user actually responds.
 */
export type AskUserResolver = (
  question: string,
  options?: string[],
  sensitive?: boolean,
) => Promise<string>

// ── Shared body (hoisted above first use to avoid TDZ) ───────────

const ASK_USER_DESCRIPTION =
  "Ask the user a question and wait for their response. " +
  "Use when you need information only the user can provide: login credentials, " +
  "personal details (email, address), choices between options, payment confirmation, " +
  "or when handing control for something you can't do (CAPTCHA, 2FA code). " +
  "The agent pauses until the user responds."

const ASK_USER_PARAMETERS = {
  type: "object",
  properties: {
    question: {
      type: "string",
      description: "The question or instruction to show the user.",
    },
    options: {
      type: "array",
      items: { type: "string" },
      description: "Optional list of choices for the user to pick from.",
    },
    sensitive: {
      type: "boolean",
      description:
        "Set to true if the expected response contains sensitive data (passwords, tokens). " +
        "The response will be masked in logs and traces.",
    },
  },
  required: ["question"],
} as const

async function runAskUser(
  resolver: AskUserResolver | null | undefined,
  args: Record<string, unknown>,
): Promise<string> {
  if (!resolver) {
    return "Error: User input is not available in this execution context."
  }

  const question = String(args.question ?? "")
  if (!question) return "Error: 'question' is required"

  const options = Array.isArray(args.options) ? args.options.map(String) : undefined
  const sensitive = Boolean(args.sensitive)

  return resolver(question, options, sensitive)
}

/**
 * Schema-only ambient export. `execute` is overridden per-run by the
 * server's `PER_RUN_FACTORIES` (see packages/server/src/tools.ts) which
 * binds the actual UI resolver via run context. If the body below ever
 * runs, the orchestrator failed to wrap the tool — treat as unavailable.
 */
export const askUserTool: Tool = {
  name: "ask_user",
  description: ASK_USER_DESCRIPTION,
  parameters: ASK_USER_PARAMETERS,

  async execute() {
    return "Error: User input is not available in this execution context."
  },
}

/**
 * Doctrine-shaped factory: build an `ask_user` tool bound to the
 * {@link AgentHost}'s `userInput` reader. No ambient state, no
 * `currentRuntime()`. See docs/doctrine.md.
 */
export function createAskUserTool(host: AgentHost): Tool {
  return {
    name: "ask_user",
    description: ASK_USER_DESCRIPTION,
    parameters: ASK_USER_PARAMETERS,
    async execute(args) {
      return runAskUser(host.userInput, args)
    },
  }
}


