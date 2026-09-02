#!/usr/bin/env node
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
    if (!(index in hooks)) hooks[index] = typeof initial === 'function' ? initial() : initial
    return [hooks[index], (value) => {
      hooks[index] = typeof value === 'function' ? value(hooks[index]) : value
    }]
  },
  useEffect(effect) {
    const hooks = hookState.get(activeComponent) || []
    hookState.set(activeComponent, hooks)
    const index = hookIndex++
    if (!(index in hooks)) {
      hooks[index] = true
      effect()
    }
  },
}

let plugin
const layoutCalls = []
const styleElements = []
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
  // The lib client inserts its stylesheet through ctx.effect; a minimal
  // document stub lets that effect run so the test can inspect the CSS.
  document: {
    createElement() { return { textContent: '' } },
    head: { appendChild(el) { styleElements.push(el) } },
  },
  navigator: undefined,
  localStorage: undefined,
  console,
  Promise,
  Set,
  Object,
  JSON,
  Error,
}
vm.runInNewContext(source, context, { filename: 'lib/client.js' })

const layout = {
  openDetails() { layoutCalls.push('open') },
  closeDetails() { layoutCalls.push('close') },
}
// Issue #14: the Working Repository is observable end to end — the git
// service stub captures the cwd every status RPC is issued with, so the
// workspace resolution of the overlay Sidebar can be asserted directly.
const statusCwds = []
const statusResult = {
  repo: false,
  root: '',
  branch: '',
  detached: false,
  upstream: null,
  ahead: 0,
  behind: 0,
  staged: [],
  unstaged: [],
  conflicts: [],
  fingerprint: '',
}
const git = {
  status(cwd) {
    statusCwds.push(cwd)
    return Promise.resolve({ ok: true, value: statusResult })
  },
}
const ctx = {
  get(name) {
    if (name === 'layout') return layout
    if (name === 'remote.rsidebarGit') return git
    return undefined
  },
  remote: { $mount: async () => async () => {} },
  effect(fn) { fn() },
  interval() { return () => {} },
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

const stylesheet = styleElements.map((el) => el.textContent).join('\n')

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

function findClass(node, className) {
  if (node == null || node === false) return null
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findClass(child, className)
      if (found) return found
    }
    return null
  }
  if (typeof node !== 'object') return null
  if (typeof node.type === 'function') return findClass(renderFunction(node.type, node.props), className)
  if (node.props?.className?.split(' ').includes(className)) return node
  return findClass(node.props?.children, className)
}

// Unlike the retention test's findComponent, the overlay tree nests
// SidebarPanel as an unrendered element, so intermediate function
// components must be rendered while descending to reach the cards.
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
  if (typeof node.type === 'function') {
    if (node.type.name === name) return node
    return findComponent(renderFunction(node.type, node.props), name)
  }
  return findComponent(node.props?.children, name)
}

// The Rail is a two-button bar (ticket #1): the container div has no onClick,
// so tests drive the first button child — the Sidebar toggle.
function railToggle(railNode) {
  const buttons = (railNode.props?.children || []).filter((child) => child && child.type === 'button')
  assert.equal(buttons.length, 2, 'the Rail must hold exactly two stacked buttons')
  return buttons[0]
}

const overlay = registrations.get('shell.overlay')
assert.equal(typeof overlay, 'function', 'the shell.overlay Rail must be registered')
const props = {
  sessionId: undefined,
  useSessions(selector) {
    return selector({ current: undefined, byId: {} })
  },
  useWorkspaces(selector) {
    return selector({ items: [] })
  },
}

let tree = renderFunction(overlay, props)
const rail = findClass(tree, 'rsb-rail')
assert.ok(rail, 'the Rail must render on the new session page')
railToggle(rail).props.onClick()

tree = renderFunction(overlay, props)
const panel = findClass(tree, 'rsb-overlay-panel')
assert.ok(panel, 'clicking the Rail must render the Sidebar on the new session page')
assert.ok(findClass(panel, 'rsb-panel'), 'the new-session Sidebar must render its panel content')
assert.deepEqual(layoutCalls, [], 'the blank session path must not use the shell Details Column')// The floating panel must not simply cover the conversation: the stylesheet
// has to reserve the panel's width inside the shell's center column.
assert.match(
  stylesheet,
  /--rsb-panel-w:\s*min\(360px,\s*calc\(100vw - 22px\)\)/,
  'the panel width must be one shared custom property',
)
assert.match(
  stylesheet,
  /\.rsb-overlay-panel \{[^}]*width: var\(--rsb-panel-w\)/,
  'the floating panel must size itself from the shared custom property',
)
assert.match(
  stylesheet,
  /\[data-details-collapsed\]:has\(\[data-shell-overlay\] \.rsb-overlay-panel\) > div:nth-child\(2\)[^{]*\{[^}]*padding-right: var\(--rsb-panel-w\)/,
  'the center column must reserve the panel width while the new-session Sidebar is open',
)

// Click the Rail's Sidebar toggle of the open render — its closure holds
// open = true, so the click collapses. The fake React never re-renders, so
// dropping the hook state models the re-render React performs after the
// store notifies subscribers.
const openRail = findClass(tree, 'rsb-rail')
railToggle(openRail).props.onClick()
hookState.clear()
tree = renderFunction(overlay, props)
assert.equal(findClass(tree, 'rsb-overlay-panel'), null, 'clicking the Rail again must collapse the Sidebar')

// Issue #14: on a blank session the overlay Sidebar's root-scoped slot
// props carry no session-scoped sessionId, yet its Source Control card
// must still query git in the session's workspace. Drive the same
// toggle-open flow with a current-but-blank session and capture the cwd
// the status RPC is issued with. The capture resets here: the earlier
// no-session assertions rendered the cards through findClass, which
// mounted GitStatusCard once with the pre-fix empty cwd.
statusCwds.length = 0
const newSessionProps = {
  sessionId: undefined,
  useSessions(selector) {
    return selector({ current: 'sess-new', byId: { 'sess-new': { blank: true } } })
  },
  useWorkspaces(selector) {
    return selector({ items: [{ path: '/workspace/new-project', sessionIds: ['sess-new'] }] })
  },
}
tree = renderFunction(overlay, newSessionProps)
railToggle(findClass(tree, 'rsb-rail')).props.onClick()
// Dropping the hook state models the re-render React performs after the
// store notifies subscribers, and remounts the cards for the new render.
hookState.clear()
tree = renderFunction(overlay, newSessionProps)
const newSessionCard = findComponent(tree, 'GitStatusCard')
assert.ok(newSessionCard, 'the blank-session overlay must render the Source Control Card')
renderFunction(newSessionCard.type, newSessionCard.props)
assert.deepEqual(
  statusCwds,
  ['/workspace/new-project'],
  'the blank-session overlay must run git status in the current session workspace',
)

// Baseline: with no current session at all the overlay keeps the no-session
// behavior — the card queries with an empty cwd and renders the "follows
// the current session workspace" empty state. Dropping the card's hooks
// models its remount so the status effect runs against the new render.
statusCwds.length = 0
hookState.delete(newSessionCard.type)
tree = renderFunction(overlay, props)
const noSessionCard = findComponent(tree, 'GitStatusCard')
assert.ok(noSessionCard, 'the no-session overlay must still render the Source Control Card')
renderFunction(noSessionCard.type, noSessionCard.props)
assert.deepEqual(
  statusCwds,
  [''],
  'with no current session the overlay must keep the empty-cwd behavior',
)

console.log('new-session Sidebar check passed')
