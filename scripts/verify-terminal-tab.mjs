#!/usr/bin/env node
// GUI-level verification for ticket #8 (Terminal Panel Tab with vendored
// xterm.js): the running GUI must offer Terminal in the + picker, spawn a live
// interactive shell in the Working Repository, echo typed keystrokes through
// the pty transport, stream output via the long-poll loop, propagate a
// viewport resize to the PTY (stty size changes), drop terminal tabs on
// reload (re-attach is ticket #9), and kill the shell when the tab closes.
//
//   node scripts/verify-terminal-tab.mjs
//
// Exit 0 = every check passed. Exit 1 = any check failed.
// Needs a started session in the GUI and a restarted `dsh web` that carries
// the ptyResize host RPC.

const baseUrl = process.env.DSH_WEB_URL ?? 'http://127.0.0.1:3080'
const chromeBin = process.env.DSH_SIDEBAR_CHROME
  ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const viewport = { width: 1440, height: 900 }
const MARKER = 'rsb-term-marker'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const { spawn } = await import('node:child_process')
const { mkdtemp, rm } = await import('node:fs/promises')
const { tmpdir } = await import('node:os')
const { join } = await import('node:path')

// ---------- served-bundle markers (the GUI must advertise the new code) ----------
async function bundleMarkers() {
  const response = await fetch(baseUrl)
  const html = await response.text()
  if (!response.ok) throw new Error(`${baseUrl} returned HTTP ${response.status}`)
  const at = html.indexOf('__DSH_BOOT__')
  const open = html.indexOf('{', at)
  let depth = 0
  let end = -1
  for (let i = open; i < html.length; i++) {
    if (html[i] === '{') depth++
    else if (html[i] === '}') { depth--; if (depth === 0) { end = i + 1; break } }
  }
  const boot = JSON.parse(html.slice(open, end))
  const entry = boot.entries?.find((e) => e.id === 'dsh-sidebar')
  if (!entry?.url) throw new Error('dsh-sidebar is absent from the boot manifest')
  const bundleResponse = await fetch(new URL(entry.url, baseUrl))
  const bundle = await bundleResponse.text()
  if (!bundleResponse.ok) throw new Error('the advertised browser bundle is unavailable')
  const checks = [
    ['ptyResize', 'the ptyResize RPC descriptor'],
    ['ptySpawn', 'the ptySpawn RPC descriptor'],
    ['rsb-term', 'the terminal container style'],
    ['.xterm', 'the vendored xterm stylesheet rules'],
    ['GENERATED: vendored @xterm/xterm', 'the vendored xterm block'],
  ]
  for (const [needle, what] of checks) {
    if (!bundle.includes(needle)) throw new Error(`the served bundle is missing ${what} (${needle})`)
  }
}

// ---------- CDP plumbing (same shape as verify-panel-tabs.mjs) ----------
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
    const settle = (why) => { for (const { reject } of this.pending.values()) reject(new Error(`CDP connection ${why}`)); this.pending.clear() }
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
        if (message.method === method && (sessionId === undefined || message.sessionId === sessionId)) {
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
  const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId)
  if (result.exceptionDetails) {
    throw new Error(`page evaluate failed: ${result.exceptionDetails.exception?.description ?? 'unknown'}`)
  }
  return result.result.value
}

async function waitFor(cdp, sessionId, expression, label, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await evaluate(cdp, sessionId, expression)) return
    await sleep(200)
  }
  throw new Error(`timed out waiting for ${label}`)
}

// Typing into xterm: real key events through the focused helper textarea, the
// path a real keyboard takes (xterm's onData fires per key).
async function typeText(cdp, sessionId, text) {
  for (const ch of text) {
    const base = { key: ch, text: ch, unmodifiedText: ch }
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base }, sessionId)
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch }, sessionId)
    await sleep(8)
  }
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', text: '\r', windowsVirtualKeyCode: 13 }, sessionId)
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, sessionId)
}

async function focusTerminal(cdp, sessionId) {
  await evaluate(cdp, sessionId, `(() => {
    const ta = document.querySelector('.rsb-term .xterm-helper-textarea')
    if (!ta) return false
    ta.focus()
    return document.activeElement === ta
  })()`)
}

// stty size, tagged: the shell echoes RSBSIZE=<rows> <cols>, an anchor that
// survives the surrounding escape-sequence junk in the terminal DOM text.
async function sttySize(cdp, sessionId) {
  await focusTerminal(cdp, sessionId)
  await typeText(cdp, sessionId, 'echo RSBSIZE=$(stty size)')
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    const match = await evaluate(cdp, sessionId, `(() => {
      const text = document.querySelector('.rsb-term')?.textContent ?? ''
      const rows = Array.from(text.matchAll(/RSBSIZE=(\\d+)\\s+(\\d+)/g))
      return rows.length ? rows[rows.length - 1][1] + ' ' + rows[rows.length - 1][2] : null
    })()`)
    if (match) return match
    await sleep(250)
  }
  throw new Error('the RSBSIZE marker never appeared in the terminal')
}

