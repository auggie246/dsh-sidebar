#!/usr/bin/env node
// listDir host RPC check (issue #21): the rsidebarGit gateway gains a
// listDir(cwd, path) method that lists ONE directory level of the Working
// Repository through ctx.shell. The listing path is confined to the
// workspace root exactly like readFile (absolute paths must already sit
// inside it, '..' may never climb above it, and the confinement is
// re-checked on the realpath so a symlinked directory pointing outside the
// root cannot escape), every listing carries the complete per-call sandbox
// policy, and one listing is capped at 1000 entries with hasMore/total.
//
// Seam (agreed): the manifest/codec assertions are pure and run first;
// the harness then stubs the Cordis context and serves exactly the
// `realpath -- '…'` and `find … -printf …` commands the controller issues
// against a fixture tree under a tmp workspaceRoot — no subprocess runtime
// is imported, like test-read-file-rpc.mjs.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { realpath as fsRealpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'
import { DirListResultCodec, TYPERT } from '../lib/remote.js'

// ---------------------------------------------------------------------------
// Codec sanity (pure, no process spawned)
// ---------------------------------------------------------------------------

const goodResult = {
  entries: [
    { name: 'docs', kind: 'dir' },
    { name: 'demo.html', kind: 'file' },
    { name: 'link', kind: 'link' },
  ],
  hasMore: false,
  total: 3,
}
assert.deepEqual(DirListResultCodec.schema.parse(goodResult), goodResult, 'DirListResultCodec must accept a good result')
assert.throws(() => DirListResultCodec.schema.parse({ entries: [], hasMore: false, extra: 1 }), 'a dir result with extra keys must be rejected')
assert.throws(() => DirListResultCodec.schema.parse({ entries: 'nope', hasMore: false, total: 0 }), 'a dir result with non-array entries must be rejected')
assert.throws(() => DirListResultCodec.schema.parse({ entries: [{ name: 'a', kind: 'sock' }], hasMore: false, total: 1 }), 'an unknown entry kind must be rejected')
assert.throws(() => DirListResultCodec.schema.parse({ entries: [], hasMore: 'no', total: 0 }), 'a non-boolean hasMore must be rejected')
assert.throws(() => DirListResultCodec.schema.parse({ entries: [], hasMore: false }), 'a dir result without total must be rejected')

// ---------------------------------------------------------------------------
// Manifest shape
// ---------------------------------------------------------------------------

const invocations = new Map(TYPERT.invocations.map((inv) => [inv.method, inv]))
const listInv = invocations.get('listDir')
assert.ok(listInv, 'TYPERT manifest must contain the listDir invocation')
assert.equal(listInv.service, 'rsidebarGit', 'listDir must ride the rsidebarGit service')
assert.deepEqual(listInv.parameters.map((p) => p.name), ['cwd', 'path'], 'listDir parameter names must be [cwd, path]')
assert.equal(listInv.result.typeSymbol, 'dsh-sidebar/DirListResult', 'listDir result codec must be dsh-sidebar/DirListResult')

// ---------------------------------------------------------------------------
// Harness: stub Cordis context + shell serving realpath/find against a
// fixture tree
// ---------------------------------------------------------------------------

const LIST_FMT = '%y%f\\0'

const effects = []
const provided = new Map()
const workspaceRoot = realpathSync(mkdtempSync(join(tmpdir(), 'rsb-list-')))
mkdirSync(join(workspaceRoot, 'docs'), { recursive: true })
mkdirSync(join(workspaceRoot, 'empty'), { recursive: true })
writeFileSync(join(workspaceRoot, 'demo.html'), '<p>hello</p>\n')
writeFileSync(join(workspaceRoot, 'docs', 'readme.md'), '# Title\n')
symlinkSync(join(workspaceRoot, 'demo.html'), join(workspaceRoot, 'file-link'))
// Issue #21 spec review: "nothing hidden" must survive hostile names. GNU
// find's -printf can emit NUL separators, so tab and newline names ride the
// same one command.
writeFileSync(join(workspaceRoot, 'with\ttab.txt'), 'tab\n')
writeFileSync(join(workspaceRoot, 'with\nnewline.txt'), 'newline\n')
const bigDir = join(workspaceRoot, 'big')
mkdirSync(bigDir, { recursive: true })
for (let i = 0; i < 1001; i++) writeFileSync(join(bigDir, 'entry-' + String(i).padStart(4, '0') + '.txt'), 'x')
mkdirSync(join(bigDir, 'zz-dir'), { recursive: true })
const exactDir = join(workspaceRoot, 'exact')
mkdirSync(exactDir, { recursive: true })
for (let i = 0; i < 1000; i++) writeFileSync(join(exactDir, 'entry-' + String(i).padStart(4, '0') + '.txt'), 'x')

