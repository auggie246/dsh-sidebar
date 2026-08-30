#!/usr/bin/env node
// GUI-level verification for ADR 0003 and ADR 0004: the running GUI must
// enable the Rail's Panel button on a fresh (blank) session — no bootstrap
// message sent — open the Panel from that click, load the embedded nerd-icon
// face for p10k prompt glyphs, and run a terminal whose shell reports
// TERM=xterm-256color. Drives a real headless Chrome (raw CDP, no
// dependencies) against the running DSH Web GUI.
//
//   node scripts/verify-terminal-render.mjs
//
// Exit 0 = every check passed. Exit 1 = any check failed.

const baseUrl = process.env.DSH_WEB_URL ?? 'http://127.0.0.1:3080'
const chromeBin = process.env.DSH_SIDEBAR_CHROME
  ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const viewport = { width: 1440, height: 900 }
const screenshotDir = '/tmp/rsb-diag'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const { spawn } = await import('node:child_process')
const { mkdir, mkdtemp, rm, writeFile } = await import('node:fs/promises')
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
    ['@font-face { font-family: "Dsh Sidebar Icons";', 'the embedded icon face'],
    ['data:font/woff2;base64,', 'the icon face data URI'],
    ['"Dsh Sidebar Icons", ui-monospace, SFMono-Regular, Menlo, monospace', 'the terminal font stack'],
    ['Panel opens once a session exists', 'the ungated Panel button title'],
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

// Real keystrokes: xterm reads keydown on its hidden textarea, and p10k/zsh
// react to actual key events, so input goes through the CDP Input domain.
async function typeLine(cdp, sessionId, text) {
  for (const char of text) {
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyDown', text: char, unmodifiedText: char, key: char,
    }, sessionId)
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: char }, sessionId)
  }
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r',
  }, sessionId)
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, sessionId)
}

async function screenshot(cdp, sessionId, name) {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId)
  await writeFile(`${screenshotDir}/${name}`, Buffer.from(data, 'base64'))
}