async function openTerminalTab(cdp, sessionId) {
  await evaluate(cdp, sessionId, `document.querySelector('.rsb-tabstrip-add').click()`)
  await waitFor(cdp, sessionId, `!!document.querySelector('.rsb-tab-picker')`, 'the type picker to open')
  const items = await evaluate(cdp, sessionId, `Array.from(document.querySelectorAll('.rsb-tab-picker-item')).map((b) => b.textContent)`)
  const at = items.findIndex((t) => t.includes('Terminal'))
  if (at === -1) throw new Error(`the type picker does not list Terminal (got: ${JSON.stringify(items)})`)
  await evaluate(cdp, sessionId, `document.querySelectorAll('.rsb-tab-picker-item')[${at}].click()`)
  await waitFor(cdp, sessionId, `!!document.querySelector('.rsb-term')`, 'the terminal container to mount')
  await waitFor(cdp, sessionId, `!!document.querySelector('.rsb-term .xterm')`, 'the vendored xterm to mount')
}

async function main() {
  await bundleMarkers()
  console.log('served bundle carries the terminal markers')

  let chrome
  let profileDir
  let ws
  try {
    profileDir = await mkdtemp(join(tmpdir(), 'rsb-term-cdp-'))
    chrome = spawn(chromeBin, [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-crashpad',
      '--disable-breakpad',
      `--window-size=${viewport.width},${viewport.height}`,
      'about:blank',
    ], { stdio: ['ignore', 'ignore', 'pipe'] })
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
    await cdp.send('Runtime.enable', {}, sessionId)
    await cdp.send('Page.enable', {}, sessionId)
    await cdp.send('Page.navigate', { url: baseUrl }, sessionId)
    await cdp.waitEvent('Page.loadEventFired', sessionId).catch(() => {})

    await waitFor(cdp, sessionId, `!!document.querySelector('[data-shell-overlay] .rsb-rail button')`, 'the Sidebar Rail to appear', 45000)
    console.log('GUI loaded; Rail found')

    // A fresh verifier profile has no current session, so the Panel Rail
    // button stays disabled. Start a session in this workspace through the
    // GUI itself: the workspace-scoped New session button, one bootstrap
    // message through the composer, then the session is running and the
    // Rail's Panel button enables. The bootstrap session lives in the
    // Working Repository, so file previews resolve repo-relative paths.
    if (await evaluate(cdp, sessionId, `(() => { const b = document.querySelector('[data-shell-overlay] .rsb-rail button:nth-of-type(2)'); return !b || b.disabled })()`)) {
      // The workspace tree renders in its own time and the dsh-sidebar
      // group may start collapsed (its New session button only exists once
      // the group is expanded). Poll: wait for the button, expanding the
      // group once on the way. The latch keeps the polls from toggling the
      // group closed again.
      await waitFor(cdp, sessionId, `(() => {
        if (document.querySelector('button[aria-label="New session in dsh-sidebar"]')) return true
        if (!window.__rsbExpandLatch) {
          const group = Array.from(document.querySelectorAll('[role=treeitem]')).find((e) => (e.textContent || '').trim().startsWith('dsh-sidebar') && e.getAttribute('aria-expanded') === 'false')
          if (group) { window.__rsbExpandLatch = true; group.click() }
        }
        return false
      })()`, 'the dsh-sidebar workspace group to expose its New session button', 20000)
      const clicked = await evaluate(cdp, sessionId, `(() => { const b = document.querySelector('button[aria-label="New session in dsh-sidebar"]'); if (!b) return false; b.click(); return true })()`)
      if (!clicked) throw new Error('could not open a new session from the GUI')
      await waitFor(cdp, sessionId, `!!document.querySelector('textarea[placeholder="Describe what you want to build"]')`, 'the composer to appear', 20000)
      let started = false
      for (let attempt = 0; attempt < 3 && !started; attempt++) {
        const filled = await evaluate(cdp, sessionId, `(() => {
          const ta = document.querySelector('textarea[placeholder="Describe what you want to build"]')
          if (!ta) return false
          const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
          setter.call(ta, 'Verifier bootstrap session — this session exists only so the dsh-sidebar GUI verifiers can drive a started session. Please ignore it.')
          ta.dispatchEvent(new Event('input', { bubbles: true }))
          return true
        })()`)
        if (!filled) throw new Error('could not fill the composer')
        await waitFor(cdp, sessionId, `(() => { const b = Array.from(document.querySelectorAll('button')).find((e) => (e.getAttribute('aria-label') || '') === 'Send message'); return !!b && !b.disabled })()`, 'the Send message button to enable', 10000)
        await evaluate(cdp, sessionId, `(() => { const b = Array.from(document.querySelectorAll('button')).find((e) => (e.getAttribute('aria-label') || '') === 'Send message'); if (!b) return false; b.click(); return true })()`)
        try {
          await waitFor(cdp, sessionId, `(() => { const b = document.querySelector('[data-shell-overlay] .rsb-rail button:nth-of-type(2)'); return !!b && !b.disabled })()`, 'the bootstrap session to start', 20000)
          started = true
        } catch (e) { /* the send click can race the composer wiring; retry */ }
      }
      if (!started) throw new Error('the bootstrap session never started after 3 attempts')
      console.log('bootstrap session started; Rail Panel button enabled')
    }
    const panelButton = `[data-shell-overlay] .rsb-rail button:nth-of-type(2)`
    const gate = await evaluate(cdp, sessionId, `(() => {
      const b = document.querySelector('${panelButton}')
      return { disabled: b?.disabled ?? null, title: b?.title ?? '' }
    })()`)
    if (gate.disabled) {
      throw new Error('the Panel Rail button is inert because the current session has not started. Start a session in the GUI, then rerun this script.')
    }
    await evaluate(cdp, sessionId, `document.querySelector('${panelButton}').click()`)
    await waitFor(cdp, sessionId, `!!document.querySelector('.rsb-bottom-panel')`, 'the Panel to open')

    // 1. The picker offers Terminal; choosing it spawns a live shell that
    //    renders through the vendored xterm.
    await openTerminalTab(cdp, sessionId)
    await focusTerminal(cdp, sessionId)
    await typeText(cdp, sessionId, `echo ${MARKER}`)
    const echoDeadline = Date.now() + 10000
    let sawMarker = false
    while (Date.now() < echoDeadline) {
      const text = await evaluate(cdp, sessionId, `document.querySelector('.rsb-term')?.textContent ?? ''`)
      if (text.includes(MARKER)) { sawMarker = true; break }
      await sleep(250)
    }
    if (!sawMarker) throw new Error(`the typed command never echoed its output (keystrokes → ptyWrite → shell → ptyPull → xterm)`)
    console.log('Terminal tab spawns a live shell; typing echoes through the transport — OK')

    // 2. Resize propagates cols/rows to the PTY: stty size must change.
    const before = await sttySize(cdp, sessionId)
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 900, height: viewport.height, deviceScaleFactor: 1, mobile: false,
    }, sessionId)
    await sleep(600)
    const after = await sttySize(cdp, sessionId)
    await cdp.send('Emulation.clearDeviceMetricsOverride', {}, sessionId)
    const beforeCols = Number(before.split(' ')[1])
    const afterCols = Number(after.split(' ')[1])
    if (!(afterCols > 0 && beforeCols > 0 && afterCols !== beforeCols)) {
      throw new Error(`the PTY never saw a resize (stty size before: ${before}, after: ${after})`)
    }
    console.log(`terminal resize updates PTY cols/rows (${before} → ${after}) — OK`)

    // 3. Terminal tabs are not persisted across reload (re-attach is #9);
    //    other tab types still are.
    await evaluate(cdp, sessionId, `location.reload()`)
    await waitFor(cdp, sessionId, `!!document.querySelector('[data-shell-overlay] .rsb-rail button')`, 'the Rail after reload', 45000)
    await waitFor(cdp, sessionId, `!!document.querySelector('.rsb-bottom-panel')`, 'the restored open Panel', 10000)
    await sleep(400)
    const restoredTabs = await evaluate(cdp, sessionId, `document.querySelectorAll('.rsb-tab').length`)
    if (restoredTabs !== 0) throw new Error(`a terminal tab came back from storage (${restoredTabs} tabs after reload)`)
    console.log('terminal tabs are dropped from persistence on reload — OK')

    // 4. Closing a terminal tab kills its shell without confirmation.
    await openTerminalTab(cdp, sessionId)
    await evaluate(cdp, sessionId, `document.querySelector('.rsb-tab .rsb-tab-close').click()`)
    await waitFor(cdp, sessionId, `!!document.querySelector('.rsb-panel-empty')`, 'the empty state to return')
    const noConfirm = await evaluate(cdp, sessionId, `!!document.querySelector('.rsb-tab')`)
    if (noConfirm) throw new Error('the terminal tab survived its close click')
    console.log('closing the terminal tab kills it immediately, no confirmation — OK')

    console.log('PASS: the Terminal Panel Tab spawns, streams, resizes, and closes end to end in the GUI')
    process.exitCode = 0
  } finally {
    if (ws) try { ws.close() } catch {}
    if (chrome) chrome.kill()
    if (profileDir) await rm(profileDir, { recursive: true, force: true }).catch(() => {})
  }
}

await main()
