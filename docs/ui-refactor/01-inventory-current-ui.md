# Inventory - Current UI (renderer)

This document is an inventory of what exists today. It should be kept current while we refactor.

## Renderer entrypoint and load path
- The app loads `agendamentos.html` directly via `BrowserWindow.loadFile(...)` in `main.cjs`.
- There is also a splash screen (`splash.html`) loaded via `loadFile`.

## Renderer files (current)
- `agendamentos.html`
  - Large single-file UI with:
    - inline CSS in `<style>` (design tokens in `:root`),
    - a large inline `<script>` block with global state and DOM manipulation,
    - an IPC wiring block at the bottom that uses `window.electronAPI`.
- `calendario.js` (calendar behavior/support code).
- `whatsapp.js` (WhatsApp UI/support code).
- `splash.html` (splash UI).

## Areas / sections (high-level map)
From a quick scan of `agendamentos.html`:
- Topbar
  - Title/logo
  - Tab/mode toggle (topbar center)
  - Right-side status/actions
- Workspace layout
  - Left panel: pendentes / fila
  - Main columns: clinicas, laboratorio (and/or other columns depending on mode)
  - Modals (orcamento, exames, confirmacao, etc. - confirm in code)
- Webview integration section (near the bottom)
  - Listeners for `did-navigate` and `did-navigate-in-page`
  - Session events from main: `sessao-expirada`, `sessao-ok`

## State and coupling patterns (critical)
Common coupling patterns in `agendamentos.html`:
- Inline handlers in HTML: `onclick="..."`
- Global state in script:
  - `clinicas`, `laboratorios`, `banco`, counters, flags, etc.
- DOM manipulation:
  - uses IDs like `listaPendentes`, `listaClinicas`, `listaLab` and others.
- IPC usage:
  - `window.electronAPI.getBanco()`, `getExames(...)`, `getPaciente(...)`, `agendar(...)`
  - `window.electronAPI.rendererReady()`
  - `window.electronAPI.webviewNavegou(url)`
  - event subscriptions: WhatsApp, session, BancoSync, splash, canal.

## IPC contract inventory (must not break)
From `preload.cjs` (high-signal list):
- invoke:
  - `get-banco`, `get-exames`, `get-paciente`, `agendar`
  - `orc-token-criar`, `orc-token-recuperar`
  - `get-contatos-fornecedores`, `salvar-contato-fornecedor`
  - WhatsApp: `whatsapp-entrar`, `whatsapp-sair`, `whatsapp-status-atual`
  - Canal: `canal-*`
  - Credenciados: `cred-*` (present even if UI is removed later)
  - `get-versao`
- send:
  - `renderer-ready`
  - `webview-navegou`
- on:
  - `whatsapp-qr`, `whatsapp-status`
  - `sessao-expirada`, `sessao-ok`
  - `banco-sync-status`, `banco-sync-bloqueio`, `banco-sync-atualizado`
  - `splash-status`
  - `canal-status`

## Commands (PowerShell) to map the current UI quickly
These are safe "inventory" commands. They do not require `rg`.

List inline onclick handlers:
```powershell
Select-String -Path .\\agendamentos.html -Pattern "onclick=" -AllMatches |
  Select-Object -First 100 | ForEach-Object { "{0}: {1}" -f $_.LineNumber, $_.Line.Trim() }
```

List IDs used in the HTML:
```powershell
Select-String -Path .\\agendamentos.html -Pattern "id=\"" -AllMatches |
  Select-Object -First 200 | ForEach-Object { "{0}: {1}" -f $_.LineNumber, $_.Line.Trim() }
```

Find all uses of `window.electronAPI`:
```powershell
Select-String -Path .\\agendamentos.html -Pattern "electronAPI" -CaseSensitive:$false |
  Select-Object -First 200 | ForEach-Object { "{0}: {1}" -f $_.LineNumber, $_.Line.Trim() }
```

List functions defined in the inline `<script>` (rough heuristic):
```powershell
Select-String -Path .\\agendamentos.html -Pattern "^function\\s" |
  Select-Object -First 200 | ForEach-Object { "{0}: {1}" -f $_.LineNumber, $_.Line.Trim() }
```

## Encoding notes (known pain point)
We have seen mojibake strings like:
- "LABORATÃ³RIO", "CLÃ­NICA", "HORÃ¡RIO", "ORÃ§AMENTO"

During refactor, enforce:
- source files saved as UTF-8,
- the renderer HTML uses `<meta charset="UTF-8" />`,
- avoid mixing encodings in build outputs,
- add a manual visual check in acceptance checklist.

