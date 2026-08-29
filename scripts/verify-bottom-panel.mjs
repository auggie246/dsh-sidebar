#!/usr/bin/env node
// GUI-level verification for ticket #3 (bottom Panel): the running GUI must
// serve a client bundle whose second Rail button opens an empty Panel pinned
// under the center conversation column only, tracking the center column, with
// the conversation content never covered. Drives a real headless Chrome (raw
// CDP, no dependencies) against the running DSH Web GUI.
//
//   node scripts/verify-bottom-panel.mjs
//
// Exit 0 = every geometry and independence check passed. Exit 1 = any check
// failed. The Panel geometry is compared against the frame's own
// grid-template-columns (the shell's authority), NOT against the plugin's
// measurement path, so the two cannot cancel out.

const baseUrl = process.env.DSH_WEB_URL ?? 'http://127.0.0.1:3080'
const chromeBin = process.env.DSH_SIDEBAR_CHROME
  ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const viewport = { width: 1440, height: 900 }
const PANEL_H = 240 // must equal --rsb-panel-h in lib/client.js
const TOL = 1 // px tolerance for sub-pixel layout rounding

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
    ["'Open panel'", 'the live Panel button label'],
    ["'Close panel'", 'the open Panel button label'],
    ['rsb-bottom-panel', 'the Panel region'],
    ['--rsb-panel-h: 240px', 'the shared Panel height variable'],
    ['padding-bottom: var(--rsb-panel-h)', 'the center column reservation'],
  ]
  for (const [needle, what] of checks) {
    if (!bundle.includes(needle)) throw new Error(`the served bundle is missing ${what} (${needle})`)
  }
  if (bundle.includes("'Panel is not available yet'")) {
    throw new Error('the served bundle still carries the inert placeholder button')
  }
}

// ---------- CDP plumbing (same shape as verify-new-session-no-overlap.mjs) ----------
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
  const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true }, sessionId)
  if (result.exceptionDetails) {
    throw new Error(`page evaluate failed: ${result.exceptionDetails.exception?.description ?? 'unknown'}`)
  }
  return result.result.value
}

// Read the Panel geometry plus the shell's own grid authority. Expected left
// edge = frame left + sidebar track; expected right edge = start of the
// details track. Both come from the frame's inline grid-template-columns.
const MEASURE = `(() => {
  const panel = document.querySelector('.rsb-bottom-panel')
  const overlayEl = document.querySelector('[data-shell-overlay]')
  const frame = overlayEl && overlayEl.parentElement
  if (!panel || !frame) return { error: 'panel or frame not found' }
  // The shell's inline grid is "<sidebar>px minmax(0, 1fr) <details>px"; the
  // 1fr center track is the frame remainder, so only the two fixed tracks
  // need parsing.
  const fixed = frame.style.gridTemplateColumns.split(' ').filter((t) => t.endsWith('px'))
  if (fixed.length !== 2) return { error: 'unreadable grid tracks: ' + frame.style.gridTemplateColumns }
  const f = frame.getBoundingClientRect()
  const p = panel.getBoundingClientRect()
  const center = frame.children[1]
  const conv = document.querySelector('[data-conversation-scroll]')
  return {
    frameLeft: f.left,
    sidebarW: parseFloat(fixed[0]), centerW: f.width - parseFloat(fixed[0]) - parseFloat(fixed[1]), detailsW: parseFloat(fixed[1]),
    panelLeft: p.left, panelRight: p.right, panelTop: p.top, panelBottom: p.bottom,
    panelHeight: p.height,
    centerPaddingBottom: parseFloat(getComputedStyle(center).paddingBottom),
    convBottom: conv ? conv.getBoundingClientRect().bottom : null,
    innerHeight: window.innerHeight,
  }
})()`

function assertGeometry(m, label) {
  if (m.error) throw new Error(`${label}: ${m.error}`)
  const problems = []
  const expectLeft = m.frameLeft + m.sidebarW
  const expectRight = m.frameLeft + m.sidebarW + m.centerW
  if (Math.abs(m.panelLeft - expectLeft) > TOL) problems.push(`left ${m.panelLeft} != center column left ${expectLeft}`)
  if (Math.abs(m.panelRight - expectRight) > TOL) problems.push(`right ${m.panelRight} != center column right ${expectRight}`)
  if (Math.abs(m.panelBottom - m.innerHeight) > TOL) problems.push(`bottom ${m.panelBottom} != viewport bottom ${m.innerHeight}`)
  if (Math.abs(m.panelHeight - PANEL_H) > TOL) problems.push(`height ${m.panelHeight} != ${PANEL_H}`)
  if (Math.abs(m.centerPaddingBottom - PANEL_H) > TOL) problems.push(`center padding-bottom ${m.centerPaddingBottom} != ${PANEL_H}`)
  if (m.convBottom !== null && m.convBottom > m.panelTop + 0.5) problems.push(`conversation bottom ${m.convBottom} overlaps Panel top ${m.panelTop}`)
  if (problems.length) throw new Error(`${label}: ${problems.join('; ')}`)
  console.log(`${label}: left=${m.panelLeft.toFixed(1)} right=${m.panelRight.toFixed(1)} height=${m.panelHeight.toFixed(1)} convBottom=${m.convBottom === null ? 'n/a' : m.convBottom.toFixed(1)} — OK`)
}

