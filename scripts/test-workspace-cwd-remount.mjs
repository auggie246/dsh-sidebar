#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
const registrations = new Map()
const hooksByComponent = new Map()
const pendingEffects = []
let activeComponent = null
let hookIndex = 0

function sameDeps(left, right) {
  return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => Object.is(value, right[index]))
}

const React = {
  Fragment: Symbol('Fragment'),
  createElement(type, props, ...children) {
    return { type, props: { ...(props || {}), children } }
  },
  useState(initial) {
    const hooks = hooksByComponent.get(activeComponent) || []
    hooksByComponent.set(activeComponent, hooks)
    const index = hookIndex++
    if (!(index in hooks)) hooks[index] = typeof initial === 'function' ? initial() : initial
    return [hooks[index], (value) => {
      hooks[index] = typeof value === 'function' ? value(hooks[index]) : value
    }]
  },
  useEffect(effect, deps) {
    const hooks = hooksByComponent.get(activeComponent) || []
    hooksByComponent.set(activeComponent, hooks)
    const index = hookIndex++
    if (!sameDeps(hooks[index], deps)) {
      hooks[index] = deps
      pendingEffects.push(effect)
    }
  },
}

let plugin
vm.runInNewContext(source, {
  window: { __ModuleLoader__: { load(definition) { plugin = definition.factory(() => React) } } },
  document: undefined,
  navigator: undefined,
  localStorage: undefined,
  console,
  Promise,
  Set,
  Map,
  Object,
  JSON,
  Error,
}, { filename: 'lib/client.js' })

const statusCwds = []
const git = {
  status(cwd) {
    statusCwds.push(cwd)
    return Promise.resolve({
      ok: true,
      value: {
        repo: false,
        root: cwd || '/example/project',
        branch: '',
        detached: false,
        upstream: null,
        ahead: 0,
        behind: 0,
        staged: [],
        unstaged: [],
        conflicts: [],
        fingerprint: '',
      },
    })
  },
  log() { return Promise.resolve({ ok: true, value: { commits: [], hasMore: false } }) },
}
const ctx = {
  get(name) {
    if (name === 'layout') return { openDetails() {}, closeDetails() {} }
    if (name === 'remote.rsidebarGit') return git
    return undefined
  },
  remote: { $mount: async () => async () => {} },
  effect() {},
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

function renderTree(node) {
  if (node == null || node === false || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const child of node) renderTree(child)
    return
  }
  if (typeof node.type === 'function') {
    renderTree(renderFunction(node.type, node.props))
    return
  }
  renderTree(node.props?.children)
}

const details = registrations.get('details')
assert.equal(typeof details, 'function', 'the details Sidebar must be registered')
const workspacePath = '/workspace/project'
const props = {
  sessionId: 'session-1',
  useSessions(selector) {
    return selector({ current: undefined, byId: { 'session-1': { blank: false } } })
  },
  useWorkspaces(selector) {
    return selector({ items: [{ path: workspacePath, sessionIds: ['session-1'] }] })
  },
}

renderTree(renderFunction(details, props))
for (let index = pendingEffects.length - 1; index >= 0; index--) pendingEffects[index]()

assert.deepEqual(statusCwds, [workspacePath], 'the Source Control mount refresh must receive the workspace path before parent effects run')
console.log('workspace cwd remount check passed')
