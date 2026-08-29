#!/usr/bin/env node
// GUI-level verification for ticket #7 (HTML file and Markdown file preview
// tabs): the running GUI must offer both types in the + picker, read the file
// from disk through the host readFile RPC, render an HTML file in a
// script-allowed srcdoc iframe, render Markdown as styled inert HTML, dedupe
// by path, and persist both tab types per session across reload.
//
//   node scripts/verify-file-preview-tabs.mjs
//
// Exit 0 = every check passed. Exit 1 = any check failed.
// Needs a started session in the GUI (the Panel Rail button must be enabled).

const baseUrl = process.env.DSH_WEB_URL ?? 'http://127.0.0.1:3080'
const chromeBin = process.env.DSH_SIDEBAR_CHROME
  ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const viewport = { width: 1440, height: 900 }
const HTML_FIXTURE = 'docs/fixtures/preview.html'
const MD_FIXTURE = 'README.md'

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
    ['html-file', 'the html-file tab type'],
    ['markdown-file', 'the markdown-file tab type'],
    ['readFile', 'the readFile RPC descriptor'],
    ['srcdoc', 'the srcdoc rendering'],
    ['rsb-tab-picker', 'the type picker'],
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

// React controlled inputs ignore a plain value write; the native setter plus
// a bubbling input event is what a real keystroke produces.
const SET_VALUE = (selector, value) => `(() => {
  const input = document.querySelector(${JSON.stringify(selector)})
  if (!input) return false
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(input, ${JSON.stringify(value)})
  input.dispatchEvent(new Event('input', { bubbles: true }))
  return true
})()`

async function openFileTab(cdp, sessionId, pickerTitle, path) {
  await evaluate(cdp, sessionId, `document.querySelector('.rsb-tabstrip-add').click()`)
  await waitFor(cdp, sessionId, `!!document.querySelector('.rsb-tab-picker')`, 'the type picker to open')
  const items = await evaluate(cdp, sessionId, `Array.from(document.querySelectorAll('.rsb-tab-picker-item')).map((b) => b.textContent)`)
  const at = items.findIndex((t) => t.includes(pickerTitle))
  if (at === -1) throw new Error(`the type picker does not list ${pickerTitle} (got: ${JSON.stringify(items)})`)
  await evaluate(cdp, sessionId, `document.querySelectorAll('.rsb-tab-picker-item')[${at}].click()`)
  await waitFor(cdp, sessionId, `!!document.querySelector('.rsb-tab-picker-form')`, `the ${pickerTitle} form to open`)
  if (!(await evaluate(cdp, sessionId, SET_VALUE('.rsb-tab-picker-input', path)))) throw new Error('the path input was not found')
  await evaluate(cdp, sessionId, `document.querySelector('.rsb-tab-picker-open').click()`)
  await waitFor(cdp, sessionId, `!document.querySelector('.rsb-tab-picker-form')`, `the ${pickerTitle} form to close`)
}

async function srcdocFrameValues(cdp) {
  // Both previews are sandboxed srcdoc frames that load as out-of-process
  // frames: they never appear in the parent's Page.getFrameTree, so find
  // each about:srcdoc iframe target, attach to it, and ask it directly.
  const { targetInfos } = await cdp.send('Target.getTargets')
  const frames = targetInfos.filter((t) => t.type === 'iframe' && t.url === 'about:srcdoc')
  const values = []
  for (const frame of frames) {
    const { sessionId: frameSession } = await cdp.send('Target.attachToTarget', { targetId: frame.targetId, flatten: true }).catch(() => ({ sessionId: null }))
    if (!frameSession) continue
    const probe = await cdp.send('Runtime.evaluate', {
      expression: `({
        marker: document.body ? document.body.getAttribute('data-rsb-marker') : null,
        h1: document.querySelector('h1') ? document.querySelector('h1').textContent : null,
      })`,
      returnByValue: true,
    }, frameSession).catch(() => null)
    if (probe && !probe.exceptionDetails) values.push(probe.result.value)
  }
  return values
}

