#!/usr/bin/env node
// Explorer Card check (issue #21): the Card Manifest gains a view-only
// Explorer card (id 'explorer', last, visible by default) that lists the
// workspace root through the listDir RPC, expands directories lazily,
// sorts folders first, re-scans only expanded directories while visible,
// caps a listing with a "+N more" row, and opens a read-only preview Panel
// Tab on file select through the pending-open store (ADR 0007) — one tab
// per file, repeat select focuses, and the store's type follows the file
// (.md renders as Markdown, everything else as an HTML file preview).
//
// Seam (agreed): the rendered tree of the shell.overlay registration and
// the injected localStorage, exactly like test-file-preview-tabs.mjs. The
// copied harness is extended in three ways: a blank session (ADR 0003
// keeps the Panel live on one) so the overlay Sidebar and the Panel mount
// together, a fake rsidebarGit remote that also records listDir calls and
// serves a per-path directory table, and ctx.interval recording its
// callbacks so a refresh tick can be fired explicitly.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
const TABS_KEY_BASE = 'dsh.rsidebar.panels.v1.'

const DEFAULT_FILES = {
  'demo.html': '<h1>Raw demo</h1>',
  'docs/readme.md': '# Hi\n',
}
const bigEntries = Array.from({ length: 1000 }, (_, i) => ({ name: 'entry-' + i + '.txt', kind: 'file' }))

