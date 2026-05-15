# `@mia/ui`

The browser UI — React + Vite. Talks to `@mia/server` over REST and the
SSE event stream.

## Layout

| Folder / file | Purpose |
| --- | --- |
| `main.tsx`, `App.tsx` | Bootstrap and root layout. |
| `api.ts` | Typed REST client. |
| `store.ts` | Zustand store — single source of UI state. |
| `dashboardSync.ts` | SSE subscription + store reconciliation. |
| `widgets/` | Self-contained UI features (run view, IOE, planner trace). |
| `components/` | Generic, presentation-only components. |
| `hooks/` | Reusable React hooks. |
| `enums/` | Façade re-exports of `@mia/shared-enums`. |
| `types.ts` | UI-facing trace + event payload types (sourced from shared enums). |

## Conventions

- **Wire types**: every enum value the server sends arrives typed. Pull
  the type from `@mia/shared-enums` (re-exported here) and use it as the
  union — never accept bare `string` for a known enum field.
- **State**: live in the Zustand store. Components read with selectors;
  no parallel `useState` for cross-cutting state.
- **Events**: do not poll. The SSE stream is the source of truth; REST is
  for actions, not for reading state that already streams.
- **Widgets are vertical slices**: a widget owns its components, hooks,
  styles. Lift to `components/` only when a second widget needs it.
