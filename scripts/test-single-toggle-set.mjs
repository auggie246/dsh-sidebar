#!/usr/bin/env node
// Single right-region control set (issue #26): DSH 0.1.5 ships an expand
// control for its Rightbar in the session-header corner seat, and that control
// expands the very column the Workspace Sidebar already owns. On a fresh load
// the user therefore sees two right-region control sets, and one click on the
// shipped control leaves an empty column open behind it. The plugin takes that
// single-kind seat at priority -1 with a component that renders nothing, and
// it keeps the shell column shut whenever our Sidebar is closed — on the hero
// page, on a blank session, and on a started session. Older shells own that
// column themselves: they get no corner registration and no new layout call.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

// Run against either distribution form, like the other twin-pinned suites:
//   node scripts/test-single-toggle-set.mjs lib/client.js
//   node scripts/test-single-toggle-set.mjs dynamic/client.js
const clientFile = process.argv[2] || 'lib/client.js'
const dynamicClient = clientFile === 'dynamic/client.js'
const source = await readFile(new URL('../' + clientFile, import.meta.url), 'utf8')
if (dynamicClient) {
  const bundle = JSON.parse(await readFile(new URL('../dynamic/dsh-sidebar.dynamic.json', import.meta.url), 'utf8'))
  assert.equal(bundle.client, source, 'the generated dynamic bundle must contain the current client source')
}
const PANEL_KEY = 'dsh.rsidebar.panel.v1'
const CORNER = 'conversation.session.header.corner'
const TOGGLES = 'conversation.session.header.utilities'
// The seats the 0.1.5 shell declares. The corner seat arrives with the new
// built-in right Sidebar; the legacy shell has no such seat.
const NEW_SLOTS = ['rightbar', CORNER, 'shell.overlay', TOGGLES]
const LEGACY_SLOTS = ['details', 'shell.overlay', TOGGLES]

