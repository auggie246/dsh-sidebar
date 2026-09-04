#!/usr/bin/env node
// Global Sidebar width check (issue #15): the Sidebar width joins Panel
// height in the dsh.rsidebar.panel.v1 blob. In overlay mode a left-edge
// drag handle rewrites --rsb-panel-w and persists the width on release;
// in docked mode a plugin-owned left-edge handle keeps the visible resize
// line on the restored edge and persists its settled inline track. A session
// switch re-applies the remembered width across a bounded frame window, so
// the shell's close/reopen commits and its 360px default can never win.
// Malformed values fall back to
// the 360px default.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
const PANEL_KEY = 'dsh.rsidebar.panel.v1'

// One boot = one page load. The frame fixture mirrors the shell structure
// the plugin walks: overlayLayer's parent is the frame, whose children are
// [sidebarCol, centerCol, detailsCol, ...]; the details column hosts the
// docked Sidebar and carries the inline grid tracks the shell writes.
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
  const detailsCol = env.detailsCol || {
    children: [{}],
    _width: 360,
    getBoundingClientRect() { return { width: this._width } },
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
    children: [{}, centerCol, detailsCol],
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
  }
  if (env.deferredRaf) {
    context.requestAnimationFrame = (fn) => { pendingFrames.push(fn); return nextFrame++ }
  }
  context.setTimeout = (fn) => { pendingTimers.push(fn); return fn }
  context.clearTimeout = (id) => {
    const idx = pendingTimers.indexOf(id)
    if (idx !== -1) pendingTimers.splice(idx, 1)
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

  function sessionProps(sessionId, blank) {
    return {
      sessionId,
      useSessions(selector) {
        return selector({ current: sessionId, byId: { [sessionId]: { blank: blank === true } } })
      },
      useWorkspaces(selector) {
        return selector({ items: [{ path: '/workspace/a', sessionIds: [sessionId] }] })
      },
    }
  }

  const overlay = registrations.get('shell.overlay')
  const details = registrations.get('details')
  return {
    overlay,
    details,
    frameListeners,
    windowListeners,
    renderStarted() { return renderFunction(overlay, sessionProps('session-a', false)) },
    renderBlank() { return renderFunction(overlay, sessionProps('session-blank', true)) },
    renderDetails() { return renderFunction(details, sessionProps('session-a', false)) },
    get stylesheet() { return styleElements.map((el) => el.textContent).join('\n') },
    storage,
    cssVars,
    pendingFrames,
    pendingTimers,
    resizeObservers,
    layoutCalls,
    frameStyle,
    detailsCol,
    findClass,
    renderFunction,
  }
}

function railButtons(rail) {
  return (rail.props.children || []).filter((child) => child && child.type === 'button')
}

// Drain every frame the follow window scheduled; each frame re-checks the
// track and stops scheduling after its budget.
function flushFrames(env) {
  while (env.pendingFrames.length) env.pendingFrames.shift()()
}

// Simulate the pointer pair the shell's Details handle produces. The
// pointerdown target's closest() decides whether the capture arms; the
// pointerup fires on the window like a captured release does.
function fireFramePointerDown(env, hitDetails) {
  for (const fn of (env.frameListeners['pointerdown'] || [])) {
    fn({ target: { closest: (sel) => (hitDetails && sel === '[data-side="details"]') ? {} : null } })
  }
}

function fireWindowPointerUp(env) {
  for (const fn of (env.windowListeners['pointerup'] || [])) fn({})
}

function pointerEvent(clientX, currentTarget) {
  return {
    clientX,
    pointerId: 7,
    preventDefault() {},
    currentTarget,
  }
}

function capturingTarget(log) {
  return {
    setPointerCapture(id) { log.push(['capture', id]) },
    releasePointerCapture(id) { log.push(['release', id]) },
  }
}

function lastWidth(env) {
  const entries = env.cssVars.filter(([k]) => k === '--rsb-panel-w')
  assert.ok(entries.length > 0, 'the Sidebar width must be applied through --rsb-panel-w')
  return entries[entries.length - 1][1]
}

function storedState(env) {
  const raw = env.storage.get(PANEL_KEY)
  return raw ? JSON.parse(raw) : undefined
}

