# Prompts (copy/paste)

These prompts are designed to be used with coding agents. They enforce guardrails and keep work disjoint.

## System context snippet (include in every agent prompt)
```
Repo: Electron app.
Main: main.cjs
Preload: preload.cjs exposes window.electronAPI (public contract).
Renderer today: agendamentos.html loaded by BrowserWindow.loadFile.
Goal: plan and refactor UI to React + Vite with light visual refresh.
Hard rules:
- Do not rename IPC events or window.electronAPI methods.
- Renderer must not import Node/Electron; use window.electronAPI only.
- Preserve webview session capture and BancoSync banners/behavior.
Output format:
- List files touched
- Decisions made (if any)
- Verification checklist
```

## Prompt - Agent A (Inventory)
```
Task: Build the current UI inventory.
Scope: docs/ui-refactor/01-inventory-current-ui.md only.
Do:
- Map UI areas, DOM IDs, inline handlers, global state variables.
- List all references to window.electronAPI in the renderer.
Do not:
- Change application logic.
- Propose framework migration steps (handled elsewhere).
Output:
- Updated inventory Markdown
- A short "unknowns" list
```

## Prompt - Agent B (Architecture + Packaging)
```
Task: Define the target React + Vite architecture and packaging integration.
Scope: docs/ui-refactor/02-target-architecture-react-vite.md and any ADR if needed.
Do:
- Specify folder structure, dev/prod loading approach, electron-builder inclusion.
- Specify the IPC gateway module pattern in the renderer.
Do not:
- Change preload contract.
Output:
- Decision complete architecture doc
- List of required build steps and constraints
```

## Prompt - Agent C (Styling refresh leve)
```
Task: Define styling strategy for a light refresh.
Scope: docs/ui-refactor/02-target-architecture-react-vite.md (styling section) and/or a new style guide under docs/ui-refactor/.
Do:
- Reuse :root tokens, define spacing/typography scale, responsive rules.
- Identify risky CSS areas (overflow, grid, webview sizing).
Output:
- Clear token usage rules and a migration checklist for CSS.
```

## Prompt - Agent D (Core flows)
```
Task: Map critical flows (orcamento/agendamento/modals) and migration order.
Scope: docs/ui-refactor/03-migration-strategy.md and 07-acceptance-checklist.md suggestions.
Do:
- List "must not break" behaviors and how to verify them manually.
- Identify edge cases and user-visible regressions.
Output:
- A prioritized flow list and acceptance hooks.
```

## Prompt - Agent E (QA)
```
Task: Produce a short, executable acceptance checklist.
Scope: docs/ui-refactor/07-acceptance-checklist.md and 08-risk-register.md suggestions.
Do:
- Define a manual smoke suite that takes < 10 minutes.
- Define what logs to expect during BancoSync/session changes.
Output:
- Acceptance checklist + risk mitigations.
```

## Prompt - Orchestrator (consolidate into implementation plan)
```
Task: Consolidate the docs into a single implementation plan file.
Inputs: docs/ui-refactor/*.md
Output: docs/ui-refactor/09-implementation-plan.md
Must include:
- Step-by-step phases with checkpoints
- Guardrails and rollback/fallback strategy
- Testing checklist and expected logs
```

