# Agent Playbook (delegation strategy)

This playbook describes how to delegate planning and implementation tasks to multiple agents without conflicts.

## Principles
- Disjoint write sets: each agent owns a clear set of files/folders.
- Preserve the IPC contract: `window.electronAPI` is a public interface.
- Avoid main/preload changes unless explicitly requested and reviewed.
- Prefer incremental, reviewable PRs over large rewrites.

## Recommended agent roles (write-scope boundaries)
Agent A - Inventory + component map
- Owns: `docs/ui-refactor/01-inventory-current-ui.md`
- Output: a complete map of current areas, DOM IDs, and function/event ownership.

Agent B - React/Vite + Electron loading + packaging
- Owns: `docs/ui-refactor/02-target-architecture-react-vite.md` and the build/loading sections.
- Output: decision complete integration plan for dev/prod, including electron-builder inclusion.

Agent C - CSS tokens + layout responsiveness (refresh leve)
- Owns: styling plan sections, tokens extraction approach, responsive rules.
- Output: style guide and token usage plan.

Agent D - Modals and core flows (orcamento/agendamento)
- Owns: flow mapping and acceptance criteria for modals and scheduling/orcamento.
- Output: list of critical flows, edge cases, and migration order.

Agent E - QA checklist + regression plan
- Owns: `docs/ui-refactor/07-acceptance-checklist.md` and risk mitigations.
- Output: short and executable acceptance checklist, plus log expectations.

## Integration policy
- Each agent must:
  - list files changed,
  - state assumptions,
  - include a minimal verification checklist.
- If a change touches `preload.cjs` or IPC:
  - it must be called out explicitly, with before/after contract notes.

