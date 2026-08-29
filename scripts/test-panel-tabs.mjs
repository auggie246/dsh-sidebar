#!/usr/bin/env node
// Working Panel Tab strip check (ticket #6): the + affordance opens a type
// picker whose first working type is Localhost URL; creating one renders a
// closable Panel Tab showing the URL in a script-allowed iframe; duplicate
// URLs re-focus the existing tab; closing the last tab leaves the Panel open
// but empty; the open tab list and the active tab persist per session under
// dsh.rsidebar.panels.v1.<sessionId>.
//
// Seam (agreed): the rendered tree of the shell.overlay registration and the
// injected localStorage, exactly like test-panel-tabstrip.mjs.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
const PANEL_KEY = 'dsh.rsidebar.panel.v1'
const TABS_KEY_BASE = 'dsh.rsidebar.panels.v1.'

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

  // Shell frame stand-in (same fixture as test-panel-tabstrip.mjs).
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

  function findAll(node, className, out = []) {
    visit(node, (n) => {
      if (n.props?.className?.split(' ').includes(className)) out.push(n)
    })
    return out
  }

  function findClass(node, className) {
    return findAll(node, className)[0] || null
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

  function buttonWithText(node, text) {
    let found = null
    visit(node, (n) => {
      if (found || n.type !== 'button') return
      const strings = []
      collectStrings(n, strings)
      if (strings.join(' ').includes(text)) found = n
    })
    return found
  }

  const overlay = registrations.get('shell.overlay')
  return {
    overlay,
    render(props) { return renderFunction(overlay, props) },
    stylesheet: styleElements.map((el) => el.textContent).join('\n'),
    storage,
    layoutCalls,
    findClass,
    findAll,
    visit,
    collectStrings,
    buttonWithText,
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

// Renders the started session, opens the Panel from the Rail unless the Rail
// button already reports it open (a Panel restored from storage), and returns
// the mounted Panel node. Each render pass must be traversed (findClass) for
// the harness to run the measured-rect effect, so the "mount pass" render is
// traversed too.
function openPanel(env) {
  const tree = env.render(startedProps)
  const buttons = railButtons(env.findClass(tree, 'rsb-rail'))
  if (buttons[1].props['aria-pressed'] !== 'true') buttons[1].props.onClick()
  env.findClass(env.render(startedProps), 'rsb-bottom-panel') // mount pass; null while rect fills
  return env.findClass(env.render(startedProps), 'rsb-bottom-panel')
}

// 1. The + affordance is live: clicking it opens the type picker, which lists
//    Localhost URL as its first working type; clicking + again closes it.
{
  const env = boot()
  const panel = openPanel(env)
  assert.ok(panel, 'the open Panel must render')

  const strip = env.findClass(panel, 'rsb-tabstrip')
  assert.ok(strip, 'the open Panel must render a tab strip header row')
  const add = env.findClass(strip, 'rsb-tabstrip-add')
  assert.ok(add, 'the strip must hold the + affordance')
  assert.equal(add.props.disabled, undefined, 'the + affordance must be live now that a tab type exists')
  assert.equal(add.props.title, 'New panel tab')
  assert.equal(add.props['aria-label'], 'New panel tab')
  assert.equal(add.props['aria-expanded'], 'false', 'the closed picker must advertise collapsed state')
  assert.equal(typeof add.props.onClick, 'function', 'the + affordance must open the picker')

  add.props.onClick()
  let next = env.render(startedProps)
  assert.equal(env.findClass(next, 'rsb-bottom-panel') && env.findClass(next, 'rsb-tabstrip-add').props['aria-expanded'], 'true')
  let picker = env.findClass(next, 'rsb-tab-picker')
  assert.ok(picker, 'clicking + must open the type picker')
  const strings = []
  env.collectStrings(picker, strings)
  assert.ok(strings.some((t) => t.includes('Localhost URL')), 'the picker must list the Localhost URL type')

  add.props.onClick()
  next = env.render(startedProps)
  picker = env.findClass(next, 'rsb-tab-picker')
  assert.equal(picker, null, 'clicking + again must close the type picker')

  assert.match(env.stylesheet, /\.rsb-tab-picker \{[^}]*position: absolute/, 'the picker must float over the Panel content')
}

// Drives the + → Localhost URL → URL form flow for one URL entry. Every step
// re-renders and re-finds its node, the way React re-renders on each state
// change. Assumes the picker starts closed.
function openUrl(env, raw) {
  let panel = env.findClass(env.render(startedProps), 'rsb-bottom-panel')
  env.findClass(panel, 'rsb-tabstrip-add').props.onClick()
  panel = env.findClass(env.render(startedProps), 'rsb-bottom-panel')
  env.buttonWithText(panel, 'Localhost URL').props.onClick()
  panel = env.findClass(env.render(startedProps), 'rsb-bottom-panel')
  const input = env.findClass(env.findClass(panel, 'rsb-tab-picker-form'), 'rsb-tab-picker-input')
  input.props.onChange({ target: { value: raw } })
  panel = env.findClass(env.render(startedProps), 'rsb-bottom-panel')
  env.findClass(panel, 'rsb-tab-picker-form').props.onSubmit({ preventDefault() {} })
  return env.findClass(env.render(startedProps), 'rsb-bottom-panel')
}

function activeTabs(env, panel) {
  return env.findAll(panel, 'rsb-tab').filter((t) => t.props.className.split(' ').includes('rsb-tab-active'))
}

// 2. Choosing Localhost URL opens a URL form that carries the iframe-refusal
//    warning; submitting it creates one tab with a close X whose URL renders
//    in a script-allowed iframe. A scheme-less entry gains http://.
{
  const env = boot()
  let panel = openPanel(env)
  const add = env.findClass(panel, 'rsb-tabstrip-add')
  add.props.onClick()
  panel = env.findClass(env.render(startedProps), 'rsb-bottom-panel')
  const item = env.buttonWithText(panel, 'Localhost URL')
  assert.ok(item, 'the picker must offer the Localhost URL type as a button')
  item.props.onClick()

  panel = env.findClass(env.render(startedProps), 'rsb-bottom-panel')
  const form = env.findClass(panel, 'rsb-tab-picker-form')
  assert.ok(form, 'choosing Localhost URL must open the URL form')
  const input = env.findClass(form, 'rsb-tab-picker-input')
  assert.ok(input, 'the URL form must hold a URL input')
  const formStrings = []
  env.collectStrings(form, formStrings)
  assert.ok(formStrings.some((t) => t.includes('iframe')), 'the form must warn that sites can refuse iframes')
  assert.ok(formStrings.some((t) => t.includes('blank') || t.includes('refuse')), 'the warning must say what refusal looks like')

  input.props.onChange({ target: { value: 'localhost:5173' } })
  // The onChange re-render produces the fresh form whose submit handler sees
  // the new draft — re-render and re-find before submitting.
  panel = env.findClass(env.render(startedProps), 'rsb-bottom-panel')
  env.findClass(env.render(startedProps), 'rsb-tab-picker-form').props.onSubmit({ preventDefault() {} })
  panel = env.findClass(env.render(startedProps), 'rsb-bottom-panel')

  const tabs = env.findAll(panel, 'rsb-tab')
  assert.equal(tabs.length, 1, 'submitting the form must create exactly one Panel Tab')
  const tabStrings = []
  env.collectStrings(tabs[0], tabStrings)
  assert.ok(tabStrings.some((t) => t.includes('http://localhost:5173')), 'the tab must show the normalized URL')

  const close = env.findClass(tabs[0], 'rsb-tab-close')
  assert.ok(close, 'every Panel Tab must carry its own close control')
  assert.equal(close.props.title, 'Close tab')
  assert.equal(close.props['aria-label'], 'Close tab')

  const frame = env.findClass(panel, 'rsb-tabframe')
  assert.ok(frame, 'the active tab must render its URL in an iframe')
  assert.equal(frame.type, 'iframe')
  assert.equal(frame.props.src, 'http://localhost:5173', 'the iframe must target the normalized URL')
  const sandbox = String(frame.props.sandbox)
  assert.ok(sandbox.includes('allow-scripts'), 'the iframe must allow scripts')
  assert.ok(!sandbox.includes('allow-same-origin'), 'the iframe must not grant same-origin access to the parent page')

  const hint = env.findClass(panel, 'rsb-tabframe-hint')
  assert.ok(hint, 'a rendered tab must keep the refusal warning visible')
  const hintStrings = []
  env.collectStrings(hint, hintStrings)
  assert.ok(hintStrings.some((t) => t.includes('refuse') && t.includes('iframe')), 'the hint must explain refusal and blank previews')

  assert.equal(env.findClass(panel, 'rsb-tab-picker'), null, 'a successful open must close the picker')
  assert.equal(env.findClass(panel, 'rsb-panel-empty'), null, 'a tabbed Panel must not show the empty state')
}

// 3. Duplicate URLs dedupe by identity: opening an existing tab's URL again
//    re-focuses that tab instead of spawning a duplicate. A scheme-less or
//    trailing-slash variant of the same URL counts as the same identity.
{
  const env = boot()
  let panel = openPanel(env)
  panel = openUrl(env, 'http://localhost:5173')
  panel = openUrl(env, 'http://localhost:5174')
  let tabs = env.findAll(panel, 'rsb-tab')
  assert.equal(tabs.length, 2, 'two distinct URLs must create two tabs')

  panel = openUrl(env, 'localhost:5173')
  tabs = env.findAll(panel, 'rsb-tab')
  assert.equal(tabs.length, 2, 're-opening an existing URL must not spawn a duplicate')
  const active = activeTabs(env, panel)
  assert.equal(active.length, 1, 'exactly one tab must be active')
  const activeStrings = []
  env.collectStrings(active[0], activeStrings)
  assert.ok(activeStrings.some((t) => t.includes('http://localhost:5173')), 'the re-opened URL must re-focus the existing tab')
  const frame = env.findClass(panel, 'rsb-tabframe')
  assert.equal(frame.props.src, 'http://localhost:5173', 'the iframe must follow the re-focused tab')

  panel = openUrl(env, 'http://localhost:5174/')
  tabs = env.findAll(panel, 'rsb-tab')
  assert.equal(tabs.length, 2, 'a trailing slash must not change a URL identity')
  const refocused = activeTabs(env, panel)
  const refocusedStrings = []
  env.collectStrings(refocused[0], refocusedStrings)
  assert.ok(refocusedStrings.some((t) => t.includes('http://localhost:5174')), 'the trailing-slash variant must re-focus the existing tab')

  panel = openUrl(env, 'HTTP://LocalHost:5173')
  tabs = env.findAll(panel, 'rsb-tab')
  assert.equal(tabs.length, 2, 'a case variation must not change a URL identity')
  const cased = activeTabs(env, panel)
  const casedStrings = []
  env.collectStrings(cased[0], casedStrings)
  assert.ok(casedStrings.some((t) => t.includes('http://localhost:5173')), 'the case variant must re-focus the existing tab')
}

// 4. Closing tabs: the X removes only its own tab; closing the active tab
//    activates a neighbor; closing the last tab leaves the Panel open but
//    empty. The X must not also act as a focus click.
{
  const env = boot()
  let panel = openPanel(env)
  panel = openUrl(env, 'http://localhost:5173')
  panel = openUrl(env, 'http://localhost:5174')
  panel = openUrl(env, 'http://localhost:5175')
  let tabs = env.findAll(panel, 'rsb-tab')
  assert.equal(tabs.length, 3, 'three distinct URLs must create three tabs')

  let stopped = false
  env.findClass(tabs[1], 'rsb-tab-close').props.onClick({ stopPropagation() { stopped = true } })
  panel = env.findClass(env.render(startedProps), 'rsb-bottom-panel')
  assert.ok(stopped, 'the X must stop propagation so closing is not also focusing')
  tabs = env.findAll(panel, 'rsb-tab')
  assert.equal(tabs.length, 2, 'the X must remove only its own tab')
  const stripStrings = []
  env.collectStrings(panel, stripStrings)
  assert.ok(!stripStrings.some((t) => t.includes('5174')), 'the closed tab must be gone from the strip')
  assert.equal(env.findClass(panel, 'rsb-tabframe').props.src, 'http://localhost:5175', 'closing a background tab must not change the active tab')

  const active = activeTabs(env, panel)[0]
  env.findClass(active, 'rsb-tab-close').props.onClick({ stopPropagation() {} })
  panel = env.findClass(env.render(startedProps), 'rsb-bottom-panel')
  assert.equal(env.findClass(panel, 'rsb-tabframe').props.src, 'http://localhost:5173', 'closing the active tab must activate a neighbor')

  const last = activeTabs(env, panel)[0]
  env.findClass(last, 'rsb-tab-close').props.onClick({ stopPropagation() {} })
  panel = env.findClass(env.render(startedProps), 'rsb-bottom-panel')
  assert.ok(panel, 'closing the last tab must leave the Panel open')
  assert.equal(env.findAll(panel, 'rsb-tab').length, 0, 'the strip must be empty')
  assert.equal(env.findClass(panel, 'rsb-tabframe'), null, 'no iframe may render without a tab')
  assert.ok(env.findClass(panel, 'rsb-panel-empty'), 'the empty state must return')
  const emptyStrings = []
  env.collectStrings(env.findClass(panel, 'rsb-panel-empty'), emptyStrings)
  assert.ok(emptyStrings.some((t) => t.includes('No tabs open.')), 'the empty state must say no tabs are open')
}

// 5. Persistence: the tab list and the active tab live under
//    dsh.rsidebar.panels.v1.<sessionId> and survive a reload — a fresh boot
//    over the same storage restores both.
{
  const env = boot()
  let panel = openPanel(env)
  panel = openUrl(env, 'http://localhost:5173')
  panel = openUrl(env, 'http://localhost:5174')
  const key = TABS_KEY_BASE + 'session-a'
  assert.ok(env.storage.has(key), 'the tab state must persist under dsh.rsidebar.panels.v1.<sessionId>')
  const saved = JSON.parse(env.storage.get(key))
  assert.equal(saved.tabs.length, 2, 'both tabs must be stored')
  assert.equal(saved.tabs[0].type, 'localhost-url', 'each stored tab must carry its type')
  assert.equal(saved.tabs[0].url, 'http://localhost:5173', 'each stored tab must carry its URL')
  assert.equal(saved.active, saved.tabs[1].id, 'the active tab must be stored')

  const env2 = boot({ storage: env.storage })
  const panel2 = openPanel(env2)
  const tabs2 = env2.findAll(panel2, 'rsb-tab')
  assert.equal(tabs2.length, 2, 'the open tab list must survive a reload')
  assert.equal(env2.findClass(panel2, 'rsb-tabframe').props.src, 'http://localhost:5174', 'the active tab must survive a reload')
}

// 6. Corrupt or foreign stored state falls back to the empty Panel instead of
//    throwing, and tabs this build cannot render never come back from
//    storage.
{
  const corrupt = new Map()
  corrupt.set(TABS_KEY_BASE + 'session-a', '{"tabs":"nope","active":')
  const env = boot({ storage: corrupt })
  const panel = openPanel(env)
  assert.ok(env.findClass(panel, 'rsb-panel-empty'), 'corrupt stored state must fall back to the empty Panel')

  const foreign = new Map()
  foreign.set(TABS_KEY_BASE + 'session-a', JSON.stringify({
    tabs: [
      { id: 'x', type: 'terminal', url: 'not-a-url' },
      { id: 'y', type: 'localhost-url', url: 'http://localhost:9' },
      { id: 'z', type: 'localhost-url', url: '' },
    ],
    active: 'x',
  }))
  const env2 = boot({ storage: foreign })
  const panel2 = openPanel(env2)
  const tabs = env2.findAll(panel2, 'rsb-tab')
  assert.equal(tabs.length, 1, 'unrenderable stored tabs must be dropped')
  assert.equal(env2.findClass(panel2, 'rsb-tabframe').props.src, 'http://localhost:9', 'the first surviving tab becomes active')
}

console.log('Panel tabs check passed')
