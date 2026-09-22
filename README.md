# dsh-sidebar

[![npm](https://img.shields.io/npm/v/dsh-sidebar)](https://www.npmjs.com/package/dsh-sidebar)
[![standard-readme compliant](https://img.shields.io/badge/readme%20style-standard-brightgreen.svg)](https://github.com/RichardLitt/standard-readme)
[![MIT licensed](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

A Git sidebar for DeepSeek Harness Web.

`dsh-sidebar` puts source control beside your DSH session: review changes, stage files, write commits, sync with a remote, and browse the commit graph without leaving the browser. A bottom Panel adds file preview, Markdown, and a live terminal. The sidebar automatically follows the repository in the active session's workspace and uses the Git credentials already configured on the machine running `dsh web`.

## Table of Contents

- [Security](#security)
- [Background](#background)
- [Install](#install)
  - [Compatibility](#compatibility)
  - [Dependencies](#dependencies)
  - [Adding the plugin](#adding-the-plugin)
  - [Install from GitHub](#install-from-github)
  - [Uninstall](#uninstall)
- [Usage](#usage)
  - [Source Control](#source-control)
  - [Commit Graph](#commit-graph)
  - [File previews](#file-previews)
  - [Explorer](#explorer)
  - [Customize the sidebar](#customize-the-sidebar)
  - [Configuration and privacy](#configuration-and-privacy)
  - [Try it for one session](#try-it-for-one-session)
  - [Troubleshooting](#troubleshooting)
- [Maintainers](#maintainers)
- [Thanks](#thanks)
- [Contributing](#contributing)
- [License](#license)

## Security

**Discard permanently removes changes.** Selecting **discard** twice throws away a file's changes. For an untracked file, it deletes the file. Check the file before confirming the second discard action.

Every git action the cards run is scoped by DSH's file sandbox to the Working Repository: a `workspace-write` policy covering the repository and temp areas, and nothing wider. Sync actions (fetch, pull, push) use the Git credentials and ssh configuration already present on the DSH Web host. No API key, token, or extra DSH setting is needed, and no credential is stored by the plugin.

## Background

`dsh-sidebar` is the Sidebar Package for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web. DSH Web renders a three-column shell: sessions on the left, the conversation in the center, and a right column that belongs to the shipped GUI. Before DSH 0.1.5 that column was the Details Column, whose shipped occupant had no reachable entry point. On DSH 0.1.5 it is the Rightbar, home of the built-in right Sidebar. The plugin occupies that column on every supported shell. It therefore displaces no reachable panel before 0.1.5, and it shadows the built-in right Sidebar's panel on 0.1.5 (see the limitations below). With no session yet, a Rail on the right edge opens the regions. While a session is blank, the same two region toggles sit at the header's top-right position, and they shift left while the Sidebar is open. Inside a started session they live in the session header's utilities row (see [CONTEXT.md](CONTEXT.md)). A bottom Panel, modeled on the VS Code terminal panel, hosts closable Panel Tabs and is independent of the Sidebar.

What you get:

- A collapsible sidebar on the right side of DSH Web
- A bottom Panel with Panel Tabs — file preview, Markdown, and a live terminal — available as soon as a session exists
- Source control for the active session's workspace
- A view-only file explorer over the active session's workspace (the Explorer card)
- Staged, unstaged, untracked, and conflicting-file views
- Stage, unstage, discard, commit, fetch, pull, and push actions
- A commit graph with branches, tags, remotes, merge lanes, and infinite scrolling
- A terminal that draws Powerlevel10k prompts correctly with no Nerd Font installed: prompt icons ship embedded in the plugin and the shell runs with `TERM=xterm-256color`
- Per-browser controls for showing or hiding cards

Cards are independent of one another: adding, removing, or hiding a Card must not affect other Cards, and future Cards join through the same Card Manifest. The Sidebar's width and the Panel's height are globally remembered region sizes that every workspace and session restores.

Limitations: the Sidebar occupies DSH Web's right column (the Details Column before DSH 0.1.5, the Rightbar since). On DSH 0.1.5 the plugin's seat registration shadows the built-in right Sidebar's panel at all times, including while the Workspace Sidebar is closed. The built-in service stays live, so Chat keeps mounting and its file links still reach the service, but nothing renders the result, and the built-in Files and Documents tabs have no visible panel. If another plugin also uses the column, the lowest-priority registration wins. The Commit Graph is designed for clear everyday history browsing, not as a full Git GUI replacement.

## Install

### Compatibility

`dsh-sidebar` supports DeepSeek Harness 0.1.1-rc.2, 0.1.2-rc.1, and 0.1.5-rc.2. The same install steps apply to every version. DSH 0.1.5 renamed the Details Column to Rightbar (new `rightbar` slot, `openRightbar`/`closeRightbar` layout methods, renamed frame attributes); the plugin feature-detects the layout service face at runtime and uses the matching dialect, so one build serves all supported releases with no per-version manifest change. On 0.1.5 the plugin keeps entirely out of the shipped left sidebar: it only occupies the rightbar seat it previously owned as the Details Column (ADR 0009). DSH resolves the plugin's peer dependencies by name only, and the declared `@deepseek-ai/dsh-typert-protocol` range covers all supported releases.

### Dependencies

- DeepSeek Harness with the Web profile (`dsh web`)
- Node.js 20 or later
- Git installed on the host that runs DSH Web

### Adding the plugin

```sh
dsh plugin --profile web add dsh-sidebar
```

Open `~/.dsh/profiles/web/cordis.patch.yml` and add:

```yaml
- insert:
    - id: sidebar
      name: 'dsh-sidebar'
```

You can also copy the same entry from [`cordis.patch.example.yml`](cordis.patch.example.yml).

Restart DSH Web, open a session, then select the arrow on the far right edge of the page to open the sidebar.

That's it. The sidebar automatically follows the repository in the active session's workspace. If the workspace is not a Git repository, it shows a helpful empty state instead.

### Install from GitHub

Use this option when you want to install directly from a branch, tag, or commit instead of the npm release:

```sh
dsh plugin --profile web add git+https://github.com/auggie246/dsh-sidebar.git
```

Then complete the patch and restart steps above.

> [!NOTE]
> A GitHub install runs this repository's build step. If pnpm reports `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`, copy the `allowBuilds` entry from its error message into `~/.dsh/profiles/web/pnpm-workspace.yaml`, then run the same install command again. The entry is specific to the Git commit pnpm downloaded.

To pin a version, append `#main`, `#v0.4.0`, or a commit SHA to the Git URL.

### Uninstall

1. Remove the `dsh-sidebar` block from `~/.dsh/profiles/web/cordis.patch.yml`.
2. Run:

   ```sh
   dsh plugin --profile web remove dsh-sidebar
   ```

3. Restart `dsh web`.

## Usage

### Source Control

Use the **Source Control** card to work with the current repository:

- Select **+** or **−** beside a file or group to stage or unstage changes.
- Select **discard** twice to confirm that you want to throw away a file's changes. See [Security](#security) for what discard removes.
- Enter a commit message and select **Commit**. Press <kbd>⌘</kbd>/<kbd>Ctrl</kbd> + <kbd>Enter</kbd> to commit from the keyboard.
- If no files are staged, committing stages all changes first—similar to VS Code's Source Control view.
- Use the sync controls to fetch, pull, or push. Pull and push require an upstream branch.

The card refreshes while it is visible, so branch and working-tree state stay current.

### Commit Graph

The **Commit Graph** card displays commits from every local and remote ref. Each row shows the subject, the author's colored initials, and the relative time; hover a row for the full author, date, and hash. Scroll to load older commits. Right-click a commit to copy its hash or message.

### File previews

Use the Panel **+** picker to open a workspace path as **HTML file**, **Markdown file**, or **Text file**. Each choice is explicit, so the same path can stay open under different presentations.

On the first load after this upgrade, saved File Previews migrate once by extension. HTML and Markdown files keep their rendered presentations. Every other file becomes Text Preview. Later picker choices remain unchanged across Panel remounts and page reloads.

Text Preview shows inert source text with theme colors and a monospace font. It preserves whitespace, keeps long lines unwrapped, and scrolls in both directions. Empty files show `File is empty.`. Files containing a NUL byte show `Binary files are not supported.` instead. The existing `2 MB` limit and read errors apply to every File Preview.

### Explorer

The **Explorer** card is a view-only file explorer over the current session's workspace. Unlike the Git cards it is not git-bound: it renders in any workspace, git repository or not, and it hides nothing — dotfiles, `.git`, and gitignored entries all show.

- Select a folder to expand or collapse it. Each expansion lists that one folder, so large folders such as `node_modules` cost nothing until you open them, and a folder with more than 1000 entries shows a "+N more" row.
- Select a file to open a read-only preview Panel Tab. `.html` and `.htm` use HTML Preview. `.md` and `.markdown` use Markdown Preview. Matching ignores letter case. Every other path uses Text Preview, including dotfiles and extensionless files. Selecting the file again focuses the matching path-and-presentation tab. Picker overrides for the same path remain separate tabs. Selecting a file also opens the Panel if it is closed.
- The card refreshes while it is visible by re-listing only the workspace root and the folders you expanded.
- View-only means exactly that: the card renders the tree and opens previews. Creating, renaming, moving, and deleting files is out of scope.

### Customize the sidebar

Select the gear icon in the sidebar header to show or hide cards. Your choice is saved in the browser, so it remains after reopening DSH Web.

### Configuration and privacy

There is nothing to configure. The plugin uses your existing Git credentials and configuration on the DSH Web host. Card visibility and layout state (Sidebar open/closed and width, Panel open/closed and height) are stored only in this browser — globally, shared by every workspace — under `dsh.rsidebar.cards.v1` and `dsh.rsidebar.panel.v1`.

### Try it for one session

Want to try the sidebar without installing it permanently? The repository includes a dynamic plugin that an agent can load into the running DSH process. It disappears when DSH restarts. See [`dynamic/README.md`](dynamic/README.md) for the one-session setup prompt.

### Troubleshooting

- **The sidebar is missing:** confirm the composition entry is in the Web profile, restart `dsh web`, then open the arrow on the far right edge.
- **The built-in right-panel tabs are missing:** expected on DSH 0.1.5. The plugin's `rightbar` registration shadows the built-in right Sidebar's panel, so its Files and Documents tabs have no visible surface. The plugin's own cards replace them. See the limitations above.
- **“Not a git repository”:** open a session whose workspace is inside a Git repository.
- **Fetch, pull, or push fails:** check that Git is installed and that the host has the required Git credentials. Pull and push also need an upstream branch. On hosts where DSH runs the session under its file sandbox, ssh can refuse its system config because the sandbox masks file ownership outside the workspace ("Bad owner or permissions on /etc/ssh/ssh_config.d/…"). The card retries on that error with your own `~/.ssh/config`, then with a config-free ssh — so your host aliases, ports and identity settings still apply and no key name is hard-coded. The same push or pull in your own terminal is never affected.
- **A commit fails:** make sure Git has a configured author identity and that your commit message is not empty.
- **A prompt icon still shows as a box:** the embedded icon set covers Powerlevel10k's default icons. If your prompt configures an icon outside that set, add its codepoint to `scripts/nerd-icon-glyphs.txt` and run `npm run build:nerd-icons`.

## Maintainers

[@auggie246](https://github.com/auggie246).

## Thanks

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — this plugin extends DSH Web through its Cordis plugin and slot system.
- [xterm.js](https://xtermjs.org/) — vendored under [`lib/vendor/xterm`](lib/vendor/xterm) (MIT) and powering the Terminal Panel Tab.

## Contributing

Questions and bug reports go to [GitHub Issues](https://github.com/auggie246/dsh-sidebar/issues). Pull requests are accepted.

Run the checks before proposing a change:

```sh
npm test
```

After changing `dynamic/host.js` or `dynamic/client.js`, regenerate the one-session bundle:

```sh
npm run bundle:dynamic
```

Repository layout:

```text
lib/        Permanent plugin source
dynamic/    One-session dynamic-plugin bundle
scripts/    Bundling and verification scripts
docs/       Design notes
```

Releases follow [Semantic Versioning](https://semver.org/), and changes are recorded in [`CHANGELOG.md`](CHANGELOG.md) in [Keep a Changelog](https://keepachangelog.com/) format. Publishing a GitHub Release triggers the npm publish workflow (`npm` trusted publishing via OIDC), so a release is the only step needed to ship a version.

## License

[MIT](LICENSE) © auggie246
