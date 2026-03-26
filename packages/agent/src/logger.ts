/**
 * Pretty logging for agent activity.
 *
 * Makes the agent's thinking visible so you can see exactly
 * what an AI agent does: think → pick tool → observe → repeat.
 */

const RESET = "\x1b[0m"
const BOLD = "\x1b[1m"
const DIM = "\x1b[2m"
const CYAN = "\x1b[36m"
const GREEN = "\x1b[32m"
const YELLOW = "\x1b[33m"
const RED = "\x1b[31m"
const MAGENTA = "\x1b[35m"

export function logGoal(goal: string): void {
  console.log(`\n${BOLD}${CYAN}🎯 Goal:${RESET} ${goal}\n`)
}

export function logThinking(thought: string | null): void {
  if (!thought) return
  console.log(`${DIM}💭 ${thought}${RESET}`)
}

export function logToolCall(name: string, args: Record<string, unknown>): void {
  const argsStr = JSON.stringify(args, null, 2)
  console.log(`${YELLOW}🔧 Tool: ${BOLD}${name}${RESET}${YELLOW}(${argsStr})${RESET}`)
}

export function logToolResult(result: string): void {
  const truncated = result.length > 500 ? result.slice(0, 500) + "... (truncated)" : result
  console.log(`${DIM}📋 Result: ${truncated}${RESET}\n`)
}

export function logToolError(error: string): void {
  console.log(`${RED}❌ Error: ${error}${RESET}\n`)
}

export function logFinalAnswer(answer: string): void {
  console.log(`\n${GREEN}${BOLD}✅ Agent finished:${RESET}\n${answer}\n`)
}

export function logIteration(i: number, max: number): void {
  console.log(`${MAGENTA}── iteration ${i + 1}/${max} ──${RESET}`)
}

export function logError(msg: string): void {
  console.log(`${RED}${BOLD}💥 ${msg}${RESET}`)
}
