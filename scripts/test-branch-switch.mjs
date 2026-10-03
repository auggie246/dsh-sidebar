#!/usr/bin/env node
// Branch picker (issue #28): the Source Control card's branch label opens a
// dropdown of local branches and picking one switches to it. The host half
// gains two RPCs on the rsidebarGit gateway — branches(cwd) lists local
// branches (current first, then newest commit first) and switchBranch(cwd,
// name) runs a plain `git switch` through the card's sandboxed git path
// (ADR 0006). Per ADR 0014 the card never stashes, forces or pre-checks: a
// refusal is git's own message, thrown to the card's error line.
//
// Seam (agreed): codec/manifest assertions are pure; the host half then runs
// against a real git repository through a stub shell that executes the exact
// `git -C … …` command lines the controller issues; the client half is
// pinned with source-level assertions on both twins, because the browser half
// intentionally exports only its Cordis registration.
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import vm from 'node:vm'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'
import { BranchesResultCodec, TYPERT } from '../lib/remote.js'

// ---------------------------------------------------------------------------
// Codec + manifest (pure)
// ---------------------------------------------------------------------------

const good = { branches: [{ name: 'main', type: 'branch', current: true, time: 1700000000 }] }
assert.deepEqual(BranchesResultCodec.schema.parse(good), good, 'BranchesResultCodec must accept a good result')
assert.throws(() => BranchesResultCodec.schema.parse({ branches: [{ name: 'main', type: 'tag', current: true, time: 1 }] }), 'an unknown branch type must be rejected')
assert.throws(() => BranchesResultCodec.schema.parse({ branches: [{ name: 'main', type: 'branch', current: 'yes', time: 1 }] }), 'a non-boolean current must be rejected')
assert.throws(() => BranchesResultCodec.schema.parse({ branches: [], extra: 1 }), 'extra keys must be rejected')

const invocations = new Map(TYPERT.invocations.map((inv) => [inv.method, inv]))
assert.deepEqual(invocations.get('branches')?.parameters.map((p) => p.name), ['cwd'], 'branches must take [cwd]')
assert.equal(invocations.get('branches')?.result.typeSymbol, 'dsh-sidebar/BranchesResult')
assert.deepEqual(invocations.get('switchBranch')?.parameters.map((p) => p.name), ['cwd', 'name'], 'switchBranch must take [cwd, name]')
assert.equal(invocations.get('switchBranch')?.result.typeSymbol, 'dsh-sidebar/OkResult')

// ---------------------------------------------------------------------------
// Host half against real git
// ---------------------------------------------------------------------------

