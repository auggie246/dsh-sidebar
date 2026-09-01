#!/usr/bin/env node
// Action errors in the Source Control card must stay on screen (source
// control ticket: stage/commit/push errors flashed away in ~3 seconds).
//
// Root cause this test locks down: `act()` used to write action failures into
// the same `err` state the status poll clears on its next successful refresh,
// so any error a stage/commit/push produced vanished before it could be read.
// Action failures now live in `actionErr`, which clears only on the next
// action or a click; status errors keep their auto-clearing behavior.
//
// Harness: the house pattern from test-global-sidebar-state.mjs — lib/client.js
// in a vm with a minimal React stub, persistent hook state, and a mock
// rsidebarGit remote whose results the test scripts per call.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
const registrations = new Map()
const hookState = new Map()
let activeComponent = null
let hookIndex = 0

const React = {
  Fragment: Symbol('Fragment'),
  createElement(type, props, ...children) {
    return { type, props: { ...(props || {}), children } }
  },
  useState(initial) {
    const hooks = hookState.get(activeComponent) || []
    hookState.set(activeComponent, hooks)
    const index = hookIndex++
    if (!(index in hooks)) hooks[index] = { kind: 'state', value: typeof initial === 'function' ? initial() : initial }
    return [hooks[index].value, (value) => {
      hooks[index].value = typeof value === 'function' ? value(hooks[index].value) : value
    }]
  },
  useEffect(effect, deps) {
    const hooks = hookState.get(activeComponent) || []
    hookState.set(activeComponent, hooks)
    const index = hookIndex++
    const previous = hooks[index]
    const changed = !previous || !deps || !previous.deps || deps.some((value, i) => !Object.is(value, previous.deps[i]))
    if (!changed) return
    if (typeof previous?.cleanup === 'function') previous.cleanup()
    hooks[index] = { kind: 'effect', deps, cleanup: effect() }
  },
}

const STATUS = {
  repo: true,
  root: '/workspace/repo',
  branch: 'main',
  detached: false,
  upstream: 'origin/main',
  ahead: 0,
  behind: 0,
  staged: [],
  unstaged: [{ path: 'a.txt', status: 'M', untracked: false, origPath: null }],
  conflicts: [],
  fingerprint: '1|head|refs',
}

// The remote mock: every method returns the scripted response for the next
// call, falling back to a per-method success.
let scripted = null
const remoteCalls = []
function okResponse(method) {
  if (method === 'status') return { ok: true, value: STATUS }
  if (method === 'log') return { ok: true, value: { commits: [], hasMore: false } }
  return { ok: true, value: { ok: true } }
}
const remote = new Proxy({}, {
  get(_target, method) {
    return (...args) => {
      remoteCalls.push(method)
      const response = scripted
      scripted = null
      if (response) return Promise.resolve(response)
      return Promise.resolve(okResponse(method))
    }
  },
})

let plugin
const polls = []
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
  },
  document: undefined,
  navigator: undefined,
  localStorage: undefined,
  console,
  Promise,
  Set,
  Map,
  Object,
  JSON,
  Error,
}
vm.runInNewContext(source, context, { filename: 'lib/client.js' })

const ctx = {
  get(name) { return name === 'remote.rsidebarGit' ? remote : undefined },
  remote: { $mount: async () => async () => {} },
  effect() {},
  interval(callback) { polls.push(callback); return () => {} },
  timeout() {},
  slots: {
    inject(_name, install) { install() },
    register(options, render) {
      registrations.set(options.name, render)
      return () => {}
    },
  },
}
plugin.apply(ctx)

function renderFunction(type, props) {
  const previousComponent = activeComponent
  const previousIndex = hookIndex
  activeComponent = type
  hookIndex = 0
  const output = type(props || {})
  activeComponent = previousComponent
  hookIndex = previousIndex
  return output
}

function findNode(node, predicate) {
  if (node == null || node === false) return null
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findNode(child, predicate)
      if (found) return found
    }
    return null
  }
  if (typeof node !== 'object') return null
  if (typeof node.type === 'function') return findNode(renderFunction(node.type, node.props), predicate)
  if (predicate(node)) return node
  return findNode(node.props?.children, predicate)
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

function errorNode(rootElement) {
  return findNode(rootElement, (node) => node.props?.className === 'rsb-error')
}

function stageButton(rootElement) {
  return findNode(rootElement, (node) => node.type === 'button' && node.props?.title === 'Stage')
}

const details = registrations.get('details')
assert.equal(typeof details, 'function', 'the Sidebar details slot must be registered')

const props = {
  sessionId: 'session-a',
  useSessions(selector) {
    return selector({ current: 'session-a', byId: { 'session-a': { blank: false } } })
  },
  useWorkspaces(selector) {
    return selector({ items: [{ path: '/workspace/repo', sessionIds: ['session-a'] }] })
  },
}

try {
  // First walk mounts the card (descent is lazy: the card's effect and its
  // first status call fire here). Then the poll settles and a FRESH walk
  // renders the file row with its Stage action.
  const rootElement = details(props)
  findNode(rootElement, () => false)
  await tick()
  let tree = rootElement
  assert.ok(stageButton(tree), 'the card must render a Stage action for the changed file')

  // The user's exact report: the action fails, an error appears…
  scripted = { ok: false, error: { message: 'dsh-sidebar: git add failed (test denial)' } }
  await stageButton(tree).props.onClick()
  await tick()

  const first = errorNode(tree)
  assert.ok(first, 'a failed stage must show an error')
  assert.match(String(first.props.children), /git add failed \(test denial\)/, 'the error must carry the message')

  // …and the 3-second status poll must NOT wipe it (the reported bug).
  assert.equal(polls.length >= 1, true, 'the card must have registered its status poll')
  for (const poll of polls) await poll()
  await tick()

  const second = errorNode(tree)
  assert.ok(second, 'the action error must survive a successful status refresh')
  assert.match(String(second.props.children), /git add failed \(test denial\)/, 'the surviving error must keep its message')

  // Click-to-dismiss is the only inline way out.
  second.props.onClick()
  await tick()
  assert.equal(errorNode(tree), null, 'clicking the error must dismiss it')

  // Status errors keep their old auto-clearing behavior: one failing poll
  // shows the error, the next succeeding poll clears it.
  scripted = { ok: false, error: { message: 'git status failed (test)' } }
  for (const poll of polls) await poll()
  await tick()
  assert.match(String(errorNode(tree).props.children), /git status failed \(test\)/, 'a failing status must show its error')
  for (const poll of polls) await poll()
  await tick()
  assert.equal(errorNode(tree), null, 'a succeeding status must clear its own error')

  console.log('commit error persistence check passed')
} finally {
  // No unmount bookkeeping needed: the vm context is discarded with the test.
}
