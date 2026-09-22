# Design notes

## Vocabulary

See [CONTEXT.md](../CONTEXT.md) for the glossary (Sidebar, Rail, Header
Toggles, Card, Card Manifest, Sidebar Settings, Details Column / Rightbar,
Working Repository, Explorer).

## Key decisions

- **Sidebar target: the DSH Web right column** — the `details` slot on
  pre-0.1.5 shells, the `rightbar` seat since DSH 0.1.5 (ADR 0009). The
  plugin feature-detects the layout service face and speaks both dialects,
  so one build owns the column on every supported shell; on 0.1.5 the
  shipped right Sidebar's visible seat is shadowed while its service stays
  live for Chat, and the shipped expand control for that column is shadowed
  too, in the `conversation.session.header.corner` seat (ADR 0011). While
  the plugin's own Sidebar does not dock into the column, the plugin reports
  the column hidden.
- **Hero-only Rail via `shell.overlay`; in-session Header Toggles.** The
  layout owns whether the Details Column is open, so the re-entry point
  lives on the frame-wide overlay layer, pinned to the right edge. A
  permanent floating bar there covers the shell's Turn Navigator turn-mark
  lane, so the Rail renders only while no session is active; with a session
  the same two-button pair renders in the session-header utilities row
  (ADR 0008). The overlay occupant still mounts the regions — the bottom
  Panel and the blank-session overlay Sidebar — in every state.
- **New sessions: reserved-width overlay.** The shell hard-zeros the Details
  Column until the current session is started (`blank === false`), so before
  the first message the Sidebar cannot dock. In that state the Sidebar floats
  on the overlay layer while its stylesheet reserves the panel width inside
  the shell frame's center column (`--rsb-panel-w`, shared by the panel width
  and the reservation), so the conversation resizes instead of being covered.
  The first message starts the session, and the Rail's layout effect docks the
  Sidebar into the Details Column.
- **Cards via an internal Card Manifest.** `{ id, title, order, render }`
  array in the client half; visibility toggles live behind the ⚙ gear menu
  and persist in `localStorage`. A cross-plugin card registry is a
  deliberate non-goal until a second card producer exists.
- **Working Repository = the active session's workspace path**, resolved
  client-side from the `useWorkspaces` snapshot (workspace whose
  `sessionIds` contains the current `sessionId`) and sent as `cwd` on every
  git call. The current `sessionId` comes from where the Sidebar renders:
  the framework's standard props inside the session-scoped `details` slot,
  or — on a new/blank session, where the shell hard-zeros that column and
  the Sidebar floats on the root-scoped `shell.overlay` slot with no
  `sessionId` — the sessions store's current session, which the Rail passes
  down itself (ADR 0005). Host-side fallback: the deployment workspace root.
- **Commit behaves like VS Code SCM**: with nothing staged, Commit stages
  everything (`git add -A`) first.
- **Explorer Card: view-only, not git-bound, lazy.** The tree roots at the
  session workspace directory without a git requirement, lists one directory
  per expansion, and refreshes while visible by re-scanning expanded
  directories only. File selection opens a preview Panel Tab through a
  module-scope pending-open store that `BottomPanel` drains — the first
  Card→Panel seam (ADR 0007).
- **File Preview presentation follows the opening action.** The Panel picker
  remains an explicit override. Explorer selection routes `.html` and `.htm`
  to HTML Preview, `.md` and `.markdown` to Markdown Preview, and every other
  path to Text Preview. Matching ignores letter case. Path and presentation
  together form tab identity. Legacy Panel state migrates once by these rules,
  then `schema: 1` makes saved presentation types authoritative. See
  [plain-text-file-preview-design.md](plain-text-file-preview-design.md).
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
