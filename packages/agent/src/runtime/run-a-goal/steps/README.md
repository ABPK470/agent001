# Steps of one run

Order is defined by `../run-goal.ts` (the orchestrator). Filenames are
descriptive verbs — not `01-` prefixes.

1. `prepare-messages` — build the starting conversation
2. `try-planner-path` — outcomes: `answered` | `use_tool_loop`
3. `prepare-iteration` — budget context; choose tools for this turn
4. `ask-the-model` — one LLM call
5. `decide-next-action` — outcomes: `finish_check` | `run_tools` | `stop`
6. `run-tools` — execute tool calls
7. `after-tools` — stuck / budget / recover (explicit)
8. `check-can-finish` — outcomes: `accept` | `reject_and_continue`
9. `finish` — return the final answer
