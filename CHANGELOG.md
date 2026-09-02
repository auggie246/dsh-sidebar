# Changelog

All notable changes to `dsh-sidebar` are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/); versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed

- The Sidebar works on a brand-new session. Before a session's first message
  the Details Column is hard-zeroed and the Sidebar renders as a floating
  overlay from a root-scoped slot, whose props carry no sessionId — so every
  git RPC fell back to the deployment workspace root instead of the session's
  workspace, leaving Source Control on "Not a git repository." and the Commit
  Graph on "No commits yet.". The overlay now passes the sessions store's
  current session to the panel, the same authority the workspaces snapshot
  matches, and the cards resolve the Working Repository from it; with no
  current session the behavior is unchanged. (#14)

### Changed

- Commit Graph rows are leaner. The short hash no longer takes row space —
  the right-click menu still copies it and the hover tooltip still shows the
  full hash. The author's username is now a fixed-width initials avatar,
  deterministically colored per author, so long names no longer crowd the
  subject line; the full name remains on the row tooltip and on the avatar.
  Each row is now: subject · author initials · relative time.

## [0.3.1] - 2026-09-02

### Fixed

- Source Control actions work again. Stage, unstage, commit, discard, push,
  pull and fetch all ran under DSH Web's deployment default `read-only`
  sandbox, so every git write was denied while the status listing kept
  working. The host half now runs each git action under a `workspace-write`
  sandbox scoped to the Working Repository. (#13)
- Action errors stay visible. A failed stage, commit or push used to be wiped
  by the next 3-second status poll, so the message flashed and disappeared.
  The card now keeps the action error on screen until it is clicked; status
  errors still clear automatically when the poll recovers. (#13)

### Added

- Regression tests for both fixes, wired into `npm test`:
  `scripts/test-git-sandbox-policy.mjs` drives the real sandbox executor and
  policy service and asserts every git spawn carries a `workspace-write`
  policy scoped to the repository;
  `scripts/test-commit-error-persistence.mjs` asserts an action error
  survives a successful status refresh and dismisses on click.
- Tests that import the DSH host runtime (PTY transport, sandbox policy) now
  skip with a note on machines that have no DSH checkout, instead of failing
  the suite. This keeps `pnpm test` green on CI runners.

### Changed

- `pnpm-lock.yaml` is now tracked, so the publish workflow's frozen CI
  install is reproducible and supply-chain verified.

## [0.3.0] - 2026-08-30

### Added

- Panel under the center column with a functional tab strip: open and close
  (#3), drag-resize and the tab strip header (#4, #5), Localhost URL Panel
  Tabs (#6), HTML and Markdown file preview tabs (#7), and the Terminal Tab
  wired to the pty transport with vendored xterm.js (#8).
- Terminal Tab reload re-attach and dead-session placeholders (#9).
- Panel spans the center column content box (#12).

### Changed

- The plugin ships as a profile-installable bundle: `dsh plugin --profile
  <name> add dsh-sidebar` registers it, and the dynamic bundle is rebuilt by
  `npm run bundle:dynamic`.

## [0.2.0] - 2026-08-28

### Added

- Right-docked Sidebar for DSH Web with the Source Control card (status
  listing, stage and unstage, commit, push, pull and fetch, discard, file
  previews) and the Commit Graph card, sharing the Card Manifest for future
  cards.
