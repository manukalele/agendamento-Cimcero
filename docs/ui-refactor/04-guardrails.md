# Guardrails (technical + process)

The goal of these guardrails is to prevent accidental regressions while the UI is being refactored.

## Technical guardrails (hard rules)
- Do not rename IPC events:
  - `sessao-ok`, `sessao-expirada`
  - `banco-sync-status`, `banco-sync-bloqueio`, `banco-sync-atualizado`
  - `whatsapp-qr`, `whatsapp-status`
  - `splash-status`, `canal-status`
- Do not change `window.electronAPI` method names or call signatures unless:
  1) the change is documented,
  2) preload + main are updated,
  3) the acceptance checklist is updated.
- Renderer must not import Node/Electron modules directly.
- Webview navigation listeners MUST remain:
  - `did-navigate` and `did-navigate-in-page` -> call `window.electronAPI.webviewNavegou(url)`
- BancoSync:
  - Preserve user-facing behavior (banners, blocks, and logs).
  - Stop-the-line if BancoSync causes UI deadlocks or a broken state.

## Stop-the-line triggers
Immediately pause the refactor and fix before continuing if any happens:
- Webview no longer triggers session capture (login loop, no `sessao-ok`).
- Encoding regressions appear in UI text (e.g., "CLINICA" becomes "CLÃNICA").
- Orcamento/agendamento flows regress (cannot create or schedule correctly).
- IPC errors appear in console repeatedly (event storm, uncaught exceptions).

## Quality guardrails (per PR checklist)
Every PR must include:
- A clear list of behavior-impacting changes (should be "none" for refactor PRs).
- A note of which blocks were migrated.
- Logs: keep debug logs in dev, avoid noisy logs in prod builds.
- Manual smoke check results (see `07-acceptance-checklist.md`).

## Packaging guardrails
- The packaged build MUST load the built renderer HTML (not the dev server).
- Ensure the Vite output directory is included in `electron-builder` config.
- Keep a clear fallback strategy during migration (optional, but recommended).

