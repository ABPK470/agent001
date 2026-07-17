# Core

**What:** Pure decision logic for the agent.  
**Why:** Keep the brain testable and free of loop state.  
**Next:** Runtime steps call into these modules.

Clusters: `clarify/`, `doctrine/`, `govern-tools/`, `plan/`, `choose-path/`, `recover/`.

Rule: core never imports runtime for **values or drivers**. Pass tenant knobs and
loop state as parameters. Tenant getters live in `domain/tenant` (documented
ambient exception). Remaining type-only imports from `runtime/delegate` (bandit /
validation codes) are transitional — prefer moving those types into `domain/` when
touched next.