// 1. Overlay mode: the floating Sidebar carries a left-edge drag handle.
//    Dragging the left edge leftwards grows the Sidebar from 360px to 480px,
//    applies it through --rsb-panel-w (the variable the reservation rule
//    reads), captures the pointer, and persists on release.
{
  const env = boot()
  let tree = env.renderBlank()
  railButtons(env.findClass(tree, 'rsb-rail'))[0].props.onClick() // open the Sidebar
  const aside = env.findClass(env.renderBlank(), 'rsb-overlay-panel')
  assert.ok(aside, 'an open Sidebar on a fresh session must render the floating overlay')
  const handle = env.findClass(aside, 'rsb-sidebar-drag')
  assert.ok(handle, 'the overlay Sidebar must contain the drag handle')
  assert.equal(handle.props.role, 'separator', 'the drag handle is a separator')
  assert.equal(handle.props['aria-orientation'], 'vertical', 'the separator is vertical')
  const captureLog = []
  handle.props.onPointerDown(pointerEvent(400, capturingTarget(captureLog)))
  handle.props.onPointerMove(pointerEvent(340, capturingTarget(captureLog)))
  handle.props.onPointerMove(pointerEvent(280, capturingTarget(captureLog)))
  handle.props.onPointerUp(pointerEvent(280, capturingTarget(captureLog)))
  assert.equal(lastWidth(env), 'min(480px, calc(100vw - 22px))', 'dragging left 120px must grow the Sidebar from 360px to 480px')
  assert.deepEqual(captureLog, [['capture', 7], ['release', 7]], 'the drag must capture and release the pointer')
  assert.equal(storedState(env).sidebarWidth, 480, 'the drag end must persist the sidebar width')
}

// 2. The drag clamps to the shell's Details Column contract: 520px at most,
//    300px at least.
{
  const env = boot()
  railButtons(env.findClass(env.renderBlank(), 'rsb-rail'))[0].props.onClick()
  const handle = env.findClass(env.findClass(env.renderBlank(), 'rsb-overlay-panel'), 'rsb-sidebar-drag')
  handle.props.onPointerDown(pointerEvent(400, capturingTarget([])))
  handle.props.onPointerMove(pointerEvent(-500, capturingTarget([])))
  handle.props.onPointerUp(pointerEvent(-500, capturingTarget([])))
  assert.equal(lastWidth(env), 'min(520px, calc(100vw - 22px))', 'the Sidebar width must clamp to the 520px maximum')
  assert.equal(storedState(env).sidebarWidth, 520, 'the clamped width is what gets persisted')
  const env2 = boot()
  railButtons(env2.findClass(env2.renderBlank(), 'rsb-rail'))[0].props.onClick()
  const handle2 = env2.findClass(env2.findClass(env2.renderBlank(), 'rsb-overlay-panel'), 'rsb-sidebar-drag')
  handle2.props.onPointerDown(pointerEvent(400, capturingTarget([])))
  handle2.props.onPointerMove(pointerEvent(2000, capturingTarget([])))
  handle2.props.onPointerUp(pointerEvent(2000, capturingTarget([])))
  assert.equal(lastWidth(env2), 'min(300px, calc(100vw - 22px))', 'the Sidebar width must clamp to the 300px minimum')
  assert.equal(storedState(env2).sidebarWidth, 300, 'the clamped width is what gets persisted')
}

// 3. Reload restores the width (fresh boot over the same storage), and a
//    fresh page still writes nothing until something changes.
{
  const storage = new Map()
  storage.set(PANEL_KEY, JSON.stringify({ sidebarOpen: true, panelOpen: false, panelHeight: 240, sidebarWidth: 480 }))
  const env = boot({ storage })
  assert.equal(lastWidth(env), 'min(480px, calc(100vw - 22px))', 'the saved Sidebar width must be restored at boot')
  assert.equal(storedState(env).sidebarWidth, 480)
  const fresh = boot()
  assert.equal(fresh.storage.get(PANEL_KEY), undefined, 'a fresh page must not write layout state until something changes')
  assert.equal(lastWidth(fresh), 'min(360px, calc(100vw - 22px))', 'the default width must still be applied at startup')
}

