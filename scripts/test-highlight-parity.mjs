#!/usr/bin/env node
// Text Preview highlighting parity check (issue #27): both client twins carry
// the same vendored Prism build and must colour a file into exactly the same
// rows. The suite boots each twin for real, opens a Text Preview through the
// Panel picker, and compares the rendered rows byte for byte; it also pins the
// generated Prism block itself, the extension table, and the 512 KB limit, so
// a change to one twin alone cannot pass.
//
// Seam (agreed): the rendered Panel Tab body of the shell.overlay tree, plus
// the generated block text between the vendoring markers.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const CLIENTS = ['lib/client.js', 'dynamic/client.js']
const HIGHLIGHT_LIMIT = 512 * 1024

const sources = {}
for (const file of CLIENTS) {
  sources[file] = await readFile(new URL('../' + file, import.meta.url), 'utf8')
}
{
  const bundle = JSON.parse(await readFile(new URL('../dynamic/dsh-sidebar.dynamic.json', import.meta.url), 'utf8'))
  assert.equal(bundle.client, sources['dynamic/client.js'], 'the generated dynamic bundle must contain the current client source')
}

const BEGIN = '// >>> GENERATED: vendored prismjs 1.29.0 — edit lib/vendor/prism/ and run: npm run sync:vendor >>>'
const END = '// <<< END GENERATED prism block <<<'

function prismBlockOf(source) {
  const start = source.indexOf(BEGIN)
  assert.notEqual(start, -1, 'every twin must carry the generated Prism marker')
  const end = source.indexOf(END, start)
  assert.notEqual(end, -1, 'every twin must close the generated Prism block')
  return source.slice(start + BEGIN.length, end)
}

function tableOf(source) {
  // The table body ends at the first line that closes it: every entry line
  // ends in a comma, so the first `}`-first line is the terminator (the twins
  // indent it differently, so the match allows any indentation).
  const m = /const PRISM_BY_EXT = \{([\s\S]*?)\n\s*\}/.exec(source)
  assert.ok(m, 'every twin must carry the extension table')
  return m[1].replace(/\s+/g, ' ').trim()
}

// 1. One vendored Prism build, byte for byte, and one extension table.
{
  const [lib, dyn] = CLIENTS.map((f) => prismBlockOf(sources[f]))
  assert.equal(lib, dyn, 'the generated Prism block must be identical in both twins')
  assert.ok(lib.length > 50000, 'the vendored Prism block must actually carry the grammars')
  assert.equal(tableOf(sources['lib/client.js']), tableOf(sources['dynamic/client.js']), 'the extension table must be identical in both twins')
  for (const file of CLIENTS) {
    assert.match(sources[file], /const HIGHLIGHT_LIMIT = 512 \* 1024/, file + ': the highlight limit must be 512 KB')
    assert.match(sources[file], /const FP_ROW_H = 18/, file + ': the row height must come from FP_ROW_H')
  }
}

// ---------------------------------------------------------------------------
// Browser harness: one real boot per twin, per file
// ---------------------------------------------------------------------------

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