// Undo the shq single-quoting so the stub can compare real paths.
function unquote(quoted) {
  return quoted.replace(/'\\''/g, "'")
}

let policies = []

// Emulate GNU find: one level below dir, `%y%f\0` per entry (one record:
// type char then name, NUL-terminated), where the type char maps
// readdirSync's dirent kinds the way find's %y does.
function findListing(dir) {
  const dirents = readdirSync(dir, { withFileTypes: true })
  let out = ''
  for (const d of dirents) {
    const kind = d.isDirectory() ? 'd' : d.isSymbolicLink() ? 'l' : d.isFile() ? 'f' : 'o'
    out += kind + d.name + '\0'
  }
  return out
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
        policies.push(req.sandboxPolicy)
        const command = String((req && req.command) || '')
        let m = /^realpath -- '(.*)'$/.exec(command)
        if (m) {
          const abs = unquote(m[1])
          try {
            const real = await fsRealpath(abs)
            return { exitCode: 0, stdout: { text: real + '\n' }, stderr: { text: '' } }
          } catch {
            return { exitCode: 1, stdout: { text: '' }, stderr: { text: 'realpath: ' + abs + ': No such file or directory' } }
          }
        }
        m = new RegExp("^find '(.*)' -maxdepth 1 -mindepth 1 -printf '" + LIST_FMT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + "'$").exec(command)
        if (m) {
          const dir = unquote(m[1])
          try {
            return { exitCode: 0, stdout: { text: findListing(dir) }, stderr: { text: '' } }
          } catch (e) {
            // GNU find on a non-directory path with -mindepth 1 lists
            // nothing and exits 0 (the path sits at depth 0); only real
            // failures surface as errors.
            if (e && e.code === 'ENOTDIR') return { exitCode: 0, stdout: { text: '' }, stderr: { text: '' } }
            return { exitCode: 1, stdout: { text: '' }, stderr: { text: 'find: ' + dir + ': No such file or directory' } }
          }
        }
        throw new Error('unexpected shell command in listDir stub: ' + command)
      },
    },
    typert: {},
  }
}

const ctx = makeCtx(workspaceRoot)
apply(ctx)
const gateway = provided.get('rsidebarGit')
assert.ok(gateway, 'apply must mount the rsidebarGit gateway into the context registry')
assert.equal(typeof gateway.listDir, 'function', 'gateway must expose listDir')

