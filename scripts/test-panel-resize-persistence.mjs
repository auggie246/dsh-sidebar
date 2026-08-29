#!/usr/bin/env node
// Panel drag-resize and layout persistence check (ticket #4): the top-edge
// drag handle resizes the Panel with pointer capture and rAF throttling,
// the height clamps to [120px, 60% viewport], and Sidebar open/closed,
// Panel open/closed, and Panel height persist under dsh.rsidebar.panel.v1
// and survive a reload (a fresh boot over the same localStorage).
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
const PANEL_KEY = 'dsh.rsidebar.panel.v1'

// One boot = one module load = one page load. Each boot gets its own React
// hook state; a storage Map can be shared across boots to model a reload.
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

  // Shell frame stand-in (same fixture as test-bottom-panel.mjs): the frame's
  // second element child is the center conversation column the Panel tracks.
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

  const pendingFrames = []
  const cancelledFrames = []
  let nextFrame = 1
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
    context.cancelAnimationFrame = (id) => { cancelledFrames.push(id) }
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

  const startedProps = {
    sessionId: 'session-a',
    useSessions(selector) {
      return selector({ current: 'session-a', byId: { 'session-a': { blank: false } } })
    },
    useWorkspaces(selector) {
      return selector({ items: [{ path: '/workspace/a', sessionIds: ['session-a'] }] })
    },
  }
  const overlay = registrations.get('shell.overlay')

  return {
    overlay,
    renderStarted() { return renderFunction(overlay, startedProps) },
    get stylesheet() { return styleElements.map((el) => el.textContent).join('\n') },
    storage,
    cssVars,
    pendingFrames,
    cancelledFrames,
    resizeObservers,
    layoutCalls,
    findClass,
    visit,
    renderFunction,
    startedProps,
  }
}

function railButtons(rail) {
  return (rail.props.children || []).filter((child) => child && child.type === 'button')
}

// Render helpers that mirror the house pattern: the tree walk itself mounts
// BottomPanel, its measuring effect fills rect on that first pass, and the
// Panel appears on the next render + walk after the toggle.
function openPanelViaRail(env) {
  const tree = env.renderStarted()
  const rail = env.findClass(tree, 'rsb-rail')
  railButtons(rail)[1].props.onClick()
  env.findClass(env.renderStarted(), 'rsb-bottom-panel') // mount pass; null while rect fills
  return env.findClass(env.renderStarted(), 'rsb-bottom-panel')
}

function dragHandleOf(panel) {
  return panel.props.children.find((child) => child && child.props?.className === 'rsb-panel-drag')
}

function pointerEvent(clientY, currentTarget) {
  return {
    clientY,
    pointerId: 7,
    preventDefault() { this.prevented = true },
    currentTarget,
  }
}

function capturingTarget(log) {
  return {
    setPointerCapture(id) { log.push(['capture', id]) },
    releasePointerCapture(id) { log.push(['release', id]) },
  }
}

function lastHeight(env) {
  const entries = env.cssVars.filter(([k]) => k === '--rsb-panel-h')
  assert.ok(entries.length > 0, 'the Panel height must be applied through --rsb-panel-h')
  return entries[entries.length - 1][1]
}

function storedState(env) {
  const raw = env.storage.get(PANEL_KEY)
  assert.ok(raw, 'layout state must be written to localStorage')
  return JSON.parse(raw)
}

// 1. Dragging the top edge up grows the Panel, with pointer capture and a
//    persisted final height. The handle applies the height through
//    --rsb-panel-h, the same variable the reservation rule reads.
{
  const env = boot()
  const panel = openPanelViaRail(env)
  const handle = dragHandleOf(panel)
  assert.ok(handle, 'the open Panel must carry a top-edge drag handle')
  const captureLog = []
  handle.props.onPointerDown(pointerEvent(700, capturingTarget(captureLog)))
  handle.props.onPointerMove(pointerEvent(500, capturingTarget(captureLog)))
  handle.props.onPointerUp(pointerEvent(500, capturingTarget(captureLog)))
  assert.equal(lastHeight(env), '440px', 'dragging up 200px must grow the Panel from 240px to 440px')
  assert.deepEqual(captureLog, [['capture', 7], ['release', 7]], 'the drag must capture and release the pointer')
  assert.deepEqual(storedState(env), { sidebarOpen: false, panelOpen: true, panelHeight: 440 }, 'the drag end must persist the layout state')
}

