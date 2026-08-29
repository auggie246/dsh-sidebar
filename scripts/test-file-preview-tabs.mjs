#!/usr/bin/env node
// File preview Panel Tab check (ticket #7): the + picker offers HTML file
// and Markdown file; submitting a path creates one tab that loads its bytes
// through the readFile RPC; the HTML preview renders inside a
// script-allowed iframe without same-origin; the Markdown preview renders
// as styled HTML with no scripts; re-opening the same path re-focuses the
// existing tab; both types persist per session; unknown stored types still
// drop.
//
// Seam (agreed): the rendered tree of the shell.overlay registration and
// the injected localStorage, exactly like test-panel-tabs.mjs. The copied
// harness is extended in two ways: a fake rsidebarGit remote records
// readFile calls and serves per-path content, and hook state is keyed by
// component name plus element key, so a keyed remount — a tab switch —
// starts fresh hooks the way real React does.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
const TABS_KEY_BASE = 'dsh.rsidebar.panels.v1.'

const DEFAULT_FILES = {
  'demo.html': '<h1>Raw demo</h1><script>alert(1)</script>',
  'docs/readme.md': '# Hi\n\n**bold** and `code`.\n\n<script>alert(1)</script>\n',
}

// One macrotask: the fake remote resolves on a microtask, so a timer tick
// puts every pending load continuation behind us before the next render.
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