// One boot = one page load. The frame fixture mirrors the rc.2 shell structure
// the plugin walks: overlayLayer's parent is the frame, whose children are
// [sidebarCol, centerCol, rightbarCol, ...]. env.layout=rightbar installs the
// 0.1.5 service face and its seat set; anything else installs the legacy
// Details face. env.declaredSlots overrides the seat set the shell declares.
function boot(env = {}) {
  const declared = env.declaredSlots || (env.layout === 'rightbar' ? NEW_SLOTS : LEGACY_SLOTS)
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
  const cssVars = []
  const documentElement = { style: { setProperty(k, v) { cssVars.push([k, v]) } } }

  const centerCol = {
    _rect: { left: 280, right: 1180, top: 0, bottom: 900, width: 900, height: 900 },
    getBoundingClientRect() { return this._rect },
  }
  const rightCol = {
    children: [{}],
    getBoundingClientRect() { return { width: 360 } },
  }
  const frameStyle = (() => {
    const vars = new Map([['grid-template-columns', '280px minmax(0px, 1fr) 360px']])
    const calls = []
    return {
      getPropertyValue(k) { return vars.get(k) || '' },
      setProperty(k, v) { calls.push([k, v]); vars.set(k, v) },
      setPropertyCalls: calls,
    }
  })()
  const frameListeners = {}
  const windowListeners = {}
  const frame = {
    children: [{}, centerCol, rightCol],
    style: frameStyle,
    addEventListener(type, fn) { (frameListeners[type] = frameListeners[type] || []).push(fn) },
    removeEventListener(type, fn) {
      const list = frameListeners[type] || []
      const idx = list.indexOf(fn)
      if (idx !== -1) list.splice(idx, 1)
    },
  }
  const overlayElement = { parentElement: frame }
  class ResizeObserver {
    constructor(callback) { this.callback = callback }
    observe(target) { this.target = target }
    disconnect() { this.target = undefined }
  }

  const pendingFrames = []
  const pendingTimers = []
  const styleElements = []
  const dynamicStyles = []

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
      innerHeight: 900,
      addEventListener(type, fn) { (windowListeners[type] = windowListeners[type] || []).push(fn) },
      removeEventListener(type, fn) {
        const list = windowListeners[type] || []
        const idx = list.indexOf(fn)
        if (idx !== -1) list.splice(idx, 1)
      },
    },
    document: {
      querySelector(selector) { return selector === '[data-shell-overlay]' ? overlayElement : null },
      createElement() { return { textContent: '' } },
      head: { appendChild(el) { styleElements.push(el) } },
      documentElement,
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
    React,
  }
  context.requestAnimationFrame = (fn) => { pendingFrames.push(fn); return pendingFrames.length }
  context.setTimeout = (fn) => { pendingTimers.push(fn); return fn }
  context.clearTimeout = (id) => {
    const idx = pendingTimers.indexOf(id)
    if (idx !== -1) pendingTimers.splice(idx, 1)
  }
  if (dynamicClient) {
    context.host = { current: undefined, call: async () => ({ ok: false, error: 'stub host' }) }
    context.styles = { insert(rules) { dynamicStyles.push(...(Array.isArray(rules) ? rules : [rules])) } }
    plugin = vm.runInNewContext('(function (React, host, styles) {\n' + source + '\n})(React, host, styles)', context, { filename: clientFile })
  } else {
    vm.runInNewContext(source, context, { filename: clientFile })
  }

  const layoutCalls = []
  const layout = env.layout === 'rightbar'
    ? {
        openRightbar(track, fullscreen) { layoutCalls.push(['openRightbar', track, fullscreen]) },
        closeRightbar() { layoutCalls.push(['closeRightbar']) },
      }
    : {
        openDetails() { layoutCalls.push(['openDetails']) },
        closeDetails() { layoutCalls.push(['closeDetails']) },
      }
  // The seat table records the registration options beside the render
  // function, so the suite can read the priority the seat was taken at.
  const registrations = new Map()
  const slotsFace = {
    inject(name, install) { if (declared.includes(name)) install() },
    register(options, render) {
      registrations.set(options.name, { options, render })
      return () => {}
    },
  }
  const ctx = {
    get(name) {
      if (name === 'slots') return slotsFace
      if (name === 'layout') return layout
      return undefined
    },
    remote: { $mount: async () => async () => {} },
    effect(fn) { fn() },
    interval() { return () => {} },
    timeout() {},
    slots: slotsFace,
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

  function sessionProps(sessionId, blank) {
    return Object.assign({
      sessionId,
      useSessions(selector) {
        return selector({ current: sessionId, byId: { [sessionId]: { blank: blank === true } } })
      },
      useWorkspaces(selector) {
        return selector({ items: [{ path: '/workspace/a', sessionIds: [sessionId] }] })
      },
    })
  }

  // The hero page: the root props carry no current session at all.
  function heroProps() {
    return {
      useSessions(selector) { return selector({ current: undefined, byId: {} }) },
      useWorkspaces(selector) { return selector({ items: [] }) },
    }
  }

  function rightbarOwner(canShow) {
    return { width: canShow === false ? 0 : 360, viewportWidth: 1400, canShow: canShow !== false }
  }

  // The live shell walks the whole tree, so child components render and their
  // effects run. These helpers mount the entry and return it for inspection.
  function mount(node) {
    visit(node, () => {})
    return node
  }

  const overlay = registrations.get('shell.overlay')
  const details = registrations.get('details')
  const rightbar = registrations.get('rightbar')
  const corner = registrations.get(CORNER)
  const headerToggles = registrations.get(TOGGLES)
  return {
    overlay,
    details,
    rightbar,
    corner,
    headerToggles,
    layoutCalls,
    renderHero() { return mount(renderFunction(overlay.render, heroProps())) },
    renderStarted() { return mount(renderFunction(overlay.render, sessionProps('session-a', false))) },
    renderBlank() { return mount(renderFunction(overlay.render, sessionProps('session-blank', true))) },
    renderTogglesStarted() { return mount(renderFunction(headerToggles.render, sessionProps('session-a', false))) },
    renderRightbarStarted(canShow = true) { return mount(renderFunction(rightbar.render, sessionProps('session-a', false, rightbarOwner(canShow)))) },
    findClass,
    visit,
    renderFunction,
  }
}

