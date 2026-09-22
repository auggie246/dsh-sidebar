#!/usr/bin/env node
// Diff Preview check (issue #27): a Diff Preview opens from a Source Control
// file name and from the Panel "+" picker, renders one unified change against
// HEAD as numbered rows, shares a single tab between a staged and an unstaged
// change to one path, and falls back to the Text Preview when git reports no
// change (an untracked file). The host gitDiff RPC is exercised against a real
// temporary repository through the real command strings the controller
// issues, so the confinement walk, the `--no-color` pin, the unborn-HEAD
// case, and the 2 MB cap are all proven on real git output.
//
// Seam (agreed): the host half is asserted through the mounted rsidebarGit
// gateway; the browser half through the rendered shell.overlay tree and the
// stored Panel state.
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import vm from 'node:vm'
import { apply } from '../lib/index.js'
import { DiffResultCodec, TYPERT } from '../lib/remote.js'

// ---------------------------------------------------------------------------
// Codec sanity and manifest shape (pure, no process spawned)
// ---------------------------------------------------------------------------

assert.deepEqual(DiffResultCodec.schema.parse({ diff: 'x' }), { diff: 'x' }, 'DiffResultCodec must accept a good result')
assert.throws(() => DiffResultCodec.schema.parse({ diff: 'x', extra: 1 }), 'a diff result with extra keys must be rejected')
assert.throws(() => DiffResultCodec.schema.parse({ diff: 7 }), 'a diff result with a non-string diff must be rejected')
assert.throws(() => DiffResultCodec.schema.parse({}), 'a diff result without a diff must be rejected')

const invocations = new Map(TYPERT.invocations.map((inv) => [inv.method, inv]))
const diffInv = invocations.get('gitDiff')
assert.ok(diffInv, 'TYPERT manifest must contain the gitDiff invocation')
assert.equal(diffInv.service, 'rsidebarGit', 'gitDiff must ride the rsidebarGit service')
assert.deepEqual(diffInv.parameters.map((p) => p.name), ['cwd', 'path'], 'gitDiff parameter names must be [cwd, path]')
assert.equal(diffInv.result.typeSymbol, 'dsh-sidebar/DiffResult', 'gitDiff result codec must be dsh-sidebar/DiffResult')

// ---------------------------------------------------------------------------
// Host harness: a real repository behind the real command strings
// ---------------------------------------------------------------------------

const repo = realpathSync(mkdtempSync(join(tmpdir(), 'rsb-diff-')))
const unborn = realpathSync(mkdtempSync(join(tmpdir(), 'rsb-unborn-')))

