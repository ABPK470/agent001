# `@mia/ui`

The browser UI — React + Vite. Talks to `@mia/server` over REST and the
SSE event stream.

## Layout

```text
src/
├── boot/          # main.tsx, global CSS
├── app/           # App composition, session/brand/layout, home/, workspace/
├── client/        # REST + SSE transport
├── state/         # Zustand store + SSE reducers
├── widgets/       # product vertical slices (WidgetType tiles + private trees)
├── components/    # presentation-only shared UI
├── hooks/
├── lib/
├── theme/
├── enums/
└── types.ts
```

| Folder | Purpose |
| --- | --- |
| `boot/` | Process entry |
| `app/` | Root App, home pages, workspace frame, session/brand helpers |
| `client/` | Typed HTTP + SSE (not a folder named `api/`) |
| `state/` | Zustand + live SSE reconciliation |
| `widgets/` | Product slices — own their private trees |
| `components/` | Presentation only — **no** store, **no** `client/` |
| `hooks/` / `lib/` / `theme/` / `enums/` | Shared helpers and wire façades |

Doctrine: [docs/doctrine.md](../../docs/doctrine.md). Enforce with `npm run lint:arch`.

## Workspace grid

Desktop workspace canvases use a flat absolute 2D grid under
`app/workspace/layout/` (`GridCanvas`, `useGridInteraction`, `grid-math`).
Tiles are stored in `state/layout-store.ts` and synced via
`app/workspace/layout/persistence.ts`. Mobile stacks tiles by `(y, x)` in a
scrollable column.

## Conventions

- **Wire types**: pull enums from `@mia/shared-enums` (re-exported via `enums/`);
  never accept bare `string` for a known enum field.
- **State**: live in the Zustand store under `state/`. Components read with
  selectors; no parallel `useState` for cross-cutting state.
- **Events**: do not poll. The SSE stream is the source of truth; REST is for
  actions.
- **Widgets are vertical slices**: a widget owns its private UI. Lift to
  `components/` only when a second widget needs presentation-only code.
