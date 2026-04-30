# Migration Strategy (incremental)

This is the step-by-step approach to minimize risk. The guiding rule is: shell first, then replace blocks one by one.

## Phase 0 - Prep (no UI behavior changes)
- Add the React + Vite scaffolding.
- Make Electron able to load the built renderer in production (no behavior changes yet).
- Keep the current `agendamentos.html` available as fallback during development.

Checkpoint:
- Packaged build still opens correctly.
- Existing IPC contract still works.

## Phase 1 - App shell parity ("Shell first")
- Render the top-level layout in React:
  - topbar + workspace container + empty columns
- Reuse CSS tokens and approximate the current layout.
- Ensure the page loads and the basic layout is responsive.

Checkpoint:
- No errors on startup.
- Session banners and BancoSync banners can render (even if minimal).

## Phase 2 - Migrate blocks
Recommended order:
1. Topbar and mode/tabs
2. Left panel (pendentes/fila) and selection logic
3. Main columns (clinicas/lab lists)
4. Modals (orcamento, exames, confirmacao)
5. Webview wrapper (if not already migrated)
6. Secondary pages/flows (WhatsApp, canal, settings)

Rules:
- Preserve behavior first. Small UI polish is allowed but must not change the flow.
- Keep IDs/semantics temporarily if needed (short-lived compatibility).
- Replace inline `onclick` handlers with React events gradually.

Checkpoint:
- After each block, run the acceptance checklist.

## Phase 3 - Cleanup
- Remove dead DOM manipulation utilities and global state.
- Consolidate CSS:
  - tokens + layout + components
- Add a "debug panel" (optional) for IPC events and BancoSync visibility in dev builds.

Checkpoint:
- No leftover references to removed DOM IDs.
- Logs remain clear, and error states are user-friendly.