function git(args) { execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore' }) }
git(['init', '-b', 'main'])
git(['config', 'user.email', 'test@example.com'])
git(['config', 'user.name', 'Test'])
writeFileSync(join(repo, 'tracked.txt'), 'one\ntwo\nthree\n')
writeFileSync(join(repo, 'big.txt'), 'x\n')
git(['add', '-A'])
git(['commit', '-m', 'init'])
// One path carries both a staged and an unstaged change.
writeFileSync(join(repo, 'tracked.txt'), 'one\nTWO\nthree\n')
git(['add', 'tracked.txt'])
writeFileSync(join(repo, 'tracked.txt'), 'one\nTWO\nthree\nfour\n')
writeFileSync(join(repo, 'untracked.txt'), 'brand new\n')
writeFileSync(join(repo, 'big.txt'), 'y'.repeat(2 * 1024 * 1024 + 64))
execFileSync('git', ['-C', unborn, 'init', '-b', 'main'], { stdio: 'ignore' })

// The stub runs the exact command string the controller builds, so the
// quoting and the flags under test are the real ones.
function makeCtx(root) {
  return {
    get(name) { return name === 'sandboxPolicy' ? { workspaceRoot: root } : undefined },
    effect() {},
    reflect: { provide(name, service) { provided.set(name, service) } },
    logger: { info() {}, error() {} },
    shell: {
      resolve(req) { return { ...req, workdir: root } },
      run(req) {
        const r = spawnSync('/bin/sh', ['-c', String((req && req.command) || '')], { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 })
        return { exitCode: r.status === null ? 1 : r.status, stdout: { text: r.stdout || '' }, stderr: { text: r.stderr || '' } }
      },
    },
    typert: {},
  }
}

const provided = new Map()
apply(makeCtx(repo))
const gateway = provided.get('rsidebarGit')
assert.ok(gateway, 'apply must mount the rsidebarGit gateway')
assert.equal(typeof gateway.gitDiff, 'function', 'gateway must expose gitDiff')

const both = await gateway.gitDiff(repo, 'tracked.txt')
assert.ok(both.diff.includes('-two'), 'the diff must carry the staged removal of the old line')
assert.ok(both.diff.includes('+TWO'), 'the diff must carry the staged addition')
assert.ok(both.diff.includes('+four'), 'the diff must carry the unstaged addition too, in one diff against HEAD')
assert.ok(!/\u001b\[/.test(both.diff), '--no-color must keep every escape sequence out of the reply')

const untracked = await gateway.gitDiff(repo, 'untracked.txt')
assert.equal(untracked.diff, '', 'an untracked file has no change against HEAD, so the diff is empty')

const absolute = await gateway.gitDiff(repo, join(repo, 'tracked.txt'))
assert.equal(absolute.diff, both.diff, 'an absolute path inside the repository must resolve to the same diff')

// git reports no change for a path that does not exist and for one it has
// never tracked; realpath does not fail either. An empty diff is the honest
// answer, and the browser then shows the Text Preview, whose readFile reports
// the real failure. The deleted-file case below proves a tracked removal still
// produces a real diff.
const missing = await gateway.gitDiff(repo, 'missing.txt')
assert.equal(missing.diff, '', 'a path that was never tracked and does not exist has no change against HEAD')

await assert.rejects(() => gateway.gitDiff(repo, '../escape.txt'), /escapes the working repository/, 'a path climbing above the root must be refused')
await assert.rejects(() => gateway.gitDiff(repo, '/etc/passwd'), /escapes the working repository/, 'an absolute path outside the root must be refused')
await assert.rejects(() => gateway.gitDiff(repo, ''), /no path given/, 'a blank path must be refused')
await assert.rejects(() => gateway.gitDiff(repo, 'big.txt'), /larger than the 2 MB preview limit/, 'a diff over 2 MB must be refused, not sent')

execFileSync('git', ['-C', repo, 'rm', '-f', '--quiet', 'tracked.txt'])
provided.clear()
apply(makeCtx(repo))
const deleted = await provided.get('rsidebarGit').gitDiff(repo, 'tracked.txt')
assert.ok(deleted.diff.includes('-one'), 'a tracked file removed from the working tree must still produce its real diff')
execFileSync('git', ['-C', repo, 'reset', '--hard', '--quiet', 'HEAD'])

provided.clear()
apply(makeCtx(unborn))
const unbornGateway = provided.get('rsidebarGit')
const noHead = await unbornGateway.gitDiff(unborn, 'anything.txt')
assert.equal(noHead.diff, '', 'a repository with no commit yet has nothing to compare against, so the diff is empty')

// ---------------------------------------------------------------------------
// Browser harness
// ---------------------------------------------------------------------------

const clientFile = process.argv[2] || 'lib/client.js'
const dynamicClient = clientFile === 'dynamic/client.js'
const source = await readFile(new URL('../' + clientFile, import.meta.url), 'utf8')
if (dynamicClient) {
  const bundle = JSON.parse(await readFile(new URL('../dynamic/dsh-sidebar.dynamic.json', import.meta.url), 'utf8'))
  const hostSource = await readFile(new URL('../dynamic/host.js', import.meta.url), 'utf8')
  assert.equal(bundle.client, source, 'the generated dynamic bundle must contain the current client source')
  assert.equal(bundle.host, hostSource, 'the generated dynamic bundle must contain the current host source')
}

const STATUS = {
  repo: true,
  root: '/workspace/a',
  branch: 'main',
  detached: false,
  upstream: 'origin/main',
  ahead: 0,
  behind: 0,
  // One path staged and unstaged at once: two rows, one diff.
  staged: [{ path: 'tracked.txt', status: 'M', untracked: false, origPath: null }],
  unstaged: [
    { path: 'tracked.txt', status: 'M', untracked: false, origPath: null },
    { path: 'untracked.txt', status: 'U', untracked: true, origPath: null },
  ],
  conflicts: [],
  fingerprint: '2|deadbeef|',
}

const DIFFS = {
  'tracked.txt': [
    'diff --git a/tracked.txt b/tracked.txt',
    'index 1111111..2222222 100644',
    '--- a/tracked.txt',
    '+++ b/tracked.txt',
    '@@ -1,3 +1,4 @@',
    ' one',
    '-two',
    '+TWO',
    ' three',
    '+four',
    '\\ No newline at end of file',
    '',
  ].join('\n'),
  'untracked.txt': '',
}

const FILES = { 'tracked.txt': 'one\nTWO\nthree\nfour', 'untracked.txt': 'brand new\n' }

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

// Loads chain (a diff, then a fallback readFile), and each load needs one
// render to start and one promise turn to land, so a settled read is a small
// loop of render + tick rather than one of each.
async function settle(env, rounds = 4) {
  for (let i = 0; i < rounds; i++) {
    env.findClass(env.render(startedProps), 'rsb-bottom-panel')
    await tick()
  }
  return env.findClass(env.render(startedProps), 'rsb-bottom-panel')
}

function boot(env = {}) {
  const hookState = new Map()
  let activeToken = null
  let hookIndex = 0
  let currentPass = new Set()
  let lastPass = new Set()
  function hooksFor() {
    let hooks = hookState.get(activeToken)
    if (!hooks) { hooks = []; hookState.set(activeToken, hooks) }
    return hooks
  }
  const React = {
    Fragment: Symbol('Fragment'),
    createElement(type, props, ...children) {
      return { type, props: { ...(props || {}), children } }
    },
    useState(initial) {
      const hooks = hooksFor()
      const index = hookIndex++
      if (!(index in hooks)) hooks[index] = { kind: 'state', value: typeof initial === 'function' ? initial() : initial }
      return [hooks[index].value, (value) => {
        hooks[index].value = typeof value === 'function' ? value(hooks[index].value) : value
      }]
    },
    useEffect(effect, deps) {
      const hooks = hooksFor()
      const index = hookIndex++
      const previous = hooks[index]
      const changed = !previous || !deps || !previous.deps || deps.some((value, i) => !Object.is(value, previous.deps[i]))
      if (!changed) return
      if (typeof previous?.cleanup === 'function') previous.cleanup()
      hooks[index] = { kind: 'effect', deps, cleanup: effect() }
    },
  }

  const storage = env.storage || new Map()
  const localStorage = {
    getItem(k) { return storage.has(k) ? storage.get(k) : null },
    setItem(k, v) { storage.set(k, String(v)) },
  }
  const styleElements = []
  const dynamicStyles = []
  const calls = []
  const diffs = env.diffs || DIFFS
  const files = env.files || FILES
  const status = env.status || STATUS

  const fakeRemote = {
    status(...args) {
      calls.push({ method: 'status', args })
      return Promise.resolve({ ok: true, value: status })
    },
    readFile(...args) {
      calls.push({ method: 'readFile', args })
      const path = args.length > 1 ? args[1] : ''
      if (Object.prototype.hasOwnProperty.call(files, path)) return Promise.resolve({ ok: true, value: { content: files[path] } })
      return Promise.resolve({ ok: false, error: { message: 'no such file: ' + path } })
    },
    gitDiff(...args) {
      calls.push({ method: 'gitDiff', args })
      const path = args.length > 1 ? args[1] : ''
      if (!Object.prototype.hasOwnProperty.call(diffs, path)) return Promise.resolve({ ok: false, error: { message: 'git diff failed: ' + path } })
      return Promise.resolve({ ok: true, value: { diff: diffs[path] } })
    },
  }

  const centerCol = {
    _rect: { left: 280, right: 1180, top: 0, bottom: 900, width: 900, height: 900 },
    getBoundingClientRect() { return this._rect },
  }
  const frame = { children: [{}, centerCol, {}] }
  const overlayElement = { parentElement: frame }
  class ResizeObserver {
    constructor(callback) { this.callback = callback }
    observe(target) { this.target = target }
    disconnect() { this.target = undefined }
  }

  let plugin
  const context = {
    window: {
      __ModuleLoader__: {
        load(definition) {
          plugin = definition.factory((id) => {
            assert.equal(id, 'react')
            return React
          })
        },
      },
      innerHeight: env.innerHeight,
    },
    document: {
      querySelector(selector) { return selector === '[data-shell-overlay]' ? overlayElement : null },
      createElement() { return { textContent: '', remove() {} } },
      head: { appendChild(el) { styleElements.push(el) } },
    },
    ResizeObserver,
    navigator: undefined,
    localStorage,
    React,
    styles: { insert(rules) { dynamicStyles.push(...(Array.isArray(rules) ? rules : [rules])) } },
    host: {
      call(method, payload) {
        if (method === 'status') { calls.push({ method, args: [] }); return Promise.resolve({ ok: true, ...status }) }
        if (method === 'readFile') {
          calls.push({ method, args: [payload?.cwd || '', payload?.path || ''] })
          const path = payload?.path || ''
          if (Object.prototype.hasOwnProperty.call(files, path)) return Promise.resolve({ ok: true, content: files[path] })
          return Promise.resolve({ ok: false, error: 'no such file: ' + path })
        }
        if (method === 'gitDiff') {
          calls.push({ method, args: [payload?.cwd || '', payload?.path || ''] })
          const path = payload?.path || ''
          if (!Object.prototype.hasOwnProperty.call(diffs, path)) return Promise.resolve({ ok: false, error: 'git diff failed: ' + path })
          return Promise.resolve({ ok: true, diff: diffs[path] })
        }
        return Promise.resolve({ ok: true })
      },
    },
    console,
    Promise,
    Set,
    Map,
    Object,
    JSON,
    Error,
  }
  if (dynamicClient) {
    plugin = vm.runInNewContext('(function (React, host) {\n' + source + '\n})(React, host)', context, { filename: clientFile })
  } else {
    vm.runInNewContext(source, context, { filename: clientFile })
  }

  const registrations = new Map()
  const ctx = {
    get(name) {
      if (name === 'slots') return this.slots
      if (name === 'sidebarRight') return undefined
      // The details dialect keeps the Rail rendering the floating Sidebar, so
      // the Source Control card and the Panel share one tree.
      if (name === 'layout') return { openDetails() {}, closeDetails() {} }
      if (name === 'remote.rsidebarGit') return fakeRemote
      return undefined
    },
    remote: { $mount: async () => async () => {} },
    effect(fn) { const d = fn(); if (typeof d === 'function') return d },
    interval() { return () => {} },
    timeout() {},
    slots: {
      inject(_name, install) { install() },
      register(options, render) { registrations.set(options.name, render); return () => {} },
    },
  }
  plugin.apply(ctx)

  function renderFunction(type, props) {
    const previousToken = activeToken
    const previousIndex = hookIndex
    const name = type.displayName || type.name || 'anonymous'
    const key = props && props.key !== undefined ? String(props.key) : ''
    const token = name + '#' + key
    if (!currentPass.has(token)) {
      if (!lastPass.has(token)) {
        const stale = hookState.get(token)
        if (stale) for (const hook of stale) if (hook && typeof hook.cleanup === 'function') hook.cleanup()
        hookState.delete(token)
      }
      currentPass.add(token)
    }
    activeToken = token
    hookIndex = 0
    const output = type(props || {})
    activeToken = previousToken
    hookIndex = previousIndex
    return output
  }

  function visit(node, fn) {
    if (node == null || node === false) return
    if (Array.isArray(node)) { for (const child of node) visit(child, fn); return }
    if (typeof node !== 'object') return
    fn(node)
    if (typeof node.type === 'function') { visit(renderFunction(node.type, node.props), fn); return }
    visit(node.props?.children, fn)
  }

  function findAll(node, className, out = []) {
    visit(node, (n) => { if (n.props?.className?.split(' ').includes(className)) out.push(n) })
    return out
  }

  const overlay = registrations.get('shell.overlay')
  const headerToggles = registrations.get('conversation.session.header.utilities')
  return {
    overlay,
    calls,
    storage,
    render(props) {
      lastPass = currentPass
      currentPass = new Set()
      const tree = renderFunction(overlay, props)
      visit(tree, () => {})
      return tree
    },
    renderToggles(props) { return renderFunction(headerToggles, props) },
    findClass(node, className) { return findAll(node, className)[0] || null },
    findAll,
    visit,
    collectStrings(node, out) {
      if (node == null || node === false) return
      if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return }
      if (Array.isArray(node)) { for (const child of node) outCollect(child, out); return }
      if (typeof node !== 'object') return
      if (typeof node.type === 'function') { outCollect(renderFunction(node.type, node.props), out); return }
      outCollect(node.props?.children, out)
    },
  }

  function outCollect(node, out) {
    if (node == null || node === false) return
    if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return }
    if (Array.isArray(node)) { for (const child of node) outCollect(child, out); return }
    if (typeof node !== 'object') return
    if (typeof node.type === 'function') { outCollect(renderFunction(node.type, node.props), out); return }
    outCollect(node.props?.children, out)
  }
}