const repo = realpathSync(mkdtempSync(join(tmpdir(), 'rsb-branch-')))
const env = { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com' }
const g = (...args) => execFileSync('git', ['-C', repo, ...args], { env, encoding: 'utf8' }).trim()
const commitAt = (msg, when) => execFileSync('git', ['-C', repo, 'commit', '--allow-empty', '-m', msg], { env: { ...env, GIT_COMMITTER_DATE: when, GIT_AUTHOR_DATE: when }, stdio: 'ignore' })

g('init', '-b', 'main')
writeFileSync(join(repo, 'a.txt'), 'one\n')
g('add', '-A')
commitAt('init', '2026-01-01T00:00:00Z')
g('branch', 'old')
g('switch', '-q', '-c', 'feature/new')
commitAt('newer', '2026-03-01T00:00:00Z')
g('switch', '-q', 'main')
g('switch', '-q', '-c', 'conflict')
writeFileSync(join(repo, 'a.txt'), 'conflict side\n')
g('commit', '-qam', 'diverge')
g('switch', '-q', 'main')

const spawns = []
const provided = new Map()
const ctx = {
  get() { return undefined },
  effect() {},
  reflect: { provide(name, service) { provided.set(name, service) } },
  logger: { info() {}, error() {} },
  shell: {
    resolve(req) { return req },
    async execute(req) {
      spawns.push(req)
      return {
        async result() {
          const r = spawnSync('bash', ['-c', req.command], { env, encoding: 'utf8', input: req.stdin })
          return { exitCode: r.status, stdout: { text: r.stdout }, stderr: { text: r.stderr } }
        },
      }
    },
  },
  typert: {},
  subprocess: {},
}
apply(ctx)
const gateway = provided.get('rsidebarGit')
assert.ok(gateway, 'apply must mount the rsidebarGit gateway')

// Listing: local branches only, current first, then newest commit first.
const listed = await gateway.branches(repo)
assert.equal(listed.branches[0].name, 'main')
assert.equal(listed.branches[0].current, true)
assert.ok(listed.branches.slice(1).every((b) => b.current === false && b.type === 'branch'), 'only the first entry is current; every entry is a local branch')
const times = listed.branches.slice(1).map((b) => b.time)
assert.deepEqual(times, [...times].sort((a, b) => b - a), 'non-current branches must be ordered newest commit first')
assert.deepEqual(listed.branches.map((b) => b.name).sort(), ['conflict', 'feature/new', 'main', 'old'])
assert.ok(listed.branches.every((b) => Number.isFinite(b.time) && b.time > 0), 'every branch carries its latest commit time')
BranchesResultCodec.schema.parse(listed)

// Switching: plain switch, through the sandboxed git spawn.
await gateway.switchBranch(repo, 'feature/new')
assert.equal(g('symbolic-ref', '--short', 'HEAD'), 'feature/new', 'switchBranch must move HEAD')
const switchSpawn = spawns.filter((s) => / switch /.test(s.command)).pop()
assert.ok(switchSpawn.command.startsWith('git -C '), 'the switch must be the card\'s git spawn')
assert.deepEqual(switchSpawn.sandboxPolicy, { mode: 'workspace-write', workspaceRoot: repo }, 'the switch must carry the repository sandbox policy')
assert.ok(!/--force|--discard-changes|stash|-f /.test(switchSpawn.command), 'ADR 0014: no force, discard or stash')
assert.equal((await gateway.branches(repo)).branches[0].name, 'feature/new', 'the listing must follow HEAD')

// Detached HEAD: the listing marks nothing current and a pick switches away.
g('switch', '-q', '--detach', 'main')
assert.ok((await gateway.branches(repo)).branches.every((b) => b.current === false), 'a detached HEAD has no current branch')
await gateway.switchBranch(repo, 'old')
assert.equal(g('symbolic-ref', '--short', 'HEAD'), 'old')

// Refusal: git's own message reaches the caller and the branch is unchanged.
g('switch', '-q', 'main')
writeFileSync(join(repo, 'a.txt'), 'dirty local edit\n')
await assert.rejects(() => gateway.switchBranch(repo, 'conflict'), /would be overwritten|local changes/i, 'a conflicting dirty tree must surface git\'s refusal')
assert.equal(g('symbolic-ref', '--short', 'HEAD'), 'main', 'a refused switch leaves HEAD alone')
assert.equal(readFileSync(join(repo, 'a.txt'), 'utf8'), 'dirty local edit\n', 'a refused switch never touches the working tree')
g('checkout', '--', 'a.txt')

// Input guards: a name git would read as an option, an unknown branch.
await assert.rejects(() => gateway.switchBranch(repo, '--detach'), /invalid branch name/i, 'an option-shaped name must be rejected before git sees it')
await assert.rejects(() => gateway.switchBranch(repo, 'no-such-branch'), /./, 'an unknown branch must fail with git\'s message')
await assert.rejects(() => gateway.switchBranch(repo, ''), /invalid branch name/i, 'an empty name must be rejected')

// ---------------------------------------------------------------------------
// Client halves (both twins) and dynamic host: source-level contract
// ---------------------------------------------------------------------------

for (const file of ['lib/client.js', 'dynamic/client.js']) {
  const source = readFileSync(new URL('../' + file, import.meta.url), 'utf8')
  assert.match(source, /className: 'rsb-branch rsb-branch-btn'/, file + ': the branch label must be a button')
  assert.match(source, /h\(GitIcon, \{ name: 'chevron' \}\)/, file + ': the dropdown affordance must be the icon-set chevron, not a text glyph')
  assert.match(source, /\.rsb-branch-btn \.rsb-icon \{ width: 16px/, file + ': the chevron must be drawn larger than the 14px action icons')
  assert.match(source, /'detached at ' \+/, file + ': a detached HEAD must read "detached at <hash>"')
  assert.match(source, /\.rsb-branch-menu \{[^}]*background: var\(--dsw-alias-bg-layer-1\)/, file + ': the menu must use the card surface, like the Panel picker, not the lighter overlay grey')
  assert.match(source, /className: 'rsb-branch-menu'[\s\S]*role: 'listbox'/, file + ': the dropdown must be a listbox')
  assert.match(source, /disabled: busy !== ''[^\n]*rsb-branch-btn|rsb-branch-btn[^\n]*disabled: busy !== ''/, file + ': the picker must be disabled while another action is busy')
  assert.match(source, /relTime\(b\.time\)/, file + ': each row must show its short relative date')
  assert.match(source, /className: 'rsb-branch-row'[\s\S]*aria-selected|'aria-selected'/, file + ': the current branch must be marked selected')
}
assert.match(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), /git\.switchBranch\(cwd\(\), b\.name\)/, 'lib client: a pick must call switchBranch through act()')
assert.match(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), /'status', 'log', 'stage', 'unstage', 'commit', 'discard', 'sync',\s*'branches', 'switchBranch'/, 'lib client: the call facade must expose both new methods')
const dynClient = readFileSync(new URL('../dynamic/client.js', import.meta.url), 'utf8')
assert.match(dynClient, /act\('switchBranch', \{ name: b\.name \}\)/, 'dynamic client: a pick must call switchBranch through act()')
assert.match(dynClient, /host\.call\('branches'/, 'dynamic client: the menu must load the branch list')
const dynHost = readFileSync(new URL('../dynamic/host.js', import.meta.url), 'utf8')
assert.match(dynHost, /harness\.handle\('branches'/, 'dynamic host: must serve branches')
assert.match(dynHost, /harness\.handle\('switchBranch'/, 'dynamic host: must serve switchBranch')
assert.match(dynHost, /invalid branch name/, 'dynamic host: must guard option-shaped names')

// ---------------------------------------------------------------------------
// Rendered behaviour (lib/client.js in a vm, house harness from
// test-commit-error-persistence.mjs): click the branch label, see the list,
// pick a branch, see a refusal land in the card's error line.
// ---------------------------------------------------------------------------

const libSource = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const hookState = new Map()
let activeComponent = null
let hookIndex = 0
const React = {
  Fragment: Symbol('Fragment'),
  createElement(type, props, ...children) { return { type, props: { ...(props || {}), children } } },
  useState(initial) {
    const hooks = hookState.get(activeComponent) || []
    hookState.set(activeComponent, hooks)
    const index = hookIndex++
    if (!(index in hooks)) hooks[index] = { kind: 'state', value: typeof initial === 'function' ? initial() : initial }
    return [hooks[index].value, (value) => { hooks[index].value = typeof value === 'function' ? value(hooks[index].value) : value }]
  },
  useEffect(effect, deps) {
    const hooks = hookState.get(activeComponent) || []
    hookState.set(activeComponent, hooks)
    const index = hookIndex++
    const previous = hooks[index]
    const changed = !previous || !deps || !previous.deps || deps.some((value, i) => !Object.is(value, previous.deps[i]))
    if (!changed) return
    hooks[index] = { kind: 'effect', deps, cleanup: effect() }
  },
}
const STATUS = { repo: true, root: '/workspace/repo', branch: 'main', detached: false, upstream: null, ahead: 0, behind: 0, staged: [], unstaged: [], conflicts: [], fingerprint: '0|h|r' }
const LIST = [
  { name: 'main', type: 'branch', current: true, time: Math.floor(Date.now() / 1000) - 7200 },
  { name: 'feature/new', type: 'branch', current: false, time: Math.floor(Date.now() / 1000) - 86400 * 3 },
]
const polls = []
let status = STATUS
let switchResponse = { ok: true, value: { ok: true } }
const switchCalls = []
let branchLoads = 0
let branchesImpl = () => Promise.resolve({ ok: true, value: { branches: LIST } })
let syncImpl = () => Promise.resolve({ ok: true, value: { ok: true } })
const remote = {
  status: () => Promise.resolve({ ok: true, value: status }),
  log: () => Promise.resolve({ ok: true, value: { commits: [], hasMore: false } }),
  branches: () => { branchLoads++; return branchesImpl() },
  sync: () => syncImpl(),
  switchBranch: (cwd, name) => { switchCalls.push([cwd, name]); return Promise.resolve(switchResponse) },
}
const registrations = new Map()
let plugin
vm.runInNewContext(libSource, {
  window: { __ModuleLoader__: { load(def) { plugin = def.factory((id) => { assert.equal(id, 'react'); return React }) } } },
  document: undefined, navigator: undefined, localStorage: undefined, console, Promise, Set, Map, Object, JSON, Error,
}, { filename: 'lib/client.js' })
plugin.apply({
  get(name) { return name === 'remote.rsidebarGit' ? remote : undefined },
  remote: { $mount: async () => async () => {} },
  effect() {},
  interval(cb) { polls.push(cb); return () => {} },
  timeout() {},
  slots: { inject(_n, install) { install() }, register(o, render) { registrations.set(o.name, render); return () => {} } },
})
function renderFunction(type, props) {
  const pc = activeComponent
  const pi = hookIndex
  activeComponent = type
  hookIndex = 0
  const out = type(props || {})
  activeComponent = pc
  hookIndex = pi
  return out
}
function findNode(node, predicate) {
  if (node == null || node === false) return null
  if (Array.isArray(node)) { for (const c of node) { const f = findNode(c, predicate); if (f) return f } return null }
  if (typeof node !== 'object') return null
  if (typeof node.type === 'function') return findNode(renderFunction(node.type, node.props), predicate)
  if (predicate(node)) return node
  return findNode(node.props?.children, predicate)
}
const findAll = (root, predicate) => {
  const found = []
  findNode(root, (n) => { if (predicate(n)) found.push(n); return false })
  return found
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
const byClass = (name) => (n) => typeof n.props?.className === 'string' && n.props.className.split(' ').includes(name)

const details = registrations.get('details')
const props = {
  sessionId: 'session-a',
  useSessions(selector) { return selector({ current: 'session-a', byId: { 'session-a': { blank: false } } }) },
  useWorkspaces(selector) { return selector({ items: [{ path: '/workspace/repo', sessionIds: ['session-a'] }] }) },
}
const tree = details(props)
findNode(tree, () => false)
await tick()

const trigger = () => findNode(tree, byClass('rsb-branch-btn'))
assert.ok(trigger(), 'the branch label must render as a button')
assert.match(JSON.stringify(trigger().props.children), /⎇ main/, 'the label must show the current branch')
assert.equal(findNode(tree, byClass('rsb-branch-menu')), null, 'the menu starts closed')

trigger().props.onClick({ currentTarget: { getBoundingClientRect: () => ({ left: 10, bottom: 20 }) } })
await tick()
assert.equal(branchLoads, 1, 'opening the menu must load the branch list')
const rows = () => findAll(tree, byClass('rsb-branch-row'))
assert.equal(rows().length, 2, 'the menu must list every branch')
assert.equal(rows()[0].props['aria-selected'], true, 'the current branch must be marked')
assert.equal(rows()[1].props['aria-selected'], false)
assert.match(JSON.stringify(rows()[1].props.children), /3d/, 'a row must show its short relative date')

// Picking the current branch is a no-op that closes the menu.
rows()[0].props.onClick()
await tick()
assert.equal(switchCalls.length, 0, 'picking the current branch must not call switch')
assert.equal(findNode(tree, byClass('rsb-branch-menu')), null, 'picking closes the menu')

// Picking another branch switches through the remote and closes the menu.
trigger().props.onClick({ currentTarget: { getBoundingClientRect: () => ({ left: 10, bottom: 20 }) } })
await tick()
status = { ...STATUS, branch: 'feature/new' }
rows()[1].props.onClick()
await tick()
assert.deepEqual(switchCalls, [['/workspace/repo', 'feature/new']], 'a pick must switch the Working Repository to that branch')
assert.equal(findNode(tree, byClass('rsb-branch-menu')), null, 'the menu closes on a pick')
assert.match(JSON.stringify(trigger().props.children), /⎇ feature\/new/, 'the label must follow the switch (status refresh)')

// A refusal lands in the card's dismissible error line; the picker re-enables.
switchResponse = { ok: false, error: { message: 'error: Your local changes would be overwritten by checkout' } }
trigger().props.onClick({ currentTarget: { getBoundingClientRect: () => ({ left: 10, bottom: 20 }) } })
await tick()
rows()[1].props.onClick()
await tick()
const refusal = findNode(tree, byClass('rsb-error'))
assert.ok(refusal, 'a refused switch must show git\'s message in the error line')
assert.match(String(refusal.props.children), /would be overwritten/)
assert.equal(trigger().props.disabled, false, 'the picker re-enables after the refusal')

// A slow earlier load can never overwrite the list the user is looking at:
// close and reopen while the first branches() call is still in flight.
let releaseSlow
const slow = new Promise((resolve) => { releaseSlow = resolve })
branchesImpl = () => slow
const open = () => trigger().props.onClick({ currentTarget: { getBoundingClientRect: () => ({ left: 10, bottom: 20 }) } })
open()
await tick()
findNode(tree, byClass('rsb-branch-bg')).props.onClick()
branchesImpl = () => Promise.resolve({ ok: true, value: { branches: LIST } })
open()
await tick()
releaseSlow({ ok: true, value: { branches: [{ name: 'stale-branch', type: 'branch', current: false, time: 1 }] } })
await tick()
assert.deepEqual(rows().map((r) => r.props.title), ['main', 'feature/new'], 'a stale load must not replace the fresh list')

// A pick while the card is busy is ignored: the menu outlives the moment a
// commit or sync starts, and only the label is disabled.
let releaseSync
syncImpl = () => new Promise((resolve) => { releaseSync = () => resolve({ ok: true, value: { ok: true } }) })
findNode(tree, (n) => n.type === 'button' && n.props?.title === 'Fetch').props.onClick()
await tick()
assert.equal(trigger().props.disabled, true, 'the label is disabled while a sync runs')
const callsBefore = switchCalls.length
rows()[1].props.onClick()
await tick()
assert.equal(switchCalls.length, callsBefore, 'a pick during a busy action must not switch')
releaseSync()
await tick()
assert.equal(trigger().props.disabled, false, 'the label re-enables when the action ends')

// Detached HEAD reads "detached at <hash>".
status = { ...STATUS, branch: 'abc1234', detached: true }
for (const poll of polls) await poll()
await tick()
assert.match(JSON.stringify(trigger().props.children), /⎇ detached at abc1234/, 'a detached HEAD must read "detached at <hash>"')

console.log('branch switch check passed')
