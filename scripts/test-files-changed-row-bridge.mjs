#!/usr/bin/env node
// Files Changed Row bridge check (issue #27): a chip on the shipped
// conversation "Files changed" row calls
// ctx.sidebarRight.openResource(<dsh-resource://file/… address>) with an
// optional { params: { line } }. The plugin wraps that method on the service
// instance, so a file address becomes a Panel Tab (with the reported line
// marked) instead of a Rightbar tab, and the original method is never called.
// A dispose restores the original, a frozen service is left alone, and an
// address this build cannot read stays with the shipped behaviour.
//
// Seam (agreed): the address parse, the route into the pending-open store, and
// the restore contract are asserted through the registration the plugin makes
// — the public seam is the wrapped service method, exactly what the shell
// calls. The rendered tree of shell.overlay then proves which Panel Tab
// appeared and which row carries the mark.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const clientFile = process.argv[2] || 'lib/client.js'
const dynamicClient = clientFile === 'dynamic/client.js'
const source = await readFile(new URL('../' + clientFile, import.meta.url), 'utf8')
if (dynamicClient) {
  const bundle = JSON.parse(await readFile(new URL('../dynamic/dsh-sidebar.dynamic.json', import.meta.url), 'utf8'))
  const hostSource = await readFile(new URL('../dynamic/host.js', import.meta.url), 'utf8')
  assert.equal(bundle.client, source, 'the generated dynamic bundle must contain the current client source')
  assert.equal(bundle.host, hostSource, 'the generated dynamic bundle must contain the current host source')
}

const DEFAULT_FILES = {
  'notes.txt': 'one\ntwo\nthree\nfour\nfive\n',
  'src/app.ts': 'const answer: number = 42\n',
  'docs/readme.md': '# Title\n',
  'weird name.txt': 'spaced\n',
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

function boot(env = {}) {
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
  const dynamicStyles = []

  const files = env.files || DEFAULT_FILES
  const calls = []
  const fakeRemote = {
    readFile(...args) {
      calls.push({ method: 'readFile', args })
      const path = args.length > 1 ? args[1] : ''
      if (Object.prototype.hasOwnProperty.call(files, path)) return Promise.resolve({ ok: true, value: { content: files[path] } })
      return Promise.resolve({ ok: false, error: { message: 'no such file: ' + path } })
    },
    gitDiff(...args) {
      calls.push({ method: 'gitDiff', args })
      const path = args.length > 1 ? args[1] : ''
      return Promise.resolve({ ok: true, value: { diff: env.diffFor ? env.diffFor(path) : '' } })
    },
  }

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
        if (method === 'gitDiff') {
          calls.push({ method, args: [payload?.cwd || '', payload?.path || ''] })
          return Promise.resolve({ ok: true, diff: env.diffFor ? env.diffFor(payload?.path || '') : '' })
        }
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

  // The service under test. `openResource` lives on the prototype so the
  // harness can prove a restore removes the plugin's own property again
  // instead of freezing a copy onto the instance.
  const opened = []
  class FakeSidebarRight {
    openResource(address, options) { opened.push({ address, options }) }
  }
  const sidebarRight = env.sidebarRight || new FakeSidebarRight()
  const effects = []
  const registrations = new Map()
  const ctx = {
    get(name) {
      if (name === 'slots') return this.slots
      if (name === 'sidebarRight') return sidebarRight
      if (name === 'layout') {
        return {
          openDetails() {},
          closeDetails() {},
        }
      }
      if (name === 'remote.rsidebarGit') return fakeRemote
      return undefined
    },
    remote: { $mount: async () => async () => {} },
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') effects.push(dispose)
    },
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

  function findClass(node, className) { return findAll(node, className)[0] || null }

  const overlay = registrations.get('shell.overlay')
  const headerToggles = registrations.get('conversation.session.header.utilities')
  return {
    overlay,
    sidebarRight,
    effects,
    opened,
    calls,
    render(props) {
      lastPass = currentPass
      currentPass = new Set()
      const tree = renderFunction(overlay, props)
      visit(tree, () => {})
      return tree
    },
    renderToggles(props) { return renderFunction(headerToggles, props) },
    storage,
    findClass,
    findAll,
    visit,
    collectStrings(node, out) {
      if (node == null || node === false) return
      if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return }
      if (Array.isArray(node)) { for (const child of node) visitCollect(child, out); return }
      if (typeof node !== 'object') return
      if (typeof node.type === 'function') { visitCollect(renderFunction(node.type, node.props), out); return }
      visitCollect(node.props?.children, out)
    },
  }

  function visitCollect(node, out) {
    if (node == null || node === false) return
    if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return }
    if (Array.isArray(node)) { for (const child of node) visitCollect(child, out); return }
    if (typeof node !== 'object') return
    if (typeof node.type === 'function') { visitCollect(renderFunction(node.type, node.props), out); return }
    visitCollect(node.props?.children, out)
  }
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

function railButtons(rail) {
  return (rail.props.children || []).filter((child) => child && child.type === 'button')
}