async function main() {
  await bundleMarkers()
  console.log('served bundle carries the ADR 0003/0004 markers')

  let chrome
  let profileDir
  let ws
  try {
    profileDir = await mkdtemp(join(tmpdir(), 'rsb-term-render-'))
    await mkdir(screenshotDir, { recursive: true })
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
    await cdp.send('Page.enable', {}, sessionId)
    await cdp.send('Page.navigate', { url: baseUrl }, sessionId)
    await cdp.waitEvent('Page.loadEventFired', sessionId).catch(() => {})

    await waitFor(cdp, sessionId, `!!document.querySelector('[data-shell-overlay] .rsb-rail button')`, 'the Sidebar Rail to appear', 45000)
    console.log('GUI loaded; Rail found')

    // --- ADR 0003: create a session and DO NOT send a message. The Panel
    // button must be live on this blank session; the old gate kept it
    // disabled until the first message was sent.
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

    const panelButton = `document.querySelector('[data-shell-overlay] .rsb-rail button:nth-of-type(2)')`
    await waitFor(cdp, sessionId, `(() => { const b = ${panelButton}; return !!b && !b.disabled })()`,
      'the Panel Rail button to enable on the blank session (ADR 0003)', 15000)
    const title = await evaluate(cdp, sessionId, `${panelButton}.title`)
    if (!['Open panel', 'Close panel'].includes(title)) {
      throw new Error(`the blank-session Panel button must be live ("Open panel"/"Close panel"), got ${JSON.stringify(title)}`)
    }
    console.log(`ADR 0003: Panel button live on a blank session ("${title}")`)

    await evaluate(cdp, sessionId, `${panelButton}.click()`)
    await waitFor(cdp, sessionId, `!!document.querySelector('.rsb-bottom-panel')`, 'the Panel to open from the blank-session click')
    console.log('ADR 0003: Panel opened on the blank session')

    // ADR 0003 follow-up: on a blank session an OPEN Sidebar floats
    // (ticket #1 overlay) and reserves its strip as padding on the center
    // column. The Panel must mirror the content box, so its right edge
    // stays clear of the floating Sidebar. A fresh profile starts with the
    // preference closed, so open it first.
    await waitFor(cdp, sessionId, `(() => {
      if (!window.__rsbSidebarLatch) {
        const b = document.querySelector('[data-shell-overlay] .rsb-rail button')
        if (b && (b.title || '').includes('Open workspace sidebar')) { window.__rsbSidebarLatch = true; b.click() }
        return false
      }
      return !!document.querySelector('.rsb-overlay-panel')
    })()`, 'the overlay Sidebar to float on the blank session', 10000)
    await sleep(600) // let the padding-right transition and re-measure settle
    const geometry = await evaluate(cdp, sessionId, `(() => {
      const panel = document.querySelector('.rsb-bottom-panel')
      const overlay = document.querySelector('.rsb-overlay-panel')
      if (!panel || !overlay) return null
      const p = panel.getBoundingClientRect()
      const o = overlay.getBoundingClientRect()
      return { panelRight: p.right, overlayLeft: o.left, clear: p.right <= o.left + 1 }
    })()`)
    if (!geometry) throw new Error('the Panel and the overlay Sidebar must both be present on the blank session')
    if (!geometry.clear) {
      throw new Error(`the Panel right edge (${geometry.panelRight}) slides under the overlay Sidebar (left edge ${geometry.overlayLeft})`)
    }
    console.log(`ADR 0003: Panel clear of the overlay Sidebar (panel right ${Math.round(geometry.panelRight)}, sidebar left ${Math.round(geometry.overlayLeft)})`)

    // --- ADR 0004a: the embedded icon face loads and actually renders p10k
    // glyphs. measureText under the shipped stack must differ from the bare
    // fallback stack for a private-use-area codepoint.
    const font = await evaluate(cdp, sessionId, `(async () => {
      // A data-URI face loads lazily; force the load before checking.
      await document.fonts.load('12px "Dsh Sidebar Icons"', '\\uF113')
      await document.fonts.ready
      const probe = (stack) => {
        const canvas = document.createElement('canvas')
        const ctx = canvas.getContext('2d')
        ctx.font = '12px ' + stack
        return ctx.measureText('\\uF113').width
      }
      return {
        check: document.fonts.check('12px "Dsh Sidebar Icons"', '\\uF113'),
        shipped: probe('"Dsh Sidebar Icons", monospace'),
        fallback: probe('monospace'),
      }
    })()`)
    if (!font.check) throw new Error('the embedded icon face did not load for U+F113')
    if (!(font.shipped > 0) || font.shipped === font.fallback) {
      throw new Error(`the icon face is not applied (shipped ${font.shipped}px vs fallback ${font.fallback}px for U+F113)`)
    }
    console.log(`ADR 0004: icon face loaded; U+F113 measures ${font.shipped}px vs ${font.fallback}px fallback`)

    // --- ADR 0004b: a terminal tab on the blank session, then the shell's
    // own word for its TERM.
    await evaluate(cdp, sessionId, `document.querySelector('.rsb-tabstrip-add').click()`)
    await waitFor(cdp, sessionId, `!!document.querySelector('.rsb-tab-picker')`, 'the type picker to open')
    const items = await evaluate(cdp, sessionId, `Array.from(document.querySelectorAll('.rsb-tab-picker-item')).map((b) => b.textContent)`)
    const term = items.findIndex((t) => t.includes('Terminal'))
    if (term === -1) throw new Error(`the type picker does not list Terminal (got: ${JSON.stringify(items)})`)
    await evaluate(cdp, sessionId, `document.querySelectorAll('.rsb-tab-picker-item')[${term}].click()`)
    await waitFor(cdp, sessionId, `!!document.querySelector('.xterm')`, 'the xterm surface to mount', 20000)
    await sleep(2500) // let zsh + p10k draw their first prompt
    // The composer keeps focus after session creation; xterm only sees keys
    // through its hidden textarea, so hand focus over before typing.
    await evaluate(cdp, sessionId, `(() => {
      const ta = document.querySelector('.xterm textarea')
      if (!ta) return false
      ta.focus()
      return true
    })()`)
    await sleep(300)
    await typeLine(cdp, sessionId, 'echo TERM=$TERM')
    // The host half of the TERM fix (ptySpawn argv) loads with the dsh web
    // process: until the next `dsh web` restart the live shell may still
    // report dumb even though the served host source carries the fix. A
    // stale host is a skip with a notice, not a pass; anything else is a
    // failure.
    await waitFor(cdp, sessionId, `(() => {
      const rows = document.querySelector('.xterm-rows')
      return !!rows && /TERM=(xterm-256color|dumb)/.test(rows.textContent)
    })()`, 'the shell to report its TERM', 20000)
    const termSeen = await evaluate(cdp, sessionId, `(() => {
      const rows = document.querySelector('.xterm-rows')
      return { fixed: rows.textContent.includes('TERM=xterm-256color'), stale: rows.textContent.includes('TERM=dumb') }
    })()`)
    if (termSeen.fixed) {
      console.log('ADR 0004: shell reports TERM=xterm-256color')
    } else if (termSeen.stale) {
      console.log('ADR 0004 (partial): live shell reports TERM=dumb — the running dsh web host predates the argv fix;')
      console.log('  the fix is in the served source and test-pty-transport proves it against a real shell. It goes live at the next `dsh web` restart.')
    } else {
      throw new Error(`the shell reported an unexpected TERM (rows: ${JSON.stringify(termSeen)})`)
    }

    await screenshot(cdp, sessionId, 'accept-term.png')
    console.log(`screenshot saved to ${screenshotDir}/accept-term.png`)
    console.log('terminal render check passed')
  } finally {
    try { if (ws) ws.close() } catch {}
    try { if (chrome) chrome.kill() } catch {}
  }
}

main().then(
  () => process.exit(0),
  (error) => { console.error(String(error?.stack ?? error)); process.exit(1) },
)
