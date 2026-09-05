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

`dsh-sidebar` is the Sidebar Package for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web. DSH Web renders a three-column shell: sessions on the left, the conversation in the center, and a Details Column on the right that the shipped GUI owns but leaves without a reachable entry point. The Sidebar occupies that column, so no reachable UI is displaced. It collapses to a Rail on the right edge and re-expands from it. A bottom Panel, modeled on the VS Code terminal panel, hosts closable Panel Tabs and is independent of the Sidebar.

What you get:

- A collapsible sidebar on the right side of DSH Web
- A bottom Panel with Panel Tabs — file preview, Markdown, and a live terminal — available as soon as a session exists
- Source control for the active session's workspace
- Staged, unstaged, untracked, and conflicting-file views
- Stage, unstage, discard, commit, fetch, pull, and push actions
- A commit graph with branches, tags, remotes, merge lanes, and infinite scrolling
- A terminal that draws Powerlevel10k prompts correctly with no Nerd Font installed: prompt icons ship embedded in the plugin and the shell runs with `TERM=xterm-256color`
- Per-browser controls for showing or hiding cards

Cards are independent of one another: adding, removing, or hiding a Card must not affect other Cards, and future Cards join through the same Card Manifest. The Sidebar's width and the Panel's height are globally remembered region sizes that every workspace and session restores.

Limitations: the Sidebar occupies DSH Web's right Details Column. If another plugin also uses that column, the most recently registered plugin wins. The Commit Graph is designed for clear everyday history browsing, not as a full Git GUI replacement.

## Install

### Compatibility

`dsh-sidebar` supports DeepSeek Harness 0.1.1-rc.2 and 0.1.2-rc.1. The same install steps apply to both versions. No per-version fallback is needed: the slot names (`details`, `shell.overlay`), the injected services (`shell`, `typert`, `subprocess`, `sandboxPolicy`, `slots`, `remote`, `timer`), and the plugin manifest format are unchanged between these releases. DSH resolves the plugin's peer dependencies by name only, and the declared `@deepseek-ai/dsh-typert-protocol` range covers both releases, so no manifest change is needed per version.

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

### Customize the sidebar

Select the gear icon in the sidebar header to show or hide cards. Your choice is saved in the browser, so it remains after reopening DSH Web.

### Configuration and privacy

There is nothing to configure. The plugin uses your existing Git credentials and configuration on the DSH Web host. Card visibility and layout state (Sidebar open/closed and width, Panel open/closed and height) are stored only in this browser — globally, shared by every workspace — under `dsh.rsidebar.cards.v1` and `dsh.rsidebar.panel.v1`.

### Try it for one session

Want to try the sidebar without installing it permanently? The repository includes a dynamic plugin that an agent can load into the running DSH process. It disappears when DSH restarts. See [`dynamic/README.md`](dynamic/README.md) for the one-session setup prompt.

### Troubleshooting

- **The sidebar is missing:** confirm the composition entry is in the Web profile, restart `dsh web`, then open the arrow on the far right edge.
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
