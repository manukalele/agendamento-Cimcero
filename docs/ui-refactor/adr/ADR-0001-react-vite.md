# ADR-0001: React + Vite for Renderer

Date: 2026-04-30

## Status
Accepted

## Context
The current renderer is primarily implemented in a large single HTML file (`agendamentos.html`) with inline CSS and inline JavaScript that manages global state and DOM manipulation. The app relies on a stable IPC contract exposed via `preload.cjs` as `window.electronAPI`.

We are planning a full UI refactor with a light visual refresh, without changing domain rules.

## Decision
Adopt React + Vite for the renderer:
- Build the UI as a Vite app and load the built output via Electron `loadFile`.
- Keep `window.electronAPI` as the only bridge to native/IPC operations.
- Avoid large UI libraries in phase 1.

## Consequences
Pros:
- More predictable component/state architecture.
- Easier incremental migration and future UI work (including AI-assisted changes).
- Clear separation between renderer and native/IPC code.

Cons:
- Adds a build pipeline and dev/prod configuration complexity.
- Requires a migration strategy to avoid big-bang regressions.

## Guardrails
- Do not rename IPC events or `window.electronAPI` methods without explicit documentation and acceptance checklist updates.
- Preserve webview session capture behavior.