// A blank session (ADR 0003/0005) renders the Sidebar and the Panel from the
// one shell.overlay tree, so both live in a single render pass — the same
// fixture the Explorer suite uses.
const startedProps = {
  sessionId: 'session-a',
  useSessions(selector) {
    return selector({ current: 'session-a', byId: { 'session-a': { blank: true } } })
  },
  useWorkspaces(selector) {
    return selector({ items: [{ path: '/workspace/a', sessionIds: ['session-a'] }] })
  },
}

function railButtons(rail) {
  return (rail.props.children || []).filter((child) => child && child.type === 'button')
}

function toggles(env) {
  return railButtons(env.findClass(env.renderToggles(startedProps), 'rsb-header-toggles'))
}

/** Open the Panel (and leave the Sidebar as it is), then return the Panel. */
function openPanel(env) {
  const buttons = toggles(env)
  if (buttons[1].props['aria-pressed'] !== 'true') buttons[1].props.onClick()
  env.findClass(env.render(startedProps), 'rsb-bottom-panel')
  env.findClass(env.render(startedProps), 'rsb-bottom-panel')
  return env.findClass(env.render(startedProps), 'rsb-bottom-panel')
}

/** Open the Sidebar and the Panel, so the Source Control card is on screen.
 *  The Sidebar toggle carries no aria-pressed; its title names the action it
 *  would take, so "Collapse workspace sidebar" means it is already open. */
