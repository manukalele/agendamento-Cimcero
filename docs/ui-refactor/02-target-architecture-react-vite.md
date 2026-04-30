# Target Architecture - React + Vite (decision complete)

## Summary
Renderer will move to a React + Vite application, built to static files and loaded by Electron via `loadFile`.

Defaults:
- React + Vite
- No UI library in phase 1 (no MUI/Ant/etc.)
- State: React Context + `useReducer` (no Redux)
- Styling: CSS variables (reuse existing `:root` tokens) + component-level CSS

## Folder structure (proposed)
```
renderer/
  index.html
  vite.config.js
  src/
    main.jsx
    app/
      App.jsx
      routes/
      state/
      components/
      pages/
      styles/
```

## Electron integration boundaries
- Renderer MUST NOT import Node or Electron packages directly.
- All native functionality goes through `window.electronAPI` (from `preload.cjs`).
- Keep IPC event names stable:
  - `sessao-ok`, `sessao-expirada`, `banco-sync-*`, `whatsapp-*`, etc.

## App shell layout (React)
AppShell (`App.jsx`) responsibilities:
- Render the main layout (topbar + workspace columns + modals).
- Provide global contexts:
  - `BancoContext` for banco snapshot and loading status
  - `SessaoContext` for session status (expirada/ok)
  - `SyncContext` for BancoSync events and banners
  - optional: `ToastContext` for user feedback
- Mount Webview wrapper component (if applicable for the current mode).

## Webview wrapper (critical)
Implement a `SystemWebview` component that:
- renders `<webview>` with the same attributes as today,
- reattaches listeners:
  - `did-navigate`, `did-navigate-in-page` -> calls `window.electronAPI.webviewNavegou(url)`
- has a "session required" banner when `sessao-expirada` event is received.

## Data access pattern
Use a thin "gateway" module in the renderer:
`renderer/src/app/ipcGateway.js`:
- exports methods that delegate to `window.electronAPI` and provide:
  - consistent error mapping
  - logging hooks (for debug builds)

Examples:
- `getBanco()`
- `getExames({ clinicaId, tipo })`
- `agendar(payload)`
- subscription helpers for:
  - BancoSync events
  - Sessao events
  - WhatsApp events

## Styling strategy (refresh leve)
- Extract current `:root` variables into `renderer/src/app/styles/tokens.css`.
- Maintain layout parity first.
- Apply small improvements:
  - consistent spacing scale
  - typography smoothing
  - responsive grid adjustments
  - focus states and keyboard navigation where feasible

## Build outputs and loading
Vite outputs to `renderer/dist/`.
Electron main must load:
- Dev: Vite dev server (optional, for development)
- Prod: `renderer/dist/index.html` via `loadFile`

Packaging note:
- Ensure `renderer/dist/**` is included in electron-builder `files`.

