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

let _resolver: AskUserResolver | null = null

/** Inject the resolver that connects this tool to the UI. */
export function setAskUserResolver(resolver: AskUserResolver | null): void {
  _resolver = resolver
}

export const askUserTool: Tool = {
  name: "ask_user",
  description:
    "Ask the user a question and wait for their response. " +
    "Use when you need information only the user can provide: login credentials, " +
    "personal details (email, address), choices between options, payment confirmation, " +
    "or when handing control for something you can't do (CAPTCHA, 2FA code). " +
    "The agent pauses until the user responds.",
  parameters: {
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
  },

  async execute(args) {
    if (!_resolver) {
      return "Error: User input is not available in this execution context."
    }

    const question = String(args.question ?? "")
    if (!question) return "Error: 'question' is required"

    const options = Array.isArray(args.options) ? args.options.map(String) : undefined
    const sensitive = Boolean(args.sensitive)

    const response = await _resolver(question, options, sensitive)
    return response
  },
}
