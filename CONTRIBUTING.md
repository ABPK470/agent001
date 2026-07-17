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
- inside `@mia/agent`, place new files in the correct layer (`domain` / `core` /
  `runtime` / `ports` / …) — `npm run lint:arch` rejects wrong-direction imports
  and forbidden trees (`application/`, `domain/services/`, …)

## Validation

Before sending a change, run the narrowest relevant checks first:

- `npm run lint:arch` — architecture / doctrine boundaries
- package-local `tsc --noEmit` / `npm run lint`
- affected tests

`npm run lint` always runs `lint:arch` first, then workspace typechecks.

If you need to change the doctrine, update `docs/doctrine.md` **and**
`scripts/lint-arch.mjs` together before changing code that relies on it.
