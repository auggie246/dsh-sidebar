#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
const registrations = new Map()
const hooksByComponent = new Map()
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
      effect()
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
  Object,
  JSON,
  Error,
}, { filename: 'lib/client.js' })

const statusCwds = []
const statusResult = {
  repo: false,
  root: '/example/project',
  branch: '',
  detached: false,
  upstream: null,
  ahead: 0,
  behind: 0,
  staged: [],
  unstaged: [],
  conflicts: [],
  fingerprint: '',
}
const git = {
  status(cwd) {
    statusCwds.push(cwd)
    return Promise.resolve({ ok: true, value: statusResult })
  },
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

function findComponent(node, name) {
  if (node == null || node === false) return null
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findComponent(child, name)
      if (found) return found
    }
    return null
  }
  if (typeof node !== 'object') return null
  if (typeof node.type === 'function' && node.type.name === name) return node
  return findComponent(node.props?.children, name)
}

const details = registrations.get('details')
assert.equal(typeof details, 'function', 'the details Sidebar must be registered')
const workspacePath = '/workspace/project'
const stableProps = {
  sessionId: 'session-1',
  useSessions(selector) {
    return selector({ current: 'session-1', byId: { 'session-1': { blank: false } } })
  },
  useWorkspaces(selector) {
    return selector({ items: [{ path: workspacePath, sessionIds: ['session-1'] }] })
  },
}
const transientProps = {
  ...stableProps,
  useWorkspaces(selector) {
    return selector({ items: [] })
  },
}

let sidebarElement = renderFunction(details, stableProps)
renderFunction(sidebarElement.type, sidebarElement.props)
sidebarElement = renderFunction(details, transientProps)
const sidebarTree = renderFunction(sidebarElement.type, sidebarElement.props)
const statusCard = findComponent(sidebarTree, 'GitStatusCard')
assert.ok(statusCard, 'the Source Control Card must render')
renderFunction(statusCard.type, statusCard.props)

assert.deepEqual(statusCwds, [workspacePath], 'a transient workspace miss must retain the last resolved workspace path')

const nextSessionProps = {
  ...transientProps,
  sessionId: 'session-2',
}
sidebarElement = renderFunction(details, nextSessionProps)
const nextSessionTree = renderFunction(sidebarElement.type, sidebarElement.props)
const nextStatusCard = findComponent(nextSessionTree, 'GitStatusCard')
hooksByComponent.delete(nextStatusCard.type)
renderFunction(nextStatusCard.type, nextStatusCard.props)
assert.deepEqual(statusCwds, [workspacePath, ''], 'a session change must not reuse the previous session workspace path')
console.log('workspace cwd retention check passed')
