# dsh-sidebar

A right-docked, modular **Sidebar for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web** (`dsh web`), delivered as an out-of-tree DSH plugin. Git cards are its initial cards, not its boundary.

## Features

- **Collapsible right sidebar** — docks into the right column of the DSH Web layout, collapses to an always-on rail (`◀`) pinned to the right edge; one click re-opens it.
- **Modular cards** — content units contributed through an internal card manifest. Show/hide each card from the ⚙ gear menu; choices persist in the browser.
- **Source Control card** (VS Code style) — branch with ahead/behind counts, staged/unstaged groups with per-file and stage-all controls, per-file discard (two-click confirm), commit box with ⌘/Ctrl+Enter, auto-stage-all commit when nothing is staged, fetch/pull/push, and a 3-second auto-refresh while visible.
- **Commit Graph card** — real branch/merge lanes computed from commit parents, all refs (`--all`) with branch/tag/remote badges, infinite vertical scroll (100 commits per batch), and a right-click menu to copy the commit hash or message.
- **Follows your session** — the cards operate on the active session's workspace repository; a clean "Not a git repository" state appears for non-repo workspaces.

## Requirements

- A [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh) deployment (`@deepseek-ai/dsh` 0.1.0-rc.7 or compatible) with the **web profile** (`dsh web`).
- `git` on the host running `dsh web`.

## Install — option A: permanent plugin (recommended)

This is the standard out-of-tree DSH plugin path; it survives restarts.

```sh
# 1. Get the package
git clone https://github.com/YOUR-USER/dsh-sidebar.git
cd dsh-sidebar

# 2. Install local peer dependencies (required for a source-link install)
corepack pnpm install

# 3. Install it into the web profile (pnpm add under the hood)
dsh plugin --profile web add /path/to/dsh-sidebar
```

4. Append the composition row from [`cordis.patch.example.yml`](cordis.patch.example.yml) to your profile patch layer:

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- insert:
    - id: sidebar
      name: 'dsh-sidebar'
```

5. **Restart `dsh web`**, open any session, and click the `◀` rail on the right edge.

### Uninstall

Remove the `- insert:` block above from `cordis.patch.yml`, then:

```sh
dsh plugin --profile web remove dsh-sidebar
```

Restart `dsh web`.

## Install — option B: session-only dynamic plugin (zero install)

No files touch your DSH deployment — an agent defines the plugin into the
running DSH process. It disappears when that process restarts. See
[`dynamic/README.md`](dynamic/README.md); the short version: give your DSH
agent this prompt —

> Read `dynamic/dsh-sidebar.dynamic.json` from this repo. Call `cordis_define` with a new plugin, using its `name` and `description`, and its `host` and `client` strings as `code.host` and `code.client`. Then `cordis_run` the returned package; I'll approve the activation.

## Usage

| Control | Action |
| --- | --- |
| `◀` / `▶` rail | Open / collapse the sidebar |
| ⚙ in the sidebar header | Show/hide cards (persisted in the browser) |
| `+` / `−` on a file or group | Stage / unstage |
| `↺` then `✓` on a file | Discard changes (untracked files are deleted) |
| Commit button or ⌘/Ctrl+Enter | Commit; with nothing staged, stages everything first (VS Code behavior) |
| `⟳` / `↓` / `↑` | Fetch / pull / push (pull & push need a configured upstream) |
| Right-click a commit row | Copy commit hash or message |
| Scroll the graph | Loads 100 more commits as you approach the end |

## Development

```
lib/            composition package (the permanent install)
  index.js      host plugin: `rsidebarGit` Typert remote service (git ops)
  remote.js     Typert manifest + strict JSON codecs + gateway class
  client.js     browser half (window.__ModuleLoader__ wrapper)
dynamic/        session-only install form (agent-defined dynamic plugin)
  host.js, client.js, dsh-sidebar.dynamic.json (generated)
scripts/        bundle-dynamic.mjs — regenerates the single-file bundle
docs/           design notes; CONTEXT.md (root) — project glossary
cordis.patch.example.yml — the composition row to copy into a profile
```

Both distribution forms share behavior; keep them in sync. After editing
`dynamic/host.js` or `dynamic/client.js`, run `npm run bundle:dynamic` and
commit the regenerated bundle. `npm test` syntax-checks the `lib/` files.

## Limitations

- Session-only installs (option B) vanish on DSH restart by design.
- The sidebar takes over the shell's right Details Column; in current DSH
  builds that column's shipped panel has no entry point, so nothing reachable
  is displaced — but a future DSH that populates it will share the column
  with this plugin on last-registration wins.
- Graph rendering is a pragmatic lane layout, not a full GitLens clone.

## License

[MIT](LICENSE)
