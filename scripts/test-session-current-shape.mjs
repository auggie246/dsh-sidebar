#!/usr/bin/env node
// DSH 0.1.7 dropped SessionListState.current. The right sidebar is a
// root-scoped seat, so its session comes from the sessions snapshot — read the
// old way, every path in this plugin resolved to "no session", the Source
// Control card sent an empty cwd, and the host fell back to the deployment
// workspace root (the user's home, which is usually not a repository).
//
// This check drives the real rightbar seat with the 0.1.7 snapshot shape and
// asserts the card is rooted at the session's own Workspace.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const clientFile = process.argv[2] || 'lib/client.js'
const source = await readFile(new URL('../' + clientFile, import.meta.url), 'utf8')
const registrations = new Map()
const hooksByComponent = new Map()
let activeComponent = null
let hookIndex = 0

function sameDeps(left, right) {
  return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => Object.is(value, right[index]))
}

const React = {
  Fragment: Symbol('Fragment'),
  createElement(type, props, ...children) {
    return { type, props: { ...(props || {}), children } }
  },
  useState(initial) {
    const hooks = hooksByComponent.get(activeComponent) || []
    hooksByComponent.set(activeComponent, hooks)
    const index = hookIndex++
    if (!(index in hooks)) hooks[index] = typeof initial === 'function' ? initial() : initial
    return [hooks[index], (value) => {
      hooks[index] = typeof value === 'function' ? value(hooks[index]) : value
    }]
  },
  useEffect(effect, deps) {
    const hooks = hooksByComponent.get(activeComponent) || []
    hooksByComponent.set(activeComponent, hooks)
    const index = hookIndex++
    if (!sameDeps(hooks[index], deps)) {
      hooks[index] = deps
      effect()
    }
  },
}

// The Sidebar must be open for the rightbar seat to render its body; the
// open state is persisted, so seed it the way a previous session would have.
const storage = new Map([
  ['dsh.rsidebar.panel.v1', JSON.stringify({ sidebarOpen: true, panelOpen: false, panelHeight: 240, sidebarWidth: 360 })],
])
const localStorage = {
  getItem: (k) => (storage.has(k) ? storage.get(k) : null),
  setItem: (k, v) => { storage.set(k, String(v)) },
  removeItem: (k) => { storage.delete(k) },
}

const dynamicClient = clientFile === 'dynamic/client.js'
if (dynamicClient) {
  // The dynamic bundle is generated from these two files; a stale bundle ships
  // the old Client, so assert it matches before driving the source.
  const bundle = JSON.parse(await readFile(new URL('../dynamic/dsh-sidebar.dynamic.json', import.meta.url), 'utf8'))
  const hostSource = await readFile(new URL('../dynamic/host.js', import.meta.url), 'utf8')
  assert.equal(bundle.client, source, 'the generated dynamic bundle must contain the current client source')
  assert.equal(bundle.host, hostSource, 'the generated dynamic bundle must contain the current host source')
}

const statusCwds = []
const statusResult = {
  repo: true,
  root: '/workspace/project',
  branch: 'main',
  detached: false,
  upstream: null,
  ahead: 0,
  behind: 0,
  staged: [],
  unstaged: [],
  conflicts: [],
  fingerprint: '',
}
// Both dialects must report the cwd they asked about: the lib half calls the
// mounted remote service, the dynamic half calls the host RPC by name.
const git = {
  status(cwd) {
    statusCwds.push(cwd)
    return Promise.resolve({ ok: true, value: statusResult })
  },
}
const host = {
  call(method, payload) {
    if (method === 'status') {
      statusCwds.push(payload && payload.cwd)
      return Promise.resolve({ ok: true, ...statusResult })
    }
    return Promise.resolve({ ok: true })
  },
}
const slots = {
  inject(_name, install) { install() },
  register(options, render) {
    registrations.set(options.name, render)
    return () => {}
  },
}
const layout = { openDetails() {}, closeDetails() {}, openRightbar() {}, closeRightbar() {} }