// Calls recorded since a marker, so a boot-time call never covers a
// render-time one (and the reverse).
function since(env, mark) {
  return env.layoutCalls.slice(mark)
}

function names(calls) {
  return calls.map((call) => call[0])
}

function railButtons(rail) {
  return (rail.props.children || []).filter((child) => child && child.type === 'button')
}

// Mount the corner entry the way the shell does: call the registered render,
// then render the component it returned.
function mountCorner(env) {
  const node = env.renderFunction(env.corner.render, { sessionId: 'session-a' })
  return node && typeof node.type === 'function' ? env.renderFunction(node.type, node.props) : node
}

// 1. New layout, Sidebar closed (a fresh load): the boot effect shuts the
//    shell column before anything renders, and the corner seat is taken at
//    priority -1 with a component that renders nothing.
{
  const env = boot({ layout: 'rightbar' })
  assert.deepEqual(names(env.layoutCalls), ['closeRightbar'], 'a fresh load with our Sidebar closed must close the shell column once at boot')
  assert.ok(env.corner, 'DSH 0.1.5 must receive a session-header corner registration')
  assert.equal(env.corner.options.name, CORNER, 'the corner registration must target the shipped expand control seat')
  assert.equal(env.corner.options.priority, -1, 'the corner entry must outrank the shipped one, which registers without a priority')
  assert.equal(mountCorner(env), null, 'the winning corner entry must render nothing')
  assert.equal(env.findClass(env.renderStarted(), 'rsb-header-toggles'), null, 'a started session keeps its toggles in the real header utilities row')
  assert.equal(railButtons(env.findClass(env.renderTogglesStarted(), 'rsb-header-toggles')).length, 2, 'our own seat still carries exactly the two-button region toggle pair')
}

// 2. Reload: one boot is one page load, so a second boot with the same storage
//    must reach the same single set — the shadow is a registration, not a
//    rendered state that a reload could forget.
{
  const storage = new Map()
  storage.set(PANEL_KEY, JSON.stringify({ sidebarOpen: false, panelOpen: false, panelHeight: 240, sidebarWidth: 360 }))
  const env = boot({ layout: 'rightbar', storage })
  assert.ok(env.corner, 'the reloaded page must take the corner seat again')
  assert.equal(mountCorner(env), null, 'the reloaded page must render no shipped expand control')
  assert.deepEqual(names(env.layoutCalls), ['closeRightbar'], 'the reloaded page must close the shell column once at boot')
}

// 3. New layout, Sidebar restored open: the boot effect leaves the column
//    alone, and the started-session Rail effect opens it.
{
  const storage = new Map()
  storage.set(PANEL_KEY, JSON.stringify({ sidebarOpen: true, panelOpen: false, panelHeight: 240, sidebarWidth: 360 }))
  const env = boot({ layout: 'rightbar', storage })
  assert.deepEqual(names(env.layoutCalls), [], 'a restored open Sidebar must not report the column hidden at boot')
  env.renderStarted()
  assert.deepEqual(names(env.layoutCalls), ['openRightbar'], 'the restored Sidebar must still open the rightbar track from the Rail effect')
}

// 4. New layout, hero page: no session exists, so the floating overlay covers
//    the region and the shell column stays shut.
{
  const env = boot({ layout: 'rightbar' })
  const mark = env.layoutCalls.length
  env.renderHero()
  assert.deepEqual(names(since(env, mark)), ['closeRightbar'], 'the hero page must leave the shell column closed')
}