function boot(clientFile, files) {
  const source = sources[clientFile]
  const dynamicClient = clientFile === 'dynamic/client.js'
  const hookState = new Map()
  let activeToken = null
  let hookIndex = 0
  let currentPass = new Set()
  let lastPass = new Set()
  function hooksFor() {
    let hooks = hookState.get(activeToken)
    if (!hooks) { hooks = []; hookState.set(activeToken, hooks) }
    return hooks
  }
  const React = {
    Fragment: Symbol('Fragment'),
    createElement(type, props, ...children) { return { type, props: { ...(props || {}), children } } },
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

  const storage = new Map()
  const localStorage = {
    getItem(k) { return storage.has(k) ? storage.get(k) : null },
    setItem(k, v) { storage.set(k, String(v)) },
  }
  const styleElements = []
  const dynamicStyles = []
  const calls = []
  const fakeRemote = {
    readFile(...args) {
      calls.push({ method: 'readFile', args })
      const path = args.length > 1 ? args[1] : ''
      if (Object.prototype.hasOwnProperty.call(files, path)) return Promise.resolve({ ok: true, value: { content: files[path] } })
      return Promise.resolve({ ok: false, error: { message: 'no such file: ' + path } })
    },
    status() { return Promise.resolve({ ok: true, value: { repo: false, root: '', branch: '', detached: false, upstream: null, ahead: 0, behind: 0, staged: [], unstaged: [], conflicts: [], fingerprint: '' } }) },
  }

  const centerCol = {
    _rect: { left: 280, right: 1180, top: 0, bottom: 900, width: 900, height: 900 },
    getBoundingClientRect() { return this._rect },
  }
  const frame = { children: [{}, centerCol, {}] }
  const overlayElement = { parentElement: frame }
  class ResizeObserver {
    constructor(callback) { this.callback = callback }
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
      innerHeight: 900,
    },
    document: {
      querySelector(selector) { return selector === '[data-shell-overlay]' ? overlayElement : null },
      createElement() { return { textContent: '', remove() {} } },
      head: { appendChild(el) { styleElements.push(el) } },
    },
    ResizeObserver,
    navigator: undefined,
    localStorage,
    React,
    styles: { insert(rules) { dynamicStyles.push(...(Array.isArray(rules) ? rules : [rules])) } },
    host: {
      call(method, payload) {
        if (method === 'readFile') {
          calls.push({ method, args: [payload?.cwd || '', payload?.path || ''] })
          const path = payload?.path || ''
          if (Object.prototype.hasOwnProperty.call(files, path)) return Promise.resolve({ ok: true, content: files[path] })
          return Promise.resolve({ ok: false, error: 'no such file: ' + path })
        }
        if (method === 'status') return Promise.resolve({ ok: true, repo: false, root: '', branch: '', detached: false, upstream: null, ahead: 0, behind: 0, staged: [], unstaged: [], conflicts: [], fingerprint: '' })
        return Promise.resolve({ ok: true })
      },
    },
    console,
    Promise,
    Set,
    Map,
    Object,
    JSON,
    Error,
  }
  if (dynamicClient) {
    plugin = vm.runInNewContext('(function (React, host) {\n' + source + '\n})(React, host)', context, { filename: clientFile })
  } else {
    vm.runInNewContext(source, context, { filename: clientFile })
  }

  const registrations = new Map()
  const ctx = {
    get(name) {
      if (name === 'slots') return this.slots
      if (name === 'layout') return { openDetails() {}, closeDetails() {} }
      if (name === 'remote.rsidebarGit') return fakeRemote
      return undefined
    },
    remote: { $mount: async () => async () => {} },
    effect(fn) { const d = fn(); if (typeof d === 'function') return d },
    interval() { return () => {} },
    timeout() {},
    slots: {
      inject(_name, install) { install() },
      register(options, render) { registrations.set(options.name, render); return () => {} },
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
    if (Array.isArray(node)) { for (const child of node) visit(child, fn); return }
    if (typeof node !== 'object') return
    fn(node)
    if (typeof node.type === 'function') { visit(renderFunction(node.type, node.props), fn); return }
    visit(node.props?.children, fn)
  }

  function findAll(node, className, out = []) {
    visit(node, (n) => { if (n.props?.className?.split(' ').includes(className)) out.push(n) })
    return out
  }

  const overlay = registrations.get('shell.overlay')
  const headerToggles = registrations.get('conversation.session.header.utilities')
  return {
    calls,
    storage,
    render(props) {
      lastPass = currentPass
      currentPass = new Set()
      const tree = renderFunction(overlay, props)
      visit(tree, () => {})
      return tree
    },
    renderToggles(props) { return renderFunction(headerToggles, props) },
    findClass(node, className) { return findAll(node, className)[0] || null },
    findAll,
    visit,
    collectStrings(node, out) {
      if (node == null || node === false) return
      if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return }
      if (Array.isArray(node)) { for (const child of node) stringsOf(child, out, renderFunction); return }
      if (typeof node !== 'object') return
      if (typeof node.type === 'function') { stringsOf(renderFunction(node.type, node.props), out, renderFunction); return }
      stringsOf(node.props?.children, out, renderFunction)
    },
  }
}