try {
  // ------------------------------------------------------------------
  // 1. Success round-trip: the root itself (empty path and '.'), a
  //    nested directory, and an absolute path inside the root. Kinds
  //    map to file/dir/link, folders sort before files case-
  //    insensitively (the host sorts before capping), and hostile
  //    names — tabs and newlines — survive ("nothing hidden").
  // ------------------------------------------------------------------
  assert.deepEqual(
    await gateway.listDir(workspaceRoot, ''),
    {
      entries: [
        { name: 'big', kind: 'dir' },
        { name: 'docs', kind: 'dir' },
        { name: 'empty', kind: 'dir' },
        { name: 'exact', kind: 'dir' },
        { name: 'demo.html', kind: 'file' },
        { name: 'file-link', kind: 'link' },
        { name: 'with\ttab.txt', kind: 'file' },
        { name: 'with\nnewline.txt', kind: 'file' },
      ],
      hasMore: false,
      total: 8,
    },
    'listDir with an empty path must list the workspace root, sorted, hostile names intact',
  )
  const dot = await gateway.listDir(workspaceRoot, '.')
  assert.equal(dot.entries.length, 8, "listDir with '.' must list the workspace root too")
  assert.deepEqual(
    await gateway.listDir(workspaceRoot, 'docs'),
    { entries: [{ name: 'readme.md', kind: 'file' }], hasMore: false, total: 1 },
    'listDir must serve nested paths relative to the root',
  )
  assert.deepEqual(
    await gateway.listDir(workspaceRoot, join(workspaceRoot, 'docs')),
    { entries: [{ name: 'readme.md', kind: 'file' }], hasMore: false, total: 1 },
    'an absolute path inside the root must be accepted',
  )
  const empty = await gateway.listDir(workspaceRoot, 'empty')
  assert.deepEqual(empty.entries, [], 'an empty directory must list zero entries')
  const link = await gateway.listDir(workspaceRoot, 'file-link')
  assert.deepEqual(link.entries, [], 'listing through a file symlink must succeed with zero entries (find -mindepth 1 yields none)')
  console.log('listDir success round-trip check passed')

  // ------------------------------------------------------------------
  // 2. Confinement: '..' above the root and absolute paths outside it
  //    reject before any shell command is issued, and a symlinked
  //    directory pointing outside the root must not escape either (the
  //    confinement is re-checked on the realpath).
  // ------------------------------------------------------------------
  await assert.rejects(() => gateway.listDir(workspaceRoot, '../outside'), /escapes the working repository/, 'a path above the root must reject')
  await assert.rejects(() => gateway.listDir(workspaceRoot, 'a/../../escape'), /escapes the working repository/, 'a climbing path must reject')
  await assert.rejects(() => gateway.listDir(workspaceRoot, '/etc'), /escapes the working repository/, 'an absolute path outside the root must reject')
  const outsideDir = realpathSync(mkdtempSync(join(tmpdir(), 'rsb-list-outside-')))
  symlinkSync(outsideDir, join(workspaceRoot, 'escape-dir'))
  await assert.rejects(() => gateway.listDir(workspaceRoot, 'escape-dir'), /escapes the working repository/, 'a symlinked directory pointing outside the root must reject')
  rmSync(outsideDir, { recursive: true, force: true })
  console.log('listDir confinement check passed')

  // ------------------------------------------------------------------
  // 3. Validation: a NUL-bearing path rejects, and a missing directory
  //    rejects with the shell's message (realpath fails first).
  // ------------------------------------------------------------------
  await assert.rejects(() => gateway.listDir(workspaceRoot, 'a\0b'), /NUL/, 'a NUL byte in the path must reject')
  await assert.rejects(
    () => gateway.listDir(workspaceRoot, 'missing-dir'),
    /missing-dir.*No such file or directory/,
    'a missing directory must reject with the shell message naming the path',
  )
  console.log('listDir validation check passed')

  // ------------------------------------------------------------------
  // 4. Entry cap: the host sorts (folders first, case-insensitive) BEFORE
  //    slicing, so the kept 1000 are the sorted-first 1000, not find's
  //    arbitrary readdir order.
  // ------------------------------------------------------------------
  const big = await gateway.listDir(workspaceRoot, 'big')
  assert.equal(big.entries.length, 1000, 'a huge directory must slice to exactly 1000 entries')
  assert.equal(big.hasMore, true, 'a directory over the cap must set hasMore')
  assert.equal(big.total, 1002, 'total must count every entry, not only the slice')
  assert.deepEqual(big.entries[0], { name: 'zz-dir', kind: 'dir' }, 'the slice must lead with the folder (folders sort first)')
  assert.deepEqual(big.entries[1], { name: 'entry-0000.txt', kind: 'file' }, 'the slice must continue with the alphabetically first files')
  assert.deepEqual(big.entries[999], { name: 'entry-0998.txt', kind: 'file' }, 'the slice must be the sorted-first 1000, not readdir order')
  const exact = await gateway.listDir(workspaceRoot, 'exact')
  assert.equal(exact.entries.length, 1000, 'a directory exactly at the cap must return all 1000 entries')
  assert.equal(exact.hasMore, false, 'a directory exactly at the cap must keep hasMore false')
  assert.equal(exact.total, 1000, 'a directory exactly at the cap must report the full total')
  console.log('listDir entry-cap check passed')

  // ------------------------------------------------------------------
  // 5. Sandbox policy: every spawn carries the complete per-call
  //    workspace-write policy scoped to the workspace root (ADR 0006).
  // ------------------------------------------------------------------
  assert.ok(policies.length > 0, 'the stub must have observed shell spawns')
  for (const p of policies) {
    assert.deepEqual(p, { mode: 'workspace-write', workspaceRoot: workspaceRoot }, 'every listDir spawn must stamp the complete per-call policy')
  }
  console.log('listDir sandbox-policy check passed')
} finally {
  for (const dispose of effects) {
    try { await dispose() } catch {}
  }
  rmSync(workspaceRoot, { recursive: true, force: true })
}
console.log('listDir RPC check passed')
