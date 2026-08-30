#!/usr/bin/env node
// Bottom Panel check (ticket #3): the second Rail button opens and closes an
// empty Panel pinned under the center conversation column only; its edges
// track the center column (drag-resizes and collapse/expand of both side
// columns move it); the center column reserves the Panel height while open;
// and the Sidebar and Panel toggles are independent.
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

// Shell frame stand-in: the frame's element children follow the shipped
// AppFrame order (sidebar column, center column, details column, then the
// overlay layer). The plugin finds the center column as the frame's second
// element child and tracks it with a ResizeObserver.
const centerCol = {
  _rect: { left: 280, right: 1180, top: 0, bottom: 900, width: 900, height: 900 },
  getBoundingClientRect() { return this._rect },
}
const frame = { children: [{}, centerCol, {}] }
const overlayElement = { parentElement: frame }
let overlayLookupResult = overlayElement
const resizeObservers = []
class ResizeObserver {
  constructor(callback) { this.callback = callback; resizeObservers.push(this) }
  observe(target) { this.target = target }
  disconnect() { this.target = undefined }
}

const styleElements = []
// Test-controlled computed style for the measured center column: the overlay
// Sidebar reservation is padding on that column, so cases set these to model
// the floating strip. Defaults model the docked Sidebar (no reservation).
let centerPaddings = { paddingLeft: '0px', paddingRight: '0px' }
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
    getComputedStyle() { return centerPaddings },
  },
  document: {
    querySelector(selector) { return selector === '[data-shell-overlay]' ? overlayLookupResult : null },
    createElement() { return { textContent: '' } },
    head: { appendChild(el) { styleElements.push(el) } },
  },
  ResizeObserver,
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

let plugin
vm.runInNewContext(source, context, { filename: 'lib/client.js' })

