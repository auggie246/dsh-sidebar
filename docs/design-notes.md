# Design notes

## Vocabulary

See [CONTEXT.md](../CONTEXT.md) for the glossary (Sidebar, Rail, Card,
Card Manifest, Sidebar Settings, Details Column, Working Repository).

## Key decisions (v0.1.0)

- **Sidebar target: the DSH Web right Details Column.** The `details` shell
  slot is the only real right-hand grid column; in current builds its shipped
  occupant (the tool-call output viewer) has no entry point and is never
  opened, so occupying it displaces no reachable UI.
- **Always-on Rail via `shell.overlay`.** The layout owns whether the
  Details Column is open, so the re-entry point lives on the frame-wide
  overlay layer, pinned to the right edge.
- **Cards via an internal Card Manifest.** `{ id, title, order, render }`
  array in the client half; visibility toggles live behind the ⚙ gear menu
  and persist in `localStorage`. A cross-plugin card registry is a
  deliberate non-goal until a second card producer exists.
- **Working Repository = the active session's workspace path**, resolved
  client-side from the `details` slot's `useWorkspaces` snapshot
  (workspace whose `sessionIds` contains the current `sessionId`) and sent
  as `cwd` on every git call. Host-side fallback: the deployment workspace
  root.
- **Commit behaves like VS Code SCM**: with nothing staged, Commit stages
  everything (`git add -A`) first.
- **Two distribution forms share the codebase** (see README): a composition
  package (`lib/`, permanent install) and a dynamic bundle (`dynamic/`,
  session-only install). Keep them behaviorally in sync.

## Distribution formats

- `lib/` is the composition package: ESM host plugin (`index.js`), Typert
  remote manifest and gateway (`remote.js`), and the hand-wrapped
  `window.__ModuleLoader__` browser half (`client.js`). Modeled on the
  out-of-tree plugin shape used by `dsh-llm-openai-codex`.
- `dynamic/` is the agent-installed form: function bodies fed to
  `cordis_define`/`cordis_run`, plus a generated single-file JSON bundle.
