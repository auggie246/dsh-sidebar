#!/usr/bin/env node
// readFile host RPC check (ticket #7): the rsidebarGit gateway gains a
// readFile(cwd, path) method that reads one file from the Working
// Repository through ctx.shell. The picker path is confined to the
// repository root (absolute paths must already sit inside it, '..' may
// never climb above it), the file is size-capped at 2 MB, and failures
// surface the shell's message.
//
// Seam (agreed): the manifest/codec assertions are pure and run first;
// the harness then stubs the Cordis context and serves exactly the
// `wc -c < '…'` and `cat -- '…'` commands the controller issues against
// a fixture tree under a tmp workspaceRoot — no subprocess runtime is
// imported, unlike test-pty-transport.mjs.
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { readFile as fsReadFile, stat as fsStat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'
import { ReadFileResultCodec, TYPERT } from '../lib/remote.js'

// ---------------------------------------------------------------------------
// Codec sanity (pure, no process spawned)
// ---------------------------------------------------------------------------

assert.deepEqual(
  ReadFileResultCodec.schema.parse({ content: 'hello' }),
  { content: 'hello' },
  'ReadFileResultCodec must accept a good result',
)
assert.throws(() => ReadFileResultCodec.schema.parse({ content: 'hello', extra: 1 }), 'read file result with extra keys must be rejected')
assert.throws(() => ReadFileResultCodec.schema.parse({ content: 7 }), 'read file result with non-string content must be rejected')
assert.throws(() => ReadFileResultCodec.schema.parse({}), 'read file result without content must be rejected')
assert.throws(() => ReadFileResultCodec.schema.parse('nope'), 'read file result that is not an object must be rejected')

// ---------------------------------------------------------------------------
// Manifest shape
// ---------------------------------------------------------------------------

const invocations = new Map(TYPERT.invocations.map((inv) => [inv.method, inv]))
const readInv = invocations.get('readFile')
assert.ok(readInv, 'TYPERT manifest must contain the readFile invocation')
assert.equal(readInv.service, 'rsidebarGit', 'readFile must ride the rsidebarGit service')
assert.deepEqual(readInv.parameters.map((p) => p.name), ['cwd', 'path'], 'readFile parameter names must be [cwd, path]')
assert.equal(readInv.result.typeSymbol, 'dsh-sidebar/ReadFileResult', 'readFile result codec must be dsh-sidebar/ReadFileResult')

// ---------------------------------------------------------------------------
// Harness: stub Cordis context + shell serving wc/cat against a fixture tree
// ---------------------------------------------------------------------------

const effects = []
const provided = new Map()
const workspaceRoot = realpathSync(mkdtempSync(join(tmpdir(), 'rsb-read-')))
mkdirSync(join(workspaceRoot, 'docs'), { recursive: true })
writeFileSync(join(workspaceRoot, 'demo.html'), '<p>hello</p>\n')
writeFileSync(join(workspaceRoot, 'docs', 'readme.md'), '# Title\n')
writeFileSync(join(workspaceRoot, 'big.txt'), 'x'.repeat(2 * 1024 * 1024 + 1))
writeFileSync(join(workspaceRoot, 'cap.txt'), 'y'.repeat(2 * 1024 * 1024))

// Undo the shq single-quoting so the stub can compare real paths.
function unquote(quoted) {
  return quoted.replace(/'\\''/g, "'")
}

function makeCtx(root) {
  return {
    get(name) { return name === 'sandboxPolicy' ? { workspaceRoot: root } : undefined },
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') effects.push(dispose)
    },
    reflect: { provide(name, service) { provided.set(name, service) } },
    logger: { info() {}, error() {} },
    shell: {
      resolve(req) { return { ...req, workdir: root } },
      async run(req) {
        const command = String((req && req.command) || '')
        let m = /^wc -c '(.*)'$/.exec(command)
        if (m) {
          const abs = unquote(m[1])
          try {
            const st = await fsStat(abs)
            // wc pads its output; parseInt reads the size field.
            return { exitCode: 0, stdout: { text: '  ' + String(st.size) + ' ' + abs + '\n' }, stderr: { text: '' } }
          } catch {
            return { exitCode: 1, stdout: { text: '' }, stderr: { text: 'wc: ' + abs + ': No such file or directory' } }
          }
        }
        m = /^cat -- '(.*)'$/.exec(command)
        if (m) {
          const abs = unquote(m[1])
          try {
            const content = await fsReadFile(abs, 'utf8')
            return { exitCode: 0, stdout: { text: content }, stderr: { text: '' } }
          } catch {
            return { exitCode: 1, stdout: { text: '' }, stderr: { text: 'cat: ' + abs + ': No such file or directory' } }
          }
        }
        throw new Error('unexpected shell command in readFile stub: ' + command)
      },
    },
    typert: {},
  }
}

const ctx = makeCtx(workspaceRoot)
apply(ctx)
const gateway = provided.get('rsidebarGit')
assert.ok(gateway, 'apply must mount the rsidebarGit gateway into the context registry')
assert.equal(typeof gateway.readFile, 'function', 'gateway must expose readFile')

try {
  // ------------------------------------------------------------------
  // 1. Success round-trip: relative path, nested path, dot segments, and
  //    an absolute path that already sits inside the root.
  // ------------------------------------------------------------------
  assert.deepEqual(
    await gateway.readFile(workspaceRoot, 'demo.html'),
    { content: '<p>hello</p>\n' },
    'readFile must return the file content',
  )
  assert.deepEqual(
    await gateway.readFile(workspaceRoot, 'docs/readme.md'),
    { content: '# Title\n' },
    'readFile must serve nested paths relative to the root',
  )
  assert.deepEqual(
    await gateway.readFile(workspaceRoot, 'docs/../demo.html'),
    { content: '<p>hello</p>\n' },
    'readFile must resolve interior .. segments',
  )
  assert.deepEqual(
    await gateway.readFile(workspaceRoot, join(workspaceRoot, 'demo.html')),
    { content: '<p>hello</p>\n' },
    'an absolute path inside the root must be accepted',
  )
  console.log('readFile success round-trip check passed')

  // ------------------------------------------------------------------
  // 2. Confinement: '..' above the root and absolute paths outside it
  //    reject before any shell command is issued.
  // ------------------------------------------------------------------
  await assert.rejects(() => gateway.readFile(workspaceRoot, '../outside'), /escapes the working repository/, 'a path above the root must reject')
  await assert.rejects(() => gateway.readFile(workspaceRoot, 'a/../../escape'), /escapes the working repository/, 'a climbing path must reject')
  await assert.rejects(() => gateway.readFile(workspaceRoot, '/etc/passwd'), /escapes the working repository/, 'an absolute path outside the root must reject')
  console.log('readFile confinement check passed')

  // ------------------------------------------------------------------
  // 3. Validation: empty and NUL-bearing paths reject.
  // ------------------------------------------------------------------
  await assert.rejects(() => gateway.readFile(workspaceRoot, ''), /no path given/, 'an empty path must reject')
  await assert.rejects(() => gateway.readFile(workspaceRoot, 'a\0b'), /NUL/, 'a NUL byte in the path must reject')
  console.log('readFile validation check passed')

  // ------------------------------------------------------------------
  // 4. A missing file rejects with the shell's message.
  // ------------------------------------------------------------------
  await assert.rejects(
    () => gateway.readFile(workspaceRoot, 'missing.html'),
    /missing\.html.*No such file or directory/,
    'a missing file must reject with the shell message naming the file',
  )
  console.log('readFile missing-file check passed')

  // ------------------------------------------------------------------
  // 5. Size cap: over 2 MB rejects; exactly 2 MB still reads.
  // ------------------------------------------------------------------
  await assert.rejects(
    () => gateway.readFile(workspaceRoot, 'big.txt'),
    /file is larger than the 2 MB preview limit/,
    'a file over the cap must reject',
  )
  const capped = await gateway.readFile(workspaceRoot, 'cap.txt')
  assert.equal(capped.content.length, 2 * 1024 * 1024, 'a file exactly at the cap must still read')
  console.log('readFile size-cap check passed')
} finally {
  for (const dispose of effects) {
    try { await dispose() } catch {}
  }
  rmSync(workspaceRoot, { recursive: true, force: true })
}
console.log('readFile RPC check passed')
