# dynamic/ — session-only install bundle

These files are the **dynamic Cordis plugin** form of dsh-git-sidebar: the
same sidebar, but installed into a *running* DSH process by an agent (the
`cordis_define`/`cordis_run` tools) with zero changes to the deployment. It
disappears when that DSH process restarts.

- `host.js` — the `code.host` function body (git RPC handlers).
- `client.js` — the `code.client` function body (the sidebar UI).
- `dsh-git-sidebar.dynamic.json` — generated single-file bundle
  (`{ name, version, host, client }`) produced by
  `npm run bundle:dynamic` (`scripts/bundle-dynamic.mjs`). Share this one file.

## Install (session-only)

Paste this into a DSH session whose agent has the Cordis tools:

> Read `dynamic/dsh-git-sidebar.dynamic.json`. Call `cordis_define` with a new
> plugin, using its `name` and `description`, and its `host` and `client`
> strings as `code.host` and `code.client`. Then `cordis_run` the returned
> package. I'll approve the activation.

For a permanent install that survives DSH restarts, see the root
[README](../README.md) — that path uses `lib/` instead.
