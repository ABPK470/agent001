# Contributing

Read `docs/doctrine.md` first.

That document is the contract for this repository: shell owns state, core is
stateless, and dependencies are always parameters. If a proposed change pulls in
ambient state, exported boot-time setters, or hidden context, stop and rewrite
the change around explicit host/context flow.

## Working rules

- import public package barrels instead of deep internals unless the owning
  package explicitly documents a deeper door
- keep new state on explicit shell objects or on the host, not in module-level
  mutable bindings
- prefer `configure...` and `replace...` APIs for boot wiring over `setXxx`
- thread request/run/sync context explicitly through parameters or closures
- keep sync consumers importing from `@mia/sync`, not `@mia/agent`

## Validation

Before sending a change, run the narrowest relevant checks first:

- package-local `tsc --noEmit`
- affected tests
- `node scripts/lint-arch.mjs` when boundaries or naming change

If you need to change the doctrine, update `docs/doctrine.md` before changing
the code that relies on it.