async function main() {
  await bundleMarkers()
  console.log('served bundle carries the file-preview markers')

  let chrome
  let profileDir
  let ws
  try {
    profileDir = await mkdtemp(join(tmpdir(), 'rsb-files-cdp-'))
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
    const contexts = new Map()
    cdp.listeners.push((message) => {
      if (message.method === 'Runtime.executionContextCreated') {
        contexts.set(message.params.context.id, message.params.context)
      }
    })
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
      const clicked = await evaluate(cdp, sessionId, `(() => {
        const b = document.querySelector('button[aria-label="New session in dsh-sidebar"]')
          || Array.from(document.querySelectorAll('button')).find((e) => (e.getAttribute('aria-label') || '').startsWith('New session in '))
          || Array.from(document.querySelectorAll('button')).find((e) => (e.textContent || '').trim() === 'New Session')
        if (!b) return false
        b.click()
        return true
      })()`)
      if (!clicked) throw new Error('could not open a new session from the GUI')
      await waitFor(cdp, sessionId, `!!document.querySelector('textarea[placeholder="Describe what you want to build"]')`, 'the composer to appear', 20000)
      const filled = await evaluate(cdp, sessionId, `(() => {
        const ta = document.querySelector('textarea[placeholder="Describe what you want to build"]')
        if (!ta) return false
        const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
        setter.call(ta, 'Verifier bootstrap session — this session exists only so the dsh-sidebar GUI verifiers can drive a started session. Please ignore it.')
        ta.dispatchEvent(new Event('input', { bubbles: true }))
        return true
      })()`)
      if (!filled) throw new Error('could not fill the composer')
      await evaluate(cdp, sessionId, `(() => { const b = Array.from(document.querySelectorAll('button')).find((e) => (e.getAttribute('aria-label') || '') === 'Send message'); if (!b) return false; b.click(); return true })()`)
      await waitFor(cdp, sessionId, `(() => { const b = document.querySelector('[data-shell-overlay] .rsb-rail button:nth-of-type(2)'); return !!b && !b.disabled })()`, 'the bootstrap session to start (Rail button enabled)', 60000)
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

    // 1. The picker lists both new types next to Localhost URL.
    await evaluate(cdp, sessionId, `document.querySelector('.rsb-tabstrip-add').click()`)
    await waitFor(cdp, sessionId, `!!document.querySelector('.rsb-tab-picker')`, 'the type picker to open')
    const pickerText = await evaluate(cdp, sessionId, `document.querySelector('.rsb-tab-picker').textContent`)
    for (const title of ['Localhost URL', 'HTML file', 'Markdown file']) {
      if (!pickerText.includes(title)) throw new Error(`the type picker does not list ${title} (got: ${JSON.stringify(pickerText)})`)
    }
    await evaluate(cdp, sessionId, `document.querySelector('.rsb-tabstrip-add').click()`)
    console.log('picker offers HTML file and Markdown file — OK')

    // 2. An HTML file renders in a script-allowed srcdoc iframe.
    await openFileTab(cdp, sessionId, 'HTML file', HTML_FIXTURE)
    await waitFor(cdp, sessionId, `!!document.querySelector('.rsb-tabframe')`, 'the HTML preview iframe to mount')
    const htmlSandbox = await evaluate(cdp, sessionId, `document.querySelector('.rsb-tabframe').getAttribute('sandbox') ?? ''`)
    if (!htmlSandbox.includes('allow-scripts')) throw new Error(`the HTML preview sandbox does not allow scripts (${JSON.stringify(htmlSandbox)})`)
    if (htmlSandbox.includes('allow-same-origin')) throw new Error('the HTML preview iframe must not be same-origin')
    let frames = []
    const deadline = Date.now() + 8000
    while (Date.now() < deadline) {
      frames = await srcdocFrameValues(cdp)
      if (frames.some((f) => f.marker === 'script-ran-marker')) break
      await sleep(300)
    }
    if (!frames.some((f) => f.marker === 'script-ran-marker')) {
      throw new Error(`the HTML fixture script never ran inside the srcdoc iframe (frames: ${JSON.stringify(frames)})`)
    }
    console.log('HTML file renders in a script-allowed srcdoc iframe — OK')

    // 3. A Markdown file renders as styled, script-free HTML.
    await openFileTab(cdp, sessionId, 'Markdown file', MD_FIXTURE)
    await waitFor(cdp, sessionId, `document.querySelectorAll('.rsb-tabframe').length >= 2`, 'the Markdown preview iframe to mount')
    frames = []
    const mdDeadline = Date.now() + 8000
    while (Date.now() < mdDeadline) {
      frames = await srcdocFrameValues(cdp)
      if (frames.some((f) => f.h1 === 'dsh-sidebar')) break
      await sleep(300)
    }
    const mdFrame = frames.find((f) => f.h1 === 'dsh-sidebar')
    if (!mdFrame) throw new Error(`README.md never rendered an <h1>dsh-sidebar</h1> preview (frames: ${JSON.stringify(frames)})`)
    const mdSandbox = await evaluate(cdp, sessionId, `Array.from(document.querySelectorAll('.rsb-tabframe')).map((f) => f.getAttribute('sandbox') ?? null).join('|')`)
    if (!mdSandbox.split('|').some((s) => s === '')) throw new Error(`the Markdown preview iframe must have an empty sandbox (got: ${JSON.stringify(mdSandbox)})`)
    console.log('Markdown file renders as styled, script-free HTML — OK')

    // 4. Re-opening the same path re-focuses the existing tab.
    await openFileTab(cdp, sessionId, 'HTML file', HTML_FIXTURE)
    const dedupe = await evaluate(cdp, sessionId, `({
      tabs: document.querySelectorAll('.rsb-tab').length,
      active: document.querySelector('.rsb-tab-active')?.textContent ?? '',
    })`)
    if (dedupe.tabs !== 2) throw new Error(`a duplicate path spawned an extra tab (${dedupe.tabs} tabs)`)
    if (!dedupe.active.includes('preview.html')) throw new Error(`the duplicate open did not re-focus the HTML tab (active: ${JSON.stringify(dedupe.active)})`)
    console.log('re-opening the same path re-focuses its tab — OK')

    // 5. Both file tab types persist per session across reload.
    await evaluate(cdp, sessionId, `location.reload()`)
    await waitFor(cdp, sessionId, `!!document.querySelector('[data-shell-overlay] .rsb-rail button')`, 'the Rail after reload', 45000)
    await waitFor(cdp, sessionId, `!!document.querySelector('.rsb-bottom-panel')`, 'the restored open Panel', 10000)
    await waitFor(cdp, sessionId, `document.querySelectorAll('.rsb-tab').length === 2`, 'both file tabs after reload', 10000)
    const stored = await evaluate(cdp, sessionId, `(() => {
      const key = Object.keys(localStorage).find((k) => k.startsWith('dsh.rsidebar.panels.v1.'))
      return key ? JSON.parse(localStorage.getItem(key)) : null
    })()`)
    const types = (stored?.tabs ?? []).map((t) => t.type).sort()
    if (JSON.stringify(types) !== JSON.stringify(['html-file', 'markdown-file'])) {
      throw new Error(`the stored tab types are wrong: ${JSON.stringify(stored?.tabs)}`)
    }
    console.log(`file tabs persist per session under dsh.rsidebar.panels.v1.<sessionId> — OK`)

    // 6. Cleanup: closing both tabs leaves the Panel open but empty.
    while (await evaluate(cdp, sessionId, `document.querySelectorAll('.rsb-tab .rsb-tab-close').length`)) {
      await evaluate(cdp, sessionId, `document.querySelector('.rsb-tab .rsb-tab-close').click()`)
      await sleep(150)
    }
    await waitFor(cdp, sessionId, `!!document.querySelector('.rsb-panel-empty')`, 'the empty state to return')
    console.log('cleanup close leaves the Panel open and empty — OK')

    console.log('PASS: HTML file and Markdown file preview tabs work end to end in the GUI')
    process.exitCode = 0
  } finally {
    if (ws) try { ws.close() } catch {}
    if (chrome) chrome.kill()
    if (profileDir) await rm(profileDir, { recursive: true, force: true }).catch(() => {})
  }
}

await main()