// 2. The drag clamps at the 120px minimum when dragged far down.
{
  const env = boot()
  const panel = openPanelViaRail(env)
  const handle = dragHandleOf(panel)
  handle.props.onPointerDown(pointerEvent(700, capturingTarget([])))
  handle.props.onPointerMove(pointerEvent(1100, capturingTarget([])))
  handle.props.onPointerUp(pointerEvent(1100, capturingTarget([])))
  assert.equal(lastHeight(env), '120px', 'the Panel height must clamp to the 120px minimum')
  assert.equal(storedState(env).panelHeight, 120, 'the clamped height is what gets persisted')
}

// 3. The drag clamps at 60% of the viewport height when dragged far up.
{
  const env = boot({ innerHeight: 600 })
  const panel = openPanelViaRail(env)
  const handle = dragHandleOf(panel)
  handle.props.onPointerDown(pointerEvent(600, capturingTarget([])))
  handle.props.onPointerMove(pointerEvent(10, capturingTarget([])))
  handle.props.onPointerUp(pointerEvent(10, capturingTarget([])))
  assert.equal(lastHeight(env), '360px', 'the Panel height must clamp to 60% of the 600px viewport')
  assert.equal(storedState(env).panelHeight, 360, 'the clamped height is what gets persisted')
  // A viewport shorter than 200px puts the 60% cap below the 120px floor;
  // the floor wins so the Panel stays usable.
  const env2 = boot({ innerHeight: 150 })
  const panel2 = openPanelViaRail(env2)
  const handle2 = dragHandleOf(panel2)
  handle2.props.onPointerDown(pointerEvent(150, capturingTarget([])))
  handle2.props.onPointerMove(pointerEvent(1, capturingTarget([])))
  handle2.props.onPointerUp(pointerEvent(1, capturingTarget([])))
  assert.equal(lastHeight(env2), '120px', 'below a 200px viewport the 120px floor must win over the 60% cap')
}

// 4. The drag is rAF-throttled: a burst of moves schedules one frame, the
//    frame applies the newest pointer position, and releasing before the
//    frame runs cancels it and flushes the final height once.
{
  const env = boot({ deferredRaf: true })
  const panel = openPanelViaRail(env)
  const handle = dragHandleOf(panel)
  handle.props.onPointerDown(pointerEvent(700, capturingTarget()))
  handle.props.onPointerMove(pointerEvent(640, capturingTarget()))
  handle.props.onPointerMove(pointerEvent(560, capturingTarget()))
  handle.props.onPointerMove(pointerEvent(500, capturingTarget()))
  assert.equal(env.pendingFrames.length, 1, 'a burst of pointermove events must schedule exactly one frame')
  assert.equal(lastHeight(env), '240px', 'no height change may apply before the frame runs')
  env.pendingFrames[0]()
  assert.equal(lastHeight(env), '440px', 'the frame must apply the newest pointer position once')
  handle.props.onPointerUp(pointerEvent(500, capturingTarget()))
  assert.equal(env.cancelledFrames.length, 0, 'a release after the frame ran has nothing to cancel')
  assert.equal(storedState(env).panelHeight, 440, 'the release persists the layout state')
  // Releasing while a frame is still pending cancels that frame and flushes.
  const env2 = boot({ deferredRaf: true })
  const panel2 = openPanelViaRail(env2)
  const handle2 = dragHandleOf(panel2)
  handle2.props.onPointerDown(pointerEvent(700, capturingTarget()))
  handle2.props.onPointerMove(pointerEvent(500, capturingTarget()))
  handle2.props.onPointerUp(pointerEvent(500, capturingTarget()))
  assert.equal(env2.cancelledFrames.length, 1, 'the release must cancel the pending frame')
  assert.equal(lastHeight(env2), '440px', 'the release must flush the final height immediately')
}

// 5. The handle is a horizontal separator styled as a row-resize grab strip
//    overhanging the top border, and the height variable keeps its 240px
//    stylesheet default for first paint.
{
  const env = boot()
  const panel = openPanelViaRail(env)
  const handle = dragHandleOf(panel)
  assert.equal(handle.props.role, 'separator', 'the drag handle is a separator')
  assert.equal(handle.props['aria-orientation'], 'horizontal', 'the separator is horizontal')
  assert.match(env.stylesheet, /\.rsb-panel-drag \{[^}]*cursor: row-resize/, 'the drag handle must carry the row-resize cursor')
  assert.match(env.stylesheet, /\.rsb-panel-drag \{[^}]*touch-action: none/, 'the drag handle must suppress touch scrolling')
  assert.match(env.stylesheet, /:root \{[^}]*--rsb-panel-h: 240px/, 'the stylesheet default height must stay 240px')
}

