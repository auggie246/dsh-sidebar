#!/usr/bin/env node
// Live wire verification for the terminal transport host half (ticket #2).
//
// Drives ptySpawn -> ptyWrite -> ptyPull -> ptyKill over the real Typert wire
// against the running DSH web GUI, exactly the way the browser half does: a
// plain HTTP POST of the client-request envelope to <base>/api/<namespace>/<method>.
// No UI and no browser involved.
//
// Run this AFTER reinstalling the plugin and restarting `dsh web`.
// Exits 0 on success, 1 with a clear message on failure.
const baseUrl = process.env.DSH_WEB_URL ?? 'http://127.0.0.1:3080'
const MARKER = 'rsb-verify-42'
let rpcCounter = 0
let ptyId = null

function fail(message) {
  console.error(`PTY transport wire check FAILED: ${message}`)
  process.exit(1)
}

async function rawInvoke(method, args) {
  const endpoint = `rsidebarGit/${method}`
  const rpcId = `verify-pty-${++rpcCounter}`
  let response
  try {
    response = await fetch(`${baseUrl}/api/${endpoint}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload: { args } }),
    })
  } catch (error) {
    fail(`${baseUrl} is unreachable (${error.message}). Is \`dsh web\` running?`)
  }
  if (response.status === 404) {
    fail(`${endpoint} is not claimed by the running host. Reinstall the plugin and restart \`dsh web\`, then rerun this check.`)
  }
  if (response.status === 403) {
    fail(`${endpoint} was rejected by the trust fence. This check must run against the loopback host (127.0.0.1).`)
  }
  if (!response.ok) {
    fail(`${endpoint} returned HTTP ${response.status} (expected 200 with a server-response envelope).`)
  }
  let envelope
  try {
    envelope = await response.json()
  } catch (error) {
    fail(`${endpoint} returned a non-JSON body: ${error.message}`)
  }
  if (!envelope || envelope.type !== 'server-response' || envelope.rpcId !== rpcId) {
    fail(`${endpoint} returned an unexpected envelope: ${JSON.stringify(envelope).slice(0, 200)}`)
  }
  return envelope
}

async function invoke(method, args) {
  const envelope = await rawInvoke(method, args)
  if (typeof envelope.result !== 'object' || envelope.result === null) {
    fail(`rsidebarGit/${method} returned no result object: ${JSON.stringify(envelope).slice(0, 200)}`)
  }
  if (envelope.result.ok !== true) {
    const error = envelope.result.error ?? {}
    fail(`rsidebarGit/${method} reported an error: ${error.code ?? 'unknown'} ${error.message ?? ''}`.trim())
  }
  // The Typert gateway wraps the business value in result.value; the dynamic
  // harness clone-wraps handler returns as the result itself.
  return envelope.result.value ?? envelope.result
}

console.log(`mode: wire (live POST ${baseUrl}/api/rsidebarGit/pty*)`)

// 1. Spawn a real PTY in the host process.
const cwd = process.cwd()
const spawned = await invoke('ptySpawn', { cwd, cols: 80, rows: 24 })
ptyId = spawned.id
if (typeof ptyId !== 'string' || !/^pty-\d+$/.test(ptyId)) {
  fail(`ptySpawn returned an unexpected id ${JSON.stringify(spawned.id)}`)
}
if (!Number.isFinite(spawned.pid) || spawned.pid <= 0) {
  fail(`ptySpawn returned an unexpected pid ${JSON.stringify(spawned.pid)}`)
}
console.log(`ptySpawn ok (id ${ptyId}, pid ${spawned.pid}, cwd ${cwd})`)

try {
  // 2. Feed a command whose output carries the marker.
  await invoke('ptyWrite', { id: ptyId, data: `echo ${MARKER}\n` })

  // 3. Long-poll until the marker arrives; seq must move forward only.
  const deadline = Date.now() + 20000
  let afterSeq = 0
  let text = ''
  let seen = false
  while (Date.now() < deadline) {
    const pull = await invoke('ptyPull', { id: ptyId, afterSeq })
    if (typeof pull.seq !== 'number' || !Number.isFinite(pull.seq) || pull.seq < afterSeq) {
      fail(`ptyPull returned a non-monotonic seq ${JSON.stringify(pull.seq)} (afterSeq ${afterSeq})`)
    }
    if (typeof pull.chunk !== 'string' || typeof pull.alive !== 'boolean') {
      fail(`ptyPull returned a malformed result: ${JSON.stringify(pull).slice(0, 200)}`)
    }
    text += pull.chunk
    afterSeq = pull.seq
    if (text.includes(MARKER)) {
      seen = true
      break
    }
    if (!pull.alive) fail('the shell reported alive: false before the marker was seen')
  }
  if (!seen) fail(`the marker ${MARKER} was never seen within 20s of polling`)
  console.log(`ptyWrite/ptyPull ok (marker seen, resumable seq ${afterSeq})`)

  // 4. Terminate the shell; the session must be gone and the write must fail.
  await invoke('ptyKill', { id: ptyId })
  console.log('ptyKill ok')
  const killedId = ptyId
  ptyId = null
  const afterKill = await rawInvoke('ptyWrite', { id: killedId, data: 'echo nope\n' })
  // The lib/Typert gateway surfaces a thrown error as result.error (an object
  // or a string); the dynamic harness returns the error as a business value
  // inside result.value. Accept both shapes.
  const result = afterKill.result ?? {}
  const directError = result.error
  const directText = directError == null
    ? ''
    : (typeof directError === 'string' ? directError : String(directError.message ?? directError))
  const wrapped = result.value
  const wrappedText = wrapped && typeof wrapped === 'object' ? String(wrapped.error ?? '') : ''
  const rejected = (result.ok === false && /unknown pty session/.test(directText))
    || (result.ok === true && /unknown pty session/.test(wrappedText))
  if (!rejected) {
    fail(`ptyWrite on the killed session must report an "unknown pty session" error, got: ${JSON.stringify(afterKill.result).slice(0, 200)}`)
  }
  console.log('write-after-kill rejected ok')
} finally {
  if (ptyId !== null) {
    try { await invoke('ptyKill', { id: ptyId }) } catch {}
  }
}

console.log('PTY transport wire check passed')
