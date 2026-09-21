#!/usr/bin/env node
// Rightbar layout compatibility check (issue #25): DSH 0.1.5 renamed the
// Details Column to Rightbar. The layout service now exposes
// openRightbar(track, fullscreen)/closeRightbar(), its drag handle moved
// from [data-side="details"] to [data-side="rightbar"], the collapsed marker
// moved from data-details-collapsed to data-rightbar-collapsed, and the
// Details slot became the root-scoped rightbar seat. The plugin
// feature-detects the service face once and speaks both dialects, so a
// single build serves either shell: on the new layout the Workspace Sidebar
// owns the rightbar seat (shadowing the shipped occupant), and on older
// shells every legacy path keeps behaving byte-identically.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

// Run against either distribution form, like the other twin-pinned suites:
//   node scripts/test-rightbar-layout-compat.mjs lib/client.js
//   node scripts/test-rightbar-layout-compat.mjs dynamic/client.js
const clientFile = process.argv[2] || 'lib/client.js'
const dynamicClient = clientFile === 'dynamic/client.js'
const source = await readFile(new URL('../' + clientFile, import.meta.url), 'utf8')
if (dynamicClient) {
  const bundle = JSON.parse(await readFile(new URL('../dynamic/dsh-sidebar.dynamic.json', import.meta.url), 'utf8'))
  assert.equal(bundle.client, source, 'the generated dynamic bundle must contain the current client source')
}
const PANEL_KEY = 'dsh.rsidebar.panel.v1'