function openPanel(env) {
  const tree = env.renderToggles(startedProps)
  const buttons = railButtons(env.findClass(tree, 'rsb-header-toggles'))
  if (buttons[1].props['aria-pressed'] !== 'true') buttons[1].props.onClick()
  env.findClass(env.render(startedProps), 'rsb-bottom-panel')
  return env.findClass(env.render(startedProps), 'rsb-bottom-panel')
}

/** Address of one workspace-relative path, in the shell's own grammar. */
function sessionAddress(sessionId, path) {
  const enc = (s) => encodeURIComponent(s).replace(/%3A/gi, ':')
  return 'dsh-resource://file/session/' + enc(sessionId) + '/' + path.split('/').map(enc).join('/')
}

function activeTabs(env, panel) {
  return env.findAll(panel, 'rsb-tab').filter((t) => t.props.className.split(' ').includes('rsb-tab-active'))
}

/** Drive the bridge, then render the Panel that drained the request. */
async function chip(env, address, options) {
  env.sidebarRight.openResource(address, options)
  env.findClass(env.render(startedProps), 'rsb-bottom-panel')
  const panel = env.findClass(env.render(startedProps), 'rsb-bottom-panel')
  await tick()
  return env.findClass(env.render(startedProps), 'rsb-bottom-panel')
}

function tabTypes(env) {
  const key = 'dsh.rsidebar.panels.v1.session-a'
  return JSON.parse(env.storage.get(key)).tabs
}

function markedRow(env, panel) {
  const row = env.findClass(panel, 'rsb-fp-hit')
  return row ? row.props['data-line'] : null
}

// 1. A session-scoped file address opens one Panel Tab for the file, and the
//    original openResource is never reached.
{
  const env = boot()
  const panel = await chip(env, sessionAddress('session-a', 'notes.txt'))
  assert.equal(env.opened.length, 0, 'a file address must never reach the shipped openResource')
  assert.equal(activeTabs(env, panel).length, 1, 'the chip must open exactly one Panel Tab')
  assert.deepEqual(tabTypes(env).map((t) => [t.type, t.path, t.line]), [['text-file', 'notes.txt', undefined]], 'the chip must route by extension and store no line when none is reported')
  assert.equal(env.calls.filter((c) => c.method === 'readFile').length, 1, 'the tab body must load the file once')
}

// 2. The reported line rides into the tab and marks that row.
{
  const env = boot()
  const panel = await chip(env, sessionAddress('session-a', 'notes.txt'), { params: { line: 4 } })
  assert.equal(tabTypes(env)[0].line, 4, 'the reported line must ride the pending request into the tab')
  assert.equal(markedRow(env, panel), 4, 'the reported line must mark its own row')
  assert.equal(env.findAll(panel, 'rsb-fp-line').length, 5, 'a trailing newline must not add a blank row')
  const line = env.findAll(panel, 'rsb-fp-line')[3]
  assert.deepEqual(line.props.className.split(' '), ['rsb-fp-line', 'rsb-fp-hit'], 'only the reported row may carry the mark')
  assert.equal(env.findClass(env.findAll(panel, 'rsb-fp-line')[0], 'rsb-fp-hit'), null, 'row one must stay unmarked')
}

// 3. A second chip for the same file focuses the existing tab and re-marks.
{
  const env = boot()
  await chip(env, sessionAddress('session-a', 'notes.txt'), { params: { line: 2 } })
  const panel = await chip(env, sessionAddress('session-a', 'notes.txt'), { params: { line: 5 } })
  assert.equal(activeTabs(env, panel).length, 1, 'a repeat chip must focus, not append')
  assert.equal(tabTypes(env).length, 1, 'a repeat chip must not store a second tab')
  assert.equal(tabTypes(env)[0].line, 5, 'a repeat chip must re-mark the line it reports')
  assert.equal(markedRow(env, panel), 5, 'the newer line must be the marked row')
}

// 4. The route still follows the extension: a Markdown address opens the
//    Markdown presentation, and the reported line rides the tab even though a
//    rendered frame has no source row to mark. The mark is a Text Preview
//    feature, so a .md or .html chip opens its rendered tab unmarked.
{
  const env = boot()
  const panel = await chip(env, sessionAddress('session-a', 'docs/readme.md'), { params: { line: 3 } })
  assert.deepEqual(tabTypes(env).map((t) => t.type), ['markdown-file'], 'a chip for a .md file must open the Markdown presentation')
  assert.equal(tabTypes(env)[0].line, 3, 'the reported line must still ride the request')
  assert.ok(env.findClass(panel, 'rsb-tabframe'), 'the Markdown presentation must render its frame')
  assert.equal(env.findClass(panel, 'rsb-fp-hit'), null, 'a rendered frame has no source row, so nothing is marked')
}

