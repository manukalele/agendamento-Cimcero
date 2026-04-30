# Acceptance Checklist (manual smoke)

Target: < 10 minutes per run.

## App boot
- Launch the app.
- Confirm splash shows progress and the main window opens.
- Confirm no repeated errors in the console.

## Session / webview
- Open the system webview (if part of the current layout/mode).
- Trigger a navigation event and confirm the app can reach a "session ok" state.
- Force session expired (or wait for it), confirm the UI shows the correct banner and does not crash.

## Banco load
- Confirm the banco loads and lists render (clinicas/lab).
- Confirm no encoding regressions in UI labels (watch for mojibake strings).

## Orcamento flow
- Search/select a clinica.
- Search/select exames.
- Confirm the orcamento modal opens and values are coherent.
- Confirm saved/loaded orcamento tokens still work (if used).

## Agendamento flow
- Add one or more items to the queue.
- Mark/select items and confirm scheduling action triggers the same behavior as before.
- Confirm errors are user-friendly (no silent failure).

## BancoSync events (when they happen)
- When BancoSync starts:
  - the UI should stay usable unless a "block" event is sent.
- If a "block" event is sent:
  - the UI should show an explicit message and not allow inconsistent actions.
- When sync finishes:
  - confirm a non-intrusive notification appears (or a clear log is emitted).

## WhatsApp / Canal (if applicable for current usage)
- Confirm WhatsApp status renders and QR events are handled.
- Confirm canal status updates render and do not crash the renderer.