function stringsOf(node, out, renderFunction) {
  if (node == null || node === false) return
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return }
  if (Array.isArray(node)) { for (const child of node) stringsOf(child, out, renderFunction); return }
  if (typeof node !== 'object') return
  if (typeof node.type === 'function') { stringsOf(renderFunction(node.type, node.props), out, renderFunction); return }
  stringsOf(node.props?.children, out, renderFunction)
}

const props = {
  sessionId: 'session-a',
  useSessions(selector) {
    return selector({ current: 'session-a', byId: { 'session-a': { blank: true } } })
  },
  useWorkspaces(selector) {
    return selector({ items: [{ path: '/workspace/a', sessionIds: ['session-a'] }] })
  },
}

function railButtons(rail) {
  return (rail.props.children || []).filter((child) => child && child.type === 'button')
}

function buttonWithText(env, node, text) {
  let found = null
  env.visit(node, (n) => {
    if (found || n.type !== 'button') return
    const strings = []
    env.collectStrings(n, strings)
    if (strings.join(' ').includes(text)) found = n
  })
  return found
}

/** Open a Text Preview tab for one path and return its rendered rows. */
async function rowsFor(clientFile, path, content) {
  const env = boot(clientFile, { [path]: content })
  const buttons = railButtons(env.findClass(env.renderToggles(props), 'rsb-header-toggles'))
  if (buttons[1].props['aria-pressed'] !== 'true') buttons[1].props.onClick()
  let panel = env.findClass(env.render(props), 'rsb-bottom-panel')
  env.findClass(panel, 'rsb-tabstrip-add').props.onClick()
  panel = env.findClass(env.render(props), 'rsb-bottom-panel')
  buttonWithText(env, panel, 'Text file').props.onClick()
  panel = env.findClass(env.render(props), 'rsb-bottom-panel')
  env.findClass(env.findClass(panel, 'rsb-tab-picker-form'), 'rsb-tab-picker-input').props.onChange({ target: { value: path } })
  env.findClass(env.render(props), 'rsb-tab-picker-form').props.onSubmit({ preventDefault() {} })
  panel = env.findClass(env.render(props), 'rsb-bottom-panel')
  await tick()
  panel = env.findClass(env.render(props), 'rsb-bottom-panel')
  const bar = env.findClass(panel, 'rsb-fp-bar')
  const meta = []
  env.collectStrings(env.findClass(bar, 'rsb-fp-meta'), meta)
  return {
    meta: meta.join(' '),
    rows: env.findAll(panel, 'rsb-fp-line').map((line) => env.findClass(line, 'rsb-fp-src').props.dangerouslySetInnerHTML.__html),
  }
}

// ---------------------------------------------------------------------------
// 2. One highlighting result per file, in both twins
// ---------------------------------------------------------------------------

const CASES = [
  { path: 'src/app.ts', content: 'const n: number = 1\n/* a block\n   comment */\nexport default n\n', grammar: 'typescript' },
  { path: 'src/App.tsx', content: 'const el = <div className="x">hi</div>\n', grammar: 'tsx' },
  { path: 'style.css', content: 'a { color: red; }\n', grammar: 'css' },
  { path: 'data.json', content: '{"a": [1, 2], "b": true}\n', grammar: 'json' },
  { path: 'run.sh', content: '#!/bin/sh\necho "hi"\n', grammar: 'bash' },
  { path: 'main.py', content: 'def f(x):\n    return x + 1\n', grammar: 'python' },
  { path: 'main.go', content: 'package main\nfunc main() {}\n', grammar: 'go' },
  { path: 'main.rs', content: 'fn main() { let x: u32 = 1; }\n', grammar: 'rust' },
  { path: 'index.html', content: '<p class="a">hi</p>\n', grammar: 'markup' },
  { path: 'README.md', content: '# Title\n\n**bold**\n', grammar: 'markdown' },
  { path: 'conf.yml', content: 'a: 1\nb:\n  - c\n', grammar: 'yaml' },
  { path: 'Cargo.toml', content: '[package]\nname = "x"\n', grammar: 'toml' },
  { path: 'app.ini', content: '[section]\nkey = value\n', grammar: 'ini' },
  { path: 'patch.diff', content: '-a\n+b\n', grammar: 'diff' },
  { path: 'Dockerfile', content: 'FROM node:20\nRUN echo hi\n', grammar: 'docker' },
  { path: 'notes.txt', content: 'plain <b>\ttab\n&amp;\n', grammar: '' },
  { path: 'Makefile', content: 'all:\n\techo hi\n', grammar: '' },
]