function openSidebar(env) {
  const buttons = toggles(env)
  if (String(buttons[0].props.title) !== 'Collapse workspace sidebar') buttons[0].props.onClick()
  return env.render(startedProps)
}

function buttonWithText(env, node, text) {
  let found = null
  env.visit(node, (n) => {
    if (found || n.type !== 'button') return
    const strings = []
    env.collectStrings(n, strings)
    if (strings.join(' ').includes(text)) found = n
  })
  return found
}

/** The + → Diff → path form flow. Opens the Panel if it is closed. */
function openDiffViaPicker(env, path) {
  let panel = openPanel(env)
  // + toggles the picker, so open it only when the type list is not already
  // showing (one caller asserts on the open list first).
  if (!env.findClass(panel, 'rsb-tab-picker')) {
    env.findClass(panel, 'rsb-tabstrip-add').props.onClick()
    panel = env.findClass(env.render(startedProps), 'rsb-bottom-panel')
  }
  buttonWithText(env, panel, 'Diff').props.onClick()
  panel = env.findClass(env.render(startedProps), 'rsb-bottom-panel')
  const input = env.findClass(env.findClass(panel, 'rsb-tab-picker-form'), 'rsb-tab-picker-input')
  input.props.onChange({ target: { value: path } })
  env.findClass(env.render(startedProps), 'rsb-tab-picker-form').props.onSubmit({ preventDefault() {} })
  return env.findClass(env.render(startedProps), 'rsb-bottom-panel')
}

