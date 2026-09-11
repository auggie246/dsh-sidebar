#!/usr/bin/env node
// Toggle seat check (ADR 0008): with a session active, the two region
// toggles move to the session-header utilities row so the floating bar can
// never cover the shell's Turn Navigator turn-mark lane; the right-edge
// Rail remains only on the hero (no current session). The Sidebar header
// keeps exactly one toggle path, and Rail space outside the buttons is not
// a click target. The Panel toggle's own behavior is pinned by
// test-bottom-panel.mjs; the document stub's null querySelector makes the
// open Panel render nothing.
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
  // querySelector returning null keeps the BottomPanel measurement effect
  // inert here (no shell frame in this stub).
  document: {
    querySelector() { return null },
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

function toggleButtons(bar) {
  return (bar.props.children || []).filter((child) => child && child.type === 'button')
}

function svgOf(button) {
  return (button.props.children || []).find((child) => child && child.type === 'svg')
}

const overlay = registrations.get('shell.overlay')
const details = registrations.get('details')
const headerToggles = registrations.get('conversation.session.header.utilities')
assert.equal(typeof overlay, 'function', 'the Rail overlay slot must be registered')
assert.equal(typeof details, 'function', 'the Sidebar details slot must be registered')
assert.equal(typeof headerToggles, 'function', 'the header utilities entry must be registered')

const props = {
  sessionId: 'session-a',
  useSessions(selector) {
    return selector({ current: 'session-a', byId: { 'session-a': { blank: false } } })
  },
  useWorkspaces(selector) {
    return selector({ items: [{ path: '/workspace/a', sessionIds: ['session-a'] }] })
  },
}
const heroProps = {
  sessionId: undefined,
  useSessions(selector) {
    return selector({ current: undefined, byId: {} })
  },
  useWorkspaces(selector) {
    return selector({ items: [] })
  },
}

const headerBar = () => findNode(renderFunction(headerToggles, props), (node) => node.props?.className === 'rsb-header-toggles')

// 1. With a session active the floating Rail is gone: the shell's Turn
//    Navigator owns the right-edge turn-mark lane.
assert.equal(findNode(overlay(props), (node) => node.props?.className === 'rsb-rail'), undefined, 'the floating Rail must not render while a session is active')

// 2. The session-header utilities row carries the two-button group. Its
//    container is a plain div, not a click target itself.
let bar = headerBar()
assert.ok(bar, 'the Header Toggles must render while a session is active')
assert.equal(bar.type, 'div', 'the Header Toggles must be a container div, not a click target')
assert.equal(bar.props.onClick, undefined, 'clicking space outside the buttons must do nothing')
const buttons = toggleButtons(bar)
assert.equal(buttons.length, 2, 'the Header Toggles must stack exactly two icon buttons')
for (const button of buttons) {
  const svg = svgOf(button)
  assert.ok(svg, 'each toggle button must contain an inline SVG glyph')
  const markup = svgMarkup(svg)
  assert.ok(markup.includes('currentColor'), 'toggle glyphs must color with currentColor')
  assert.doesNotMatch(markup, /#|rgb\(|hsl\(/, 'toggle glyphs must not hardcode colors')
}

// The first glyph is a frame with the right pane filled; the second is a
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

// 3. The first button toggles the Sidebar with the Rail's semantics.
assert.equal(buttons[0].props.title, 'Open workspace sidebar', 'the closed Sidebar labels its toggle button as open')
assert.equal(buttons[0].props['aria-label'], 'Open workspace sidebar')
buttons[0].props.onClick()
bar = headerBar()
assert.equal(toggleButtons(bar)[0].props.title, 'Collapse workspace sidebar', 'the first button must set the open preference')
assert.equal(layoutCalls.at(-1), 'open', 'opening the Sidebar must open the Details Column for a started session')
toggleButtons(bar)[0].props.onClick()
bar = headerBar()
assert.equal(toggleButtons(bar)[0].props.title, 'Open workspace sidebar', 'the second click must set the open preference back to closed')
assert.equal(layoutCalls.at(-1), 'close', 'closing the Sidebar must close the Details Column for a started session')

// 4. The second button is the live Panel toggle; its full behavior is
//    pinned by test-bottom-panel.mjs. Here: enabled, titled, and clicking
//    it must not disturb the Sidebar toggle path above.
const panelButton = toggleButtons(bar)[1]
assert.equal(panelButton.props.disabled, undefined, 'the Panel button must be enabled now that the Panel exists')
assert.equal(panelButton.props.title, 'Open panel', 'the closed Panel labels its toggle button as open')
assert.equal(panelButton.props['aria-label'], 'Open panel')
const callsBefore = layoutCalls.length
const titleBefore = toggleButtons(bar)[0].props.title
panelButton.props.onClick()
bar = headerBar()
assert.equal(toggleButtons(bar)[0].props.title, titleBefore, 'the Panel toggle must not change the Sidebar open preference')
assert.equal(layoutCalls.length, callsBefore, 'the Panel toggle must not change layout state')
toggleButtons(bar)[1].props.onClick()
bar = headerBar()
assert.equal(toggleButtons(bar)[0].props.title, titleBefore, 'the second Panel click must leave the Sidebar preference alone')
assert.match(stylesheet, /\.rsb-header-toggles button:disabled \{[^}]*cursor: default/, 'a disabled header toggle must not suggest interactivity')
// On windows narrower than ~1600px the shell's @container rule would hide
// the Turn Navigator while the Sidebar is open; the plugin un-hides it
// because the marks reposition with the conversation width on their own.
assert.match(stylesheet, /@container \(width<=900px\) \{[^}]*div\.eGxaPq_slot \{ display: block/, 'the Turn Navigator un-hide override must ride the stylesheet')

// The hero Rail keeps its footprint while splitting it into two 36px
// targets.
assert.match(stylesheet, /\.rsb-rail \{[^}]*height: 72px/, 'the Rail container must keep its 72px footprint')
assert.match(stylesheet, /\.rsb-rail button \{[^}]*height: 36px/, 'the two Rail buttons must split the Rail into two 36px targets')

// 5. The hero Rail is the re-entry point while no session is active; it
//    holds the same two-button factory and keeps the Panel toggle disabled.
const heroRail = findNode(overlay(heroProps), (node) => node.props?.className === 'rsb-rail')
assert.ok(heroRail, 'the hero must keep the right-edge Rail')
assert.equal(heroRail.props.onClick, undefined, 'clicking Rail space outside the buttons must do nothing')
const heroButtons = toggleButtons(heroRail)
assert.equal(heroButtons.length, 2, 'the hero Rail must hold the same two buttons')
assert.equal(heroButtons[1].props.disabled, true, 'on the hero the Panel toggle stays disabled')
assert.match(stylesheet, /\.rsb-rail button:disabled \{[^}]*cursor: default/, 'a disabled Rail button must not suggest interactivity')

// 6. The header keeps the settings button and loses the collapse button.
const headerButtons = findAll(details(props), (node) => node.type === 'button' && node.props?.className === 'rsb-iconbtn')
assert.equal(headerButtons.length, 1, 'the header must keep exactly one icon button')
assert.equal(headerButtons[0].props.title, 'Sidebar settings (show/hide cards)', 'the header keeps the settings button')
const strings = []
collectStrings(details(props), strings)
assert.ok(!strings.some((text) => text.includes('»')), 'the header collapse button must be gone: one toggle path per region')
assert.ok(strings.includes('⚙'), 'the header must keep the settings glyph')

console.log('Toggle seat check passed')
