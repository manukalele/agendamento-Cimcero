# Charter - Full UI Refactor

## Objective
Migrate the current renderer (HTML/CSS/JS inline) to a React + Vite renderer while keeping the application behavior intact.

## Non-negotiable constraints
- Do not break `window.electronAPI` (contract defined by `preload.cjs`).
- Do not change domain rules (agendamento/orcamento), only presentation and organization.
- Preserve the webview flow and the session capture (`webview-navegou` -> `PHPSESSID` capture).
- Preserve BancoSync notifications and behavior from the user's perspective.

## Out of scope (phase 1)
- Full redesign / new information architecture.
- Changing the database format (JSON to SQLite, etc.).
- Replacing the upstream system integration approach (HTTP/webview).
- Large dependency additions beyond Vite + React (no big UI libraries in phase 1).

## Success criteria
- The React UI reaches parity for core flows:
  - open app, load banco, search clinicas/exames, build orcamento, agendar, WhatsApp basics, webview login.
- All IPC events continue to work with identical names and payload shapes.
- No recurring encoding regressions (e.g., "CLINICA" rendering as "CLÃ\u008dNICA").
- The packaged build works (electron-builder), and `loadFile` points to the built HTML.

## Rollout defaults
- Prefer incremental migration and check-pointing over a big-bang rewrite.
- Any behavior change must be documented and reviewed explicitly.

