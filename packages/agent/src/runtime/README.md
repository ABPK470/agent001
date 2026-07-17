# Runtime

**What:** Stateful drivers — host, run context, the run-a-goal loop, delegation.  
**Why:** Someone must own mutable state and I/O; that is this folder.  
**Next:** Open `run-a-goal/` for the story of one run.

Rule: runtime owns state; core is called with parameters.