// 6. Reload restores Sidebar open/closed, Panel open/closed, and Panel
//    height from dsh.rsidebar.panel.v1 (fresh boot over the same storage).
{
  const storage = new Map()
  const env = boot({ storage })
  const tree = env.renderStarted()
  const rail = env.findClass(tree, 'rsb-rail')
  const buttons = railButtons(rail)
  buttons[0].props.onClick() // open the Sidebar
  buttons[1].props.onClick() // open the Panel
  assert.deepEqual(storedState(env), { sidebarOpen: true, panelOpen: true, panelHeight: 240 }, 'both toggles must persist')
  env.findClass(env.renderStarted(), 'rsb-bottom-panel') // mount pass; null while rect fills
  const panel = env.findClass(env.renderStarted(), 'rsb-bottom-panel')
  const captureLog = []
  dragHandleOf(panel).props.onPointerDown(pointerEvent(700, capturingTarget(captureLog)))
  dragHandleOf(panel).props.onPointerMove(pointerEvent(500, capturingTarget(captureLog)))
  dragHandleOf(panel).props.onPointerUp(pointerEvent(500, capturingTarget(captureLog)))

  const reloaded = boot({ storage })
  const tree2 = reloaded.renderStarted()
  const rail2 = reloaded.findClass(tree2, 'rsb-rail')
  const buttons2 = railButtons(rail2)
  assert.equal(buttons2[0].props.title, 'Collapse workspace sidebar', 'the Sidebar must come back open after a reload')
  assert.equal(buttons2[1].props['aria-pressed'], 'true', 'the Panel must come back open after a reload')
  assert.equal(buttons2[1].props.title, 'Close panel')
  assert.ok(reloaded.layoutCalls.includes('open'), 'the restored Sidebar must re-open the Details Column for a started session')
  const panel2 = reloaded.findClass(reloaded.renderStarted(), 'rsb-bottom-panel')
  assert.ok(panel2, 'the Panel must be mounted right after the reload')
  assert.equal(lastHeight(reloaded), '440px', 'the saved Panel height must be restored')
}

// 7. A height saved on a taller window is re-clamped to the current
//    viewport on restore.
{
  const storage = new Map()
  storage.set(PANEL_KEY, JSON.stringify({ sidebarOpen: false, panelOpen: true, panelHeight: 800 }))
  const env = boot({ storage, innerHeight: 900 })
  assert.equal(lastHeight(env), '540px', 'an oversized saved height must clamp to 60% of the current viewport')
  env.findClass(env.renderStarted(), 'rsb-bottom-panel') // mount pass; null while rect fills
  assert.ok(env.findClass(env.renderStarted(), 'rsb-bottom-panel'), 'the Panel still restores while clamping the height')
}

// 8. Corrupt or mistyped state falls back to the defaults instead of
//    crashing or restoring garbage.
{
  for (const raw of ['{not json', JSON.stringify({ sidebarOpen: 'yes', panelOpen: 1, panelHeight: '240px' }), JSON.stringify([1, 2]), 'null']) {
    const storage = new Map()
    storage.set(PANEL_KEY, raw)
    const env = boot({ storage })
    const tree = env.renderStarted()
    const buttons = railButtons(env.findClass(tree, 'rsb-rail'))
    assert.equal(buttons[0].props.title, 'Open workspace sidebar', `a malformed payload (${raw}) must not restore an open Sidebar`)
    assert.equal(buttons[1].props['aria-pressed'], 'false', `a malformed payload (${raw}) must not restore an open Panel`)
    assert.equal(env.findClass(env.renderStarted(), 'rsb-bottom-panel'), null, `a malformed payload (${raw}) must not mount the Panel`)
    assert.equal(lastHeight(env), '240px', `a malformed payload (${raw}) must fall back to the 240px default`)
  }
  const emptyEnv = boot()
  assert.equal(emptyEnv.storage.get(PANEL_KEY), undefined, 'a fresh page must not write layout state until something changes')
  assert.equal(lastHeight(emptyEnv), '240px', 'the default height must still be applied at startup')
}

console.log('Panel resize and persistence check passed')
