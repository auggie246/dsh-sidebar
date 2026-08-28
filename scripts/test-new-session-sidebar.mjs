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
const ctx = {
  get(name) { return name === 'layout' ? layout : undefined },
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
rail.props.onClick()

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

// Click the Rail of the open render — its closure holds open = true, so the
// click collapses. The fake React never re-renders, so dropping the hook state
// models the re-render React performs after the store notifies subscribers.
const openRail = findClass(tree, 'rsb-rail')
openRail.props.onClick()
hookState.clear()
tree = renderFunction(overlay, props)
assert.equal(findClass(tree, 'rsb-overlay-panel'), null, 'clicking the Rail again must collapse the Sidebar')
console.log('new-session Sidebar check passed')