// 4. Docked mode: on a session switch the shell reopens the Details Column
//    at its 360px default; the plugin re-applies the remembered width after
//    the shell's reopen render commits, re-checking across a bounded frame
//    window but writing only once.
{
  const storage = new Map()
  storage.set(PANEL_KEY, JSON.stringify({ sidebarOpen: true, panelOpen: false, panelHeight: 240, sidebarWidth: 480 }))
  // React's authored form (minmax(0, 1fr)) — the browser normalizes the
  // zero to 0px, so both serializations must parse and restore.
  const env = boot({ storage, deferredRaf: true, frameStyle: { vars: new Map([['grid-template-columns', '280px minmax(0, 1fr) 360px']]), getPropertyValue(k) { return this.vars.get(k) || '' }, setProperty(k, v) { this.setPropertyCalls.push([k, v]); this.vars.set(k, v) }, setPropertyCalls: [] } })
  env.findClass(env.renderStarted(), 'rsb-rail')
  assert.ok(env.layoutCalls.includes('open'), 'the restored Sidebar must re-open the Details Column')
  assert.deepEqual(env.frameStyle.setPropertyCalls || [], [], 'no width write may land before the shell commits')
  flushFrames(env)
  const tracks = env.frameStyle.getPropertyValue('grid-template-columns')
  assert.equal(tracks, '280px minmax(0, 1fr) 480px', 'the session switch must restore the remembered 480px width, preserving the authored minmax form')
  const docked = env.findClass(env.renderDetails(), 'rsb-docked-panel')
  assert.ok(docked, 'the docked Sidebar must own its resize surface')
  const dockedHandle = env.findClass(docked, 'rsb-sidebar-drag')
  assert.ok(dockedHandle, 'the docked resize line must sit on the Sidebar edge')
  assert.match(env.stylesheet, /\.rsb-docked-panel > \.rsb-sidebar-drag \{ left: 0; \}/, 'the docked resize line must remain inside the clipped Details Column edge')
  assert.match(env.stylesheet, /\.rsb-docked-panel[^\n]*\n[^\n]*\[data-side="details"\] \{ display: none; \}/, 'the stale shell Details handle must be hidden')
  assert.equal(env.frameStyle.setPropertyCalls.length, 1, 'the follow window must rewrite the track exactly once')
  dockedHandle.props.onPointerDown(pointerEvent(720, capturingTarget([])))
  dockedHandle.props.onPointerMove(pointerEvent(700, capturingTarget([])))
  dockedHandle.props.onPointerUp(pointerEvent(700, capturingTarget([])))
  assert.equal(env.frameStyle.getPropertyValue('grid-template-columns'), '280px minmax(0, 1fr) 500px', 'the docked handle must resize the real Details track')
  assert.equal(storedState(env).sidebarWidth, 500, 'the docked handle must persist its settled width')
}

// 5. The docked follow never rewrites a track that already matches, never
//    touches a closed column, and stays off while the Sidebar is closed.
{
  const storage = new Map()
  storage.set(PANEL_KEY, JSON.stringify({ sidebarOpen: true, panelOpen: false, panelHeight: 240, sidebarWidth: 360 }))
  const env = boot({ storage, deferredRaf: true })
  env.findClass(env.renderStarted(), 'rsb-rail')
  flushFrames(env)
  assert.equal(env.frameStyle.getPropertyValue('grid-template-columns'), '280px minmax(0px, 1fr) 360px', 'a matching track is left untouched')
  assert.equal(env.frameStyle.setPropertyCalls.length, 0, 'a matching track must never be rewritten')
  // A closed column (0px track, fresh session) must not be resized.
  const env2 = boot({ storage: new Map([[PANEL_KEY, JSON.stringify({ sidebarOpen: true, panelOpen: false, panelHeight: 240, sidebarWidth: 480 })]]), deferredRaf: true, detailsCol: { children: [{}], _width: 0, getBoundingClientRect() { return { width: this._width } } }, frameStyle: { vars: new Map([['grid-template-columns', '280px minmax(0px, 1fr) 0px']]), getPropertyValue(k) { return this.vars.get(k) || '' }, setProperty() { throw new Error('must not write a closed column') } } })
  env2.findClass(env2.renderStarted(), 'rsb-rail')
  flushFrames(env2)
}

// 6. Docked mode: releasing the shell's Details handle persists the settled
//    inline track. A press anywhere else arms nothing, and the width is
//    read from the track the shell's final setDetails commit wrote.
{
  const env = boot() // no deferred raf: the pointerup persist runs inline
  railButtons(env.findClass(env.renderStarted(), 'rsb-rail'))[0].props.onClick() // open on a started session
  env.findClass(env.renderStarted(), 'rsb-rail') // re-render with the open state; the capture attaches
  assert.ok((env.frameListeners['pointerdown'] || []).length > 0, 'an open docked Sidebar must delegate pointerdown on the frame')
  assert.ok((env.windowListeners['pointerup'] || []).length > 0, 'the release must be observed on the window')
  // The shell's final setDetails commit writes the settled track.
  env.frameStyle.setProperty('grid-template-columns', '280px minmax(0px, 1fr) 500px')
  fireWindowPointerUp(env) // nothing armed
  assert.equal(storedState(env).sidebarWidth, 360, 'a release with nothing armed must not persist')
  fireFramePointerDown(env, false) // the sidebar-side handle
  fireWindowPointerUp(env)
  assert.equal(storedState(env).sidebarWidth, 360, 'a release off the details handle must not persist')
  fireFramePointerDown(env, true) // the details handle
  fireWindowPointerUp(env)
  assert.equal(storedState(env).sidebarWidth, 500, 'releasing the details handle must persist the settled track')
}

