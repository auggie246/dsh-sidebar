#!/usr/bin/env node
// Terminal Panel Tab check (ticket #8 + ticket #9, ADR 0002): the + picker
// offers a Terminal type whose tab spawns one shell through the ticket-7
// transport (ptySpawn in the Working Repository), streams its output through
// the long-poll ptyPull loop resuming from the returned seq, and kills the
// shell on close with no confirmation. Ticket #9 adds the lifecycle: a page
// reload re-attaches the stored tab to its live shell (the persisted entry
// carries the host PTY session id; the ring buffer replays the scrollback
// from seq 0), and a session id from a previous host boot is unknown, so a
// restored tab whose session is gone renders a dead-session placeholder.
//
// Seam (agreed): the rendered tree of the shell.overlay registration, the
// injected localStorage, and a fake rsidebarGit remote that records every
// call and resolves ptyPull from manually controlled promises. The vm harness
// mounts no real DOM element, so xterm cannot attach and the fallback pre is
// the observation point for streamed output.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
const TABS_KEY_BASE = 'dsh.rsidebar.panels.v1.'

// ---------------------------------------------------------------------------
// Vendoring (acceptance: prebuilt xterm.js + CSS vendored, inlined, no CDN)
// ---------------------------------------------------------------------------

{
  const xtermJs = await readFile(new URL('../lib/vendor/xterm/xterm.js', import.meta.url), 'utf8')
  const xtermCss = await readFile(new URL('../lib/vendor/xterm/xterm.css', import.meta.url), 'utf8')
  assert.ok(xtermJs.length > 100000, 'the prebuilt xterm.js must be vendored under lib/vendor/xterm/')
  assert.ok(xtermCss.includes('.xterm'), 'the prebuilt xterm.css must be vendored under lib/vendor/xterm/')
  const dynamicSource = await readFile(new URL('../dynamic/client.js', import.meta.url), 'utf8')
  for (const twin of [source, dynamicSource]) {
    assert.ok(twin.includes('const XTERM = (function () {'), 'each client twin must inline the vendored XTERM block')
    assert.ok(twin.includes(xtermJs.slice(0, 200)), 'the vendored library must be pasted verbatim into each twin')
  }
  // The dynamic twin must carry the same terminal half as lib (README:
  // dynamic/ is the one-session bundle of this plugin), and the twin host
  // must handle ptyResize — a half-mirrored twin only fails at click time.
  const twinHost = await readFile(new URL('../dynamic/host.js', import.meta.url), 'utf8')
  for (const needle of [
    "const TAB_TYPE_TERMINAL = 'terminal'",
    'const terminalSessions = new Map()',
    '[TAB_TYPE_TERMINAL]: {',
    'function TerminalTab(props)',
    "host.call('ptySpawn', withCwd({ cols: 80, rows: 24 }))",
    "host.call('ptyResize', { id: inst.session.ptyId",
    // Ticket #9 twins: the restore/re-attach, the session-id persistence,
    // and the dead-session placeholder must exist in the dynamic bundle too.
    "if (typeof entry.ptyId !== 'string' || !entry.ptyId.trim()) return null",
    'if (typeof bindSession === \'function\') bindSession(tab.id, spawn.id)',
    'if (/unknown pty session/.test(message)) setEnded(true)',
    "'.rsb-term-dead { flex: 1;",
  ]) {
    assert.ok(dynamicSource.includes(needle), 'the dynamic twin must carry ' + needle)
  }
  assert.ok(twinHost.includes("harness.handle('ptyResize'"), 'the dynamic twin host must handle ptyResize')
  assert.ok(twinHost.includes("'pty-' + ptyBoot + '-' + ptyCounter"), 'the dynamic twin host must mint boot-unique session ids')
  console.log('vendoring check passed')
}

