#!/usr/bin/env node
// Panel tab strip check (ticket #5): the open Panel renders a tab strip
// header row with an empty state while no Panel Tabs exist; the + affordance
// is live since ticket #6 (its full behavior is covered by
// test-panel-tabs.mjs). The Panel and its Rail button stay hidden/inert
// before the session starts — the same startedSession gate the Rail already
// uses — and come alive after.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
const PANEL_KEY = 'dsh.rsidebar.panel.v1'

function boot(env = {}) {
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

  const storage = env.storage || new Map()
  const localStorage = {
    getItem(k) { return storage.has(k) ? storage.get(k) : null },
    setItem(k, v) { storage.set(k, String(v)) },
  }
  const styleElements = []

  // Shell frame stand-in (same fixture as test-bottom-panel.mjs).
  const centerCol = {
    _rect: { left: 280, right: 1180, top: 0, bottom: 900, width: 900, height: 900 },
    getBoundingClientRect() { return this._rect },
  }
  const frame = { children: [{}, centerCol, {}] }
  const overlayElement = { parentElement: frame }
  const resizeObservers = []
  class ResizeObserver {
    constructor(callback) { this.callback = callback; resizeObservers.push(this) }
    observe(target) { this.target = target }
    disconnect() { this.target = undefined }
  }

  let plugin
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
      innerHeight: env.innerHeight,
    },
    document: {
      querySelector(selector) { return selector === '[data-shell-overlay]' ? overlayElement : null },
      createElement() { return { textContent: '' } },
      head: { appendChild(el) { styleElements.push(el) } },
    },
    ResizeObserver,
    navigator: undefined,
    localStorage,
    console,
    Promise,
    Set,
    Map,
    Object,
    JSON,
    Error,
  }
  vm.runInNewContext(source, context, { filename: 'lib/client.js' })

  const layoutCalls = []
  const registrations = new Map()
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

  function findClass(node, className) {
    let found = null
    visit(node, (n) => {
      if (!found && n.props?.className?.split(' ').includes(className)) found = n
    })
    return found
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

  const overlay = registrations.get('shell.overlay')
  return {
    overlay,
    render(props) { return renderFunction(overlay, props) },
    stylesheet: styleElements.map((el) => el.textContent).join('\n'),
    storage,
    layoutCalls,
    findClass,
    visit,
    collectStrings,
  }
}

function railButtons(rail) {
  return (rail.props.children || []).filter((child) => child && child.type === 'button')
}

const startedProps = {
  sessionId: 'session-a',
  useSessions(selector) {
    return selector({ current: 'session-a', byId: { 'session-a': { blank: false } } })
  },
  useWorkspaces(selector) {
    return selector({ items: [{ path: '/workspace/a', sessionIds: ['session-a'] }] })
  },
}
const blankProps = {
  sessionId: undefined,
  useSessions(selector) {
    return selector({ current: undefined, byId: {} })
  },
  useWorkspaces(selector) {
    return selector({ items: [] })
  },
}

// 1. The open Panel renders a tab strip header row with exactly one live +
//    affordance, and an empty state while no Panel Tabs exist.
{
  const env = boot()
  let tree = env.render(startedProps)
  railButtons(env.findClass(tree, 'rsb-rail'))[1].props.onClick()
  env.findClass(env.render(startedProps), 'rsb-bottom-panel') // mount pass; null while rect fills
  const panel = env.findClass(env.render(startedProps), 'rsb-bottom-panel')
  assert.ok(panel, 'the open Panel must render')

  const strip = env.findClass(panel, 'rsb-tabstrip')
  assert.ok(strip, 'the open Panel must render a tab strip header row')
  const addButtons = []
  env.visit(strip, (n) => { if (n.type === 'button' && n.props?.className === 'rsb-tabstrip-add') addButtons.push(n) })
  assert.equal(addButtons.length, 1, 'the strip must hold exactly one + affordance')
  const add = addButtons[0]
  assert.equal(add.props.disabled, undefined, 'the + affordance is live since ticket #6')
  assert.equal(typeof add.props.onClick, 'function', 'the + affordance must open the type picker')
  assert.equal(add.props.title, 'New panel tab')
  assert.equal(add.props['aria-label'], 'New panel tab')
  assert.deepEqual(add.props.children, ['+'], 'the affordance must be the + glyph')

  const empty = env.findClass(panel, 'rsb-panel-empty')
  assert.ok(empty, 'the no-tab Panel must show its empty state')
  const strings = []
  env.collectStrings(empty, strings)
  assert.ok(strings.some((t) => t.includes('No tabs open.')), 'the empty state must say no tabs are open')
  assert.ok(strings.some((t) => t.includes('Panel tabs will appear here.')), 'the empty state must state what will appear')
  assert.ok(!strings.some((t) => t.includes('Use +')), 'the empty state must not invite clicking the disabled +')

  assert.match(env.stylesheet, /\.rsb-tabstrip \{[^}]*border-bottom: 1px solid/, 'the strip must read as a header row')
  assert.match(env.stylesheet, /\.rsb-tab-picker \{[^}]*position: absolute/, 'the type picker must float over the Panel content')
}

// 2. Before the session starts the Panel and its Rail button are inert.
{
  const env = boot()
  const tree = env.render(blankProps)
  const rail = env.findClass(tree, 'rsb-rail')
  const buttons = railButtons(rail)
  assert.equal(buttons.length, 2, 'the Rail keeps both buttons before the session starts')
  assert.equal(buttons[1].props.disabled, true, 'the Panel Rail button must be inert before the session starts')
  assert.equal(buttons[1].props.title, 'Panel opens once the session starts', 'the inert button must say why')
  assert.equal(buttons[1].props['aria-pressed'], 'false')
  buttons[1].props.onClick()
  env.render(blankProps)
  assert.equal(env.findClass(env.render(blankProps), 'rsb-bottom-panel'), null, 'clicking the inert button must not open the Panel')
}

// 3. A Panel left open in storage stays hidden until the session starts, and
//    appears once it does (the same gate the Rail applies on mount).
{
  const storage = new Map()
  storage.set(PANEL_KEY, JSON.stringify({ sidebarOpen: false, panelOpen: true, panelHeight: 240 }))
  const env = boot({ storage })
  assert.equal(env.findClass(env.render(blankProps), 'rsb-bottom-panel'), null, 'a restored open Panel must stay hidden before the session starts')
  assert.equal(env.findClass(env.render(blankProps), 'rsb-bottom-panel'), null, 'still hidden on the second render')
  assert.equal(railButtons(env.findClass(env.render(blankProps), 'rsb-rail'))[1].props.disabled, true, 'the Rail button stays inert before the session starts')

  env.findClass(env.render(startedProps), 'rsb-bottom-panel') // mount pass; null while rect fills
  const panel = env.findClass(env.render(startedProps), 'rsb-bottom-panel')
  assert.ok(panel, 'the restored Panel must appear once the session starts')
  const buttons = railButtons(env.findClass(env.render(startedProps), 'rsb-rail'))
  assert.equal(buttons[1].props.disabled, undefined, 'the Rail button must be live after the session starts')
  assert.equal(buttons[1].props.title, 'Close panel', 'the live button reflects the open Panel')
  assert.ok(env.findClass(panel, 'rsb-tabstrip'), 'the restored Panel carries the tab strip')
}

console.log('Panel tab strip check passed')
