#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { GitSidebarGateway, TYPERT } from '../lib/remote.js'

// Typert codec contract across supported DSH releases. DSH 0.1.7 validates
// and invokes a strict codec through a `create()` factory
// (`codec.create().parse(v)`); DSH 0.1.2 and 0.1.5 read `codec.schema.parse(v)`
// and require a `_zod` marker on the schema. Every codec in the host manifest
// and the client mount must satisfy both faces.

function assertCodec(codec, subject) {
  assert.equal(codec.mode, 'strict', `${subject} must be strict`)
  assert.ok(typeof codec.typeSymbol === 'string' && codec.typeSymbol.length > 0, `${subject} must carry a typeSymbol`)
  // DSH 0.1.7 face.
  assert.equal(typeof codec.create, 'function', `${subject} must have a create() factory (DSH 0.1.7)`)
  assert.equal(typeof codec.create().parse, 'function', `${subject} create() must return a schema with parse()`)
  // DSH 0.1.2 / 0.1.5 face.
  assert.ok(codec.schema && '_zod' in codec.schema, `${subject} must keep a _zod-marked schema (DSH 0.1.2/0.1.5)`)
  assert.equal(typeof codec.schema.parse, 'function', `${subject} schema must keep parse()`)
}

for (const inv of TYPERT.invocations) {
  for (const p of inv.parameters) assertCodec(p.codec, `${inv.id} parameter ${p.name}`)
  assertCodec(inv.result, `${inv.id} result`)
}

// The factory's schema must validate like the legacy schema.
const status = TYPERT.invocations.find((inv) => inv.method === 'status')
assert.equal(status.parameters[0].codec.create().parse('/repo'), '/repo')
assert.throws(() => status.parameters[0].codec.create().parse(7), 'the cwd codec must reject a non-string')

// The host Service registers against the installed protocol: the hand-rolled
// Remote markers in lib/remote.js must survive whichever supported protocol
// version resolves, and must cover every manifest invocation.
const gateway = new GitSidebarGateway(new Context(), {})
const markers = remoteMethods(gateway)
assert.deepEqual(
  markers.map((marker) => marker.method),
  TYPERT.invocations.map((inv) => inv.method),
  'the gateway must register every manifest invocation, in manifest order',
)
assert.ok(markers.every((marker) => marker.invocation.kind === 'direct'), 'every registered method must be a direct invocation')

// The client mount (lib/client.js) mirrors the codec helpers; it is a browser
// module, so pin its source shape.
const client = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
assert.match(client, /function codec\(typeSymbol, parse\) \{\s*const schema = Object\.freeze\(\{ _zod: \{\}, parse \}\)\s*return Object\.freeze\(\{ mode: 'strict', typeSymbol, schema, create: \(\) => schema \}\)/, 'lib/client.js: codec() must expose both schema and create()')
assert.match(client, /codec: \{ mode: 'strict', typeSymbol: c\.typeSymbol, schema: c\.schema, create: c\.create \}/, 'lib/client.js: param() must forward create()')
assert.match(client, /return \{ mode: 'strict', typeSymbol: c\.typeSymbol, schema: c\.schema, create: c\.create \}/, 'lib/client.js: result() must forward create()')

console.log('typert codec contract: ok')