function tabTypes(env) {
  return JSON.parse(env.storage.get('dsh.rsidebar.panels.v1.session-a')).tabs
}

/** Click one Source Control file name and return the settled Panel. */
async function clickSourceControlName(env, index = 0) {
  openSidebar(env)
  await tick()
  const names = env.findAll(env.render(startedProps), 'rsb-fname-open')
  assert.ok(names.length > index, 'the Source Control card must expose a clickable file name at index ' + index)
  names[index].props.onClick()
  return settle(env)
}

function diffRows(env, panel) {
  return env.findAll(panel, 'rsb-diff-row').map((row) => ({
    kind: row.props['data-kind'],
    text: env.findClass(row, 'rsb-diff-src').props.children[0],
    numbers: env.findAll(row, 'rsb-diff-no').map((n) => n.props.children[0]),
    mark: env.findClass(row, 'rsb-diff-mark').props.children[0],
  }))
}

// 1. The Panel "+" picker offers Diff and its form creates one Diff Preview tab
//    that loads the change through the gitDiff RPC.
{
  const env = boot()
  let panel = openPanel(env)
  env.findClass(panel, 'rsb-tabstrip-add').props.onClick()
  panel = env.findClass(env.render(startedProps), 'rsb-bottom-panel')
  assert.ok(buttonWithText(env, panel, 'Diff'), 'the picker must offer the Diff option (issue #27)')
  openDiffViaPicker(env, 'tracked.txt')
  panel = await settle(env)
  assert.deepEqual(tabTypes(env).map((t) => [t.type, t.path]), [['diff-file', 'tracked.txt']], 'the Diff form must create one diff-file tab')
  assert.equal(env.calls.filter((c) => c.method === 'gitDiff').length, 1, 'the Diff Preview must load through the gitDiff RPC')
  assert.equal(env.calls.filter((c) => c.method === 'readFile').length, 0, 'a changed file must not be read as text')
  const chip = env.findAll(panel, 'rsb-tab')[0]
  assert.equal(chip.props.title, 'Diff of tracked.txt', 'the diff chip title must say which presentation it carries')
}

