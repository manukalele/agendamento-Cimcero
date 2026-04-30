# UI Refactor Kit (React + Vite)

This folder contains a planning kit: a set of Markdown documents that help us plan (and later execute) a full UI refactor.

Goals:
- Target architecture: React + Vite for the renderer.
- Scope: "refresh leve" (light polish), no domain-rule changes.
- Guardrails: checklists + logs + rules to avoid regressions in IPC, webview, encoding, and core flows.

## How To Use (recommended order)
1. Read `00-charter.md` and confirm the constraints.
2. Fill/validate `01-inventory-current-ui.md` with the real current state.
3. Lock the target architecture in `02-target-architecture-react-vite.md`.
4. Write the step-by-step sequence in `03-migration-strategy.md`.
5. Lock guardrails and acceptance checks: `04-guardrails.md` and `07-acceptance-checklist.md`.
6. Use `05-agent-playbook.md` and `06-prompts.md` to delegate and produce the final implementation plan.
7. Track risks in `08-risk-register.md`.

If desired, capture decisions as ADRs under `adr/`.

## Glossary
- main process: Electron main (`main.cjs`), owns BrowserWindow and OS integrations.
- preload: Electron preload (`preload.cjs`), exposes `window.electronAPI` via contextBridge.
- renderer: the UI (currently `agendamentos.html` loaded via `BrowserWindow.loadFile`).
- IPC: Electron communication via `ipcMain.handle` and `ipcRenderer.invoke/on/send`.
- webview: embedded system UI; used to login/capture session and interact with the upstream system.
- BancoSync: background sync job that updates `banco-completo-*.json` and emits IPC status events.

## Definitions
- refatorar: reorganize and re-implement the UI code while preserving behavior.
- migrar: change platform/stack boundaries (e.g., HTML/JS to React/Vite).
- refresh leve: small improvements to spacing/typography/responsiveness without a full redesign.

