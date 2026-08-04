# Local run-simulate harness (NOT a product feature)

LLM-free paced SSE playback so you can exercise chat / Trace / Pipelines on your laptop without calling models.

**Never ship. Never enable on hosted/dev servers.**

## Enable (local only)

In the **repo-root** `.env` (not committed):

```bash
MIA_LOCAL_RUN_SIMULATE=1
VITE_LOCAL_RUN_SIMULATE=1
```

Restart **both** server and Vite (`npm run dev`). Open the **workspace** shell (not chat). Toolbar ops rail → **Local sim** → flip ON.

Without both flags, the route is unregistered and the toolbar control is not mounted.

## Delete this harness

1. Delete `packages/server/src/local-harness/`
2. Delete `packages/ui/src/local-harness/`
3. Remove the `registerLocalRunSimulateHarness` import + call from `packages/server/src/http/build-app.ts`
4. Remove the `MIA_LOCAL_RUN_SIMULATE` dynamic-import block from cancel in `packages/server/src/api/runs/routes.ts`
5. Remove the lazy `LocalRunSimulateSlot` from `packages/ui/src/app/workspace/Toolbar.tsx`
6. Remove the `MIA_LOCAL_RUN_SIMULATE` / `VITE_LOCAL_RUN_SIMULATE` notes from `.env.example`

Seed demo builders under `api/runs/service/demo-trace-builders.ts` are unrelated static seed data — leave them unless you also drop the seed CLI.