for (const entry of CASES) {
  const lib = await rowsFor('lib/client.js', entry.path, entry.content)
  const dyn = await rowsFor('dynamic/client.js', entry.path, entry.content)
  assert.deepEqual(dyn, lib, entry.path + ': both twins must render identical rows')
  assert.equal(lib.meta, entry.grammar || 'plain', entry.path + ': the toolbar must name the grammar it used, or say plain')
  const coloured = lib.rows.some((row) => row.indexOf('<span class="token') !== -1)
  assert.equal(coloured, entry.grammar !== '', entry.path + ': colouring must follow the extension table')
  if (!entry.grammar && entry.content.indexOf('<') !== -1) {
    assert.ok(lib.rows.some((row) => row.indexOf('&lt;b&gt;') !== -1), entry.path + ': a plain row must still escape its markup')
    assert.ok(lib.rows.some((row) => row.indexOf('&amp;amp;') !== -1), entry.path + ': a plain row must still escape its ampersand')
  }
}

// 3. A token that crosses a newline is closed at the end of its line and
//    reopened on the next one, so every row stays well formed on its own.
{
  const content = '/* first\nsecond\nthird */\nconst a = 1\n'
  const lib = await rowsFor('lib/client.js', 'multi.ts', content)
  const dyn = await rowsFor('dynamic/client.js', 'multi.ts', content)
  assert.deepEqual(dyn, lib, 'a multi-line token must split identically in both twins')
  assert.equal(lib.rows.length, 4, 'one row per source line, with no blank row for the trailing newline')
  for (const row of lib.rows) {
    const open = (row.match(/<span/g) || []).length
    const close = (row.match(/<\/span>/g) || []).length
    assert.equal(open, close, 'every row must close the spans it opens: ' + row)
  }
  assert.ok(lib.rows[0].indexOf('token comment') !== -1, 'line one must start the comment token')
  assert.ok(lib.rows[1].indexOf('token comment') !== -1, 'the middle line must reopen the comment token')
  assert.ok(lib.rows[2].indexOf('token comment') !== -1, 'the closing line must still be a comment')
  assert.ok(lib.rows[3].indexOf('token comment') === -1, 'the line after the comment must not be a comment')
}

// 4. Over the 512 KB limit the file stays plain, in both twins, and the
//    toolbar says why. One byte under the limit still colours.
{
  const over = 'x'.repeat(HIGHLIGHT_LIMIT + 1)
  const lib = await rowsFor('lib/client.js', 'big.js', over)
  const dyn = await rowsFor('dynamic/client.js', 'big.js', over)
  assert.deepEqual(dyn, lib, 'an over-limit file must render identically in both twins')
  assert.equal(lib.rows.length, 1, 'the over-limit file has one line')
  assert.equal(lib.rows[0].indexOf('<span class="token'), -1, 'an over-limit file must never be coloured')
  assert.equal(lib.meta, 'plain — over 512 KB', 'the toolbar must report the size limit')
}

// 5. A language the vendored build does not carry stays plain even when the
//    extension is one the table names only because Prism lacks it. The table
//    is the single source of truth, so an unknown extension is the same case.
{
  const lib = await rowsFor('lib/client.js', 'weird.zz', 'a <b> c\n')
  const dyn = await rowsFor('dynamic/client.js', 'weird.zz', 'a <b> c\n')
  assert.deepEqual(dyn, lib, 'an unknown extension must render identically in both twins')
  assert.equal(lib.meta, 'plain', 'an unknown extension must say plain')
  assert.equal(lib.rows[0], 'a &lt;b&gt; c', 'an unknown extension must escape its markup')
}

console.log('Text Preview highlighting parity check passed')
