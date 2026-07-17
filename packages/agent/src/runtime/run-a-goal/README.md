# Run a goal

**What:** The spine of one agent run — from user goal to final answer.  
**Why:** Everything else in this package exists to support this story.  
**Next:** Open `run-goal.ts` (orchestrator), then `steps/` for each chapter.

## Plain-language flow

1. **Prepare messages** — build the starting conversation from the goal.
2. **Try planner path** — if structured planning can finish the goal, stop with
   that answer. Otherwise continue with the tool loop.
   Outcomes: `answered` | `use_tool_loop`.
3. **Prepare iteration** — trim/budget context; choose which tools the model may see.
4. **Ask the model** — one LLM call for this turn.
5. **Decide next action** — finish check, run tools, or stop.
   Outcomes: `finish_check` | `run_tools` | `stop`.
6. **Run tools** — execute tool calls with governance and guards.
7. **After tools** — stuck detection, budget nudges, recovery hints (explicit).
8. **Check can finish** — completion guards on a draft answer.
   Outcomes: `accept` | `reject_and_continue`.
9. **Finish** — return the final answer (or cancellation message).

There is no silent fall-through. Every branch returns a named outcome; an
unknown outcome throws with the full route state for logs.

## Files

| File | Role |
| ---- | ---- |
| `index.ts` | `Agent` class — thin wrapper around `runGoal` |
| `run-goal.ts` | Orchestrator — reads top-to-bottom like a chapter |
| `steps/` | One module per step (descriptive names, no `01-` prefixes) |
| `state.ts` | Mutable loop state owned by runtime |

## Related

- Pure routing / planning / recovery: `../../core/`
- Host wiring: `../host/`, `../run-context/`
