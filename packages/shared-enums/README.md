# `@mia/shared-enums`

Single source of truth for every enum that crosses an HTTP / WS / JSON
boundary between the `agent`, `server`, and `ui` packages.

## Properties

- **Zero runtime dependencies.** Browser-safe ESM.
- **No compile step.** `exports["."]` points directly at `./src/index.ts`;
  consumers (esbuild for the server bundle, Vite for the UI, tsc for tests)
  resolve TypeScript source. Do not add a build script that tools depend on.
- **Lockdown tested.** `tests/no-ts-enum.test.ts` forbids TS `enum` syntax.
  `tests/no-wire-enum-duplication.test.ts` forbids any package from
  re-declaring an enum that lives here.

## Canonical enum pattern

```ts
export const Foo = { A: "a", B: "b" } as const
export type Foo = (typeof Foo)[keyof typeof Foo]
export const FOO_VALUES = Object.values(Foo) as readonly Foo[]
export const isFoo = (v: unknown): v is Foo =>
  typeof v === "string" && (FOO_VALUES as readonly string[]).includes(v)
```

Every wire enum exports the const object, the derived type, a `_VALUES`
array, and an `is*` guard. Consuming packages re-export verbatim through
their own enum barrel — never re-declare.

## Where things go

- **An enum value crosses a network boundary** → goes here.
- **An enum is package-internal** (e.g. internal state machine never
  serialised) → keep it in the owning package.
- **Shape of payloads** (objects, request/response types) → does **not**
  live here. Keep those alongside the code that produces them.
