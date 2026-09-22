# 0012 — The Files Changed Row opens a Panel Tab through a wrapped `sidebarRight` service

Date: 2026-09-22

## Status

Accepted.

This is 0012 rather than 0011 because issue #26 takes 0011 on its own branch
(`issue-26-single-toggle-set`), which is not merged into this one. If #27 lands
first the directory has a temporary gap at 0011; a gap is preferable to two
different files claiming the same number.

## Context

On DSH 0.1.5 the conversation's "Files changed" row lists the files a turn
touched. Clicking a chip calls `openFile`, which asks the shell's Rightbar
service for a file resource:

```js
// @deepseek-ai/dsh-client-ui-chat/lib/client.js
const url = fileAddressFor(sessionId, cwd, path)
if (options?.line === void 0) ctx.sidebarRight.openResource(url)
else ctx.sidebarRight.openResource(url, { params: { line: options.line } })
```

That path fed the shipped Rightbar text tab type. This plugin owns the
`rightbar` seat at the lowest priority (ADR 0009), so the shipped body never
renders and a chip click showed nothing at all. The shipped viewer cannot be
reused either: it is neither Monaco nor CodeMirror, the shell exposes only ten
shared module ids, `reflect.provide` throws on a second registration of
`sidebarRight`, and `reflect.set` refuses a foreign fiber. No plugin can
replace that service.

The address grammar is fixed and public
(`@deepseek-ai/dsh-util-workspace-path`):

```
dsh-resource://file/session/<sessionId>/<path>     workspace-relative
dsh-resource://file/absolute/<path>                absolute, or outside the workspace
```

## Decision

Read the service with `ctx.get('sidebarRight')` and wrap its `openResource`
method **on the instance**:

- The wrapper parses the address with a local mirror of the shell's grammar.
- A file address with a non-empty path becomes a Panel Tab through the
  ADR 0007 pending-open store, carrying `params.line` when the chip reported
  one. The original method is never called, so the shell column cannot expand.
- Any other address — another resource type, an unknown scope, an empty path, a
  segment that will not decode, a non-string — falls through to the original
  method, so shipped behaviour is untouched.
- `ctx.effect` restores the original on dispose. Only this plugin's own wrapper
  is removed: a later wrap by another plugin stays, and a method found on the
  prototype is deleted again rather than frozen onto the instance.

The Panel Tab type follows the extension exactly as the Explorer does, and the
Diff Preview is asked for explicitly by the Source Control file name and by the
Panel `+` picker.

## Accepted risk

The wrap needs the service object to accept an own property. Verified against
the installed package: `ctx.reflect.provide('sidebarRight', controller)` hands
out the `SidebarRightController` instance, whose `openResource` lives on the
prototype, and the instance is a plain class object — no `Object.freeze`. The
wrapper therefore shadows the prototype method and the shell's own call site
(`ctx.sidebarRight.openResource`) reaches it.

This could not be confirmed live in the running GUI: the local `web` profile
installs the published `dsh-sidebar` 0.6.0 rather than this workspace, so the
running page does not contain this change. If a future DSH build freezes the
service, the wrapper assignment is skipped entirely (the `Object.isFrozen`
guard), the chip quietly returns to doing nothing, and every other Card keeps
working. The `test-files-changed-row-bridge.mjs` suite pins the frozen case.

## What was verified

- The address parse for both scopes, encoded segments, a query or fragment
  suffix, a drive letter, a rooted path inside a session address, and every
  rejection case, through the wrapped method the shell actually calls.
- The reported line reaches the tab and marks its row when the file opens as a
  Text Preview; a repeat chip focuses the existing tab and re-marks rather than
  appending. A `.md` or `.html` chip opens its rendered tab unmarked, because a
  rendered frame has no source row to mark.
- Dispose restores the original in all three shapes (prototype method, own
  method, a later wrap by another plugin).
- A frozen service and an absent service both boot normally with no wrap.

## Consequences

- A chip click opens a Panel Tab, so the fix arrives without touching the
  shipped packages.
- The plugin now carries a copy of the address grammar. A future grammar change
  in the shell would need a matching update here; an address the mirror does not
  understand is delegated rather than misread, so the failure mode is the old
  behaviour, not a wrong tab.
- Both scopes are read, not only `session`. The shell emits an `absolute`
  address whenever it cannot place a path inside the session workspace, and
  such a path is normally outside the Working Repository. The Panel Tab then
  reports the host's "path escapes the working repository" error. That is a
  deliberate extension of the decided design: it turns a click that would
  plainly do nothing into one that says why.
- The wrapper is process-wide for the service instance, not per session. The
  Panel Tab it opens belongs to the current session, which is the session the
  chip was clicked in.

## Rejected alternatives

- **Hide the row with CSS.** The row is shipped Chat DOM; hiding it removes a
  useful affordance and fights the shell's own layout.
- **Register a second `sidebarRight` tab type.** `reflect.provide` throws on a
  second registration, and the seat is already owned.
- **Call the original and let the column expand.** The shipped body cannot
  render under this plugin's `rightbar` seat (ADR 0010), so the column would
  open onto a blank pane.
- **Patch the shipped Chat package.** The install belongs to the deployment and
  an upgrade overwrites it.
- **A new shell-independent chip.** The row belongs to Chat; the plugin cannot
  render into it.
