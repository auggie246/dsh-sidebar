# 0013 — Supported DSH releases: drop 0.1.1-rc.2, add 0.1.7-rc.2, with codecs that carry both schema faces

Date: 2026-09-26

## Status

Accepted.

## Context

DSH 0.1.7-rc.2 replaced how `dsh-typert-loader` validates a strict codec. Up to
0.1.5 the loader required `codec.schema` to be an object marked with `_zod` and
carrying `parse()`, and the gateway (`dsh-api-gateway`) invoked the codec as
`codec.schema.parse(value)`. On 0.1.7 the loader requires a `create()` factory
(`typeof codec.create !== "function"` throws "has no create() factory") and the
gateway invokes `codec.create().parse(value)`. `TypedCodec` in
`@deepseek-ai/dsh-typert-protocol` 0.1.7 declares `create(): TypertSchema`.

The plugin builds its codecs by hand rather than by code generation: one helper
in `lib/remote.js` and its deliberate mirror in `lib/client.js`. Both exposed
only `schema`. On 0.1.7 the host manifest therefore failed to register and the
whole plugin row did not activate:

```
typert-loader: dsh-sidebar invocation "dsh-sidebar#rsidebarGit/status"
parameter codec has no create() factory
```

The mirror must keep working on 0.1.2-rc.1 and 0.1.5-rc.2, which read `schema`.
The plugin's supported-release list had also grown one entry per DSH release
(0.1.1-rc.2, 0.1.2-rc.1, 0.1.5-rc.2) while the layout adapter behind it only
ever needed two dialects, one for the pre-0.1.5 Details Column and one for the
Rightbar.

## Decision

1. **Codecs carry both faces.** `codec(typeSymbol, parse)` freezes one schema
   object `{ _zod: {}, parse }` and returns `{ mode, typeSymbol, schema,
   create: () => schema }`. `create()` returns the same object `schema` holds,
   so both call shapes validate identically. The `param()`/`result()` builders
   in both halves forward `create` beside `schema`.

2. **Supported releases are 0.1.2-rc.1, 0.1.5-rc.2 and 0.1.7-rc.2.** Support
   for 0.1.1-rc.2 is dropped; users on it stay on dsh-sidebar 0.6.0. This
   supersedes the release list in ADR 0009's consequences, which named 0.1.1,
   0.1.2 and 0.1.5.

3. **The peer range is `^0.1.2-rc.0 || ^0.1.5-rc.0 || ^0.1.7-rc.0`** on
   `@deepseek-ai/dsh-typert-protocol`. The `^0.1.0-rc.7 || ^0.1.1-rc.0` arms
   existed only for the dropped release. The dev dependency moves to
   `@deepseek-ai/cordis` ^4.0.4, the floor 0.1.7's protocol declares.

## Alternatives rejected

- **Pin the plugin to a DSH release.** Rejected: one build serving several
  releases is the standing policy (ADR 0009), and the codec fix is additive.
- **Ship per-release typert manifests or a generated one.** Rejected: two
  faces on one codec is three lines, and a generator's output is what the
  browser half cannot run (`lib/client.js` is hand-authored).
- **Drop every release before 0.1.5.** Rejected for now: 0.1.2-rc.1 costs
  nothing extra, because the dual-dialect layout adapter it needs is already
  the one 0.1.5 shares a code path with. ADR 0010 keeps that decision open.
- **Add 0.1.7 without dropping anything.** Rejected on the owner's call: the
  list is a support commitment, and 0.1.1-rc.2 is two shell generations back.

## Consequences

- The pre-0.1.5 dialect (Details Column slot and `openDetails`/`closeDetails`)
  stays, because 0.1.2-rc.1 still needs it.
- A codec's `create()` is called per boundary value, so each call allocates a
  closure over the same frozen schema; the schema itself is still built once.
- `scripts/test-typert-codec-contract.mjs` pins both faces on every codec in
  the host manifest and on the client mirror's source shape, so a future DSH
  that requires the factory cannot silently break one half.
