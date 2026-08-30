# dsh-sidebar

A Git sidebar for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web.

`dsh-sidebar` puts source control beside your DSH session: review changes, stage files, write commits, sync with a remote, and browse the commit graph without leaving the browser.

## What you get

- A collapsible sidebar on the right side of DSH Web
- A bottom Panel with Panel Tabs — file preview, Markdown, and a live terminal — available as soon as a session exists
- Source control for the active session's workspace
- Staged, unstaged, untracked, and conflicting-file views
- Stage, unstage, discard, commit, fetch, pull, and push actions
- A commit graph with branches, tags, remotes, merge lanes, and infinite scrolling
- A terminal that draws Powerlevel10k prompts correctly with no Nerd Font installed: prompt icons ship embedded in the plugin and the shell runs with `TERM=xterm-256color`
- Per-browser controls for showing or hiding cards

The sidebar uses the Git credentials already configured on the machine running `dsh web`. It does not need an API key or extra DSH settings.

## Requirements

- DeepSeek Harness with the Web profile (`dsh web`)
- Node.js 20 or later
- Git installed on the host that runs DSH Web

## Install

### 1. Add the plugin

```sh
dsh plugin --profile web add dsh-sidebar
```

### 2. Add it to your Web profile

Open `~/.dsh/profiles/web/cordis.patch.yml` and add:

```yaml
- insert:
    - id: sidebar
      name: 'dsh-sidebar'
```

You can also copy the same entry from [`cordis.patch.example.yml`](cordis.patch.example.yml).

### 3. Restart DSH Web

Restart `dsh web`, open a session, then select the arrow on the far right edge of the page to open the sidebar.

That's it. The sidebar automatically follows the repository in the active session's workspace. If the workspace is not a Git repository, it shows a helpful empty state instead.

## Using the sidebar

### Source Control

Use the **Source Control** card to work with the current repository:

- Select **+** or **−** beside a file or group to stage or unstage changes.
- Select **discard** twice to confirm that you want to throw away a file's changes. Discarding an untracked file deletes it.
- Enter a commit message and select **Commit**. Press <kbd>⌘</kbd>/<kbd>Ctrl</kbd> + <kbd>Enter</kbd> to commit from the keyboard.
- If no files are staged, committing stages all changes first—similar to VS Code's Source Control view.
- Use the sync controls to fetch, pull, or push. Pull and push require an upstream branch.

> [!WARNING]
> **Discard permanently removes changes.** For an untracked file, it deletes the file. Check the file before confirming the second discard action.

The card refreshes while it is visible, so branch and working-tree state stay current.

### Commit Graph

The **Commit Graph** card displays commits from every local and remote ref. Scroll to load older commits. Right-click a commit to copy its hash or message.

### Customize the sidebar

Select the gear icon in the sidebar header to show or hide cards. Your choice is saved in the browser, so it remains after reopening DSH Web.

## Install from GitHub

Use this option when you want to install directly from a branch, tag, or commit instead of the npm release:

```sh
dsh plugin --profile web add git+https://github.com/auggie246/dsh-sidebar.git
```

Then complete [steps 2 and 3 above](#2-add-it-to-your-web-profile).

> [!NOTE]
> A GitHub install runs this repository's build step. If pnpm reports `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`, copy the `allowBuilds` entry from its error message into `~/.dsh/profiles/web/pnpm-workspace.yaml`, then run the same install command again. The entry is specific to the Git commit pnpm downloaded.

To pin a version, append `#main`, `#v0.2.0`, or a commit SHA to the Git URL.

## Configuration and privacy

There is nothing to configure. The plugin uses your existing Git credentials and configuration on the DSH Web host. Card visibility is stored only in this browser under `dsh.rsidebar.cards.v1`.

## Try it for one session

Want to try the sidebar without installing it permanently? The repository includes a dynamic plugin that an agent can load into the running DSH process. It disappears when DSH restarts. See [`dynamic/README.md`](dynamic/README.md) for the one-session setup prompt.

## Troubleshooting

- **The sidebar is missing:** confirm the composition entry is in the Web profile, restart `dsh web`, then open the arrow on the far right edge.
- **“Not a git repository”:** open a session whose workspace is inside a Git repository.
- **Fetch, pull, or push fails:** check that Git is installed and that the host has the required Git credentials. Pull and push also need an upstream branch.
- **A commit fails:** make sure Git has a configured author identity and that your commit message is not empty.
- **A prompt icon still shows as a box:** the embedded icon set covers Powerlevel10k's default icons. If your prompt configures an icon outside that set, add its codepoint to `scripts/nerd-icon-glyphs.txt` and run `npm run build:nerd-icons`.

## Uninstall

1. Remove the `dsh-sidebar` block from `~/.dsh/profiles/web/cordis.patch.yml`.
2. Run:

   ```sh
   dsh plugin --profile web remove dsh-sidebar
   ```

3. Restart `dsh web`.

## Development

```text
lib/        Permanent plugin source
dynamic/    One-session dynamic-plugin bundle
scripts/    Bundling and verification scripts
docs/       Design notes
```

After changing `dynamic/host.js` or `dynamic/client.js`, regenerate the bundle:

```sh
npm run bundle:dynamic
```

Run the checks with:

```sh
npm test
```

## Limitations

The sidebar occupies DSH Web's right Details Column. If another plugin also uses that column, the most recently registered plugin wins. The graph is designed for clear everyday history browsing, not as a full Git GUI replacement.

## License

[MIT](LICENSE)
