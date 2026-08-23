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
assert.equal(typeof details, 'function', 'the Sidebar details slot must be registered')
assert.equal(typeof overlay, 'function', 'the Rail overlay slot must be registered')

const sessionA = sessionProps('session-a', '/workspace/a')
const firstPanelElement = details(sessionA)
const firstPanel = renderFunction(firstPanelElement.type, firstPanelElement.props)
const collapse = findNode(firstPanel, (node) => node.props?.title === 'Collapse sidebar')
assert.ok(collapse, 'the Sidebar must provide its collapse control')
collapse.props.onClick()

let rail = findNode(overlay(sessionA), (node) => node.props?.className === 'rsb-rail')
assert.equal(rail.props.title, 'Open workspace sidebar', 'collapsing the Sidebar must update the global preference')

unmountFunction(firstPanelElement.type)
const sessionB = sessionProps('session-b', '/workspace/b')
const secondPanelElement = details(sessionB)
renderFunction(secondPanelElement.type, secondPanelElement.props)
rail = findNode(overlay(sessionB), (node) => node.props?.className === 'rsb-rail')
assert.equal(
  rail.props.title,
  'Open workspace sidebar',
  'switching sessions must preserve the globally collapsed Sidebar preference',
)
assert.equal(layoutCalls.includes('open'), false, 'switching sessions must not reopen a globally collapsed Details Column')

rail.props.onClick()
rail = findNode(overlay(sessionB), (node) => node.props?.className === 'rsb-rail')
assert.equal(rail.props.title, 'Collapse workspace sidebar', 'opening the Sidebar must update the global preference')
assert.equal(layoutCalls.at(-1), 'open', 'opening the Sidebar must open the current Details Column')

layout.closeDetails()
unmountFunction(secondPanelElement.type)
const sessionC = sessionProps('session-c', '/workspace/c')
const thirdPanelElement = details(sessionC)
renderFunction(thirdPanelElement.type, thirdPanelElement.props)
rail = findNode(overlay(sessionC), (node) => node.props?.className === 'rsb-rail')
assert.equal(
  rail.props.title,
  'Collapse workspace sidebar',
  'switching sessions must preserve the globally open Sidebar preference',
)
assert.equal(layoutCalls.at(-1), 'open', 'switching sessions must reopen a globally open Details Column')
console.log('global Sidebar state check passed')