const context = {
  window: { __ModuleLoader__: { load(definition) { plugin = definition.factory(() => React) } } },
  document: dynamicClient
    ? { createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }), head: { appendChild() {} } }
    : undefined,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  navigator: undefined,
  localStorage,
  React,
  host,
  styles: { insert() {} },
  console,
  Promise,
  Set,
  Map,
  Object,
  JSON,
  Error,
}
let plugin
if (dynamicClient) {
  // The dynamic dialect is a function body that returns the plugin itself.
  plugin = vm.runInNewContext('(function (React, host) {\n' + source + '\n})(React, host)', context, { filename: clientFile })
} else {
  vm.runInNewContext(source, context, { filename: clientFile })
}

const ctx = dynamicClient
  ? {
      get(name) {
        if (name === 'slots') return slots
        if (name === 'layout') return layout
        if (name === 'sidebarRight') return undefined
        return undefined
      },
      effect() {},
      interval() { return () => {} },
      timeout() {},
    }
  : {
      get(name) {
        if (name === 'layout') return layout
        if (name === 'remote.rsidebarGit') return git
        return undefined
      },
      remote: { $mount: async () => async () => {} },
      effect() {},
      interval() { return () => {} },
      timeout() {},
      slots,
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

function findComponent(node, name) {
  if (node == null || node === false) return null
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findComponent(child, name)
      if (found) return found
    }
    return null
  }
  if (typeof node !== 'object') return null
  if (typeof node.type === 'function' && node.type.name === name) return node
  return findComponent(node.props?.children, name)
}

const workspacePath = '/workspace/project'
const SESSION = 'session-7'

// The 0.1.7 snapshot: ids/byId/phase only, and the session the main view shows
// is the one whose retention count is positive.
const modernSnapshot = {
  ids: [SESSION],
  byId: { [SESSION]: { blank: false, retainedBy: { mainView: 1 } } },
  phase: 'ready',
  projectionsBySession: {},
}
// The older shells' snapshot, which still carried `current`.
const legacySnapshot = {
  ids: [SESSION],
  byId: { [SESSION]: { blank: false } },
  current: SESSION,
}

function props(snapshot) {
  return {
    width: 360,
    viewportWidth: 1400,
    canShow: true,
    useSessions(selector) { return selector(snapshot) },
    useWorkspaces(selector) {
      return selector({ items: [{ path: workspacePath, sessionIds: [SESSION] }] })
    },
  }
}

function statusCwdFor(snapshot, label) {
  statusCwds.length = 0
  // The rightbar seat is root-scoped: no framework sessionId rides its props.
  const seat = registrations.get('rightbar')
  assert.equal(typeof seat, 'function', 'the rightbar seat must be registered')
  // The seat itself renders a wrapper, which resolves the session and only then
  // yields the docked body — the resolution under test sits between the two.
  const seatElement = seat(props(snapshot))
  const docked = renderFunction(seatElement.type, seatElement.props)
  assert.ok(docked, `${label}: the rightbar body must render for an open Sidebar on a started session`)
  const tree = renderFunction(docked.type, docked.props)
  const card = findComponent(tree, 'GitStatusCard')
  assert.ok(card, `${label}: the Source Control card must render`)
  // A fresh hook slot: the card re-runs its mount effect on every render we drive.
  hooksByComponent.delete(card.type)
  renderFunction(card.type, card.props)
  return statusCwds
}

assert.deepEqual(statusCwdFor(modernSnapshot, 'DSH 0.1.7 snapshot'), [workspacePath],
  'the card must root at the session Workspace from ids/byId retention, not at the deployment root')

assert.deepEqual(statusCwdFor(legacySnapshot, 'legacy snapshot'), [workspacePath],
  'shells that still carry current must keep resolving the session Workspace')

// Without any session the seat stays closed rather than rooting at home.
statusCwds.length = 0
const emptySeat = registrations.get('rightbar')(props({ ids: [], byId: {}, phase: 'ready', projectionsBySession: {} }))
assert.equal(renderFunction(emptySeat.type, emptySeat.props), null,
  'no session may still mean no body, never a card rooted at the deployment root')

console.log('session current-shape check passed')