// 5. Encoded segments decode, a query or fragment suffix is ignored, and an
//    absolute address keeps its path.
{
  const env = boot()
  await chip(env, sessionAddress('session-a', 'weird name.txt'))
  assert.equal(tabTypes(env)[0].path, 'weird name.txt', 'a component-encoded segment must decode to its path')
  const queryEnv = boot()
  await chip(queryEnv, sessionAddress('session-a', 'notes.txt') + '?line=9#top')
  assert.equal(tabTypes(queryEnv)[0].path, 'notes.txt', 'a query and fragment must not become part of the path')
  const absEnv = boot()
  await chip(absEnv, 'dsh-resource://file/absolute/workspace/a/notes.txt', { params: { line: 1 } })
  assert.equal(tabTypes(absEnv)[0].path, '/workspace/a/notes.txt', 'an absolute address must be rooted again')
  assert.equal(absEnv.opened.length, 0, 'an absolute file address must not reach the shipped openResource')
  // The shell encodes a path segment by segment, so an absolute path inside a
  // session address keeps its leading empty segment and arrives as
  // `session/<id>//abs/path`. The parse must keep it absolute, not read it as a
  // one-level-deep relative path.
  const rootedEnv = boot()
  await chip(rootedEnv, sessionAddress('session-a', '/workspace/a/notes.txt'))
  assert.equal(tabTypes(rootedEnv)[0].path, '/workspace/a/notes.txt', 'a rooted path inside a session address must stay absolute')
  assert.equal(rootedEnv.opened.length, 0, 'a rooted session address must not reach the shipped openResource')
}

// 6. Anything this build cannot read stays with the shipped method: another
//    resource type, an unknown scope, a session address with no path, and a
//    segment that will not decode.
{
  const cases = [
    ['dsh-resource://terminal/session-a/1', 'a resource type that is not a file'],
    ['dsh-resource://file/blob/abc', 'a file scope this build does not know'],
    ['dsh-resource://file/session/session-a/', 'a session address with an empty path'],
    ['dsh-resource://file/session/%ZZ/notes.txt', 'a segment that will not decode'],
    ['https://example.com/notes.txt', 'a plain URL'],
    [42, 'a value that is not a string'],
  ]
  for (const [address, why] of cases) {
    const env = boot()
    env.sidebarRight.openResource(address, { params: { line: 3 } })
    assert.deepEqual(
      env.opened.map((o) => o.address),
      [address],
      why + ' must be delegated to the shipped openResource',
    )
    assert.equal(env.storage.has('dsh.rsidebar.panels.v1.session-a'), false, why + ' must not open a Panel Tab')
  }
}

// 7. The wrap is reversible and never freezes a copy onto the instance: after
//    the plugin disposes, the prototype method answers again.
{
  const env = boot()
  assert.equal(Object.prototype.hasOwnProperty.call(env.sidebarRight, 'openResource'), true, 'the plugin must wrap the method on the instance')
  assert.equal(env.effects.length > 0, true, 'the plugin must register its disposers')
  for (const dispose of env.effects) dispose()
  assert.equal(Object.prototype.hasOwnProperty.call(env.sidebarRight, 'openResource'), false, 'a dispose must remove the plugin property again')
  env.sidebarRight.openResource(sessionAddress('session-a', 'notes.txt'), { params: { line: 4 } })
  assert.equal(env.opened.length, 1, 'after a dispose the original method must answer again')
  assert.equal(env.storage.has('dsh.rsidebar.panels.v1.session-a'), false, 'after a dispose a file address must not open a Panel Tab')
}

// 8. A later wrap by another plugin survives this plugin's dispose, and an
//    instance that already owned the method gets its own copy back.
{
  const env = boot()
  const other = () => 'other'
  env.sidebarRight.openResource = other
  for (const dispose of env.effects) dispose()
  assert.equal(env.sidebarRight.openResource, other, 'a dispose must not clobber a wrap made after it')

  const service = { openResource() { return 'mine' } }
  const owned = service.openResource
  const ownEnv = boot({ sidebarRight: service })
  assert.notEqual(service.openResource, owned, 'an own method must still be wrapped while the plugin runs')
  for (const dispose of ownEnv.effects) dispose()
  assert.equal(service.openResource, owned, 'an instance that owned the method must get its own copy back')
  assert.equal(Object.prototype.hasOwnProperty.call(service, 'openResource'), true, 'the restored copy must stay an own property')
}

// 9. A frozen service is left completely alone: no wrap, no throw, no Panel.
{
  const frozenOpened = []
  const frozen = Object.freeze({ openResource(address) { frozenOpened.push(address) } })
  const frozenEnv = boot({ sidebarRight: frozen })
  assert.equal(Object.isFrozen(frozenEnv.sidebarRight), true)
  frozenEnv.sidebarRight.openResource(sessionAddress('session-a', 'notes.txt'))
  assert.equal(frozenOpened.length, 1, 'a frozen service must still route to the shipped method')
  assert.equal(frozenEnv.storage.has('dsh.rsidebar.panels.v1.session-a'), false, 'a frozen service must never open a Panel Tab')
}

// 10. The bridge needs no service at all: a shell without sidebarRight still
//     boots and still serves every other Card.
{
  const env = boot({ sidebarRight: null })
  const panel = openPanel(env)
  assert.ok(panel, 'the Panel must mount without a sidebarRight service')
  assert.equal(env.opened.length, 0, 'nothing may be delegated when the service is absent')
}

console.log('Files Changed Row bridge check passed (' + clientFile + ')')