async function main() {
  await bundleMarkers()
  console.log('served bundle carries the Panel markers')

  let chrome
  let profileDir
  let ws
  try {
    profileDir = await mkdtemp(join(tmpdir(), 'rsb-panel-cdp-'))
    chrome = spawn(chromeBin, [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      // Chrome's own sandbox and crashpad fight the DSH file sandbox and break
      // the DevTools endpoint; headless needs neither here.
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

    const deadline = Date.now() + 45000
    while (Date.now() < deadline) {
      if (await evaluate(cdp, sessionId, `!!document.querySelector('[data-shell-overlay] .rsb-rail button')`)) break
      await sleep(500)
    }
    if (!(await evaluate(cdp, sessionId, `!!document.querySelector('[data-shell-overlay] .rsb-rail button')`))) {
      throw new Error('the Sidebar Rail did not appear on the page (plugin missing or GUI gate)')
    }
    console.log('GUI loaded; Rail found')

    const panelButton = `[data-shell-overlay] .rsb-rail button:nth-of-type(2)`
    // 1. Open the Panel and check the geometry against the shell grid.
    await evaluate(cdp, sessionId, `document.querySelector('${panelButton}').click()`)
    const openDeadline = Date.now() + 5000
    let panelOpen = false
    while (Date.now() < openDeadline) {
      panelOpen = await evaluate(cdp, sessionId, `!!document.querySelector('.rsb-bottom-panel')`)
      if (panelOpen) break
      await sleep(200)
    }
    if (!panelOpen) throw new Error('clicking the second Rail button did not open the Panel')
    assertGeometry(await evaluate(cdp, sessionId, MEASURE), 'open at 1440px')

    // 2. Drag the sidebar column handle right by 80px: the sidebar widens
    //    to 360 and the Panel left edge must follow it.
    const handle = await evaluate(cdp, sessionId, `(() => {
      const el = document.querySelector('[data-side="sidebar"]')
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    })()`)
    if (!handle) throw new Error('the sidebar drag handle was not found')
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: handle.x, y: handle.y, button: 'left', clickCount: 1 }, sessionId)
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: handle.x + 80, y: handle.y, button: 'left' }, sessionId)
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: handle.x + 80, y: handle.y, button: 'left', clickCount: 1 }, sessionId)
    await sleep(500)
    const dragged = await evaluate(cdp, sessionId, MEASURE)
    if (Math.abs(dragged.sidebarW - 360) > TOL) {
      throw new Error(`the sidebar drag did not take effect (sidebar track ${dragged.sidebarW}, expected 360)`)
    }
    assertGeometry(dragged, 'after 80px sidebar drag')

    // 3. Collapse the viewport below the auto-collapse breakpoint: the
    //    sidebar drops to its 56px rail and the Panel left edge follows.
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 900, height: 700, deviceScaleFactor: 1, mobile: false,
    }, sessionId)
    await sleep(500)
    const narrow = await evaluate(cdp, sessionId, MEASURE)
    if (Math.abs(narrow.sidebarW - 56) > TOL) {
      throw new Error(`the sidebar did not auto-collapse (sidebar track ${narrow.sidebarW}, expected 56)`)
    }
    assertGeometry(narrow, 'after collapse to 900px')
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: false,
    }, sessionId)
    await sleep(500)

    // 4. Sidebar and Panel are independent: both open at once, and closing
    //    the Sidebar leaves the Panel up.
    await evaluate(cdp, sessionId, `document.querySelector('[data-shell-overlay] .rsb-rail button:nth-of-type(1)').click()`)
    await sleep(400)
    const both = await evaluate(cdp, sessionId, `({
      sidebar: !!document.querySelector('.rsb-overlay-panel') || !document.querySelector('[data-details-collapsed]'),
      panel: !!document.querySelector('.rsb-bottom-panel'),
    })`)
    if (!both.panel) throw new Error('the Panel closed while the Sidebar opened')
    if (!both.sidebar) throw new Error('the Sidebar did not open alongside the Panel')
    console.log('Sidebar and Panel both open simultaneously — OK')
    await evaluate(cdp, sessionId, `document.querySelector('[data-shell-overlay] .rsb-rail button:nth-of-type(1)').click()`)
    await sleep(400)
    if (!(await evaluate(cdp, sessionId, `!!document.querySelector('.rsb-bottom-panel')`))) {
      throw new Error('closing the Sidebar closed the Panel')
    }

    // 5. The second click closes the Panel and releases the reservation.
    await evaluate(cdp, sessionId, `document.querySelector('${panelButton}').click()`)
    await sleep(300)
    const closed = await evaluate(cdp, sessionId, `(() => {
      const panel = document.querySelector('.rsb-bottom-panel')
      const overlayEl = document.querySelector('[data-shell-overlay]')
      const center = overlayEl && overlayEl.parentElement ? overlayEl.parentElement.children[1] : null
      return {
        panelGone: !panel,
        padding: center ? parseFloat(getComputedStyle(center).paddingBottom) : null,
      }
    })()`)
    if (!closed.panelGone) throw new Error('the second click did not remove the Panel')
    if (closed.padding !== 0) throw new Error(`the center column kept its reservation after close (padding-bottom ${closed.padding})`)
    console.log('second click closes the Panel and releases the reservation — OK')

    console.log('PASS: the bottom Panel tracks the center column and never covers conversation content')
    process.exitCode = 0
  } finally {
    if (ws) try { ws.close() } catch {}
    if (chrome) chrome.kill()
    if (profileDir) await rm(profileDir, { recursive: true, force: true }).catch(() => {})
  }
}

await main()
