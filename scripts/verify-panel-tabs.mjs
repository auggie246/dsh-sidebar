#!/usr/bin/env node
// GUI-level verification for ticket #6 (working tab strip): the running GUI
// must serve a client bundle whose Panel opens a type picker, creates a
// Localhost URL Panel Tab rendering a live local page in a script-allowed
// iframe, dedupes by URL identity, persists the tab list and active tab per
// session across reload, and leaves the Panel open but empty after the last
// tab closes. Drives a real headless Chrome (raw CDP, no dependencies)
// against the running DSH Web GUI.
//
//   node scripts/verify-panel-tabs.mjs
//
// Exit 0 = every check passed. Exit 1 = any check failed.

const baseUrl = process.env.DSH_WEB_URL ?? 'http://127.0.0.1:3080'
const chromeBin = process.env.DSH_SIDEBAR_CHROME
  ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const viewport = { width: 1440, height: 900 }

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const { spawn } = await import('node:child_process')
const { mkdtemp, rm } = await import('node:fs/promises')
const { tmpdir } = await import('node:os')
const { join } = await import('node:path')
const http = await import('node:http')

// ---------- local preview server ----------
// Serves one page whose body text is set BY inline script, so finding that
// text inside the iframe proves scripts ran. Bound to 127.0.0.1 on an
// ephemeral port.
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' })
  res.end('<!doctype html><title>rsb-preview</title><body>static-marker<script>document.body.textContent = "script-ran-marker"</script></body>')
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const previewPort = server.address().port
const previewUrl = `http://127.0.0.1:${previewPort}/`
console.log(`preview server on ${previewUrl}`)

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
    ['rsb-tab-picker', 'the type picker'],
    ['rsb-tab-picker-warning', 'the iframe-refusal warning'],
    ['rsb-tabframe', 'the Panel Tab iframe'],
    ['dsh.rsidebar.panels.v1.', 'the per-session Panel Tabs storage key'],
    ['allow-scripts allow-forms allow-popups', 'the script-allowed iframe sandbox'],
  ]
  for (const [needle, what] of checks) {
    if (!bundle.includes(needle)) throw new Error(`the served bundle is missing ${what} (${needle})`)
  }
}

// ---------- CDP plumbing (same shape as verify-bottom-panel.mjs) ----------
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

async function openLocalhostTab(cdp, sessionId, url) {
  await evaluate(cdp, sessionId, `document.querySelector('.rsb-tabstrip-add').click()`)
  await waitFor(cdp, sessionId, `!!document.querySelector('.rsb-tab-picker')`, 'the type picker to open')
  const items = await evaluate(cdp, sessionId, `Array.from(document.querySelectorAll('.rsb-tab-picker-item')).map((b) => b.textContent)`)
  const item = items.findIndex((t) => t.includes('Localhost URL'))
  if (item === -1) throw new Error(`the type picker does not list Localhost URL (got: ${JSON.stringify(items)})`)
  await evaluate(cdp, sessionId, `document.querySelectorAll('.rsb-tab-picker-item')[${item}].click()`)
  await waitFor(cdp, sessionId, `!!document.querySelector('.rsb-tab-picker-form')`, 'the Localhost URL form to open')
  const warning = await evaluate(cdp, sessionId, `document.querySelector('.rsb-tab-picker-warning')?.textContent ?? ''`)
  if (!warning.includes('iframe')) throw new Error(`the URL form lost the iframe-refusal warning (got: ${JSON.stringify(warning)})`)
  if (!(await evaluate(cdp, sessionId, SET_VALUE('.rsb-tab-picker-input', url)))) throw new Error('the URL input was not found')
  await evaluate(cdp, sessionId, `document.querySelector('.rsb-tab-picker-open').click()`)
  await waitFor(cdp, sessionId, `!!document.querySelector('.rsb-tab')`, 'the Panel Tab to appear')
}

