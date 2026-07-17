# Core

**What:** Pure decision logic for the agent.  
**Why:** Keep the brain testable and free of loop state.  
**Next:** Runtime steps call into these modules.

Clusters:

- `choose-path/` — direct vs planner
- `plan/` — generate → validate → execute → verify
- `clarify/` — ambiguity detectors
- `doctrine/` — SQL/query rules
- `policy/` — selector matching + RulePolicyEvaluator (pure)
- `govern-tools/` — wrap tools with policy/audit wiring
- `recover/` — hint builders, retry policy (pure)
- `delegate-decision/` — should this work be delegated?

Rule: core never imports runtime for **values or drivers**. Pass tenant knobs and
loop state as parameters. Tenant getters live in `domain/tenant` (documented
ambient exception). AuditService / Learner live under `ports/services/`.