// 2. The diff body renders one row per line: meta prose, the hunk header, the
//    old and new numbers on the right rows, and the +/-/space marker.
{
  const env = boot()
  openDiffViaPicker(env, 'tracked.txt')
  const panel = await settle(env)
  const rows = diffRows(env, panel)
  assert.deepEqual(rows.map((r) => r.kind), ['meta', 'meta', 'meta', 'meta', 'hunk', 'ctx', 'del', 'add', 'ctx', 'add', 'note'], 'every diff line must land in its own row kind')
  assert.deepEqual(rows[5], { kind: 'ctx', text: 'one', numbers: ['1', '1'], mark: ' ' }, 'context rows carry both numbers')
  assert.deepEqual(rows[6], { kind: 'del', text: 'two', numbers: ['2', ''], mark: '−' }, 'a removal carries only the old number')
  assert.deepEqual(rows[7], { kind: 'add', text: 'TWO', numbers: ['', '2'], mark: '+' }, 'an addition carries only the new number')
  assert.deepEqual(rows[8], { kind: 'ctx', text: 'three', numbers: ['3', '3'], mark: ' ' }, 'the hunk keeps both counters in step')
  assert.deepEqual(rows[9], { kind: 'add', text: 'four', numbers: ['', '4'], mark: '+' }, 'the second change continues the new counter')
  assert.deepEqual(rows[10], { kind: 'note', text: '\\ No newline at end of file', numbers: ['', ''], mark: ' ' }, 'the newline note belongs to the row above and gets no number')
  const title = []
  env.collectStrings(env.findClass(env.findClass(env.render(startedProps), 'rsb-bottom-panel'), 'rsb-fp-bar'), title)
  assert.ok(title.join(' ').includes('+2 −1 against HEAD'), 'the toolbar must count the change: ' + title.join(' '))
}

// 3. A Source Control file name opens the Diff Preview, and the same path in
//    the staged and the unstaged group shares that one tab.
{
  const env = boot()
  let panel = await clickSourceControlName(env, 0)
  assert.deepEqual(tabTypes(env).map((t) => [t.type, t.path]), [['diff-file', 'tracked.txt']], 'a Source Control file name must open a Diff Preview')
  assert.equal(env.calls.filter((c) => c.method === 'gitDiff').length, 1, 'the Source Control route must load the change once')
  panel = await clickSourceControlName(env, 1)
  assert.equal(env.findAll(panel, 'rsb-tab').length, 1, 'the staged and the unstaged row for one path must share one Diff Preview tab')
  assert.equal(tabTypes(env).length, 1, 'the second row must not store a second tab')
  assert.deepEqual(tabTypes(env)[0].type, 'diff-file', 'the shared tab stays a Diff Preview')
  panel = await clickSourceControlName(env, 1)
  assert.equal(env.findAll(panel, 'rsb-tab').length, 1, 'a third click must still keep one tab')
  assert.equal(env.calls.filter((c) => c.method === 'gitDiff').length, 1, 're-opening the shared tab must not call gitDiff again')
}

// 4. An untracked file requested as a diff opens as a Text Preview: git
//    reports no change, so the body renders source rows, not diff rows.
{
  const env = boot()
  const panel = await clickSourceControlName(env, 2)
  assert.deepEqual(tabTypes(env).map((t) => [t.type, t.path]), [['diff-file', 'untracked.txt']], 'the untracked row still asks for a diff')
  assert.equal(env.findAll(panel, 'rsb-diff-row').length, 0, 'an empty diff must render no diff rows')
  const lines = env.findAll(panel, 'rsb-fp-line')
  assert.equal(lines.length, 1, 'an empty diff must fall back to the Text Preview rows')
  assert.deepEqual(
    env.findClass(lines[0], 'rsb-fp-src').props.dangerouslySetInnerHTML.__html,
    'brand new',
    'the fallback must show the file source',
  )
  assert.equal(env.calls.filter((c) => c.method === 'readFile').length, 1, 'the fallback must read the file once')
}