// 5. New layout, blank session: the docked seat renders nothing, so the
//    column stays shut whether our Sidebar is closed or shows the overlay.
{
  const closed = boot({ layout: 'rightbar' })
  let mark = closed.layoutCalls.length
  closed.renderBlank()
  assert.deepEqual(names(since(closed, mark)), ['closeRightbar'], 'a closed Sidebar on a blank session must leave the shell column closed')

  const storage = new Map()
  storage.set(PANEL_KEY, JSON.stringify({ sidebarOpen: true, panelOpen: false, panelHeight: 240, sidebarWidth: 360 }))
  const opened = boot({ layout: 'rightbar', storage })
  mark = opened.layoutCalls.length
  const blank = opened.renderBlank()
  assert.ok(opened.findClass(blank, 'rsb-overlay-panel'), 'an open Sidebar on a blank session renders the floating overlay')
  assert.ok(!opened.findClass(blank, 'rsb-docked-panel'), 'an open Sidebar on a blank session must not dock into the column')
  assert.deepEqual(names(since(opened, mark)), ['closeRightbar'], 'an open overlay Sidebar on a blank session must keep the shell column shut')
}

// 6. New layout, started session: closed shuts the column, open reserves it —
//    the pre-existing behavior the widen must not disturb.
{
  const env = boot({ layout: 'rightbar' })
  let mark = env.layoutCalls.length
  env.renderStarted()
  assert.deepEqual(names(since(env, mark)), ['closeRightbar'], 'a closed Sidebar on a started session must close the shell column')

  const storage = new Map()
  storage.set(PANEL_KEY, JSON.stringify({ sidebarOpen: true, panelOpen: false, panelHeight: 240, sidebarWidth: 360 }))
  const opened = boot({ layout: 'rightbar', storage })
  mark = opened.layoutCalls.length
  opened.renderStarted()
  assert.deepEqual(names(since(opened, mark)), ['openRightbar'], 'an open Sidebar on a started session must open the shell column')
  assert.deepEqual(since(opened, mark)[0], ['openRightbar', true, false], 'the docked open must reserve the track and keep fullscreen off')
}

// 7. Legacy shell with the corner seat declared anyway: the seat is left
//    exactly as it was, so the gate is the dialect — not the missing seat.
{
  const env = boot({ layout: 'details', declaredSlots: [...LEGACY_SLOTS, CORNER] })
  assert.equal(env.corner, undefined, 'a pre-0.1.5 shell must keep its session-header corner even when the seat exists')
  assert.deepEqual(names(env.layoutCalls), [], 'a pre-0.1.5 shell must receive no new layout call at boot')
}

// 8. Legacy shell: every page keeps the old call pattern. The hero, a blank
//    session, and an open overlay Sidebar add nothing; a started session
//    still routes through the Details face.
{
  const env = boot({ layout: 'details' })
  let mark = env.layoutCalls.length
  env.renderHero()
  env.renderBlank()
  assert.deepEqual(names(since(env, mark)), [], 'pre-0.1.5 hero and blank pages must stay free of new layout calls')

  const storage = new Map()
  storage.set(PANEL_KEY, JSON.stringify({ sidebarOpen: true, panelOpen: false, panelHeight: 240, sidebarWidth: 360 }))
  const opened = boot({ layout: 'details', storage })
  mark = opened.layoutCalls.length
  const blank = opened.renderBlank()
  assert.ok(opened.findClass(blank, 'rsb-overlay-panel'), 'the legacy blank-session overlay must survive')
  assert.deepEqual(names(since(opened, mark)), [], 'the legacy blank-session overlay must not touch the Details face')

  mark = opened.layoutCalls.length
  opened.renderStarted()
  assert.deepEqual(names(since(opened, mark)), ['openDetails'], 'a started legacy session with an open Sidebar must still call openDetails()')
  assert.ok(opened.details, 'the Details slot registration must survive on older shells')

  const started = boot({ layout: 'details' })
  mark = started.layoutCalls.length
  started.renderStarted()
  assert.deepEqual(names(since(started, mark)), ['closeDetails'], 'a closed Sidebar on a started legacy session must still call closeDetails()')
}

console.log('single right-region control set check passed (' + clientFile + ')')
