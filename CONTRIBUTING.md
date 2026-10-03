# Contributing

Questions and bug reports go to [GitHub Issues](https://github.com/auggie246/dsh-sidebar/issues). Pull requests are accepted.

Run the checks before proposing a change:

```sh
npm test
```

After changing `dynamic/host.js` or `dynamic/client.js`, regenerate the one-session bundle:

```sh
npm run bundle:dynamic
```

## Live GUI checks

The `scripts/verify-*.mjs` checks drive the running GUI. They are not part of `npm test`, because they need a live `dsh web`.

Every `dsh web` process prints one root URL that carries a random launch token:

```text
dsh web: http://127.0.0.1:3080/?token=<token>
```

`GET /?token=<token>` trades that token for a signed browser cookie, and every later request needs the cookie. The checks cannot read the token, because it lives only in that line. Pass one of these:

```sh
DSH_WEB_TOKEN=<token> node scripts/verify-live-sidebar.mjs
DSH_WEB_COOKIE=<cookie> node scripts/verify-file-preview-tabs.mjs
```

`DSH_WEB_TOKEN` is the better input. It is what the GUI itself uses, and it works for the Chrome-driven checks, which set the cookie in the browser before they navigate. `DSH_WEB_COOKIE` suits a session whose token has scrolled away; copy the cookie value from the browser's devtools.

Two more variables tune the checks:

- `DSH_WEB_URL` — the GUI origin. Defaults to `http://127.0.0.1:3080`.
- `DSH_SIDEBAR_CHROME` — the Chrome or Chromium binary. Defaults to the macOS Google Chrome path, so on Linux set it: `DSH_SIDEBAR_CHROME=/usr/bin/chromium`.

Repository layout:

```text
lib/        Permanent plugin source
dynamic/    One-session dynamic-plugin bundle
scripts/    Bundling and verification scripts
docs/       Design notes and architecture decision records (docs/adr/)
```

Releases follow [Semantic Versioning](https://semver.org/), and changes are recorded in [`CHANGELOG.md`](CHANGELOG.md) in [Keep a Changelog](https://keepachangelog.com/) format. Publishing a GitHub Release triggers the npm publish workflow (`npm` trusted publishing via OIDC), so a release is the only step needed to ship a version.