// 5. A reverted file (no change against HEAD) falls back the same way, and a
//    diff that fails to load reports the error instead of an empty frame.
{
  const env = boot({ diffs: { 'tracked.txt': '' } })
  openDiffViaPicker(env, 'tracked.txt')
  const panel = await settle(env)
  assert.ok(env.findClass(panel, 'rsb-fp-line'), 'a no-change diff must fall back to the Text Preview')
  assert.equal(env.findClass(panel, 'rsb-diff-row'), null, 'a no-change diff must not render diff rows')

  const failEnv = boot({ diffs: {} })
  openDiffViaPicker(failEnv, 'tracked.txt')
  const failed = await settle(failEnv)
  const message = []
  failEnv.collectStrings(failEnv.findClass(failed, 'rsb-error'), message)
  assert.ok(message.join(' ').includes('git diff failed'), 'a failed gitDiff must surface its message')
  assert.equal(failEnv.findClass(failed, 'rsb-diff-row'), null, 'a failed gitDiff must render no rows')
}

// 6. The two presentations of one file are separate tabs: a Text Preview and a
//    Diff Preview of the same path coexist and never collide.
{
  const env = boot({ diffs: { 'tracked.txt': '' }, files: { 'tracked.txt': 'one\ntwo\n' } })
  let panel = openPanel(env)
  env.findClass(panel, 'rsb-tabstrip-add').props.onClick()
  panel = env.findClass(env.render(startedProps), 'rsb-bottom-panel')
  buttonWithText(env, panel, 'Text file').props.onClick()
  panel = env.findClass(env.render(startedProps), 'rsb-bottom-panel')
  env.findClass(env.findClass(panel, 'rsb-tab-picker-form'), 'rsb-tab-picker-input').props.onChange({ target: { value: 'tracked.txt' } })
  env.findClass(env.render(startedProps), 'rsb-tab-picker-form').props.onSubmit({ preventDefault() {} })
  await settle(env)
  openDiffViaPicker(env, 'tracked.txt')
  await settle(env)
  assert.deepEqual(
    tabTypes(env).map((t) => t.type).sort(),
    ['diff-file', 'text-file'],
    'one path must be able to hold a Text Preview and a Diff Preview at once',
  )
}

// 7. The tab list round-trips: a stored diff-file tab restores and reloads its
//    change, and a type this build does not know still drops.
{
  const env = boot()
  openDiffViaPicker(env, 'tracked.txt')
  const panel = await settle(env)
  assert.equal(env.findAll(panel, 'rsb-diff-row').length > 0, true)

  const env2 = boot({ storage: env.storage })
  openPanel(env2)
  const panel2 = await settle(env2)
  const restored = env2.findAll(panel2, 'rsb-diff-row')
  assert.equal(restored.length, 11, 'a restored Diff Preview must render its rows again')
  assert.deepEqual(
    env2.calls.filter((c) => c.method === 'gitDiff').map((c) => c.args),
    [['', 'tracked.txt']],
    'the restored Diff Preview must load its own change through the RPC',
  )
  const foreign = new Map()
  foreign.set('dsh.rsidebar.panels.v1.session-a', JSON.stringify({
    schema: 1,
    tabs: [{ id: 'z', type: 'diff-file', path: 'tracked.txt' }, { id: 'y', type: 'nope-file', path: 'tracked.txt' }],
    active: 'y',
  }))
  const env3 = boot({ storage: foreign })
  const panel3 = openPanel(env3)
  await settle(env3)
  const chips = env3.findAll(panel3, 'rsb-tab')
  assert.equal(chips.length, 1, 'an unknown stored type must still drop')
  assert.equal(chips[0].props.title, 'Diff of tracked.txt', 'the surviving chip must be the Diff Preview')
}

console.log('Diff Preview check passed (' + clientFile + ')')
rmSync(repo, { recursive: true, force: true })
rmSync(unborn, { recursive: true, force: true })