function boot(env = {}) {
  const hookState = new Map()
  let activeToken = null
  let hookIndex = 0
  // Remount model: real React destroys hook state on unmount. Each
  // env.render() pass fully walks the tree, so a token that never appeared
  // while walking the previous pass has unmounted — its hooks reset on the
  // next encounter, exactly like a keyed remount in React.
  let currentPass = new Set()
  let lastPass = new Set()
  function hooksFor() {
    let hooks = hookState.get(activeToken)
    if (!hooks) { hooks = []; hookState.set(activeToken, hooks) }
    return hooks
  }
  const React = {
    Fragment: Symbol('Fragment'),
    createElement(type, props, ...children) {
      return { type, props: { ...(props || {}), children } }
    },
    useState(initial) {
      const hooks = hooksFor()
      const index = hookIndex++
      if (!(index in hooks)) hooks[index] = { kind: 'state', value: typeof initial === 'function' ? initial() : initial }
      return [hooks[index].value, (value) => {
        hooks[index].value = typeof value === 'function' ? value(hooks[index].value) : value
      }]
    },
    useEffect(effect, deps) {
      const hooks = hooksFor()
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

  // Fake rsidebarGit remote: records every readFile call and serves the
  // per-path content table. Unknown paths reject with an error message.
  const files = env.files || DEFAULT_FILES
  const remoteCalls = []
  const fakeRemote = {
    readFile(...args) {
      remoteCalls.push({ method: 'readFile', args })
      const path = args.length > 1 ? args[1] : ''
      if (Object.prototype.hasOwnProperty.call(files, path)) {
        return Promise.resolve({ ok: true, value: { content: files[path] } })
      }
      return Promise.resolve({ ok: false, error: { message: 'no such file: ' + path } })
    },
  }

  // Shell frame stand-in (same fixture as test-panel-tabs.mjs).
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
      if (name === 'remote.rsidebarGit') return fakeRemote
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
    const previousToken = activeToken
    const previousIndex = hookIndex
    const name = type.displayName || type.name || 'anonymous'
    const key = props && props.key !== undefined ? String(props.key) : ''
    const token = name + '#' + key
    if (!currentPass.has(token)) {
      if (!lastPass.has(token)) {
        const stale = hookState.get(token)
        if (stale) for (const hook of stale) if (hook && typeof hook.cleanup === 'function') hook.cleanup()
        hookState.delete(token)
      }
      currentPass.add(token)
    }
    activeToken = token
    hookIndex = 0
    const output = type(props || {})
    activeToken = previousToken
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
    render(props) {
      lastPass = currentPass
      currentPass = new Set()
      const tree = renderFunction(overlay, props)
      visit(tree, () => {})
      return tree
    },
    stylesheet: styleElements.map((el) => el.textContent).join('\n'),
    storage,
    layoutCalls,
    remoteCalls,
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

function activeTabs(env, panel) {
  return env.findAll(panel, 'rsb-tab').filter((t) => t.props.className.split(' ').includes('rsb-tab-active'))
}

// Drives the + → <itemLabel> → path form flow for one path entry. Every step
// re-renders and re-finds its node, the way React re-renders on each state
// change. Assumes the picker starts closed. The returned panel node is the
// mount pass: the tab exists and its content effect has just started.
function openFileTab(env, itemLabel, path) {
  let panel = env.findClass(env.render(startedProps), 'rsb-bottom-panel')
  env.findClass(panel, 'rsb-tabstrip-add').props.onClick()
  panel = env.findClass(env.render(startedProps), 'rsb-bottom-panel')
  env.buttonWithText(panel, itemLabel).props.onClick()
  panel = env.findClass(env.render(startedProps), 'rsb-bottom-panel')
  const input = env.findClass(env.findClass(panel, 'rsb-tab-picker-form'), 'rsb-tab-picker-input')
  input.props.onChange({ target: { value: path } })
  env.findClass(env.render(startedProps), 'rsb-tab-picker-form').props.onSubmit({ preventDefault() {} })
  return env.findClass(env.render(startedProps), 'rsb-bottom-panel')
}

// 1. The picker offers both new types after Localhost URL, with the ticket's
//    titles and subs.
{
  const env = boot()
  const panel = openPanel(env)
  env.findClass(panel, 'rsb-tabstrip-add').props.onClick()
  const next = env.findClass(env.render(startedProps), 'rsb-bottom-panel')
  assert.ok(env.findClass(next, 'rsb-tab-picker'), 'clicking + must open the type picker')
  const items = env.findAll(next, 'rsb-tab-picker-item')
  assert.equal(items.length, 3, 'the picker must list Localhost URL, HTML file and Markdown file')
  const labels = items.map((item) => {
    const strings = []
    env.collectStrings(item, strings)
    return strings.join(' ')
  })
  assert.ok(labels[0].includes('Localhost URL'), 'Localhost URL stays the first picker item')
  assert.ok(labels[1].includes('HTML file') && labels[1].includes('Preview a repo file in an iframe'), 'the HTML file item must carry its title and sub')
  assert.ok(labels[2].includes('Markdown file') && labels[2].includes('Render a repo Markdown file'), 'the Markdown file item must carry its title and sub')
}

// 2. The HTML file flow: the form matches the URL form structure, submitting
//    a path creates one tab that calls git.readFile(cwd(), path), and the
//    loaded content renders in an iframe that allows scripts but never
//    same-origin.
{
  const env = boot()
  let panel = openPanel(env)
  env.findClass(panel, 'rsb-tabstrip-add').props.onClick()
  panel = env.findClass(env.render(startedProps), 'rsb-bottom-panel')
  env.buttonWithText(panel, 'HTML file').props.onClick()

  panel = env.findClass(env.render(startedProps), 'rsb-bottom-panel')
  const form = env.findClass(panel, 'rsb-tab-picker-form')
  assert.ok(form, 'choosing HTML file must open the path-entry form')
  const headStrings = []
  env.collectStrings(env.findClass(form, 'rsb-tab-picker-head'), headStrings)
  assert.ok(headStrings.join(' ').includes('HTML FILE'), 'the form head must read HTML FILE')
  const input = env.findClass(form, 'rsb-tab-picker-input')
  assert.ok(input, 'the form must hold a path input')
  assert.equal(input.props.placeholder, 'path/to/file.html', 'the input must hint at a repo-relative path')
  const openBtn = env.findAll(form, 'rsb-tab-picker-open')[0]
  assert.equal(openBtn.props.disabled, true, 'Open must stay disabled while the draft is blank')
  assert.equal(env.findAll(form, 'rsb-tab-picker-actions').length, 1, 'the form must keep the actions row')

  input.props.onChange({ target: { value: 'demo.html' } })
  panel = env.findClass(env.render(startedProps), 'rsb-bottom-panel')
  const openEnabled = env.findAll(env.findClass(panel, 'rsb-tab-picker-form'), 'rsb-tab-picker-open')[0]
  assert.equal(openEnabled.props.disabled, false, 'Open must enable once a path is typed')
  env.findClass(env.render(startedProps), 'rsb-tab-picker-form').props.onSubmit({ preventDefault() {} })

  panel = env.findClass(env.render(startedProps), 'rsb-bottom-panel')
  assert.equal(env.findAll(panel, 'rsb-tab').length, 1, 'submitting the form must create exactly one Panel Tab')
  const loading = env.findClass(panel, 'rsb-empty')
  assert.ok(loading, 'the fresh tab must show a loading state')
  const loadingStrings = []
  env.collectStrings(loading, loadingStrings)
  assert.ok(loadingStrings.join(' ').includes('Loading…'), 'the loading state must say it is loading')
  assert.deepEqual(
    env.remoteCalls.map((c) => c.args),
    [['', 'demo.html']],
    'mounting the tab must call git.readFile(cwd(), "demo.html")',
  )
  assert.equal(env.findClass(panel, 'rsb-tab-picker'), null, 'a successful open must close the picker')

  await tick()
  panel = env.findClass(env.render(startedProps), 'rsb-bottom-panel')
  const frame = env.findClass(panel, 'rsb-tabframe')
  assert.ok(frame, 'the loaded tab must render an iframe')
  assert.equal(frame.type, 'iframe')
  assert.ok(String(frame.props.srcdoc).includes('<h1>Raw demo</h1>'), 'the iframe must carry the file content in srcdoc')
  const sandbox = String(frame.props.sandbox)
  assert.ok(sandbox.includes('allow-scripts'), 'the HTML preview must allow scripts')
  assert.ok(!sandbox.includes('allow-same-origin'), 'the HTML preview must not grant same-origin access to the parent page')
  assert.equal(frame.props.title, 'demo.html', 'the iframe title must name the file')
  const hintStrings = []
  env.collectStrings(env.findClass(panel, 'rsb-tabframe-hint'), hintStrings)
  assert.ok(hintStrings.join(' ').includes('Scripts run inside the preview'), 'the hint must explain what runs inside the frame')
  const chipStrings = []
  env.collectStrings(env.findClass(env.findAll(panel, 'rsb-tab')[0], 'rsb-tab-label'), chipStrings)
  assert.ok(chipStrings.join(' ').includes('demo.html'), 'the strip chip must show the file base name')
}

// 3. Form guards: a blank submit shows the ticket's error and creates no
//    tab; Back returns to the type list; Escape closes the form.
{
  const env = boot()
  let panel = openPanel(env)
  env.findClass(panel, 'rsb-tabstrip-add').props.onClick()
  panel = env.findClass(env.render(startedProps), 'rsb-bottom-panel')
  env.buttonWithText(panel, 'Markdown file').props.onClick()

  panel = env.findClass(env.render(startedProps), 'rsb-bottom-panel')
  const form = env.findClass(panel, 'rsb-tab-picker-form')
  const headStrings = []
  env.collectStrings(env.findClass(form, 'rsb-tab-picker-head'), headStrings)
  assert.ok(headStrings.join(' ').includes('MARKDOWN FILE'), 'the Markdown form head must read MARKDOWN FILE')
  form.props.onSubmit({ preventDefault() {} })

  panel = env.findClass(env.render(startedProps), 'rsb-bottom-panel')
  const err = env.findClass(panel, 'rsb-tab-picker-error')
  assert.ok(err, 'a blank submit must show the form error')
  const errStrings = []
  env.collectStrings(err, errStrings)
  assert.ok(errStrings.join(' ').includes('Enter a file path from the Working Repository root.'), 'the error must ask for a repo-root path')
  assert.equal(env.findAll(panel, 'rsb-tab').length, 0, 'a blank submit must not create a tab')

  env.buttonWithText(env.findClass(env.render(startedProps), 'rsb-bottom-panel'), 'Back').props.onClick()
  panel = env.findClass(env.render(startedProps), 'rsb-bottom-panel')
  assert.ok(env.findClass(panel, 'rsb-tab-picker'), 'Back must return to the type list')
  assert.equal(env.findClass(panel, 'rsb-tab-picker-form'), null, 'Back must close the entry form')

  env.buttonWithText(panel, 'Markdown file').props.onClick()
  panel = env.findClass(env.render(startedProps), 'rsb-bottom-panel')
  env.findClass(env.findClass(panel, 'rsb-tab-picker-form'), 'rsb-tab-picker-input').props.onKeyDown({ key: 'Escape' })
  panel = env.findClass(env.render(startedProps), 'rsb-bottom-panel')
  assert.equal(env.findClass(panel, 'rsb-tab-picker-form'), null, 'Escape must close the form')
  assert.equal(env.findClass(panel, 'rsb-tab-picker'), null, 'Escape must close the whole picker')
}

// 4. The Markdown flow: the rendered srcdoc carries the styled document —
//    headings, strong, code — and never a script tag, and the iframe allows
//    no scripts at all.
{
  const env = boot()
  let panel = openPanel(env)
  panel = openFileTab(env, 'Markdown file', 'docs/readme.md')
  await tick()
  panel = env.findClass(env.render(startedProps), 'rsb-bottom-panel')
  const frame = env.findClass(panel, 'rsb-tabframe')
  assert.ok(frame, 'the loaded Markdown tab must render an iframe')
  const doc = String(frame.props.srcdoc)
  assert.ok(doc.includes('<h1>Hi</h1>'), '# Hi must render as a heading')
  assert.ok(doc.includes('<strong>bold</strong>'), '**bold** must render as strong')
  assert.ok(doc.includes('<code>code</code>'), '`code` must render as code')
  assert.ok(!doc.includes('<script'), 'a raw script tag must never survive into the srcdoc')
  assert.equal(String(frame.props.sandbox), '', 'the Markdown preview must not allow scripts')
  assert.ok(doc.includes('<style>'), 'the Markdown preview must embed its own styles')
  assert.ok(doc.includes('prefers-color-scheme'), 'the embedded styles must follow light and dark schemes')
  const hintStrings = []
  env.collectStrings(env.findClass(panel, 'rsb-tabframe-hint'), hintStrings)
  assert.ok(hintStrings.join(' ').includes('scripts are stripped'), 'the hint must say scripts are stripped')
  const tab = env.findAll(panel, 'rsb-tab')[0]
  assert.equal(tab.props.title, 'docs/readme.md', 'the chip title must carry the full path')
  const chipStrings = []
  env.collectStrings(env.findClass(tab, 'rsb-tab-label'), chipStrings)
  assert.ok(chipStrings.join(' ').includes('readme.md'), 'the chip label must show the base name')
}

// 5. Re-opening the same path re-focuses the existing tab: no append, no
//    second readFile call, and the loaded content stays put.
{
  const env = boot()
  let panel = openPanel(env)
  panel = openFileTab(env, 'HTML file', 'demo.html')
  await tick()
  assert.equal(env.remoteCalls.length, 1, 'the first open loads the file once')

  panel = openFileTab(env, 'HTML file', 'demo.html')
  assert.equal(env.findAll(panel, 'rsb-tab').length, 1, 're-opening the same path must not append a tab')
  assert.equal(env.remoteCalls.length, 1, 're-opening the same path must not call the RPC again')
  assert.equal(activeTabs(env, panel).length, 1, 'exactly one tab must be active')
  const frame = env.findClass(panel, 'rsb-tabframe')
  assert.ok(String(frame.props.srcdoc).includes('<h1>Raw demo</h1>'), 'the re-focused tab must keep its loaded content')
}

// 6. Dedupe is per type: the same path under the other type is a second tab,
//    and switching back re-focuses the first tab. Switching remounts the
//    preview, which reloads its file — the submit path itself never calls
//    the RPC.
{
  const env = boot()
  let panel = openPanel(env)
  panel = openFileTab(env, 'HTML file', 'demo.html')
  await tick()
  panel = openFileTab(env, 'Markdown file', 'demo.html')
  assert.equal(env.findAll(panel, 'rsb-tab').length, 2, 'the same path under the other type must be a distinct tab')

  panel = openFileTab(env, 'HTML file', 'demo.html')
  assert.equal(env.findAll(panel, 'rsb-tab').length, 2, 're-opening the html path must re-focus, not append')
  const active = activeTabs(env, panel)
  const activeStrings = []
  env.collectStrings(active[0], activeStrings)
  assert.ok(activeStrings.some((t) => t.includes('demo.html')), 'the re-opened path must re-focus its existing tab')
  await tick()
  assert.equal(env.remoteCalls.length, 3, 'two opens plus one remount must be the only readFile calls')
  panel = env.findClass(env.render(startedProps), 'rsb-bottom-panel')
  const frame = env.findClass(panel, 'rsb-tabframe')
  assert.ok(String(frame.props.srcdoc).includes('<h1>Raw demo</h1>'), 'the re-focused html tab must show its content again')
}

// 7. Persistence: both file preview types round-trip through
//    dsh.rsidebar.panels.v1.<sessionId>, and the restored active tab loads
//    its own file.
{
  const env = boot()
  let panel = openPanel(env)
  panel = openFileTab(env, 'HTML file', 'demo.html')
  panel = openFileTab(env, 'Markdown file', 'docs/readme.md')
  const key = TABS_KEY_BASE + 'session-a'
  assert.ok(env.storage.has(key), 'the tab state must persist under dsh.rsidebar.panels.v1.<sessionId>')
  const saved = JSON.parse(env.storage.get(key))
  assert.equal(saved.tabs.length, 2, 'both tabs must be stored')
  assert.equal(saved.tabs[0].type, 'html-file', 'the stored html tab must carry its type')
  assert.equal(saved.tabs[0].path, 'demo.html', 'the stored html tab must carry its path')
  assert.equal(saved.tabs[1].type, 'markdown-file', 'the stored markdown tab must carry its type')
  assert.equal(saved.tabs[1].path, 'docs/readme.md', 'the stored markdown tab must carry its path')
  assert.equal(saved.active, saved.tabs[1].id, 'the active tab must be stored')

  const env2 = boot({ storage: env.storage })
  const panel2 = openPanel(env2)
  assert.equal(env2.findAll(panel2, 'rsb-tab').length, 2, 'both file preview types must survive a reload')
  await tick()
  const panel3 = env2.findClass(env2.render(startedProps), 'rsb-bottom-panel')
  const frame = env2.findClass(panel3, 'rsb-tabframe')
  assert.ok(String(frame.props.srcdoc).includes('<h1>Hi</h1>'), 'the restored active tab must render its markdown')
  assert.deepEqual(
    env2.remoteCalls.map((c) => c.args),
    [['', 'docs/readme.md']],
    'the restored active tab must load its own file',
  )
}

// 8. Unknown stored types still drop: a terminal entry and an empty-path
//    markdown entry disappear, while the html-file entry survives.
{
  const foreign = new Map()
  foreign.set(TABS_KEY_BASE + 'session-a', JSON.stringify({
    tabs: [
      { id: 'x', type: 'terminal', path: 'nope.md' },
      { id: 'y', type: 'html-file', path: 'demo.html' },
      { id: 'z', type: 'markdown-file', path: '' },
    ],
    active: 'x',
  }))
  const env = boot({ storage: foreign })
  const panel = openPanel(env)
  const tabs = env.findAll(panel, 'rsb-tab')
  assert.equal(tabs.length, 1, 'unknown types and empty paths must drop from storage')
  assert.equal(tabs[0].props.title, 'demo.html', 'the surviving tab must be the html-file one')
  await tick()
  const panel2 = env.findClass(env.render(startedProps), 'rsb-bottom-panel')
  assert.ok(env.findClass(panel2, 'rsb-tabframe'), 'the surviving html-file tab must render its content')
}

// 9. A failed load renders the error state and no iframe.
{
  const env = boot({ files: {} })
  let panel = openPanel(env)
  panel = openFileTab(env, 'HTML file', 'gone.html')
  await tick()
  panel = env.findClass(env.render(startedProps), 'rsb-bottom-panel')
  const err = env.findClass(panel, 'rsb-error')
  assert.ok(err, 'a failed load must render the error state')
  const errStrings = []
  env.collectStrings(err, errStrings)
  assert.ok(errStrings.join(' ').includes('no such file: gone.html'), 'the error state must carry the failure message')
  assert.equal(env.findClass(panel, 'rsb-tabframe'), null, 'a failed load must not render an iframe')
}

console.log('File preview tabs check passed')
