# Changelog

All notable changes to `dsh-sidebar` are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/); versions follow
[Semantic Versioning](https://semver.org/).

## [0.4.0] - 2026-09-05

### Added

- A README Compatibility section: `dsh-sidebar` supports DeepSeek Harness
  0.1.1-rc.2 and 0.1.2-rc.1 with the same install steps and no per-version
  fallback. Verified against the 0.1.2-rc.1 source: the plugin's slots
  (`details`, `shell.overlay`), its injected services (`shell`, `typert`,
  `subprocess`, `sandboxPolicy`, `slots`, `remote`, `timer`), and the bundle
  manifest format are unchanged, and DSH resolves plugin peer dependencies by
  name only, never by version range.

### Changed

- The peer dependency range on `@deepseek-ai/dsh-typert-protocol` gains
  `^0.1.2-rc.0`. DSH never enforced the range, so this changes no runtime
  behavior; it makes range-aware tooling accept DSH 0.1.2-rc.1 instead of
  reporting a peer mismatch. The dev harness keeps its existing range, so
  `pnpm-lock.yaml` is untouched.

## [0.3.3] - 2026-09-04

### Fixed

- The docked Sidebar's resize line sits on the Sidebar edge again. The shell
  positions its own Details handle from its transient layout store, which
  resets to 360px on every session switch — so after a switch the Sidebar
  kept its remembered width while the visible line stayed at the default
  position. The details registration now mounts the plugin's own left-edge
  drag handle: it writes `--rsb-panel-w` and the frame's inline grid track
  together and persists on release, and the shell's stale handle is hidden
  while the Sidebar owns the column. (#15)
- Source Control sync retries even when the sandboxed shell surfaces ssh's
  ownership diagnostic on stdout. The retry gate read only stderr, so a
  transport that places the child's diagnostic there returned the original
  "Bad owner or permissions" error without ever attempting the safe
  `core.sshCommand` chain. Both host halves now inspect both streams. (#17)

## [0.3.2] - 2026-09-04

### Fixed

- Source Control fetch, pull and push work again when DSH runs the session
  under its file sandbox. ssh inside the sandbox sees the system ssh config
  as owner `nobody:nobody`, fails its ownership check and refuses to read
  `/etc/ssh/ssh_config.d/*.conf`, so every sync died with "Bad owner or
  permissions" before any network access; the user's own terminal was never
  affected because it runs without the sandbox. The host `sync` now retries
  the same op with `core.sshCommand`, walking the chain a human would: first
  the user's `~/.ssh/config` — the file the sandbox does not mask, so host
  aliases, ports and IdentityFile settings still apply — then a config-free
  `ssh -F /dev/null`, whose default identity-file discovery and agent need
  no hard-coded key name. Healthy machines never reach the retries, and
  non-ssh remotes never fail this way. (#17)
- The Source Control Commit button shows its label again in the dark theme.
  The button paired the themed brand fill with a hardcoded white text color;
  DSH resolves `--dsw-alias-brand-primary` to the theme's ink accent —
  near-black in the light theme, near-white (#f9fafb) in the dark theme — so
  the dark theme rendered white text on a near-white button at 1.05:1
  contrast: a solid block with no visible text, brightening as soon as a
  commit message made it clickable. The Commit button and the Panel tab
  picker's Open button, which carried the same rule, now use the host's
  primary-button text token `--dsw-alias-label-primary-foreground` (dark:
  18.08:1, light: 18.90:1). (#16)
- The Sidebar works on a brand-new session. Before a session's first message
  the Details Column is hard-zeroed and the Sidebar renders as a floating
  overlay from a root-scoped slot, whose props carry no sessionId — so every
  git RPC fell back to the deployment workspace root instead of the session's
  workspace, leaving Source Control on "Not a git repository." and the Commit
  Graph on "No commits yet.". The overlay now passes the sessions store's
  current session to the panel, the same authority the workspaces snapshot
  matches, and the cards resolve the Working Repository from it; with no
  current session the behavior is unchanged. (#14)
- The Sidebar keeps its size across workspaces. Switching to a session in
  another workspace closed and re-opened the shell's Details Column, snapping
  the docked Sidebar back to the 360px default and discarding any width the
  user had dragged; the floating Sidebar on a fresh session had a fixed,
  non-draggable width. The Sidebar width is now user-draggable in both modes,
  joins Panel height in the globally stored layout state, and every session
  switch restores the remembered width. (#15)

### Added

- `scripts/test-sync-ssh-retry.mjs` guards the sync fix: it drives the real
  sandboxed executor with a `git` shim that fails plain sync ops with
  OpenSSH's exact ownership-check error, and asserts the retry walks
  `core.sshCommand` from `ssh -F ~/.ssh/config` to `ssh -F /dev/null` when no
  user config can be read, that a healthy first attempt is unwrapped, that
  every attempt failing surfaces the last error, and that `dynamic/host.js`
  carries the same fix. It skips on machines without a DSH checkout. Wired
  into `npm test`. (#17)
- ADR 0006 records why the card's git runs sandboxed through the shell
  service, and why sync walks the ssh config only after ssh's exact
  ownership error, with the rejected alternatives. (#17)
- `scripts/test-commit-button-theme-contrast.mjs` guards the fix: it extracts
  the Commit and Open button rules from both client sources, resolves them
  against the real DSH theme token tables, and asserts a WCAG contrast of at
  least 4.5:1 in both themes plus a non-empty button label. It skips on
  machines without a DSH checkout. Wired into `npm test`. (#16)

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