const layoutCalls = []
const ctx = {
  get(name) {
    if (name === 'layout') {
      return {
        openDetails() { layoutCalls.push('open') },
        closeDetails() { layoutCalls.push('close') },
      }
    }
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

function findNode(node, predicate) {
  const found = []
  visit(node, (n) => { if (predicate(n)) found.push(n) })
  return found[0] || null
}

function railNode(root) {
  return findNode(root, (node) => node.props?.className === 'rsb-rail')
}

function railButtons(rail) {
  return (rail.props.children || []).filter((child) => child && child.type === 'button')
}

const overlay = registrations.get('shell.overlay')
assert.equal(typeof overlay, 'function', 'the Rail overlay slot must be registered')

const props = {
  sessionId: 'session-a',
  useSessions(selector) {
    return selector({ current: 'session-a', byId: { 'session-a': { blank: false } } })
  },
  useWorkspaces(selector) {
    return selector({ items: [{ path: '/workspace/a', sessionIds: ['session-a'] }] })
  },
}

function panelNode(root) {
  return findNode(root, (node) => node.props?.className === 'rsb-bottom-panel')
}

// 1. Closed by default: the second Rail button is live but the Panel region
//    is not rendered, and no layout action fires.
let rail = railNode(overlay(props))
assert.ok(rail, 'the Rail must render')
let buttons = railButtons(rail)
assert.equal(buttons.length, 2, 'the Rail must keep its two stacked buttons')
let panelButton = buttons[1]
assert.equal(panelButton.props.disabled, undefined, 'the Panel button must be enabled now that the Panel exists')
assert.equal(panelButton.props.title, 'Open panel', 'the closed Panel labels its Rail button as open')
assert.equal(panelButton.props['aria-label'], 'Open panel')
assert.equal(panelButton.props['aria-pressed'], 'false', 'the Panel button reports not-pressed while closed')
assert.equal(panelNode(overlay(props)), null, 'the closed Panel must render nothing')
// Mounting the Rail itself fires one closeDetails (the globally collapsed
// baseline, ticket #1); the Panel must add nothing on top of it.
const callsAfterMount = layoutCalls.length
assert.equal(layoutCalls.length, callsAfterMount, 'the closed Panel must not change Details Column state')

// 2. Opening the Panel renders a fixed region spanning the center column:
//    the measured rect is the test's independent source of truth.
panelButton.props.onClick()
// First render pass runs the measuring effect; the second carries the rect.
rail = railNode(overlay(props))
const panelA = panelNode(overlay(props))
assert.ok(panelA, 'the open Panel must render')
assert.equal(panelA.type, 'section', 'the Panel is a landmark section')
assert.equal(panelA.props['aria-label'], 'Panel')
assert.equal(panelA.props.style.left, '280px', 'the Panel left edge must equal the center column left edge')
assert.equal(panelA.props.style.width, '900px', 'the Panel width must equal the center column width')
assert.deepEqual(resizeObservers.map((ro) => ro.target), [centerCol], 'the Panel must track the center column element')

// 3. The Panel edges track the center column: a drag-resize or side-column
//    collapse/expand changes the measured rect and the Panel follows.
centerCol._rect = { left: 340, right: 1120, top: 0, bottom: 900, width: 780, height: 900 }
resizeObservers[0].callback()
const panelB = panelNode(overlay(props))
assert.ok(panelB, 'the Panel must stay mounted while the center column resizes')
assert.equal(panelB.props.style.left, '340px', 'the Panel left edge must follow the center column')
assert.equal(panelB.props.style.width, '780px', 'the Panel width must follow the center column')

// 3b. On a fresh session the Sidebar floats (ticket #1 overlay) and reserves
//     its strip as padding-right on the same center column. The Panel must
//     mirror the content box, so it spans the visible area and never slides
//     underneath the floating Sidebar (ADR 0003 follow-up).
centerCol._rect = { left: 280, right: 1180, top: 0, bottom: 900, width: 900, height: 900 }
centerPaddings = { paddingLeft: '0px', paddingRight: '360px' }
resizeObservers[0].callback()
const panelC = panelNode(overlay(props))
assert.ok(panelC, 'the Panel must stay mounted while the overlay Sidebar reserves its strip')
assert.equal(panelC.props.style.left, '280px', 'the Panel left edge must stay at the content box left edge')
assert.equal(panelC.props.style.width, '540px', 'the Panel width must exclude the overlay Sidebar strip (900 - 360)')
centerPaddings = { paddingLeft: '0px', paddingRight: '0px' }
resizeObservers[0].callback()
const panelD = panelNode(overlay(props))
assert.equal(panelD.props.style.width, '900px', 'docking the Sidebar again must restore the full span')

// 4. While open, the center column reserves the Panel height so no
//    conversation content is covered; the Panel and the reservation share
//    one variable so they can never drift apart.
assert.match(stylesheet, /:root \{[^}]*--rsb-panel-h: 240px/, 'the Panel height must be a shared root variable')
assert.match(stylesheet, /\.rsb-bottom-panel \{[^}]*position: fixed/, 'the Panel must be fixed-position')
assert.match(stylesheet, /\.rsb-bottom-panel \{[^}]*bottom: 0/, 'the Panel must pin to the bottom edge')
assert.match(stylesheet, /\.rsb-bottom-panel \{[^}]*height: var\(--rsb-panel-h\)/, 'the Panel height must come from the shared variable')
assert.match(
  stylesheet,
  /div:has\(> \[data-shell-overlay\] \.rsb-bottom-panel\) > div:nth-child\(2\) \{[^}]*padding-bottom: var\(--rsb-panel-h\)/,
  'the frame center column must reserve exactly the Panel height while the Panel is open',
)
const railZ = Number(stylesheet.match(/\.rsb-rail \{[^}]*z-index: (\d+)/)[1])
const panelZ = Number(stylesheet.match(/\.rsb-bottom-panel \{[^}]*z-index: (\d+)/)[1])
assert.ok(panelZ < railZ, 'the Rail must stay above the Panel so both stay reachable')

// 5. The second click closes the Panel: the region and its reservation go.
rail = railNode(overlay(props))
buttons = railButtons(rail)
panelButton = buttons[1]
assert.equal(panelButton.props.title, 'Close panel', 'the open Panel labels its Rail button as close')
assert.equal(panelButton.props['aria-pressed'], 'true', 'the Panel button reports pressed while open')
panelButton.props.onClick()
assert.equal(panelNode(overlay(props)), null, 'the second click must remove the Panel region')

// 6. Sidebar and Panel toggles are independent: either can be open alone
//    and both can be open at once, without disturbing each other.
rail = railNode(overlay(props))
buttons = railButtons(rail)
assert.equal(buttons[0].props.title, 'Open workspace sidebar', 'Panel toggling must not move the Sidebar preference')
assert.equal(layoutCalls.length, callsAfterMount, 'Panel toggling must not fire Details Column actions')
buttons[1].props.onClick()
buttons[0].props.onClick()
rail = railNode(overlay(props))
buttons = railButtons(rail)
assert.ok(panelNode(overlay(props)), 'opening the Sidebar must leave the Panel open')
assert.equal(buttons[0].props.title, 'Collapse workspace sidebar', 'the Sidebar opens independently')
// The Sidebar toggle fires 'open' (twice: handler + effect, per ticket #1
// semantics); the Panel toggle must contribute nothing but 'open' calls.
assert.equal(layoutCalls.at(-1), 'open', 'opening the Sidebar still opens the Details Column for a started session')
assert.ok(!layoutCalls.slice(callsAfterMount).includes('close'), 'Panel and Sidebar toggling must not close the Details Column')
buttons[0].props.onClick()
rail = railNode(overlay(props))
assert.ok(panelNode(overlay(props)), 'closing the Sidebar must leave the Panel open')

// 7. Fail-safe: without the shell frame the Panel renders nothing instead of
//    crashing or reserving space.
overlayLookupResult = null
rail = railNode(overlay(props))
buttons = railButtons(rail)
buttons[1].props.onClick()
assert.equal(panelNode(overlay(props)), null, 'without the shell frame the Panel must render nothing')

console.log('Bottom Panel check passed')
