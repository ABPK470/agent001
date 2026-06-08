/**
 * Phase E.1 — disclosure categories.
 *
 * Vocabulary for "what kind of internal information would this leak?"
 * Used by the prompt section in `<information_disclosure>` to teach the
 * model what to keep private under non-admin roles, and tagged on policy
 * rules in `hosted-defaults.ts` so an operator scanning the rule set can
 * see WHY each deny exists. Data only — no runtime behaviour here.
 *
 * Categories are intentionally coarse: enough to explain the rules, not
 * so fine-grained that adding a new tool requires inventing a new tag.
 */

export const DisclosureCategory = {
  /** Tool names, schemas, parameter shapes, counts, filter decisions. */
  ToolRegistry: "tool_registry",
  /** Full system-prompt text, section names, persona files. */
  SystemPrompt: "system_prompt",
  /** Source-file paths under `packages/`; module / class / function names. */
  Internals: "internals",
  /** Policy rules, governance rule names, audit log structure. */
  PolicyConfig: "policy_config",
  /** Memory tier names, internal ids, retention rules. */
  Memory: "memory",
  /** DB schema names, storage paths, env-var names. */
  Infrastructure: "infrastructure",
  /** Agent definition ids, internal agent descriptions, tool whitelists. */
  AgentDefinitions: "agent_definitions"
} as const

export type DisclosureCategory = (typeof DisclosureCategory)[keyof typeof DisclosureCategory]

export const DISCLOSURE_CATEGORIES: ReadonlyArray<DisclosureCategory> = Object.values(DisclosureCategory)

/** Short human-readable description for each category. */
export const DISCLOSURE_CATEGORY_DESCRIPTIONS: Readonly<Record<DisclosureCategory, string>> = {
  [DisclosureCategory.ToolRegistry]:
    "tool names, parameter schemas, the list of available tools, goal-filter decisions",
  [DisclosureCategory.SystemPrompt]: "the verbatim system prompt, section headers, persona files",
  [DisclosureCategory.Internals]:
    "source file paths under packages/, internal module / class / function names",
  [DisclosureCategory.PolicyConfig]:
    "policy rule names, governance rule wiring, audit log internal structure",
  [DisclosureCategory.Memory]: "memory tier names, internal ids, retention rules, consolidation cadence",
  [DisclosureCategory.Infrastructure]:
    "database schema, storage paths, environment variable names, deployment topology",
  [DisclosureCategory.AgentDefinitions]:
    "internal agent ids, system prompts of named agents, per-agent tool whitelists"
}