// ---------------------------------------------------------------------------
// vm harness (copied from test-panel-tabs.mjs, extended for ticket #8)
// ---------------------------------------------------------------------------

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
    // xterm reads navigator/window at load; a real navigator lets the
    // vendored XTERM block capture the library, undefined keeps it null.
    navigator: env.navigator,
    ResizeObserver,
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
      if (name === 'remote.rsidebarGit') return env.remote || null
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

  // Unmount semantics for one component: run its stored effect cleanups,
  // then drop its hook state, so the next render is a fresh mount.
  function remount(type) {
    const hooks = hookState.get(type)
    if (hooks) {
      for (const hook of hooks) {
        if (hook && typeof hook.cleanup === 'function') {
          try { hook.cleanup() } catch (e) {}
        }
      }
    }
    hookState.delete(type)
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

  function findTerminalTabElement(node) {
    let found = null
    visit(node, (n) => {
      if (found || typeof n.type !== 'function') return
      if (n.props?.tab && n.props.tab.type === 'terminal') found = n
    })
    return found
  }

  const overlay = registrations.get('shell.overlay')
  const details = registrations.get('details')
  return {
    overlay,
    details,
    render(props) { return renderFunction(overlay, props) },
    renderDetails(props) {
      // Walking is what renders: the details registration must actually run
      // SidebarPanel so the cwd store publishes the Working Repository root.
      const tree = renderFunction(details, props)
      visit(tree, () => {})
      return tree
    },
    remount,
    resizeObservers,
    styleElements,
    stylesheet: styleElements.map((el) => el.textContent).join('\n'),
    storage,
    layoutCalls,
    findClass,
    findAll,
    visit,
    collectStrings,
    buttonWithText,
    findTerminalTabElement,
  }
}