// 6b. The stale-match regression: the pre-switch track can read exactly the
//     remembered width while the shell's close and reopen commits are still
//     pending. The follow window must keep re-checking and land the width
//     after the reopen commit writes its 360px default.
{
  const storage = new Map()
  storage.set(PANEL_KEY, JSON.stringify({ sidebarOpen: true, panelOpen: false, panelHeight: 240, sidebarWidth: 480 }))
  const env = boot({
    storage,
    deferredRaf: true,
    frameStyle: {
      vars: new Map([['grid-template-columns', '280px minmax(0px, 1fr) 480px']]),
      getPropertyValue(k) { return this.vars.get(k) || '' },
      setProperty(k, v) { this.calls.push([k, v]); this.vars.set(k, v) },
      calls: [],
    },
  })
  env.findClass(env.renderStarted(), 'rsb-rail')
  env.pendingFrames.shift()() // frame 1: stale track reads 480; must not stop the window
  assert.equal(env.frameStyle.calls.length, 0, 'the stale matching track must not be rewritten')
  env.frameStyle.setProperty('grid-template-columns', '280px minmax(0px, 1fr) 0px') // close commit
  env.pendingFrames.shift()() // frame 2: closed column, skipped
  env.frameStyle.setProperty('grid-template-columns', '280px minmax(0px, 1fr) 360px') // reopen commit
  const pluginWritesBefore = env.frameStyle.calls.length // the stub also logs the simulated commits above
  flushFrames(env)
  assert.equal(env.frameStyle.getPropertyValue('grid-template-columns'), '280px minmax(0px, 1fr) 480px', 'the follow must land the remembered width after the reopen commit')
  assert.equal(env.frameStyle.calls.length, pluginWritesBefore + 1, 'the reopen default must be rewritten exactly once')
}

// 7. Malformed sidebarWidth values fall back to the 360px default.
{
  for (const raw of [
    JSON.stringify({ sidebarOpen: false, panelOpen: false, panelHeight: 240, sidebarWidth: '480px' }),
    JSON.stringify({ sidebarOpen: false, panelOpen: false, panelHeight: 240, sidebarWidth: null }),
    JSON.stringify({ sidebarOpen: false, panelOpen: false, panelHeight: 240 }),
    '{not json',
    'null',
  ]) {
    const storage = new Map()
    storage.set(PANEL_KEY, raw)
    const env = boot({ storage })
    assert.equal(lastWidth(env), 'min(360px, calc(100vw - 22px))', `a malformed width (${raw}) must fall back to the 360px default`)
    assert.equal(env.storage.get(PANEL_KEY), raw, `a malformed width (${raw}) must not be rewritten until something changes`)
  }
}

// 8. The handle is styled as a vertical ew-resize grab strip overhanging the
//    left border, and the width variable keeps its stylesheet default for
//    first paint.
{
  const env = boot()
  assert.match(env.stylesheet, /\.rsb-sidebar-drag \{[^}]*cursor: ew-resize/, 'the drag handle must carry the ew-resize cursor')
  assert.match(env.stylesheet, /\.rsb-sidebar-drag \{[^}]*touch-action: none/, 'the drag handle must suppress touch scrolling')
  assert.match(env.stylesheet, /:root \{[^}]*--rsb-panel-w: min\(360px, calc\(100vw - 22px\)\)/, 'the stylesheet default width must stay 360px')
}

const dynamicClient = await readFile(new URL('../dynamic/client.js', import.meta.url), 'utf8')
assert.ok(dynamicClient.includes("className: props && props.docked ? 'rsb-panel rsb-docked-panel' : 'rsb-panel'"), 'dynamic/client.js must carry the docked resize surface')
assert.ok(dynamicClient.includes('[data-side="details"] { display: none; }'), 'dynamic/client.js must hide the stale shell Details handle')

console.log('global Sidebar width check passed')