async function main() {
  await bundleMarkers()
  console.log('served bundle carries the Panel Tabs markers')

  let chrome
  let profileDir
  let ws
  try {
    profileDir = await mkdtemp(join(tmpdir(), 'rsb-tabs-cdp-'))
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
    // Iframe contexts are needed later to prove the preview's script ran.
    await cdp.send('Runtime.enable', {}, sessionId)
    const contexts = new Map()
    const contextListener = (message) => {
      if (message.method === 'Runtime.executionContextCreated') {
        contexts.set(message.params.context.id, message.params.context)
      }
    }
    cdp.listeners.push(contextListener)
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

    // 1. The + affordance opens the type picker listing Localhost URL.
    await evaluate(cdp, sessionId, `document.querySelector('.rsb-tabstrip-add').click()`)
    await waitFor(cdp, sessionId, `!!document.querySelector('.rsb-tab-picker')`, 'the type picker to open')
    const pickerText = await evaluate(cdp, sessionId, `document.querySelector('.rsb-tab-picker').textContent`)
    if (!pickerText.includes('Localhost URL')) throw new Error(`the type picker does not list Localhost URL (got: ${JSON.stringify(pickerText)})`)
    console.log('+ opens the type picker with Localhost URL — OK')
    await evaluate(cdp, sessionId, `document.querySelector('.rsb-tabstrip-add').click()`)
    await waitFor(cdp, sessionId, `!document.querySelector('.rsb-tab-picker')`, 'the type picker to close')
    console.log('clicking + again closes the picker — OK')

    // 2. Localhost URL creates one tab whose iframe loads the preview and
    //    runs its script.
    await openLocalhostTab(cdp, sessionId, previewUrl)
    await waitFor(cdp, sessionId, `!!document.querySelector('.rsb-tabframe')`, 'the iframe to mount')
    const tabCount = await evaluate(cdp, sessionId, `document.querySelectorAll('.rsb-tab').length`)
    if (tabCount !== 1) throw new Error(`expected exactly one Panel Tab, got ${tabCount}`)
    const closeInfo = await evaluate(cdp, sessionId, `(() => {
      const x = document.querySelector('.rsb-tab .rsb-tab-close')
      return { present: !!x, label: x?.getAttribute('aria-label') ?? '' }
    })()`)
    if (!closeInfo.present) throw new Error('the Panel Tab carries no close X')
    const sandbox = await evaluate(cdp, sessionId, `document.querySelector('.rsb-tabframe').getAttribute('sandbox') ?? ''`)
    if (!sandbox.includes('allow-scripts')) throw new Error(`the iframe sandbox does not allow scripts (${JSON.stringify(sandbox)})`)
    await waitFor(cdp, sessionId, `!!document.querySelector('.rsb-tabframe')`, 'the iframe to stay mounted', 5000)
    // The sandboxed preview loads as an out-of-process frame: it never shows
    // in this page's Page.getFrameTree, so find it as its own CDP target and
    // attach to it directly.
    let frameSession = null
    const frameDeadline = Date.now() + 10000
    while (Date.now() < frameDeadline && !frameSession) {
      const { targetInfos } = await cdp.send('Target.getTargets')
      const t = targetInfos.find((t) => t.type === 'iframe' && t.url.startsWith(previewUrl))
      if (t) frameSession = (await cdp.send('Target.attachToTarget', { targetId: t.targetId, flatten: true })).sessionId
      else await sleep(250)
    }
    if (!frameSession) throw new Error('the preview iframe never appeared as a CDP target')
    const inner = await cdp.send('Runtime.evaluate', { expression: `document.body.textContent`, returnByValue: true }, frameSession)
    if (inner.exceptionDetails || inner.result.value !== 'script-ran-marker') {
      throw new Error(`the preview script did not run in the iframe (got: ${JSON.stringify(inner.result?.value ?? inner.exceptionDetails?.exception?.description)})`)
    }
    console.log('Localhost URL tab renders the page in a script-allowed iframe — OK')

    // 3. Re-opening the same URL (different spelling) re-focuses the tab.
    await openLocalhostTab(cdp, sessionId, previewUrl.replace(/\/$/, '') + '/')
    const dedupe = await evaluate(cdp, sessionId, `({
      tabs: document.querySelectorAll('.rsb-tab').length,
      active: document.querySelector('.rsb-tab-active')?.textContent ?? '',
      src: document.querySelector('.rsb-tabframe')?.getAttribute('src') ?? '',
    })`)
    if (dedupe.tabs !== 1) throw new Error(`a duplicate URL spawned an extra tab (${dedupe.tabs} tabs)`)
    if (dedupe.src !== previewUrl) throw new Error(`the duplicate open did not re-focus the existing tab (src: ${dedupe.src})`)
    console.log('duplicate URL re-focuses the existing tab — OK')

    // 4. The tab list and the active tab persist per session across reload.
    await evaluate(cdp, sessionId, `location.reload()`)
    await waitFor(cdp, sessionId, `!!document.querySelector('[data-shell-overlay] .rsb-rail button')`, 'the Rail after reload', 45000)
    await waitFor(cdp, sessionId, `!!document.querySelector('.rsb-bottom-panel')`, 'the restored open Panel', 10000)
    const restored = await evaluate(cdp, sessionId, `({
      tabs: document.querySelectorAll('.rsb-tab').length,
      src: document.querySelector('.rsb-tabframe')?.getAttribute('src') ?? '',
      keys: Object.keys(localStorage).filter((k) => k.startsWith('dsh.rsidebar.panels.v1.')),
    })`)
    if (restored.tabs !== 1) throw new Error(`the tab list did not survive reload (${restored.tabs} tabs)`)
    if (restored.src !== previewUrl) throw new Error(`the active tab did not survive reload (src: ${restored.src})`)
    if (restored.keys.length !== 1) throw new Error(`expected one dsh.rsidebar.panels.v1.<sessionId> key, got ${JSON.stringify(restored.keys)}`)
    const stored = JSON.parse(await evaluate(cdp, sessionId, `localStorage.getItem(${JSON.stringify(restored.keys[0])})`))
    if (stored.tabs?.length !== 1 || stored.tabs[0].type !== 'localhost-url' || stored.tabs[0].url !== previewUrl) {
      throw new Error(`the stored tab state is wrong: ${JSON.stringify(stored)}`)
    }
    if (stored.active !== stored.tabs[0].id) throw new Error('the stored active tab does not match the stored tab')
    console.log(`tab list and active tab persist under ${restored.keys[0]} — OK`)

    // 5. Closing the last tab leaves the Panel open but empty.
    await evaluate(cdp, sessionId, `document.querySelector('.rsb-tab .rsb-tab-close').click()`)
    await waitFor(cdp, sessionId, `!!document.querySelector('.rsb-panel-empty')`, 'the empty state to return')
    const empty = await evaluate(cdp, sessionId, `({
      panel: !!document.querySelector('.rsb-bottom-panel'),
      tabs: document.querySelectorAll('.rsb-tab').length,
      frames: document.querySelectorAll('.rsb-tabframe').length,
    })`)
    if (!empty.panel) throw new Error('closing the last tab closed the Panel')
    if (empty.tabs !== 0 || empty.frames !== 0) throw new Error(`the last close left tab remnants (${JSON.stringify(empty)})`)
    console.log('closing the last tab leaves the Panel open and empty — OK')

    console.log('PASS: the working tab strip creates, focuses, persists, and closes Localhost URL Panel Tabs')
    process.exitCode = 0
  } finally {
    server.close()
    if (ws) try { ws.close() } catch {}
    if (chrome) chrome.kill()
    if (profileDir) await rm(profileDir, { recursive: true, force: true }).catch(() => {})
  }
}

await main()
