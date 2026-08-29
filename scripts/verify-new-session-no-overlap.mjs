#!/usr/bin/env node
// Contract check for the new-session Sidebar: expanding the Sidebar on the
// new-session page must NOT cover the conversation content. Drives a real
// headless Chrome (raw CDP, no dependencies) against the running DSH Web GUI.
//
//   node scripts/verify-new-session-no-overlap.mjs
//
// Exit 0 = the chat area stays clear of the panel. Exit 1 = the panel
// overlaps the conversation content (the reported bug). --probe-fix also
// injects the stylesheet from lib/client.js into the live page and re-runs
// the measurement, to prove the fix mechanism without reinstalling.

import { spawn } from 'node:child_process'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const baseUrl = process.env.DSH_WEB_URL ?? 'http://127.0.0.1:3080'
const chromeBin = process.env.DSH_SIDEBAR_CHROME
  ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const viewport = process.env.DSH_SIDEBAR_VIEWPORT ?? '1440,900'
const probeFix = process.argv.includes('--probe-fix')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Stylesheet text the plugin ships (single source: lib/client.js). */
async function pluginStylesheet() {
  const source = await readFile(join(dirname(fileURLToPath(import.meta.url)), '../lib/client.js'), 'utf8')
  const start = source.indexOf('const CSS = [')
  const end = source.indexOf("].join('\\n')", start)
  if (start === -1 || end === -1) throw new Error('lib/client.js CSS array not found')
  const inner = source.slice(source.indexOf('[', start) + 1, end)
  const lines = new Function(`return [${inner}]`)()
  return lines.join('\n')
}

