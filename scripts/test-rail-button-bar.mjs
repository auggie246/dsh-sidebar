#!/usr/bin/env node
// Rail button bar check: the Rail is a two-button bar (Sidebar toggle on
// top, inert Panel toggle below), the Sidebar header keeps exactly one
// toggle path, and Rail space outside the buttons is not a click target.
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

function visit(node, fn) {
  if (node == null || node === false) return
  if (Array.isArray(node)) {
    for (const child of node) visit(child, fn)
    return
  }
  if (typeof node !== 'object') return
  fn(node)
  if (typeof node.type === 'function') {
    visit(renderFunction(node.type, node.props), fn)
    return
  }
  visit(node.props?.children, fn)
}

function findAll(node, predicate) {
  const found = []
  visit(node, (n) => { if (predicate(n)) found.push(n) })
  return found
}

function findNode(node, predicate) {
  return findAll(node, predicate)[0]
}

function collectStrings(node, out) {
  if (node == null || node === false) return
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return
  }
  if (Array.isArray(node)) {
    for (const child of node) collectStrings(child, out)
    return
  }
  if (typeof node !== 'object') return
  if (typeof node.type === 'function') {
    collectStrings(renderFunction(node.type, node.props), out)
    return
  }
  collectStrings(node.props?.children, out)
}

function svgMarkup(svg) {
  const parts = []
  visit(svg, (n) => {
    if (typeof n !== 'object' || !n.props) return
    for (const value of Object.values(n.props)) {
      if (typeof value === 'string') parts.push(value)
    }
  })
  return parts.join(' ')
}

function railButtons(rail) {
  return (rail.props.children || []).filter((child) => child && child.type === 'button')
}

function svgOf(button) {
  return (button.props.children || []).find((child) => child && child.type === 'svg')
}

const overlay = registrations.get('shell.overlay')
const details = registrations.get('details')
assert.equal(typeof overlay, 'function', 'the Rail overlay slot must be registered')
assert.equal(typeof details, 'function', 'the Sidebar details slot must be registered')

const props = {
  sessionId: 'session-a',
  useSessions(selector) {
    return selector({ current: 'session-a', byId: { 'session-a': { blank: false } } })
  },
  useWorkspaces(selector) {
    return selector({ items: [{ path: '/workspace/a', sessionIds: ['session-a'] }] })
  },
}

const railNode = () => findNode(overlay(props), (node) => node.props?.className === 'rsb-rail')

// 1. The Rail container is a plain div holding two stacked SVG buttons.
let rail = railNode()
assert.ok(rail, 'the Rail must render')
assert.equal(rail.type, 'div', 'the Rail must be a container div, not a click target itself')
assert.equal(rail.props.onClick, undefined, 'clicking Rail space outside the buttons must do nothing')
const buttons = railButtons(rail)
assert.equal(buttons.length, 2, 'the Rail must stack exactly two icon buttons')
for (const button of buttons) {
  const svg = svgOf(button)
  assert.ok(svg, 'each Rail button must contain an inline SVG glyph')
  const markup = svgMarkup(svg)
  assert.ok(markup.includes('currentColor'), 'Rail glyphs must color with currentColor')
  assert.doesNotMatch(markup, /#|rgb\(|hsl\(/, 'Rail glyphs must not hardcode colors')
}

// The top glyph is a frame with the right pane filled; the second is a
// frame with the bottom pane filled.
const sidebarSvg = svgOf(buttons[0])
const sidebarFilled = findAll(sidebarSvg, (n) => n.type === 'rect' && n.props.fill === 'currentColor')
assert.equal(sidebarFilled.length, 1, 'the Sidebar glyph must fill exactly one pane')
assert.ok(Number(sidebarFilled[0].props.x) >= 8, 'the Sidebar glyph must fill the right pane')
assert.ok(findAll(sidebarSvg, (n) => n.type === 'rect' && n.props.stroke === 'currentColor').length > 0, 'the Sidebar glyph must stroke its frame with currentColor')
const panelSvg = svgOf(buttons[1])
const panelFilled = findAll(panelSvg, (n) => n.type === 'rect' && n.props.fill === 'currentColor')
assert.equal(panelFilled.length, 1, 'the Panel glyph must fill exactly one pane')
assert.ok(Number(panelFilled[0].props.y) >= 8, 'the Panel glyph must fill the bottom pane')

// 2. The top button toggles the Sidebar with the Rail's existing semantics.
assert.equal(buttons[0].props.title, 'Open workspace sidebar', 'the closed Sidebar labels its Rail button as open')
assert.equal(buttons[0].props['aria-label'], 'Open workspace sidebar')
buttons[0].props.onClick()
rail = railNode()
assert.equal(railButtons(rail)[0].props.title, 'Collapse workspace sidebar', 'the top button must set the open preference')
assert.equal(layoutCalls.at(-1), 'open', 'opening the Sidebar must open the Details Column for a started session')
railButtons(rail)[0].props.onClick()
rail = railNode()
assert.equal(railButtons(rail)[0].props.title, 'Open workspace sidebar', 'the second click must set the open preference back to closed')
assert.equal(layoutCalls.at(-1), 'close', 'closing the Sidebar must close the Details Column for a started session')

// 3. The second button is visibly inert: disabled, no handler, no effect.
const inert = railButtons(rail)[1]
assert.equal(inert.props.disabled, true, 'the Panel button must be disabled')
assert.equal(inert.props.onClick, undefined, 'the Panel button must have no click handler to force')
assert.equal(inert.props.title, 'Panel is not available yet')
assert.equal(inert.props['aria-label'], 'Panel is not available yet')
const callsBefore = layoutCalls.length
const titleBefore = railButtons(rail)[0].props.title
rail = railNode()
assert.equal(layoutCalls.length, callsBefore, 'the inert Panel button must not change layout state')
assert.equal(railButtons(rail)[0].props.title, titleBefore, 'the inert Panel button must not change the open preference')
assert.match(stylesheet, /\.rsb-rail button:disabled \{[^}]*cursor: default/, 'the disabled Panel button must not suggest interactivity')

// The Rail keeps its footprint while splitting it into two 36px targets.
assert.match(stylesheet, /\.rsb-rail \{[^}]*height: 72px/, 'the Rail container must keep its 72px footprint')
assert.match(stylesheet, /\.rsb-rail button \{[^}]*height: 36px/, 'the two Rail buttons must split the Rail into two 36px targets')

// 4. The header keeps the settings button and loses the collapse button.
const headerButtons = findAll(details(props), (node) => node.type === 'button' && node.props?.className === 'rsb-iconbtn')
assert.equal(headerButtons.length, 1, 'the header must keep exactly one icon button')
assert.equal(headerButtons[0].props.title, 'Sidebar settings (show/hide cards)', 'the header keeps the settings button')
const strings = []
collectStrings(details(props), strings)
assert.ok(!strings.some((text) => text.includes('»')), 'the header collapse button must be gone: one toggle path per region')
assert.ok(strings.includes('⚙'), 'the header must keep the settings glyph')

console.log('Rail button bar check passed')