// A fake rsidebarGit remote: every call is recorded; ptySpawn resolves from a
// scripted envelope (a `spawns` array is consumed one entry per call),
// ptyPull resolves only when the test settles the promise, which gives
// manual control over the long-poll loop.
function makeRemote(script) {
  const calls = []
  const pullWaiters = []
  const remote = {
    ptySpawn(cwd, cols, rows) {
      calls.push({ method: 'ptySpawn', args: [cwd, cols, rows] })
      const next = Array.isArray(script.spawns) ? script.spawns.shift() : script.spawn
      return Promise.resolve(next)
    },
    ptyWrite(id, data) {
      calls.push({ method: 'ptyWrite', args: [id, data] })
      return Promise.resolve({ ok: true, value: { ok: true } })
    },
    ptyPull(id, afterSeq) {
      calls.push({ method: 'ptyPull', args: [id, afterSeq] })
      return new Promise((resolve) => { pullWaiters.push({ id, afterSeq, resolve }) })
    },
    ptyResize(id, cols, rows) {
      calls.push({ method: 'ptyResize', args: [id, cols, rows] })
      return Promise.resolve({ ok: true, value: { ok: true } })
    },
    ptyKill(id) {
      calls.push({ method: 'ptyKill', args: [id] })
      return Promise.resolve({ ok: true, value: { ok: true } })
    },
  }
  const methodsOf = (name) => calls.filter((c) => c.method === name)
  return { remote, calls, pullWaiters, methodsOf }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

const startedProps = {
  sessionId: 'session-a',
  useSessions(selector) {
    return selector({ current: 'session-a', byId: { 'session-a': { blank: false } } })
  },
  useWorkspaces(selector) {
    return selector({ items: [{ path: '/workspace/a', sessionIds: ['session-a'] }] })
  },
}

// Renders the started session, opens the Panel from the Rail unless the Rail
// button already reports it open, and returns the mounted Panel node. Each
// render pass must be traversed (findClass) for the harness to run the
// measured-rect effect, so the "mount pass" render is traversed too.
function openPanel(env) {
  const tree = env.render(startedProps)
  const rail = env.findClass(tree, 'rsb-rail')
  const buttons = (rail.props.children || []).filter((child) => child && child.type === 'button')
  if (buttons[1].props['aria-pressed'] !== 'true') buttons[1].props.onClick()
  env.findClass(env.render(startedProps), 'rsb-bottom-panel') // mount pass; null while rect fills
  return env.findClass(env.render(startedProps), 'rsb-bottom-panel')
}

// Boots with a fake remote and publishes the Working Repository root through
// the details registration (the Sidebar's cwd store), then returns the open
// Panel. `script` shapes the remote's answers.
async function bootWithTerminal(script) {
  const fake = makeRemote(script)
  const env = boot({ remote: fake.remote })
  env.renderDetails(startedProps) // publishes /workspace/a into the cwd store
  const panel = openPanel(env)
  return { env, fake, panel }
}

// Opens the + picker and clicks the Terminal item; returns the fresh Panel.
function pickTerminal(env, panel) {
  env.findClass(panel, 'rsb-tabstrip-add').props.onClick()
  panel = env.findClass(env.render(startedProps), 'rsb-bottom-panel')
  const item = env.buttonWithText(panel, 'Terminal')
  assert.ok(item, 'the picker must offer the Terminal type as a button')
  item.props.onClick()
  return env.findClass(env.render(startedProps), 'rsb-bottom-panel')
}

function activeTabs(env, panel) {
  return env.findAll(panel, 'rsb-tab').filter((t) => t.props.className.split(' ').includes('rsb-tab-active'))
}

// ---------------------------------------------------------------------------
// 1. The picker lists Terminal; choosing it appends and focuses one terminal
//    tab immediately, with no entry form, and the tab persists typed.
// ---------------------------------------------------------------------------
{
  const { env, panel } = await bootWithTerminal({ spawn: { ok: true, value: { id: 'pty-1', pid: 4242 } } })
  let current = pickTerminal(env, panel)

  const tabs = env.findAll(current, 'rsb-tab')
  assert.equal(tabs.length, 1, 'choosing Terminal must create exactly one Panel Tab')
  const active = activeTabs(env, current)
  assert.equal(active.length, 1, 'the new terminal tab must be focused')
  const chipStrings = []
  env.collectStrings(active[0], chipStrings)
  assert.ok(chipStrings.some((t) => t.includes('Terminal')), 'the terminal tab chip must read Terminal')
  assert.equal(env.findClass(current, 'rsb-tab-picker'), null, 'choosing Terminal must close the picker')
  assert.equal(env.findClass(current, 'rsb-tab-picker-form'), null, 'Terminal needs no entry form')

  const key = TABS_KEY_BASE + 'session-a'
  assert.ok(env.storage.has(key), 'the terminal tab must persist like every Panel Tab')
  const saved = JSON.parse(env.storage.get(key))
  assert.equal(saved.tabs.length, 1, 'one tab must be stored')
  assert.equal(saved.tabs[0].type, 'terminal', 'the stored tab must carry the terminal type')
  assert.equal(saved.active, saved.tabs[0].id, 'the terminal tab must be the stored active tab')
  assert.ok(env.findClass(current, 'rsb-term'), 'the terminal tab must render its surface')

  // Creating a second Terminal tab never dedupes: two shells, two tabs.
  current = pickTerminal(env, current)
  assert.equal(env.findAll(current, 'rsb-tab').length, 2, 'terminal tabs never dedupe — each is its own shell')
  console.log('picker + terminal tab creation check passed')
}

// ---------------------------------------------------------------------------
// 2. Mounting the tab spawns one shell in the Working Repository at 80x24;
//    a remount of the same tab reuses the session without a second spawn.
// ---------------------------------------------------------------------------
{
  const { env, fake, panel } = await bootWithTerminal({ spawn: { ok: true, value: { id: 'pty-1', pid: 4242 } } })
  const current = pickTerminal(env, panel)
  // The mount pass must be traversed for the TerminalTab effect to run.
  env.findClass(current, 'rsb-term')
  await tick()

  const spawns = fake.methodsOf('ptySpawn')
  assert.equal(spawns.length, 1, 'mounting the terminal tab must spawn exactly one shell')
  assert.deepEqual(spawns[0].args, ['/workspace/a', 80, 24], 'the shell must spawn in the Working Repository at 80x24')

  // Simulate a tab switch away and back: the component unmounts (cleanups
  // run) and remounts; the session map must be reused, not re-spawned.
  const termTabElement = env.findTerminalTabElement(current)
  assert.ok(termTabElement, 'the terminal tab content must render through the TerminalTab component')
  env.remount(termTabElement.type)
  const again = env.findClass(env.render(startedProps), 'rsb-bottom-panel')
  env.findClass(again, 'rsb-term')
  await tick()
  assert.equal(fake.methodsOf('ptySpawn').length, 1, 'a remount of the same tab must reuse the session — no second ptySpawn')
  console.log('ptySpawn session check passed')
}

// ---------------------------------------------------------------------------
// 3. Without an xterm constructor the pulled output lands in the fallback
//    pre; the loop resumes from the returned seq and stops after alive:false.
// ---------------------------------------------------------------------------
{
  const { env, fake, panel } = await bootWithTerminal({ spawn: { ok: true, value: { id: 'pty-1', pid: 4242 } } })
  const current = pickTerminal(env, panel)
  env.findClass(current, 'rsb-term')
  await tick()

  assert.equal(fake.methodsOf('ptyPull').length, 1, 'the mount must start exactly one pull loop')
  assert.deepEqual(fake.methodsOf('ptyPull')[0].args, ['pty-1', 0], 'the loop must start pulling from seq 0')

  fake.pullWaiters[0].resolve({ ok: true, value: { seq: 1, chunk: 'hello', alive: true } })
  await tick()
  const pulls = fake.methodsOf('ptyPull')
  assert.equal(pulls.length, 2, 'the loop must pull again after a live chunk')
  assert.deepEqual(pulls[1].args, ['pty-1', 1], 'the loop must resume from the returned seq')

  fake.pullWaiters[1].resolve({ ok: true, value: { seq: 2, chunk: '', alive: false } })
  await tick()
  assert.equal(fake.methodsOf('ptyPull').length, 2, 'the loop must stop after alive: false')

  const after = env.findClass(env.render(startedProps), 'rsb-bottom-panel')
  const fallback = env.findClass(after, 'rsb-term-fallback')
  assert.ok(fallback, 'with no xterm constructor the output must render in the fallback pre')
  assert.equal(fallback.type, 'pre')
  const outStrings = []
  env.collectStrings(fallback, outStrings)
  assert.ok(outStrings.join('').includes('hello'), 'the pulled chunk must land in the fallback text')
  console.log('pull loop fallback check passed')
}

// ---------------------------------------------------------------------------
// 4. Closing the tab kills its shell immediately through dispose — no
//    confirmation step.
// ---------------------------------------------------------------------------
{
  const { env, fake, panel } = await bootWithTerminal({ spawn: { ok: true, value: { id: 'pty-1', pid: 4242 } } })
  const current = pickTerminal(env, panel)
  env.findClass(current, 'rsb-term')
  await tick()
  assert.equal(fake.methodsOf('ptySpawn').length, 1)

  const tab = env.findAll(current, 'rsb-tab')[0]
  env.findClass(tab, 'rsb-tab-close').props.onClick({ stopPropagation() {} })
  // dispose runs synchronously inside closeTab: the kill call is already out.
  const kills = fake.methodsOf('ptyKill')
  assert.equal(kills.length, 1, 'closing the tab must kill its shell immediately')
  assert.deepEqual(kills[0].args, ['pty-1'], 'the kill must target the spawned session id')

  const closed = env.findClass(env.render(startedProps), 'rsb-bottom-panel')
  assert.equal(env.findAll(closed, 'rsb-tab').length, 0, 'the closed terminal tab must be gone from the strip')
  assert.ok(env.findClass(closed, 'rsb-panel-empty'), 'closing the last tab must return the empty state')

  // Closing again must not double-kill: the session entry is already gone.
  env.findClass(env.render(startedProps), 'rsb-tabstrip-add') // traversal only
  assert.equal(fake.methodsOf('ptyKill').length, 1, 'dispose must delete the session entry — no double kill')
  console.log('close kills shell check passed')
}

// ---------------------------------------------------------------------------
// 5. A failed spawn renders the error state.
// ---------------------------------------------------------------------------
{
  const { env, fake, panel } = await bootWithTerminal({ spawn: { ok: false, error: { message: 'the sandbox refused the pty' } } })
  const current = pickTerminal(env, panel)
  env.findClass(current, 'rsb-term')
  await tick()

  const errored = env.findClass(env.render(startedProps), 'rsb-bottom-panel')
  const errBox = env.findClass(errored, 'rsb-error')
  assert.ok(errBox, 'a failed spawn must render an error state')
  const errStrings = []
  env.collectStrings(errBox, errStrings)
  assert.ok(errStrings.join('').includes('the sandbox refused the pty'), 'the error state must carry the failure message')
  assert.equal(fake.methodsOf('ptyPull').length, 0, 'a failed spawn must not start a pull loop')
  console.log('spawn failure check passed')
}

// ---------------------------------------------------------------------------
// 6. Reload re-attach (ticket #9): a stored terminal tab re-attaches to its
//    live shell — the persisted entry carries the host PTY session id, no
//    shell is spawned, and the pull loop replays the ring buffer from seq 0
//    so the scrollback comes back. An entry without a session id cannot
//    re-attach and is dropped; non-terminal tabs restore as before.
// ---------------------------------------------------------------------------
{
  const stored = new Map()
  stored.set(TABS_KEY_BASE + 'session-a', JSON.stringify({
    tabs: [
      { id: 't1', type: 'terminal', ptyId: 'pty-rs9x2-1' },
      { id: 'u1', type: 'localhost-url', url: 'http://localhost:9' },
    ],
    active: 't1',
  }))
  const fake = makeRemote({})
  const env = boot({ storage: stored, remote: fake.remote })
  env.renderDetails(startedProps) // publishes /workspace/a into the cwd store
  const panel = openPanel(env)
  const tabs = env.findAll(panel, 'rsb-tab')
  assert.equal(tabs.length, 2, 'a stored terminal tab must restore next to the other tabs')
  env.findClass(panel, 'rsb-term')
  await tick()

  assert.equal(fake.methodsOf('ptySpawn').length, 0, 'the restored tab must re-attach — no ptySpawn')
  const pulls = fake.methodsOf('ptyPull')
  assert.equal(pulls.length, 1, 'the restored tab must start exactly one pull loop')
  assert.deepEqual(pulls[0].args, ['pty-rs9x2-1', 0], 're-attach must replay the ring buffer from seq 0')

  fake.pullWaiters[0].resolve({ ok: true, value: { seq: 3, chunk: 'restored-scrollback', alive: true } })
  await tick()
  const after = env.findClass(env.render(startedProps), 'rsb-bottom-panel')
  const fallback = env.findClass(after, 'rsb-term-fallback')
  assert.ok(fallback, 'with no xterm constructor the restored output must render in the fallback pre')
  const outStrings = []
  env.collectStrings(fallback, outStrings)
  assert.ok(outStrings.join('').includes('restored-scrollback'), 'the restored scrollback must render')
  assert.deepEqual(fake.methodsOf('ptyPull')[1].args, ['pty-rs9x2-1', 3], 'the loop must resume from the replayed seq')
  console.log('terminal restore re-attach check passed')
}

// ---------------------------------------------------------------------------
// 6b. A stored terminal tab without a session id cannot re-attach and is
//     dropped on boot (the ticket-8 entries, or a crashed spawn), while a
//     stored localhost-url tab still survives.
// ---------------------------------------------------------------------------
{
  const stored = new Map()
  stored.set(TABS_KEY_BASE + 'session-a', JSON.stringify({
    tabs: [
      { id: 't1', type: 'terminal' },
      { id: 'u1', type: 'localhost-url', url: 'http://localhost:9' },
    ],
    active: 't1',
  }))
  const env = boot({ storage: stored })
  const panel = openPanel(env)
  const tabs = env.findAll(panel, 'rsb-tab')
  assert.equal(tabs.length, 1, 'a stored terminal tab without a session id must be dropped on boot')
  const strings = []
  env.collectStrings(tabs[0], strings)
  assert.ok(strings.some((t) => t.includes('http://localhost:9')), 'the stored localhost-url tab must survive')
  assert.equal(env.findClass(panel, 'rsb-tabframe').props.src, 'http://localhost:9', 'the surviving tab becomes active')
  console.log('sessionless terminal drop check passed')
}

// ---------------------------------------------------------------------------
// 6c. Closing a restored tab kills the restored session id — the dispose
//     path must work for a tab whose shell was never spawned this boot.
// ---------------------------------------------------------------------------
{
  const stored = new Map()
  stored.set(TABS_KEY_BASE + 'session-a', JSON.stringify({
    tabs: [{ id: 't1', type: 'terminal', ptyId: 'pty-rs9x2-7' }],
    active: 't1',
  }))
  const fake = makeRemote({})
  const env = boot({ storage: stored, remote: fake.remote })
  env.renderDetails(startedProps)
  const panel = openPanel(env)
  env.findClass(panel, 'rsb-term')
  await tick()
  const tab = env.findAll(panel, 'rsb-tab')[0]
  env.findClass(tab, 'rsb-tab-close').props.onClick({ stopPropagation() {} })
  const kills = fake.methodsOf('ptyKill')
  assert.equal(kills.length, 1, 'closing a restored tab must kill its shell immediately')
  assert.deepEqual(kills[0].args, ['pty-rs9x2-7'], 'the kill must target the restored session id')
  console.log('restored tab close check passed')
}

// ---------------------------------------------------------------------------
// 7. Vendored xterm loads when browser globals exist: the library captures a
//    Terminal constructor and its CSS reaches the page as a second style
//    element. (The vm harness mounts no real DOM, so attach still cannot
//    happen and the fallback stays the observation point.)
// ---------------------------------------------------------------------------
{
  const fake = makeRemote({ spawn: { ok: true, value: { id: 'pty-1', pid: 4242 } } })
  const env = boot({ remote: fake.remote, navigator: { userAgent: 'dsh-sidebar-test', platform: 'MacIntel' } })
  env.renderDetails(startedProps)
  const panel = openPanel(env)

  const vendor = env.styleElements.find((el) => el.id === 'dsh-sidebar-vendor-xterm')
  assert.ok(vendor, 'the vendored xterm CSS must reach the page as its own style element')
  assert.ok(String(vendor.textContent).includes('.xterm'), 'the vendored style element must carry the xterm.css rules')
  assert.ok(env.styleElements.some((el) => el.id === 'dsh-sidebar-styles'), 'the plugin stylesheet must stay in place')

  const current = pickTerminal(env, panel)
  env.findClass(current, 'rsb-term')
  await tick()
  // The constructor exists here, but with no mounted DOM container xterm
  // still cannot attach — the pull loop must feed the fallback all the same.
  fake.pullWaiters[0].resolve({ ok: true, value: { seq: 1, chunk: 'shell-ready', alive: true } })
  await tick()
  fake.pullWaiters[1].resolve({ ok: true, value: { seq: 2, chunk: '', alive: false } })
  await tick()
  const after = env.findClass(env.render(startedProps), 'rsb-bottom-panel')
  const fallbackStrings = []
  env.collectStrings(env.findClass(after, 'rsb-term-fallback'), fallbackStrings)
  assert.ok(fallbackStrings.join('').includes('shell-ready'), 'output must still stream while xterm cannot attach')
  assert.ok(env.stylesheet.includes('.rsb-term'), 'the terminal surface rules must ship in the plugin stylesheet')
  console.log('vendored xterm capture check passed')
}

// ---------------------------------------------------------------------------
// 8. Per-session tab persistence includes terminal session ids (ticket #9):
//    once the shell spawns, the tab entry gains the host PTY session id —
//    that stored id is what the next boot re-attaches to. Each tab binds its
//    own id to its own entry.
// ---------------------------------------------------------------------------
{
  const { env, fake, panel } = await bootWithTerminal({
    spawns: [
      { ok: true, value: { id: 'pty-b1-1', pid: 4242 } },
      { ok: true, value: { id: 'pty-b1-2', pid: 4243 } },
    ],
  })
  let current = pickTerminal(env, panel)
  env.findClass(current, 'rsb-term')
  await tick()

  const key = TABS_KEY_BASE + 'session-a'
  let saved = JSON.parse(env.storage.get(key))
  assert.equal(saved.tabs.length, 1, 'one terminal tab must be stored before the second is picked')
  assert.equal(saved.tabs[0].ptyId, 'pty-b1-1', 'the spawned session id must persist into the stored tab entry')

  current = pickTerminal(env, current)
  // The vm harness keys hook state by component function, so the second
  // tab (same TerminalTab function, new React key in the real DOM) needs a
  // fresh instance for its mount effect to run — same shape as the remount
  // simulation in section 2.
  const term2 = env.findTerminalTabElement(current)
  env.remount(term2.type)
  env.findClass(current, 'rsb-term')
  await tick()
  saved = JSON.parse(env.storage.get(key))
  assert.equal(saved.tabs.length, 2, 'two terminal tabs must be stored')
  assert.equal(saved.tabs[1].ptyId, 'pty-b1-2', 'each tab must bind its own spawned session id')
  assert.equal(saved.tabs[0].ptyId, 'pty-b1-1', 'the first tab keeps its own session id')
  assert.equal(fake.methodsOf('ptySpawn').length, 2, 'binding must not re-spawn — one shell per tab')
  console.log('terminal session id persistence check passed')
}

// ---------------------------------------------------------------------------
// 9. Dead-session placeholder (ticket #9): session ids are boot-unique, so a
//    pull failing with "unknown pty session" means the host restarted and
//    the shell is gone. A restored tab then renders the placeholder instead
//    of a broken terminal; a live tab whose host restarts mid-session flips
//    to it too. Any other pull failure stays the plain error box.
// ---------------------------------------------------------------------------
{
  const stored = new Map()
  stored.set(TABS_KEY_BASE + 'session-a', JSON.stringify({
    tabs: [{ id: 't1', type: 'terminal', ptyId: 'pty-old-1' }],
    active: 't1',
  }))
  const fake = makeRemote({})
  const env = boot({ storage: stored, remote: fake.remote })
  env.renderDetails(startedProps)
  const panel = openPanel(env)
  env.findClass(panel, 'rsb-term')
  await tick()
  assert.equal(fake.methodsOf('ptySpawn').length, 0, 'a restored tab never respawns on its own')

  // The pull comes back "unknown pty session": the host was restarted.
  fake.pullWaiters[0].resolve({ ok: false, error: { message: 'dsh-sidebar: unknown pty session: pty-old-1' } })
  await tick()
  const after = env.findClass(env.render(startedProps), 'rsb-bottom-panel')
  assert.equal(fake.methodsOf('ptyPull').length, 1, 'the loop must stop once the session is known dead')
  const dead = env.findClass(after, 'rsb-term-dead')
  assert.ok(dead, 'a restored tab whose session is gone must render the dead-session placeholder')
  assert.equal(env.findClass(after, 'rsb-error'), null, 'the placeholder is not an error box')
  const strings = []
  env.collectStrings(dead, strings)
  assert.ok(strings.join('').includes('Terminal session ended'), 'the placeholder must say the session ended')
  assert.ok(env.stylesheet.includes('.rsb-term-dead'), 'the placeholder must ship styled')
  console.log('dead-session placeholder check passed')
}

// A tab that was live before the restart flips to the placeholder as well.
{
  const { env, fake, panel } = await bootWithTerminal({ spawn: { ok: true, value: { id: 'pty-live-1', pid: 4242 } } })
  const current = pickTerminal(env, panel)
  env.findClass(current, 'rsb-term')
  await tick()
  fake.pullWaiters[0].resolve({ ok: true, value: { seq: 1, chunk: 'before-restart', alive: true } })
  await tick()
  fake.pullWaiters[1].resolve({ ok: false, error: { message: 'dsh-sidebar: unknown pty session: pty-live-1' } })
  await tick()
  const after = env.findClass(env.render(startedProps), 'rsb-bottom-panel')
  assert.ok(env.findClass(after, 'rsb-term-dead'), 'a live tab whose host restarted must flip to the placeholder')
  console.log('live tab restart flip check passed')
}

// Any other pull failure keeps the plain error box.
{
  const { env, fake, panel } = await bootWithTerminal({ spawn: { ok: true, value: { id: 'pty-live-1', pid: 4242 } } })
  const current = pickTerminal(env, panel)
  env.findClass(current, 'rsb-term')
  await tick()
  fake.pullWaiters[0].resolve({ ok: false, error: { message: 'the channel dropped' } })
  await tick()
  const after = env.findClass(env.render(startedProps), 'rsb-bottom-panel')
  assert.ok(env.findClass(after, 'rsb-error'), 'a non-session pull failure must stay an error box')
  assert.equal(env.findClass(after, 'rsb-term-dead'), null, 'a non-session failure must not render the placeholder')
  console.log('pull error passthrough check passed')
}

console.log('Terminal tab check passed')
