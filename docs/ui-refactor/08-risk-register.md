# Risk Register

This is a living list of risks and mitigation steps for the UI refactor.

## R1 - Webview session capture breaks
Symptoms:
- Login loop, `sessao-ok` never fires, HTTP calls fail.
Mitigations:
- Keep `did-navigate` and `did-navigate-in-page` listeners identical.
- Add explicit logs in dev builds for navigation events and session transitions.
- Stop-the-line if session capture regresses.

## R2 - Encoding regressions (mojibake)
Symptoms:
- "CLINICA" becomes "CLÃ\u008dNICA", "ORCAMENTO" becomes "ORÃ\u0087AMENTO", etc.
Mitigations:
- Ensure all sources are UTF-8.
- Verify `meta charset="UTF-8"` in the built HTML.
- Include an explicit visual check in acceptance checklist.

## R3 - IPC contract drift
Symptoms:
- Renderer calls methods that no longer exist, or event names change.
Mitigations:
- Treat `window.electronAPI` as public API.
- Keep a contract inventory in `01-inventory-current-ui.md` and `04-guardrails.md`.

## R4 - BancoSync UI deadlocks / confusing UX
Symptoms:
- Sync starts and user cannot proceed, or sees inconsistent state.
Mitigations:
- Preserve existing banner/block semantics.
- Ensure "block" state is explicit and prevents destructive actions.

## R5 - Performance regressions (lists)
Symptoms:
- Scrolling jank, slow filters, long re-renders.
Mitigations:
- In phase 1, keep parity and avoid over-render.
- If needed later, add list virtualization as a dedicated follow-up (phase 2+).

## R6 - Packaging issues (built assets missing)
Symptoms:
- Packaged app shows "HTML not found" or blank screen.
Mitigations:
- Ensure Vite output is included in electron-builder `files`.
- Validate prod uses `loadFile` to built `index.html` (not dev server).

