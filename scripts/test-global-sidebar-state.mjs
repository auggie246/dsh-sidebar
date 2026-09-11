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

let plugin
const layoutCalls = []
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

const layout = {
  openDetails() { layoutCalls.push('open') },
  closeDetails() { layoutCalls.push('close') },
}
const ctx = {
  get(name) { return name === 'layout' ? layout : undefined },
  remote: { $mount: async () => async () => {} },
  effect() {},
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

function unmountFunction(type) {
  const hooks = hookState.get(type) || []
  for (const hook of hooks) {
    if (hook?.kind === 'effect' && typeof hook.cleanup === 'function') hook.cleanup()
  }
  hookState.delete(type)
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

// The region toggles are a two-button group (ticket #1, ADR 0008): with a
// session active they live in the session-header utilities row, whose
// container div has no onClick, so tests drive the first button child —
// the Sidebar toggle.
function sidebarToggleOf(bar) {
  const buttons = (bar.props?.children || []).filter((child) => child && child.type === 'button')
  assert.equal(buttons.length, 2, 'the Header Toggles must hold exactly two buttons')
  return buttons[0]
}

function sessionProps(sessionId, path) {
  return {
    sessionId,
    useSessions(selector) {
      return selector({ current: sessionId, byId: { [sessionId]: { blank: false } } })
    },
    useWorkspaces(selector) {
      return selector({ items: [{ path, sessionIds: [sessionId] }] })
    },
  }
}

const details = registrations.get('details')
const overlay = registrations.get('shell.overlay')
const headerToggles = registrations.get('conversation.session.header.utilities')
assert.equal(typeof details, 'function', 'the Sidebar details slot must be registered')
assert.equal(typeof overlay, 'function', 'the Rail overlay slot must be registered')
assert.equal(typeof headerToggles, 'function', 'the header utilities entry must be registered')
// ADR 0008: with a session active the toggles are read from the Header
// Toggles bar rendered by the session-header utilities entry.
function toggleBar(props) {
  return findNode(renderFunction(headerToggles, props), (node) => node.props?.className === 'rsb-header-toggles')
}

const sessionA = sessionProps('session-a', '/workspace/a')
// The `»` header collapse control is gone (ticket #1): the globally collapsed
// baseline is now the store's initial state, so the first toggle render must
// already read 'Open workspace sidebar'.
let bar = toggleBar(sessionA)
assert.equal(sidebarToggleOf(bar).props.title, 'Open workspace sidebar', 'the Sidebar must start globally collapsed')
// The floating Rail is gone whenever a session is active.
assert.equal(findNode(overlay(sessionA), (node) => node.props?.className === 'rsb-rail'), null, 'the floating Rail must not render while a session is active')

const sessionB = sessionProps('session-b', '/workspace/b')
const secondPanelElement = details(sessionB)
renderFunction(secondPanelElement.type, secondPanelElement.props)
// The layout effect lives in the shell.overlay Rail: rendering the overlay
// for the new session mirrors the global preference into its Details Column.
findNode(overlay(sessionB), (node) => node.props?.className === 'rsb-bottom-panel')
bar = toggleBar(sessionB)
assert.equal(
  sidebarToggleOf(bar).props.title,
  'Open workspace sidebar',
  'switching sessions must preserve the globally collapsed Sidebar preference',
)
assert.equal(layoutCalls.includes('open'), false, 'switching sessions must not reopen a globally collapsed Details Column')

sidebarToggleOf(bar).props.onClick()
bar = toggleBar(sessionB)
assert.equal(sidebarToggleOf(bar).props.title, 'Collapse workspace sidebar', 'opening the Sidebar must update the global preference')
assert.equal(layoutCalls.at(-1), 'open', 'opening the Sidebar must open the current Details Column')

layout.closeDetails()
unmountFunction(secondPanelElement.type)
const sessionC = sessionProps('session-c', '/workspace/c')
const thirdPanelElement = details(sessionC)
renderFunction(thirdPanelElement.type, thirdPanelElement.props)
// The layout effect lives in the shell.overlay Rail: rendering the overlay
// for the new session reopens its Details Column for a globally open
// Sidebar.
findNode(overlay(sessionC), (node) => node.props?.className === 'rsb-bottom-panel')
bar = toggleBar(sessionC)
assert.equal(
  sidebarToggleOf(bar).props.title,
  'Collapse workspace sidebar',
  'switching sessions must preserve the globally open Sidebar preference',
)
assert.equal(layoutCalls.at(-1), 'open', 'switching sessions must reopen a globally open Details Column')
console.log('global Sidebar state check passed')
