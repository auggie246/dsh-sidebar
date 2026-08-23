# plugin/ — rside-2 source

The DSH web right sidebar is a **dynamic Cordis plugin** (`rside-2`, latest
package `pkg-4`). Dynamic plugins live only in the running DSH process; these
two files are the exact source of that package, so the sidebar survives DSH
restarts as code.

- `host.js` — the `code.host` function body: git RPC handlers (`status`,
  `log`, `stage`, `unstage`, `commit`, `discard`, `sync`) executed through the
  host `shell` service.
- `client.js` — the `code.client` function body: the `details`-slot sidebar
  panel, the always-on `shell.overlay` rail, the card manifest, the Source
  Control card, and the Commit Graph card (React.createElement only, no JSX).

## Reinstall after a DSH restart

Ask the agent to define and run a plugin whose `code.host` is the contents of
`host.js` and `code.client` is the contents of `client.js`, then approve the
activation in the UI.

## Versioning

New features = a new immutable package under the same `rside-2` plugin
(`cordis_define` kind `existing`, then `cordis_run` mode `update`). Keep these
files in sync with the latest package so they remain reinstallable.