// One boot = one page load. The frame fixture mirrors the rc.2 shell
// structure the plugin walks: overlayLayer's parent is the frame, whose
// children are [sidebarCol, centerCol, rightbarCol, ...]; the right column
// hosts the docked Sidebar and carries the inline grid tracks the shell
// writes. env.layout=rightbar installs the 0.1.5 service face; anything
// else installs the legacy Details face.
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
  const frameStyle = env.frameStyle || (() => {
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
  const resizeObservers = []
  class ResizeObserver {
    constructor(callback) { this.callback = callback; resizeObservers.push(this) }
    observe(target) { this.target = target }
    disconnect() { this.target = undefined }
  }

  const pendingFrames = []
  let nextFrame = 1
  const pendingTimers = []
  const styleElements = []
  // The composition form appends a <style> element; the dynamic form hands
  // its rules to the host's styles face. Both must be readable as one sheet.
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
      innerHeight: env.innerHeight,
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
  if (env.deferredRaf) {
    context.requestAnimationFrame = (fn) => { pendingFrames.push(fn); return nextFrame++ }
  }
  context.setTimeout = (fn) => { pendingTimers.push(fn); return fn }
  context.clearTimeout = (id) => {
    const idx = pendingTimers.indexOf(id)
    if (idx !== -1) pendingTimers.splice(idx, 1)
  }
  // The dynamic form is a Cordis function body taking its two globals; the
  // composition form registers itself through the module loader.
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
        // The 0.1.5 face: no openDetails; the track/fullscreen pair is
        // recorded so the exact docked call can be asserted.
        openRightbar(track, fullscreen) { layoutCalls.push(['openRightbar', track, fullscreen]) },
        closeRightbar() { layoutCalls.push(['closeRightbar']) },
      }
    : {
        openDetails() { layoutCalls.push(['openDetails']) },
        closeDetails() { layoutCalls.push(['closeDetails']) },
      }
  const registrations = new Map()
  const slotsFace = {
    inject(_name, install) { install() },
    register(options, render) {
      registrations.set(options.name, render)
      return () => {}
    },
  }
  const ctx = {
    get(name) {
      // The composition form reaches ctx.slots directly; the dynamic form
      // resolves the same object through ctx.get('slots').
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

  function sessionProps(sessionId, blank, owner) {
    return Object.assign({
      sessionId,
      useSessions(selector) {
        return selector({ current: sessionId, byId: { [sessionId]: { blank: blank === true } } })
      },
      useWorkspaces(selector) {
        return selector({ items: [{ path: '/workspace/a', sessionIds: [sessionId] }] })
      },
    }, owner || {})
  }

  // The rightbar seat carries the frame's owner share; default to a frame
  // that can show the column, as a wide viewport reports.
  function rightbarOwner(canShow) {
    return { width: canShow === false ? 0 : 360, viewportWidth: 1400, canShow: canShow !== false }
  }

  const overlay = registrations.get('shell.overlay')
  const details = registrations.get('details')
  const rightbar = registrations.get('rightbar')
  const headerToggles = registrations.get('conversation.session.header.utilities')
  return {
    overlay,
    details,
    rightbar,
    frameListeners,
    windowListeners,
    renderStarted() { return renderFunction(overlay, sessionProps('session-a', false)) },
    renderBlank() { return renderFunction(overlay, sessionProps('session-blank', true)) },
    renderTogglesStarted() { return renderFunction(headerToggles, sessionProps('session-a', false)) },
    renderTogglesBlank() { return renderFunction(headerToggles, sessionProps('session-blank', true)) },
    renderRightbarStarted(canShow = true) { return renderFunction(rightbar, sessionProps('session-a', false, rightbarOwner(canShow))) },
    renderRightbarBlank() { return renderFunction(rightbar, sessionProps('session-blank', true, rightbarOwner(true))) },
    renderDetails() { return renderFunction(details, sessionProps('session-a', false)) },
    get stylesheet() { return styleElements.map((el) => el.textContent).join('\n') + '\n' + dynamicStyles.join('\n') },
    storage,
    cssVars,
    pendingFrames,
    pendingTimers,
    resizeObservers,
    layoutCalls,
    frameStyle,
    findClass,
    visit,
    renderFunction,
  }
}

function railButtons(rail) {
  return (rail.props.children || []).filter((child) => child && child.type === 'button')
}

function flushFrames(env) {
  while (env.pendingFrames.length) env.pendingFrames.shift()()
}

// Simulate the pointer pair the shell's right-column handle produces. The
// pointerdown target's closest() decides whether the capture arms; the
// pointerup fires on the window like a captured release does.
function fireFramePointerDown(env, hitSelector) {
  for (const fn of (env.frameListeners['pointerdown'] || [])) {
    fn({ target: { closest: (sel) => (sel === hitSelector) ? {} : null } })
  }
}

function fireWindowPointerUp(env) {
  for (const fn of (env.windowListeners['pointerup'] || [])) fn({})
}

function storedState(env) {
  const raw = env.storage.get(PANEL_KEY)
  return raw ? JSON.parse(raw) : undefined
}

function openSidebarStarted(env) {
  railButtons(env.findClass(env.renderTogglesStarted(), 'rsb-header-toggles'))[0].props.onClick()
  env.findClass(env.renderStarted(), 'rsb-bottom-panel')
}

// 1. New layout: the toggle routes the open/close pair to the 0.1.5 face,
//    docked with the track reserved and fullscreen off.
{
  const env = boot({ layout: 'rightbar' })
  // A closed Sidebar never opens the column, so the open call below can
  // only come from the toggle under test.
  env.findClass(env.renderStarted(), 'rsb-rail')
  assert.equal(
    env.layoutCalls.filter((c) => c[0] === 'openRightbar' || c[0] === 'openDetails').length, 0,
    'a closed Sidebar must not open the right column')
  openSidebarStarted(env)
  assert.ok(
    env.layoutCalls.some((c) => c[0] === 'openRightbar' && c[1] === true && c[2] === false),
    'opening the Sidebar on DSH 0.1.5 must call openRightbar(true, false)')
  assert.equal(env.layoutCalls.filter((c) => c[0] === 'openDetails').length, 0, 'the legacy face must not be called on DSH 0.1.5')
  railButtons(env.findClass(env.renderTogglesStarted(), 'rsb-header-toggles'))[0].props.onClick() // close
  assert.ok(env.layoutCalls.some((c) => c[0] === 'closeRightbar'), 'closing the Sidebar on DSH 0.1.5 must call closeRightbar()')
}

// 2. New layout: the restored Sidebar opens through the Rail effect too.
{
  const storage = new Map()
  storage.set(PANEL_KEY, JSON.stringify({ sidebarOpen: true, panelOpen: false, panelHeight: 240, sidebarWidth: 480 }))
  const env = boot({ layout: 'rightbar', storage, deferredRaf: true })
  env.findClass(env.renderStarted(), 'rsb-rail')
  assert.ok(
    env.layoutCalls.some((c) => c[0] === 'openRightbar' && c[1] === true && c[2] === false),
    'the restored Sidebar must re-open the rightbar track on DSH 0.1.5')
  flushFrames(env)
  assert.equal(env.frameStyle.getPropertyValue('grid-template-columns'), '280px minmax(0px, 1fr) 480px', 'the width follow must still rewrite the trailing track on DSH 0.1.5')
}

// 3. New layout: the rightbar seat exists, resolves the session from the
//    root props, and renders the same docked body. While the Sidebar is
//    closed or the session has not started, the seat renders nothing.
{
  const storage = new Map()
  storage.set(PANEL_KEY, JSON.stringify({ sidebarOpen: true, panelOpen: false, panelHeight: 240, sidebarWidth: 360 }))
  const env = boot({ layout: 'rightbar', storage })
  assert.ok(env.rightbar, 'DSH 0.1.5 must receive a rightbar seat registration')
  const started = env.renderRightbarStarted()
  const docked = env.findClass(started, 'rsb-docked-panel')
  assert.ok(docked, 'an open Sidebar on a started session must dock into the rightbar seat')
  // The seat is root-scoped, so the session must reach SidebarPanel from the
  // root props; without it the cards would fall back to the deployment root.
  let panelNode = null
  env.visit(started, (n) => {
    if (!panelNode && typeof n.type === 'function' && n.type.name === 'SidebarPanel' && n.props.sessionId === 'session-a') panelNode = n
  })
  assert.ok(panelNode, 'the docked SidebarPanel must receive the current sessionId resolved from the root props')
  assert.equal(
    env.findClass(env.renderRightbarBlank(), 'rsb-docked-panel'),
    null,
    'a fresh session must leave the rightbar seat empty; the overlay Sidebar covers it')
  assert.equal(
    env.findClass(env.renderRightbarStarted(false), 'rsb-docked-panel'),
    null,
    'a frame that cannot show the right column must leave the rightbar seat empty')
  const opened = boot({ layout: 'rightbar' })
  assert.equal(
    env.findClass(opened.renderRightbarStarted(), 'rsb-docked-panel'),
    null,
    'a closed Sidebar must leave the rightbar seat empty')
}

// 4. New layout: the stylesheet hides the shell's [data-side="rightbar"]
//    handle while the Sidebar owns the column, and pads the center column
//    for the floating overlay behind data-rightbar-collapsed.
{
  const env = boot({ layout: 'rightbar' })
  assert.match(env.stylesheet, /\.rsb-docked-panel[^\n]*\n[^\n]*\[data-side="rightbar"\] \{ display: none; \}/, 'the stale shell rightbar handle must be hidden on DSH 0.1.5')
  assert.match(env.stylesheet, /\[data-rightbar-collapsed\]:has\(\[data-shell-overlay\] \.rsb-overlay-panel\) > div:nth-child\(2\) \{ padding-right: var\(--rsb-panel-w\)/, 'the overlay padding rule must speak the 0.1.5 collapsed marker')
}

// 5. New layout: releasing the shell's rightbar handle persists the settled
//    inline track, exactly like the Details handle before it.
{
  const env = boot({ layout: 'rightbar' })
  openSidebarStarted(env)
  assert.ok((env.frameListeners['pointerdown'] || []).length > 0, 'an open docked Sidebar must delegate pointerdown on the frame')
  env.frameStyle.setProperty('grid-template-columns', '280px minmax(0px, 1fr) 500px')
  fireFramePointerDown(env, '[data-side="rightbar"]')
  fireWindowPointerUp(env)
  flushFrames(env)
  assert.equal(storedState(env).sidebarWidth, 500, 'releasing the rightbar handle must persist the settled track on DSH 0.1.5')
}

// 6. Legacy layout: nothing changed. The toggle calls openDetails, the
//    rightbar seat is inert, and the old stylesheet forms survive.
{
  const env = boot({ layout: 'details' })
  openSidebarStarted(env)
  assert.ok(env.layoutCalls.some((c) => c[0] === 'openDetails'), 'opening the Sidebar on an older shell must still call openDetails()')
  railButtons(env.findClass(env.renderTogglesStarted(), 'rsb-header-toggles'))[0].props.onClick() // close
  assert.ok(env.layoutCalls.some((c) => c[0] === 'closeDetails'), 'closing the Sidebar on an older shell must still call closeDetails()')
  assert.ok(env.details, 'the Details slot registration must survive')
  const docked = env.findClass(env.renderDetails(), 'rsb-docked-panel')
  assert.ok(docked, 'the docked Sidebar must still render into the Details slot on older shells')
  assert.ok(
    env.layoutCalls.every((c) => c[0] === 'openDetails' || c[0] === 'closeDetails'),
    'older shells must only ever call the Details layout face')
  assert.match(env.stylesheet, /\.rsb-docked-panel[^\n]*\n[^\n]*\[data-side="details"\] \{ display: none; \}/, 'the legacy handle hide rule must survive')
  assert.match(env.stylesheet, /\[data-details-collapsed\]:has\(\[data-shell-overlay\] \.rsb-overlay-panel\) > div:nth-child\(2\) \{ padding-right: var\(--rsb-panel-w\)/, 'the legacy overlay padding rule must survive')
  // The legacy handle still arms the persisted-release capture.
  const persist = boot({ layout: 'details' })
  openSidebarStarted(persist)
  persist.frameStyle.setProperty('grid-template-columns', '280px minmax(0px, 1fr) 500px')
  fireFramePointerDown(persist, '[data-side="details"]')
  fireWindowPointerUp(persist)
  flushFrames(persist)
  assert.equal(storedState(persist).sidebarWidth, 500, 'releasing the Details handle must still persist the settled track on older shells')
}

// Twins parity is pinned by running this same suite against both
// distribution forms (see the pnpm test script), not by substring checks.

console.log('rightbar layout compatibility check passed (' + clientFile + ')')
