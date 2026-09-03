/**
 * dsh-sidebar — host half (composition plugin).
 *
 * Mounts the `rsidebarGit` Typert remote service that the browser half
 * (lib/client.js) calls for git status/log/stage/unstage/commit/discard/sync
 * against the caller-supplied repo cwd, and the host-half terminal transport
 * (ptySpawn/ptyWrite/ptyPull/ptyKill, ADR 0002) whose PTY sessions live in
 * this host process. Composition row:
 *
 *   - insert:
 *       - id: sidebar
 *         name: 'dsh-sidebar'
 */
import { GitSidebarGateway, PACKAGE } from './remote.js'

export const name = 'sidebar'
// `subprocess` backs the terminal transport: Cordis refuses ctx.subprocess
// unless the plugin declares it here.
export const inject = ['shell', 'typert', 'subprocess']

const shq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'"
const text = (c) => (c && typeof c.text === 'string' ? c.text : '')
const RING_LIMIT = 100 * 1024
const PULL_HOLD_MS = 1000
// File previews (ticket #7): one readFile payload may not exceed 2 MB, so a
// giant file can never flood the RPC channel or the iframe srcdoc.
const READ_FILE_LIMIT = 2 * 1024 * 1024

export function apply(ctx) {
  const sandboxPolicy = ctx.get('sandboxPolicy')
  const fallbackRoot = sandboxPolicy && sandboxPolicy.workspaceRoot
    ? sandboxPolicy.workspaceRoot
    : ctx.shell.resolve({ command: 'true' }).workdir

  function cwdOf(cwd) {
    return typeof cwd === 'string' && cwd.length > 0 && cwd[0] === '/' ? cwd : fallbackRoot
  }

  function failure(message) {
    return new Error(`dsh-sidebar: ${message}`)
  }

  // The controller's shell calls are direct plugin calls, so the DSH shell
  // executor resolves them against the DEPLOYMENT sandbox policy — whose
  // default mode is read-only, denying every write git needs (stage, commit,
  // push all write .git). Tool calls pass a complete per-call policy; the
  // card does the same, scoped to the Working Repository it operates on: the
  // user's button click is the approval, and the grant never exceeds the
  // repository plus temp areas.
  function repoPolicy(cwd) {
    return { mode: 'workspace-write', workspaceRoot: cwd }
  }

  async function git(cwd, args, opts) {
    const req = {
      command: 'git -C ' + shq(cwd) + ' ' + args,
      timeoutMs: opts && opts.timeoutMs ? opts.timeoutMs : 15000,
      sandboxPolicy: repoPolicy(cwd),
    }
    if (opts && opts.stdin !== undefined) req.stdin = opts.stdin
    const res = await ctx.shell.run(ctx.shell.resolve(req))
    return { code: res.exitCode, out: text(res.stdout), err: text(res.stderr).trim() }
  }

  // Terminal transport (ADR 0002): PTY sessions live in this host process.
  // Output is buffered in a bounded per-shell ring and served by the long-poll
  // ptyPull; the buffer also backs reload re-attach (ticket #9 reads it).
  const terminals = new Map()
  let ptyCounter = 0
  // Ticket #9: session ids embed a per-boot nonce. A page reload carries
  // tab-persisted ids back to this host, so ids must stay unique across
  // host restarts — a plain counter would let a restored tab re-attach to
  // a later boot's pty-1, and a dead session would look like a live one.
  const ptyBoot = Math.random().toString(36).slice(2, 8)

  function ptySize(value, label) {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw failure(`${label} must be a finite number`)
    return Math.max(2, Math.floor(value))
  }

  function wake(session) {
    for (const waiter of [...session.waiters]) waiter()
  }

  // A UTF-8 sequence can straddle two output chunks; hold the trailing
  // incomplete sequence and prepend it to the next chunk so the ring never
  // stores replacement-corrupted text.
  function splitUtf8(buf) {
    const n = buf.length
    let i = n - 1
    while (i >= 0 && (buf[i] & 0xC0) === 0x80) i--
    if (i < 0) return { complete: buf, pending: null }
    const lead = buf[i]
    let need = 1
    if ((lead & 0xE0) === 0xC0) need = 2
    else if ((lead & 0xF0) === 0xE0) need = 3
    else if ((lead & 0xF8) === 0xF0) need = 4
    if (n - i < need) return { complete: buf.slice(0, i), pending: buf.slice(i) }
    return { complete: buf, pending: null }
  }

  function appendBody(session, body) {
    if (!body) return
    session.seq += 1
    session.chunks.push({ seq: session.seq, text: body })
    session.bytes += Buffer.byteLength(body, 'utf8')
    while (session.bytes > RING_LIMIT && session.chunks.length > 0) {
      const dropped = session.chunks.shift()
      session.bytes -= Buffer.byteLength(dropped.text, 'utf8')
    }
    wake(session)
  }

  function appendChunk(session, chunk) {
    const raw = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
    const joined = session.pending ? Buffer.concat([session.pending, raw]) : raw
    const split = splitUtf8(joined)
    session.pending = split.pending && split.pending.length > 0 ? split.pending : null
    appendBody(session, split.complete.toString('utf8'))
  }

  function sessionOf(id) {
    const session = terminals.get(id)
    if (!session) throw failure(`unknown pty session: ${id}`)
    return session
  }

  // Newest chunks with seq > afterSeq; clamps to what the ring still retains.
  function readFrom(session, afterSeq) {
    let seq = afterSeq
    let chunk = ''
    for (const entry of session.chunks) {
      if (entry.seq > seq) {
        seq = entry.seq
        chunk += entry.text
      }
    }
    return { seq, chunk }
  }

  const controller = {
    async status(cwdArg) {
      const cwd = cwdOf(cwdArg)
      const empty = {
        repo: false, root: cwd, branch: '', detached: false, upstream: null,
        ahead: 0, behind: 0, staged: [], unstaged: [], conflicts: [], fingerprint: '',
      }
      const inside = await git(cwd, 'rev-parse --is-inside-work-tree')
      if (inside.code !== 0 || inside.out.trim() !== 'true') return empty

      let branch = ''
      let detached = false
      const sym = await git(cwd, 'symbolic-ref --short -q HEAD')
      if (sym.code === 0 && sym.out.trim()) {
        branch = sym.out.trim()
      } else {
        const rev = await git(cwd, 'rev-parse --short HEAD')
        if (rev.code === 0 && rev.out.trim()) {
          branch = rev.out.trim()
          detached = true
        }
      }

      let upstream = null
      let ahead = 0
      let behind = 0
      const up = await git(cwd, 'rev-parse --abbrev-ref --symbolic-full-name @{upstream}')
      if (up.code === 0 && up.out.trim()) {
        upstream = up.out.trim()
        const counts = await git(cwd, 'rev-list --left-right --count HEAD...@{upstream}')
        if (counts.code === 0) {
          const m = counts.out.trim().split(/\s+/)
          ahead = parseInt(m[0] || '0', 10) || 0
          behind = parseInt(m[1] || '0', 10) || 0
        }
      }

      const staged = []
      const unstaged = []
      const conflicts = []
      const st = await git(cwd, 'status --porcelain -z -uall', { timeoutMs: 20000 })
      if (st.code !== 0) throw failure(st.err || 'git status failed')
      const toks = st.out.split('\0')
      for (let i = 0; i < toks.length; i++) {
        const t = toks[i]
        if (!t || t.length < 4) continue
        const x = t[0]
        const y = t[1]
        const path = t.slice(3)
        let origPath = null
        if (x === 'R' || x === 'C') {
          origPath = toks[i + 1] || null
          i++
        }
        if (x === '?' && y === '?') {
          unstaged.push({ path, status: 'U', untracked: true, origPath: null })
          continue
        }
        if (x === '!') continue
        const conflict = x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')
        if (conflict) {
          conflicts.push({ path, status: x + y, untracked: false, origPath: null })
          continue
        }
        if (x !== ' ' && x !== '?') staged.push({ path, status: x, untracked: false, origPath })
        if (y !== ' ' && y !== '?') unstaged.push({ path, status: y, untracked: false, origPath })
      }

      const headR = await git(cwd, 'rev-parse HEAD')
      const head = headR.code === 0 ? headR.out.trim() : ''
      const refsR = await git(cwd, "for-each-ref '--format=%(objectname) %(refname)'")
      const refs = refsR.code === 0 ? refsR.out : ''
      const fingerprint = (staged.length + unstaged.length + conflicts.length) + '|' + head + '|' + refs

      return Object.assign({}, empty, {
        repo: true, branch, detached, upstream, ahead, behind, staged, unstaged, conflicts, fingerprint,
      })
    },

    async log(cwdArg, skipArg, maxArg) {
      const cwd = cwdOf(cwdArg)
      const skip = Math.max(0, skipArg | 0)
      const max = Math.min(200, Math.max(1, maxArg || 100))
      const fmt = '%H%x1f%h%x1f%P%x1f%an%x1f%at%x1f%D%x1f%s%x1e'
      const r = await git(cwd, 'log --all --topo-order --skip=' + skip + ' --max-count=' + max + ' ' + shq('--pretty=tformat:' + fmt), { timeoutMs: 20000 })
      if (r.code !== 0) {
        if (/does not have any commits|ambiguous argument|bad default revision|unknown revision|unborn|not a git repository/i.test(r.err)) {
          return { commits: [], hasMore: false }
        }
        throw failure(r.err || 'git log failed')
      }
      const commits = []
      const records = r.out.split('\x1e')
      for (const rec of records) {
        const clean = rec.replace(/^\s+|\s+$/g, '')
        if (!clean) continue
        const f = clean.split('\x1f')
        if (f.length < 7) continue
        const refs = []
        if (f[5]) {
          for (const rawPart of f[5].split(', ')) {
            let part = rawPart.trim()
            if (!part || part === 'HEAD') continue
            if (part.indexOf('HEAD -> ') === 0) part = part.slice(8)
            if (part.indexOf('tag: ') === 0) refs.push({ name: part.slice(5), type: 'tag' })
            else if (part.indexOf('/') !== -1) refs.push({ name: part, type: 'remote' })
            else refs.push({ name: part, type: 'branch' })
          }
        }
        commits.push({
          hash: f[0],
          short: f[1],
          parents: f[2] ? f[2].split(' ').filter(Boolean) : [],
          author: f[3],
          time: parseInt(f[4], 10) || 0,
          refs,
          subject: f[6],
        })
      }
      return { commits, hasMore: commits.length === max }
    },

    async stage(cwdArg, paths) {
      const cwd = cwdOf(cwdArg)
      if (!paths.length) throw failure('no paths given')
      const r = await git(cwd, 'add -- ' + paths.map(shq).join(' '), { timeoutMs: 30000 })
      if (r.code !== 0) throw failure(r.err || 'git add failed')
      return { ok: true }
    },

    async unstage(cwdArg, paths) {
      const cwd = cwdOf(cwdArg)
      if (!paths.length) throw failure('no paths given')
      let r = await git(cwd, 'restore --staged -- ' + paths.map(shq).join(' '), { timeoutMs: 30000 })
      if (r.code !== 0) r = await git(cwd, 'reset -q -- ' + paths.map(shq).join(' '), { timeoutMs: 30000 })
      if (r.code !== 0) throw failure(r.err || 'git unstage failed')
      return { ok: true }
    },

    async commit(cwdArg, message, stageAll) {
      const cwd = cwdOf(cwdArg)
      if (!/\S/.test(message)) throw failure('commit message is empty')
      if (stageAll) {
        const add = await git(cwd, 'add -A', { timeoutMs: 30000 })
        if (add.code !== 0) throw failure(add.err || 'git add -A failed')
      }
      const r = await git(cwd, 'commit -F -', { stdin: message, timeoutMs: 60000 })
      if (r.code !== 0) throw failure(r.err || r.out || 'git commit failed')
      return { ok: true }
    },

    async discard(cwdArg, path, untracked) {
      const cwd = cwdOf(cwdArg)
      if (!path) throw failure('no path given')
      if (untracked) {
        const rm = await ctx.shell.run(ctx.shell.resolve({ command: 'rm -f -- ' + shq(path), workdir: cwd, timeoutMs: 15000, sandboxPolicy: repoPolicy(cwd) }))
        if (rm.exitCode !== 0) throw failure(text(rm.stderr).trim() || 'rm failed')
        return { ok: true }
      }
      let r = await git(cwd, 'restore --worktree -- ' + shq(path), { timeoutMs: 30000 })
      if (r.code !== 0) r = await git(cwd, 'checkout -- ' + shq(path), { timeoutMs: 30000 })
      if (r.code !== 0) throw failure(r.err || 'git discard failed')
      return { ok: true }
    },

    async sync(cwdArg, op) {
      const cwd = cwdOf(cwdArg)
      let r = await git(cwd, op, { timeoutMs: 90000 })
      // DSH's file sandbox masks metadata for paths outside the workspace, so
      // ssh sees /etc/ssh/ssh_config* as owner nobody:nobody, fails its
      // ownership check and refuses its config: "Bad owner or permissions on
      // /etc/ssh/ssh_config.d/*.conf" kills fetch/pull/push before any network
      // access. Retry once with ssh pointed at only the user's own config —
      // the file the sandbox does not mask — so host aliases, ports and
      // IdentityFile settings still apply. Healthy machines never reach the
      // retry, and non-ssh remotes never fail this way.
      if (r.code !== 0 && /Bad owner or permissions/.test(r.err)) {
        r = await git(cwd, '-c core.sshCommand=' + shq('ssh -F ~/.ssh/config') + ' ' + op, { timeoutMs: 90000 })
      }
      if (r.code !== 0) throw failure(r.err || r.out || ('git ' + op + ' failed'))
      return { ok: true }
    },

    async ptySpawn(cwdArg, colsArg, rowsArg) {
      const subprocess = ctx.subprocess
      if (!subprocess || typeof subprocess.spawnTerminal !== 'function') throw failure('subprocess service unavailable')
      const handle = await subprocess.spawnTerminal({
        // Prepend `env TERM=xterm-256color`: dsh-subprocess-local hard-codes
        // name: 'dumb', which node-pty turns into TERM=dumb, and env passed
        // to spawnTerminal loses that race. argv is the seam that wins, so
        // the shell sees a real terminal type — colors work and p10k stops
        // redrawing the prompt in a storm.
        argv: ['env', 'TERM=xterm-256color', process.env.SHELL || '/bin/sh'],
        cwd: cwdOf(cwdArg),
        rows: ptySize(rowsArg, 'rows'),
        cols: ptySize(colsArg, 'cols'),
        graceMs: 2000,
      })
      ptyCounter += 1
      const session = { id: `pty-${ptyBoot}-${ptyCounter}`, handle, chunks: [], bytes: 0, seq: 0, waiters: new Set(), alive: true, pending: null }
      terminals.set(session.id, session)
      handle.output.on('data', (chunk) => appendChunk(session, chunk))
      // The stream ends after the terminal's queued output, so this wake is the
      // final one after exit; `done` settling marks the session not alive. Any
      // held partial UTF-8 sequence is flushed here: the stream will not
      // deliver more bytes after this point.
      handle.output.on('end', () => {
        if (session.pending && session.pending.length > 0) {
          const tail = session.pending
          session.pending = null
          appendBody(session, tail.toString('utf8'))
        }
        wake(session)
      })
      const settle = () => {
        session.alive = false
        wake(session)
      }
      handle.done.then(settle, settle)
      return { id: session.id, pid: handle.pid }
    },

    async ptyWrite(idArg, data) {
      const session = sessionOf(idArg)
      await session.handle.write(data == null ? '' : String(data))
      return { ok: true }
    },

    async ptyPull(idArg, afterSeqArg) {
      const session = sessionOf(idArg)
      const afterSeq = typeof afterSeqArg === 'number' && Number.isFinite(afterSeqArg) ? afterSeqArg : 0
      const first = readFrom(session, afterSeq)
      if (first.chunk !== '') return { seq: first.seq, chunk: first.chunk, alive: session.alive }
      if (!session.alive) return { seq: afterSeq, chunk: '', alive: false }
      // Long-poll: hold until new output lands (waiters re-read the ring) or
      // the ~1s hold elapses; a dead shell reports alive: false immediately.
      return new Promise((resolve) => {
        let settled = false
        let timer = null
        function finish(pull) {
          if (settled) return
          settled = true
          session.waiters.delete(waiter)
          clearTimeout(timer)
          resolve(pull)
        }
        function waiter() {
          if (settled) return
          const read = readFrom(session, afterSeq)
          if (read.chunk !== '' || !session.alive) {
            finish({ seq: read.seq, chunk: read.chunk, alive: session.alive })
          }
        }
        timer = setTimeout(() => finish({ seq: afterSeq, chunk: '', alive: session.alive }), PULL_HOLD_MS)
        session.waiters.add(waiter)
      })
    },

    async ptyKill(idArg) {
      const session = sessionOf(idArg)
      try {
        await session.handle.terminate()
      } finally {
        session.alive = false
        wake(session)
      }
      terminals.delete(idArg)
      return { ok: true }
    },

    // File previews (ticket #7): read one file from the Working Repository
    // for the HTML/Markdown Panel Tabs. The picker path is relative to the
    // repository root and is never trusted: absolute paths must already sit
    // inside the root, and no '..' may climb above it. The walk stays
    // plain-string based (no node:path) so the dynamic twin mirrors it
    // literally.
    async readFile(cwdArg, pathArg) {
      const rootRaw = cwdOf(cwdArg)
      const root = rootRaw.length > 1 ? rootRaw.replace(/\/+$/, '') : '/'
      const path = String(pathArg == null ? '' : pathArg).trim()
      if (!path) throw failure('no path given')
      if (path.indexOf('\0') !== -1) throw failure('path contains a NUL byte')
      let rel = path
      if (path[0] === '/') {
        if (root === '/') rel = path.slice(1)
        else if (path === root) rel = ''
        else if (path.indexOf(root + '/') === 0) rel = path.slice(root.length + 1)
        else throw failure('path escapes the working repository')
      }
      const parts = []
      for (const segment of rel.split('/')) {
        if (segment === '' || segment === '.') continue
        if (segment === '..') {
          if (parts.length === 0) throw failure('path escapes the working repository')
          parts.pop()
          continue
        }
        parts.push(segment)
      }
      const abs = parts.length ? root + '/' + parts.join('/') : root
      // Confinement is re-checked on the real path: wc and cat follow
      // symlinks, so a link inside the repository pointing outside it must
      // not escape. realpath also errors on a missing file.
      const realRes = await ctx.shell.run(ctx.shell.resolve({ command: 'realpath -- ' + shq(abs), timeoutMs: 15000, sandboxPolicy: repoPolicy(root) }))
      if (realRes.exitCode !== 0) throw failure(text(realRes.stderr).trim() || 'cannot read file')
      const real = text(realRes.stdout).trim()
      if (root !== '/' && real !== root && real.indexOf(root + '/') !== 0) throw failure('path escapes the working repository')
      const target = real
      // Size first, content second: the wc probe refuses an oversized file
      // before its bytes ever cross the channel. The shell service spawns
      // commands directly (no shell), so there is no redirection — wc prints
      // "  <size> <path>" and parseInt reads the size field. An unparseable
      // size fails closed, and the cat output is capped too, so a file
      // growing between the two probes cannot flood the channel.
      const sizeRes = await ctx.shell.run(ctx.shell.resolve({ command: 'wc -c ' + shq(target), timeoutMs: 15000, sandboxPolicy: repoPolicy(root) }))
      if (sizeRes.exitCode !== 0) throw failure(text(sizeRes.stderr).trim() || 'cannot read file')
      const size = parseInt(text(sizeRes.stdout).trim(), 10)
      if (!Number.isFinite(size)) throw failure('cannot measure file size')
      if (size > READ_FILE_LIMIT) throw failure('file is larger than the 2 MB preview limit')
      const catRes = await ctx.shell.run(ctx.shell.resolve({ command: 'cat -- ' + shq(target), timeoutMs: 15000, sandboxPolicy: repoPolicy(root) }))
      if (catRes.exitCode !== 0) throw failure(text(catRes.stderr).trim() || 'cannot read file')
      const content = text(catRes.stdout)
      if (content.length > READ_FILE_LIMIT) throw failure('file is larger than the 2 MB preview limit')
      return { content }
    },

    // Ticket #8: keep the kernel PTY size in step with the rendered
    // terminal surface. The DSH `LocalTerminalHandle` exposes no resize
    // verb; `handle.terminal` is the underlying node-pty object (a plain
    // class field). The reach is feature-detected and fails loudly
    // otherwise; the client swallows resize failures as progressive
    // enhancement.
    async ptyResize(idArg, colsArg, rowsArg) {
      const session = sessionOf(idArg)
      const terminal = session.handle.terminal
      if (!terminal || typeof terminal.resize !== 'function') throw failure('pty resize is not supported by this DSH build')
      terminal.resize(ptySize(colsArg, 'cols'), ptySize(rowsArg, 'rows'))
      return { ok: true }
    },
  }

  // The Typert loader discovers this package's host manifest; the gateway
  // supplies its implementations under the matching rsidebarGit service key.
  if (ctx.typert !== undefined) new GitSidebarGateway(ctx, controller)
  ctx.logger.info(`[${PACKAGE}] rsidebarGit remote service mounted (fallback root: ${fallbackRoot})`)
}