const DEFAULT_DIRTABLE = {
  '': { entries: [{ name: 'demo.html', kind: 'file' }, { name: 'docs', kind: 'dir' }, { name: 'zeta.txt', kind: 'file' }], hasMore: false, total: 3 },
  docs: { entries: [{ name: 'readme.md', kind: 'file' }, { name: 'img', kind: 'dir' }], hasMore: false, total: 2 },
  'docs/img': { entries: [], hasMore: false, total: 0 },
  big: { entries: bigEntries, hasMore: true, total: 1003 },
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

  // Fake rsidebarGit remote: records every call, serves readFile from a
  // per-path content table and listDir from a per-path directory table.
  const files = env.files || DEFAULT_FILES
  const dirtable = env.dirtable || DEFAULT_DIRTABLE
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
    listDir(...args) {
      remoteCalls.push({ method: 'listDir', args })
      const path = args.length > 1 ? args[1] : ''
      if (Object.prototype.hasOwnProperty.call(dirtable, path)) {
        return Promise.resolve({ ok: true, value: dirtable[path] })
      }
      return Promise.resolve({ ok: false, error: { message: 'no such directory: ' + path } })
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
  const intervals = []
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
    interval(fn) { intervals.push(fn); return () => {} },
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

  function rowWithText(node, className, text) {
    for (const row of findAll(node, className)) {
      const strings = []
      collectStrings(row, strings)
      if (strings.join(' ').includes(text)) return row
    }
    return null
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
    intervals,
    remoteCalls,
    findClass,
    findAll,
    visit,
    collectStrings,
    rowWithText,
  }
}

function railButtons(rail) {
  return (rail.props.children || []).filter((child) => child && child.type === 'button')
}

// A blank session (ADR 0003): it exists, so the Panel button is live, but
// its Details Column is hard-zeroed, so the Sidebar floats on the overlay
// and the Rail hands down the sessions store's current session (ADR 0005).
const blankProps = {
  useSessions(selector) {
    return selector({ current: 'session-a', byId: { 'session-a': { blank: true } } })
  },
  useWorkspaces(selector) {
    return selector({ items: [{ path: '/workspace/a', sessionIds: ['session-a'] }] })
  },
}

// Opens the overlay Sidebar and the Panel over a blank session and returns
// the latest tree. Every step re-renders, the way React re-renders on each
// state change.
function openSidebar(env) {
  let tree = env.render(blankProps)
  railButtons(env.findClass(tree, 'rsb-rail'))[0].props.onClick()
  return env.render(blankProps)
}

function openPanel(env, tree) {
  railButtons(env.findClass(tree, 'rsb-rail'))[1].props.onClick()
  return env.render(blankProps)
}

// 1. Manifest: the gear menu lists three cards with Explorer last, the card
//    renders under its "Explorer" head, and the tree lists the workspace
//    root through listDir(cwd, '').
{
  const env = boot()
  const tree = openSidebar(env)
  env.findClass(tree, 'rsb-iconbtn').props.onClick()
  const gear = env.findClass(env.render(blankProps), 'rsb-gear')
  assert.ok(gear, 'the gear menu must open')
  const titles = []
  env.collectStrings(gear, titles)
  const gearText = titles.join(' ')
  assert.ok(gearText.includes('Source Control'), 'Source Control must stay in the manifest')
  assert.ok(gearText.includes('Commit Graph'), 'Commit Graph must stay in the manifest')
  assert.ok(gearText.includes('Explorer'), 'the Explorer card must be in the manifest')
  assert.ok(gearText.indexOf('Explorer') > gearText.indexOf('Commit Graph'), 'Explorer must sit last in the manifest')

  await tick()
  const panel = env.findClass(env.render(blankProps), 'rsb-panel')
  assert.ok(env.findClass(panel, 'rsb-tree'), 'the Explorer card must render a tree')
  const cards = env.findAll(panel, 'rsb-card')
  assert.equal(cards.length, 3, 'three cards must render')
  const explorerStrings = []
  env.collectStrings(cards[2], explorerStrings)
  assert.ok(explorerStrings.join(' ').includes('Explorer'), 'the third card must be the Explorer')
  assert.deepEqual(
    env.remoteCalls.filter((c) => c.method === 'listDir').map((c) => c.args),
    [['/workspace/a', '']],
    'mounting the card must list the workspace root via listDir(cwd, "")',
  )
  const rows = env.findAll(panel, 'rsb-tree-row')
  assert.equal(rows.length, 3, 'the root listing must render one row per entry')
  const rowText = (row) => {
    const strings = []
    env.collectStrings(row, strings)
    return strings.join(' ')
  }
  assert.ok(rowText(rows[0]).includes('docs'), 'folders must sort before files')
  assert.ok(rowText(rows[1]).includes('demo.html'), 'files must sort together case-insensitively (demo.html before zeta.txt)')
  assert.ok(rowText(rows[2]).includes('zeta.txt'), 'the zeta.txt row must come last')
}
console.log('explorer manifest and root listing check passed')

// 2. Lazy expansion: clicking a folder lists that folder and renders its
//    children indented under it; collapsing hides the children; re-
//    expanding lists again; an empty folder renders its empty state; a
//    failed listing shows the error under the folder.
{
  const env = boot()
  const tree = openSidebar(env)
  await tick()
  let panel = env.findClass(env.render(blankProps), 'rsb-panel')
  assert.equal(env.findAll(panel, 'rsb-tree-row').length, 3, 'only the root is listed before any expansion')

  env.rowWithText(panel, 'rsb-tree-row', 'docs').props.onClick()
  await tick()
  panel = env.findClass(env.render(blankProps), 'rsb-panel')
  const listCalls = env.remoteCalls.filter((c) => c.method === 'listDir').map((c) => c.args)
  assert.ok(listCalls.some((args) => args[1] === 'docs'), 'expanding a folder must call listDir for it')
  let rows = env.findAll(panel, 'rsb-tree-row')
  assert.equal(rows.length, 5, 'the expanded folder must render its children under it')
  const childRow = env.rowWithText(panel, 'rsb-tree-row', 'img')
  assert.ok(String(childRow.props.style.paddingLeft).length > 0, 'child rows must carry an indent style')
  const rootRow = env.rowWithText(panel, 'rsb-tree-row', 'docs')
  assert.ok(childRow.props.style.paddingLeft !== rootRow.props.style.paddingLeft, 'child rows must be indented deeper than the root row')

  env.rowWithText(env.findClass(env.render(blankProps), 'rsb-panel'), 'rsb-tree-row', 'docs').props.onClick()
  panel = env.findClass(env.render(blankProps), 'rsb-panel')
  assert.equal(env.findAll(panel, 'rsb-tree-row').length, 3, 'collapsing a folder must hide its children')

  env.rowWithText(panel, 'rsb-tree-row', 'docs').props.onClick()
  await tick()
  panel = env.findClass(env.render(blankProps), 'rsb-panel')
  assert.equal(env.remoteCalls.filter((c) => c.method === 'listDir' && c.args[1] === 'docs').length, 2, 're-expanding must list the folder again')
  assert.equal(env.findAll(panel, 'rsb-tree-row').length, 5, 're-expanding must render the children again')

  env.rowWithText(panel, 'rsb-tree-row', 'img').props.onClick()
  await tick()
  panel = env.findClass(env.render(blankProps), 'rsb-panel')
  const emptyRow = env.findClass(panel, 'rsb-tree-empty')
  assert.ok(emptyRow, 'an empty folder must render its empty state')
  const emptyStrings = []
  env.collectStrings(emptyRow, emptyStrings)
  assert.ok(emptyStrings.join(' ').includes('(empty)'), 'the empty state must say the folder is empty')

  const env2 = boot({ dirtable: { '': { entries: [{ name: 'broken', kind: 'dir' }], hasMore: false, total: 1 } } })
  const tree2 = openSidebar(env2)
  await tick()
  let panel2 = env2.findClass(env2.render(blankProps), 'rsb-panel')
  env2.rowWithText(panel2, 'rsb-tree-row', 'broken').props.onClick()
  await tick()
  panel2 = env2.findClass(env2.render(blankProps), 'rsb-panel')
  const errRow = env2.findClass(panel2, 'rsb-tree-err')
  assert.ok(errRow, 'a failed listing must render an error row')
  const errStrings = []
  env2.collectStrings(errRow, errStrings)
  assert.ok(errStrings.join(' ').includes('no such directory: broken'), 'the error row must carry the failure message')
}
console.log('explorer lazy expansion check passed')

// 3. Refresh while visible: the 3 s tick re-lists the root and every
//    expanded folder, and nothing else. Card mount order is deterministic
//    (manifest order), so intervals[1] is the Explorer's — GitStatusCard's
//    poll is intervals[0] and Commit Graph never polls.
{
  const env = boot()
  openSidebar(env)
  await tick()
  assert.equal(env.intervals.length, 2, 'exactly two cards may poll: Source Control and Explorer')
  env.rowWithText(env.findClass(env.render(blankProps), 'rsb-panel'), 'rsb-tree-row', 'docs').props.onClick()
  await tick()
  env.rowWithText(env.findClass(env.render(blankProps), 'rsb-panel'), 'rsb-tree-row', 'img').props.onClick()
  await tick()
  env.render(blankProps) // the click's re-render publishes the expanded set
  const before = env.remoteCalls.filter((c) => c.method === 'listDir').length
  env.intervals[1]()
  await tick()
  const refreshed = env.remoteCalls.filter((c) => c.method === 'listDir').slice(before).map((c) => c.args)
  assert.deepEqual(
    refreshed.map((args) => args[1]),
    ['', 'docs', 'docs/img'],
    'one tick must re-list the root and the expanded folders only',
  )
}
console.log('explorer refresh-while-visible check passed')

// 4. The "+N more" row: a listing over the cap renders its 1000 rows plus
//    one row naming the hidden remainder.
{
  const oversize = boot({ dirtable: Object.assign({}, DEFAULT_DIRTABLE, {
    '': { entries: bigEntries, hasMore: true, total: 1003 },
  }) })
  openSidebar(oversize)
  await tick()
  const oversizePanel = oversize.findClass(oversize.render(blankProps), 'rsb-panel')
  const more = oversize.findClass(oversizePanel, 'rsb-tree-more')
  assert.ok(more, 'an over-cap listing must render a more-row')
  const moreStrings = []
  oversize.collectStrings(more, moreStrings)
  assert.ok(moreStrings.join(' ').includes('+3 more'), 'the more-row must name the hidden remainder (1003 - 1000)')
  assert.equal(oversize.findAll(oversizePanel, 'rsb-tree-row').length, 1000, 'an over-cap listing must render exactly the 1000 capped rows')
}
console.log('explorer over-cap row check passed')

// 5. File select opens the Panel with one read-only preview tab (ADR 0007):
//    the pending-open store opens the Panel, the drain creates one
//    html-file tab for demo.html and a markdown-file tab for a .md file,
//    and a repeat select focuses the existing tab instead of duplicating.
{
  const env = boot()
  let tree = openSidebar(env)
  await tick()
  tree = env.render(blankProps)
  assert.equal(env.findClass(tree, 'rsb-bottom-panel'), null, 'the Panel must start closed')

  env.rowWithText(tree, 'rsb-tree-row', 'demo.html').props.onClick()
  tree = env.render(blankProps)
  let panel = env.findClass(tree, 'rsb-bottom-panel')
  assert.ok(panel, 'selecting a file must open the Panel (ADR 0007)')
  assert.equal(env.findAll(panel, 'rsb-tab').length, 1, 'selecting a file must create exactly one tab')
  const htmlTab = env.findAll(panel, 'rsb-tab')[0]
  assert.equal(htmlTab.props.title, 'demo.html', 'the tab must carry the file path as its title')
  await tick()
  panel = env.findClass(env.render(blankProps), 'rsb-bottom-panel')
  assert.ok(env.findClass(panel, 'rsb-tabframe'), 'the preview tab must load the file')
  assert.ok(
    env.remoteCalls.some((c) => c.method === 'readFile' && c.args[1] === 'demo.html'),
    'the preview tab must load through readFile',
  )

  env.rowWithText(env.findClass(env.render(blankProps), 'rsb-panel'), 'rsb-tree-row', 'docs').props.onClick()
  await tick()
  env.rowWithText(env.findClass(env.render(blankProps), 'rsb-panel'), 'rsb-tree-row', 'readme.md').props.onClick()
  tree = env.render(blankProps)
  panel = env.findClass(tree, 'rsb-bottom-panel')
  assert.equal(env.findAll(panel, 'rsb-tab').length, 2, 'a second file must get its own tab')
  const markdownTab = env.findAll(panel, 'rsb-tab')[1]
  assert.equal(markdownTab.props.className.split(' ').includes('rsb-tab-active'), true, 'the new tab must be active')
  assert.equal(markdownTab.props.title, 'docs/readme.md', 'the markdown tab must carry its path')

  env.rowWithText(env.findClass(env.render(blankProps), 'rsb-panel'), 'rsb-tree-row', 'demo.html').props.onClick()
  tree = env.render(blankProps)
  panel = env.findClass(tree, 'rsb-bottom-panel')
  assert.equal(env.findAll(panel, 'rsb-tab').length, 2, 're-selecting a file must not duplicate its tab')
  const active = env.findAll(panel, 'rsb-tab').filter((t) => t.props.className.split(' ').includes('rsb-tab-active'))
  assert.equal(active.length, 1, 'exactly one tab stays active')
  assert.equal(active[0].props.title, 'demo.html', 're-selecting a file must focus its existing tab')
}
console.log('explorer file-select preview check passed')

// 6. With the Panel already open, a file select still lands: the live
//    store subscription drains the request into the open Panel without a
//    remount.
{
  const env = boot()
  let tree = openSidebar(env)
  await tick()
  tree = openPanel(env, tree)
  let panel = env.findClass(tree, 'rsb-bottom-panel')
  assert.ok(panel, 'the Panel must be open from the Rail')
  assert.equal(env.findAll(panel, 'rsb-tab').length, 0, 'the Panel starts with no tabs')

  env.rowWithText(env.findClass(env.render(blankProps), 'rsb-panel'), 'rsb-tree-row', 'demo.html').props.onClick()
  tree = env.render(blankProps)
  panel = env.findClass(tree, 'rsb-bottom-panel')
  assert.equal(env.findAll(panel, 'rsb-tab').length, 1, 'selecting a file into the open Panel must create its tab')
  assert.equal(env.findAll(panel, 'rsb-tab')[0].props.title, 'demo.html', 'the created tab must be the selected file')
}
console.log('explorer open-panel drain check passed')

// 7. The tree scroll area scrolls instead of stretching the card, and the
//    stylesheet pins the tree row height to the constant the card renders.
{
  const env = boot()
  const tree = openSidebar(env)
  const css = env.stylesheet
  assert.ok(/\.rsb-tree \{[^}]*overflow-y: auto/.test(css), 'the tree must scroll, never stretch the card')
  assert.ok(/\.rsb-tree-row \{[^}]*height: 24px; box-sizing: border-box/.test(css), 'tree rows must carry the exact height the card reserves')
  void tree
}
console.log('explorer stylesheet check passed')

console.log('Explorer card check passed')