class Cdp {
  constructor(ws) {
    this.ws = ws
    this.nextId = 1
    this.pending = new Map()
    this.listeners = []
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(typeof event.data === 'string' ? event.data : event.data.toString())
      if (message.id !== undefined && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id)
        this.pending.delete(message.id)
        if (message.error) reject(new Error(`${message.error.message} (${message.error.data ?? ''}`.trim() + ')'))
        else resolve(message.result)
      } else {
        for (const listener of this.listeners) listener(message)
      }
    })
    const settle = (why) => {
      for (const { reject } of this.pending.values()) reject(new Error(`CDP connection ${why}`))
      this.pending.clear()
    }
    ws.addEventListener('close', () => settle('closed'))
    ws.addEventListener('error', () => settle('errored'))
  }
  send(method, params = {}, sessionId, timeoutMs = 15000) {
    const id = this.nextId++
    const payload = { id, method, params }
    if (sessionId) payload.sessionId = sessionId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP ${method} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value) },
        reject: (error) => { clearTimeout(timer); reject(error) },
      })
      this.ws.send(JSON.stringify(payload))
    })
  }
  waitEvent(method, sessionId, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${method}`)), timeoutMs)
      const listener = (message) => {
        if (message.method === method && message.sessionId === sessionId) {
          clearTimeout(timer)
          this.listeners = this.listeners.filter((l) => l !== listener)
          resolve(message.params)
        }
      }
      this.listeners.push(listener)
    })
  }
}

async function evaluate(cdp, sessionId, expression) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
  }, sessionId)
  if (result.exceptionDetails) {
    throw new Error(`page evaluate failed: ${result.exceptionDetails.exception?.description ?? 'unknown'}`)
  }
  return result.result.value
}

const MEASURE = `(() => {
  const panel = document.querySelector('.rsb-overlay-panel')
  const body = document.querySelector('[data-conversation-scroll]')
  if (!panel || !body) return { error: 'panel or conversation body not found' }
  const p = panel.getBoundingClientRect()
  const b = body.getBoundingClientRect()
  return {
    panelWidth: Math.round(p.width),
    panelLeft: p.left,
    bodyRight: b.right,
    overlapPx: b.right - p.left,
  }
})()`

async function main() {
  let chrome
  let profileDir
  let ws
  try {
    profileDir = await mkdtemp(join(tmpdir(), 'rsb-cdp-'))
    chrome = spawn(chromeBin, [
      '--headless=new',
      `--remote-debugging-port=0`,
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      // Chrome's own sandbox and crashpad fight the DSH file sandbox and break
      // the DevTools endpoint; headless needs neither here.
      '--no-sandbox',
      '--disable-gpu',
      '--disable-crashpad',
      '--disable-breakpad',
      `--window-size=${viewport}`,
      'about:blank',
    ], { stdio: ['ignore', 'ignore', 'pipe'] })
    let chromeStderr = ''
    chrome.stderr.on('data', (chunk) => { chromeStderr += chunk.toString() })
    chrome.on('exit', (code) => {
      if (!chrome.killed) console.error(`[chrome exited with code ${code}] stderr tail: ${chromeStderr.split('\n').slice(-12).join(' | ')}`)
    })
    const wsUrl = await new Promise((resolve, reject) => {
      let buffered = ''
      const timer = setTimeout(() => reject(new Error('Chrome did not report a DevTools endpoint')), 15000)
      chrome.stderr.on('data', (chunk) => {
        buffered += chunk.toString()
        const match = buffered.match(/DevTools listening on (ws:\/\/\S+)/)
        if (match) { clearTimeout(timer); resolve(match[1]) }
      })
      chrome.on('exit', (code) => { clearTimeout(timer); reject(new Error(`Chrome exited early (${code})`)) })
    })

    ws = new WebSocket(wsUrl)
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve)
      ws.addEventListener('error', () => reject(new Error('CDP WebSocket failed')))
    })
    const cdp = new Cdp(ws)

    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
    console.log('connected to Chrome; loading the GUI…')
    await cdp.send('Page.enable', {}, sessionId)
    await cdp.send('Page.navigate', { url: baseUrl }, sessionId)
    await cdp.waitEvent('Page.loadEventFired', sessionId).catch(() => {})

    // Wait for the plugin's Rail; the GUI connects its session socket first.
    const deadline = Date.now() + 45000
    let railReady = false
    while (Date.now() < deadline) {
      railReady = await evaluate(cdp, sessionId, `!!document.querySelector('[data-shell-overlay] .rsb-rail')`)
      if (railReady) break
      await sleep(500)
    }
    if (!railReady) throw new Error('the Sidebar Rail did not appear on the page (plugin missing or GUI gate)')
    console.log('GUI loaded; Rail found. Expanding the Sidebar…')

    // The Rail is a two-button bar (ticket #1); the first button is the
    // Sidebar toggle. The container itself has no click action by design.
    await evaluate(cdp, sessionId, `document.querySelector('[data-shell-overlay] .rsb-rail button').click()`)
    const panelDeadline = Date.now() + 5000
    let panelOpen = false
    while (Date.now() < panelDeadline) {
      panelOpen = await evaluate(cdp, sessionId, `!!document.querySelector('.rsb-overlay-panel')`)
      if (panelOpen) break
      await sleep(200)
    }
    if (!panelOpen) throw new Error('clicking the Rail did not open the Sidebar panel')

    const before = await evaluate(cdp, sessionId, MEASURE)
    if (before.error) throw new Error(before.error)
    console.log(`expanded on the new-session page: ${JSON.stringify(before)}`)
    // Half a pixel of tolerance absorbs sub-pixel layout rounding.
    const cleanBefore = before.overlapPx <= 0.5

    let cleanAfter = null
    if (probeFix) {
      const css = await pluginStylesheet()
      await evaluate(cdp, sessionId, `(() => {
        const el = document.createElement('style')
        el.id = 'rsb-probe-fix'
        el.textContent = ${JSON.stringify(css)}
        document.head.appendChild(el)
      })()`)
      await sleep(700) /* let the padding transition settle */
      const after = await evaluate(cdp, sessionId, MEASURE)
      if (after.error) throw new Error(after.error)
      console.log(`with the lib/client.js stylesheet injected: ${JSON.stringify(after)}`)
      cleanAfter = after.overlapPx <= 0.5
    }

    if (cleanBefore) {
      console.log('PASS: the conversation content stays clear of the expanded Sidebar.')
      process.exitCode = 0
    } else if (cleanAfter === true) {
      console.log('FAIL on the installed plugin, but the lib/client.js stylesheet fixes the overlap on this page.')
      process.exitCode = 1
    } else {
      console.log('FAIL: the expanded Sidebar covers the conversation content on the new-session page.')
      process.exitCode = 1
    }
  } finally {
    if (ws) try { ws.close() } catch {}
    if (chrome) chrome.kill()
    if (profileDir) await rm(profileDir, { recursive: true, force: true }).catch(() => {})
  }
}

await main()
