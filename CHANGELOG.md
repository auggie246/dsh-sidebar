# Changelog

All notable changes to `dsh-sidebar` are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/); versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed

- DSH 0.1.7 support: `typert-loader` rejected the plugin with "parameter codec
  has no create() factory". DSH 0.1.7 builds a strict codec's schema through
  `codec.create()`; both the host manifest (`lib/remote.js`) and the client
  mount (`lib/client.js`) now carry `create()` beside the `schema` that DSH
  0.1.2 and 0.1.5 read.

### Added

- A Diff Preview Panel Tab (issue #27): one unified change against `HEAD`,
  rendered as rows that carry the old number, the new number, and the
  `-`/`+`/space marker. It opens from a Source Control file name and from the
  Panel `+` picker, and a staged plus an unstaged change to one path share the
  one tab. A new `gitDiff` host method serves it on `readFile`'s sandboxed and
  confined path, with `--no-color` and the same 2 MB cap.
- The Text Preview now colours source (issue #27): a vendored Prism build with
  20 common languages is inlined into both client twins by
  `npm run sync:vendor`, beside the vendored xterm. Files up to 512 KB are
  coloured; larger files render plain. A toolbar row carries the path, a copy
  control, a wrap toggle, and a hint at the browser's own find, and every
  source line has its own number in the gutter.
- A chip on the Files Changed Row now opens a Panel Tab (issue #27). That row
  called `ctx.sidebarRight.openResource`, which fed the shipped Rightbar tab
  type that this plugin's `rightbar` seat shadows, so a click showed nothing.
  The plugin wraps that service method on the instance (ADR 0012), routes a
  file address into the ADR 0007 pending-open store, and never calls the
  original, so the shell column cannot expand. Any other address keeps the
  shipped behaviour, and a dispose restores the original method.
- A chip that reports a line marks that row in the Text Preview and brings it
  into view.
- `scripts/live-auth.mjs` gives the live GUI checks the browser session they
  need. Every `dsh web` process prints one root URL carrying a random launch
  token, and the checks cannot read it, so they now take `DSH_WEB_TOKEN` and
  trade it for the session cookie, or take `DSH_WEB_COOKIE` directly.
  `scripts/test-live-auth.mjs` guards that contract against a fixture server
  that reproduces the token exchange and the 401, and it is wired into
  `npm test`.

### Changed

- A Diff Preview for a file with no change against `HEAD` — an untracked file,
  or one whose change was just reverted — shows the Text Preview under the same
  tab type and identity, rather than an empty frame.

### Fixed

- The `scripts/verify-*.mjs` live checks reach the running GUI again. Each
  passed the root document request with no credential and stopped at the GUI's
  401, because none of them carried the browser session `dsh web` mints at
  start-up. Nine checks are affected. Every request they make now carries that
  session, so they no longer depend on which asset routes the GUI leaves public:
  the three plain-HTTP checks send the cookie themselves, and the six
  Chrome-driven ones set it in the browser before they navigate.
- `scripts/verify-web-profile-install.mjs` reads the sidebar composition row
  from the package's own bundle patch, which is where DSH applies it, instead of
  requiring it in the profile's `cordis.patch.yml`. It also fails when the row
  is in both layers, because a duplicate loader entry id stops the profile from
  booting. The README install steps told users to make exactly that mistake, and
  they are corrected.

- Exactly one right-region control set on DSH 0.1.5 (issue #26): the shipped
  Rightbar registers an expand control for its collapsed column into the
  `conversation.session.header.corner` seat, so a fresh load showed two
  control sets, and one click on it left an empty column open. The plugin now
  takes that single-kind seat at priority -1 with an empty component, and it
  keeps the shell column shut whenever the Workspace Sidebar does not dock
  into it — the hero page, a blank session, and a started session with the
  Sidebar closed (ADR 0011). Older shells receive no new layout call.

## [0.6.0] - 2026-09-22

### Added

- DSH 0.1.5 (Rightbar) support (issue #25): the shell renamed the Details
  Column to Rightbar — a new `rightbar` slot, `openRightbar(track, fullscreen)` /
  `closeRightbar()` layout methods, a `[data-side="rightbar"]` drag handle, and
  a `data-rightbar-collapsed` marker. The plugin feature-detects the layout
  service face once at boot and speaks both dialects (ADR 0009), so one build
  serves 0.1.1-rc.2, 0.1.2-rc.1, and 0.1.5-rc.2.
- The `@deepseek-ai/dsh-typert-protocol` peer dependency range now also covers
  `^0.1.5-rc.0`.

### Changed

- On DSH 0.1.5 the plugin occupies the rightbar seat and shadows the built-in
  right Sidebar's visible panel. The shipped `ui-sidebar-right` stays installed
  because Chat hard-injects its service, so Chat keeps mounting and its file
  links still reach the service. No built-in panel renders the result, and its
  Files and Documents tabs have no visible surface.

### Fixed

- Blank-session Header Toggles shift left by the open Sidebar width, keeping
  the controls beside the Sidebar instead of covering its top-right content.

## [0.5.3] - 2026-09-14

### Added

- The Panel now supports a safe Text Preview presentation. The `+` picker can
  open any workspace path as inert source text, regardless of its extension.
  Text Preview preserves whitespace, uses theme colors and monospace text,
  scrolls without wrapping,
  reports empty files, and rejects NUL-containing content as unsupported binary.
  File presentation remains part of tab identity and persists per session.
- Explorer file selection now routes `.html` and `.htm` to HTML Preview,
  `.md` and `.markdown` to Markdown Preview, and every other path to Text
  Preview. Matching ignores letter case. Repeated selection focuses the tab
  matching both path and presentation, while picker overrides remain separate.
- Legacy saved Panel state now migrates once by the same extension rules and
  immediately receives `schema: 1`. Valid non-file tabs and the active tab
  remain unchanged. Marked state preserves later explicit picker choices.

### Fixed

- Source Control file and group actions use the same SVG stroke icons and
  button sizing as Fetch, Pull, Push, and Refresh, including discard confirmation.
- New blank sessions show header-style Sidebar and Panel toggles at the
  top-right until DSH shows the real session header. Both regions remain
  available before the first message, without the old centered-to-header
  position jump or the Turn Navigator overlap in started sessions.

## [0.5.2] - 2026-09-11

### Fixed

- The right-edge Rail overlapped the DSH Turn Navigator: its two region
  toggles floated (`position: fixed`, vertically centered, z-index 60) over
  the turn-mark lane the navigator renders in the rightmost strip of the
  conversation, covering the marks and stealing their clicks. While a
  session is active the Sidebar and Panel toggles now render in the shell's
  `conversation.session.header.utilities` row — plain inline content, no
  floating overlap possible. The edge Rail remains only on the hero page,
  where no session is active and the Turn Navigator does not exist. Both
  client halves (composition plugin and dynamic-plugin variant) carry the
  change; see ADR 0008.
- The Turn Navigator vanished whenever the Sidebar was open on windows
  narrower than ~1600px: the shell hides it through an
  `@container (width<=900px)` rule once the open Sidebar narrows the
  conversation past that width. The marks reposition with the conversation
  on their own, so the plugin now counter-rules the hide
  (`div.eGxaPq_slot { display: block }` inside the same container
  condition), loading after the shell's bundle and at higher specificity.
  If a shell update renames the hashed class, the override no-ops and the
  shell behavior returns.

## [0.5.1] - 2026-09-08

### Fixed

- Long file names in the Source Control card overlapped the Stage and
  Discard buttons: `.rsb-fname` grew without bound and pushed the action
  buttons out of the row. The name now shrinks and truncates with an
  ellipsis, the action group can no longer shrink or move, and the row
  clips overflow. The full path is still one hover away via the row
  tooltip. The fix is applied to both client halves (composition plugin
  and dynamic-plugin variant).

## [0.5.0] - 2026-09-08

### Added

- The **Explorer** card joins the Sidebar: a view-only file explorer over the
  current session's workspace directory. It is not git-bound — unlike the Git
  cards it renders in any workspace, git repository or not — and it hides
  nothing: dotfiles, `.git`, and gitignored entries all show. Directories
  list lazily (one `listDir` call per expansion, capped at 1000 entries with
  a "+N more" row — the host sorts folders first and slices afterwards, so
  the shown entries are the sorted-first 1000), and the card refreshes while
  visible by re-scanning only the root and the expanded folders. Selecting a
  file opens a read-only preview Panel Tab — one tab per file, a repeat
  select focuses the open tab, and a `.md`/`.markdown` file opens as a
  Markdown preview. The Card→Panel seam is a pending-open store drained by
  the Panel (ADR 0007). Rows draw VS Code-style inline SVG folder/file/link
  icons, and the card head carries a collapse-all button using the codicon
  `collapse-all` glyph.

### Fixed

- Header action buttons (Commit Graph refresh, Explorer collapse-all) were
  disabled in real React whenever their action was published as a bare
  function: the state setter interprets function values as functional
  updates and calls them. Actions now ride inside `{ run }`.
- The dynamic twin's `BottomPanel` used `tabChipOf` without defining it, so
  any Panel render with tabs crashed with "tabChipOf is not defined" in a
  dynamic install.
- The dynamic bundle's file preview was broken: `READ_FILE_LIMIT` was used
  in `dynamic/host.js` without ever being declared, so every readFile in a
  one-session dynamic install failed on its size probe with a
  ReferenceError. The composition package (`lib/`) was unaffected.

### Changed

- Git Status pending-commit rows (Merge Conflicts, Staged Changes, and
  Changes) now share one scroll area that shows at most six file rows before
  it scrolls, so the card no longer grows with the number of pending files.
  With six or fewer rows pending the card renders as before; the cap only
  engages past six.
- Commit Graph ref pills lead with the green remote badge (`origin/main`),
  then local branches, then tags; the old order showed the local branch
  first. Symbolic HEAD pointers such as `origin/HEAD` no longer render at
  all: they only name a branch the row already shows, so the badge was pure
  duplication in both the row and the overflow popover. The Commit Ref
  Summary's glossary entry and its test now pin the new order.

## [0.4.2] - 2026-09-06

### Changed

- Commit Graph rows now follow a two-line history-list layout: short hash +
  subject on the first line, ref pills + "author · time" on the second. The
  lane dot aligns with the subject line, and the initials avatar is replaced
  by the plain author name.
- The Commit Graph scroll box caps at exactly six rows (240px) instead of
  38vh, so the default view always shows six commits before scrolling.
- Commit Graph ref pills are no longer capped at one pill plus "+N": a
  measuring pass renders as many pills as the row width fits, in priority
  order and with the existing branch/remote/tag colors, and only the
  remainder collapses into the "+N" popover button. Sidebar resizes
  re-measure the live DOM, so a pill that stops fitting converts into "+N"
  instead of clipping behind the author name.

## [0.4.1] - 2026-09-05

### Changed

- npm now carries the restructured README and the shortened package
  description ("A Git sidebar for DeepSeek Harness Web") that the re-cut
  v0.4.0 tag already carries. npm cannot republish an existing version, so
  the npm-visible documentation changes ride on this patch release. No
  plugin code changes.

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

- The README follows the [Standard Readme](https://github.com/RichardLitt/standard-readme)
  structure, with the same content re-filed into its section order. The package
  description is shortened to "A Git sidebar for DeepSeek Harness Web" to meet
  the spec's 120-character short-description rule, and the repository
  description on GitHub is updated to match.
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
