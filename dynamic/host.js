// rside-2 — Host half (Cordis dynamic plugin, package pkg-4)
// This file is the exact `code.host` function body passed to cordis_define:
// plain JavaScript, no imports/JSX/TS, evaluated as a function body that
// returns a Cordis Plugin. Reinstall by feeding this text back as code.host.

return {
  apply(ctx) {
    const shell = ctx.get('shell')
    if (shell === undefined) {
      console.error('rside: shell service unavailable')
      return
    }
    const sandboxPolicy = ctx.get('sandboxPolicy')
    const fallbackRoot = sandboxPolicy && sandboxPolicy.workspaceRoot
      ? sandboxPolicy.workspaceRoot
      : shell.resolve({ command: 'true' }).workdir
    console.log('rside fallback git root: ' + fallbackRoot)

    const shq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'"
    const out = (c) => (c && typeof c.text === 'string' ? c.text : '')

    function cwdOf(args) {
      const c = args && typeof args.cwd === 'string' ? args.cwd : ''
      return c.length > 0 && c[0] === '/' ? c : fallbackRoot
    }

    async function git(cwd, args, opts) {
      const req = {
        command: 'git -C ' + shq(cwd) + ' ' + args,
        timeoutMs: opts && opts.timeoutMs ? opts.timeoutMs : 15000,
      }
      if (opts && opts.stdin !== undefined) req.stdin = opts.stdin
      const res = await shell.run(shell.resolve(req))
      return { code: res.exitCode, out: out(res.stdout), err: out(res.stderr).trim() }
    }

    // Terminal transport (ADR 0002): PTY sessions live in the DSH host
    // process. Output is buffered in a bounded per-shell ring and served by
    // the long-poll ptyPull; the buffer also backs reload re-attach.
    const subprocess = ctx.get('subprocess')
    const RING_LIMIT = 100 * 1024
    const PULL_HOLD_MS = 1000
    const terminals = new Map()
    let ptyCounter = 0

    function ptySize(value, label) {
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(label + ' must be a finite number')
      return Math.max(2, Math.floor(value))
    }

    function wake(session) {
      const waiters = Array.from(session.waiters)
      for (const waiter of waiters) waiter()
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

    // Newest chunks with seq > afterSeq; clamps to what the ring still retains.
    function readFrom(session, afterSeq) {
      let seq = afterSeq
      let chunk = ''
      for (const entry of session.chunks) {
        if (entry.seq > seq) {
          seq = entry.seq
          chunk = chunk + entry.text
        }
      }
      return { seq: seq, chunk: chunk }
    }

    harness.handle('status', async (args) => {
      try {
        const cwd = cwdOf(args)
        const inside = await git(cwd, 'rev-parse --is-inside-work-tree')
        if (inside.code !== 0 || inside.out.trim() !== 'true') return { ok: true, repo: false, root: cwd }

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
        if (st.code === 0) {
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
              unstaged.push({ path: path, status: 'U', untracked: true })
              continue
            }
            if (x === '!') continue
            const conflict = x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')
            if (conflict) {
              conflicts.push({ path: path, status: x + y })
              continue
            }
            if (x !== ' ' && x !== '?') staged.push({ path: path, status: x, origPath: origPath })
            if (y !== ' ' && y !== '?') unstaged.push({ path: path, status: y, origPath: origPath })
          }
        }

        const headR = await git(cwd, 'rev-parse HEAD')
        const head = headR.code === 0 ? headR.out.trim() : ''
        const refsR = await git(cwd, "for-each-ref '--format=%(objectname) %(refname)'")
        const refs = refsR.code === 0 ? refsR.out : ''
        const fingerprint = (staged.length + unstaged.length + conflicts.length) + '|' + head + '|' + refs

        return {
          ok: true,
          repo: true,
          root: cwd,
          branch: branch,
          detached: detached,
          upstream: upstream,
          ahead: ahead,
          behind: behind,
          staged: staged,
          unstaged: unstaged,
          conflicts: conflicts,
          fingerprint: fingerprint,
        }
      } catch (e) {
        return { ok: false, error: String((e && e.message) || e) }
      }
    })

    harness.handle('log', async (args) => {
      try {
        const cwd = cwdOf(args)
        const skip = Math.max(0, ((args && args.skip) || 0) | 0)
        const max = Math.min(200, Math.max(1, (args && args.max) || 100))
        const fmt = '%H%x1f%h%x1f%P%x1f%an%x1f%at%x1f%D%x1f%s%x1e'
        const r = await git(cwd, 'log --all --topo-order --skip=' + skip + ' --max-count=' + max + ' ' + shq('--pretty=tformat:' + fmt), { timeoutMs: 20000 })
        if (r.code !== 0) {
          if (/does not have any commits|ambiguous argument|bad default revision|unknown revision|unborn|not a git repository/i.test(r.err)) {
            return { ok: true, commits: [], hasMore: false }
          }
          return { ok: false, error: r.err || 'git log failed' }
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
            refs: refs,
            subject: f[6],
          })
        }
        return { ok: true, commits: commits, hasMore: commits.length === max }
      } catch (e) {
        return { ok: false, error: String((e && e.message) || e) }
      }
    })

    harness.handle('stage', async (args) => {
      const paths = (args && args.paths) || []
      if (!paths.length) return { ok: false, error: 'no paths given' }
      const r = await git(cwdOf(args), 'add -- ' + paths.map(shq).join(' '), { timeoutMs: 30000 })
      return r.code === 0 ? { ok: true } : { ok: false, error: r.err || 'git add failed' }
    })

    harness.handle('unstage', async (args) => {
      const paths = (args && args.paths) || []
      if (!paths.length) return { ok: false, error: 'no paths given' }
      const cwd = cwdOf(args)
      let r = await git(cwd, 'restore --staged -- ' + paths.map(shq).join(' '), { timeoutMs: 30000 })
      if (r.code !== 0) r = await git(cwd, 'reset -q -- ' + paths.map(shq).join(' '), { timeoutMs: 30000 })
      return r.code === 0 ? { ok: true } : { ok: false, error: r.err || 'unstage failed' }
    })

    harness.handle('commit', async (args) => {
      const message = String((args && args.message) || '')
      if (!/\S/.test(message)) return { ok: false, error: 'commit message is empty' }
      const cwd = cwdOf(args)
      if (args && args.stageAll) {
        const add = await git(cwd, 'add -A', { timeoutMs: 30000 })
        if (add.code !== 0) return { ok: false, error: add.err || 'git add -A failed' }
      }
      const r = await git(cwd, 'commit -F -', { stdin: message, timeoutMs: 60000 })
      if (r.code !== 0) return { ok: false, error: r.err || r.out || 'git commit failed' }
      return { ok: true }
    })

    harness.handle('discard', async (args) => {
      const path = String((args && args.path) || '')
      if (!path) return { ok: false, error: 'no path given' }
      const cwd = cwdOf(args)
      if (args && args.untracked) {
        const rm = await shell.run(shell.resolve({ command: 'rm -f -- ' + shq(path), workdir: cwd, timeoutMs: 15000 }))
        return rm.exitCode === 0 ? { ok: true } : { ok: false, error: out(rm.stderr).trim() || 'rm failed' }
      }
      let r = await git(cwd, 'restore --worktree -- ' + shq(path), { timeoutMs: 30000 })
      if (r.code !== 0) r = await git(cwd, 'checkout -- ' + shq(path), { timeoutMs: 30000 })
      return r.code === 0 ? { ok: true } : { ok: false, error: r.err || 'discard failed' }
    })

    harness.handle('sync', async (args) => {
      const op = args && args.op
      if (op !== 'fetch' && op !== 'pull' && op !== 'push') return { ok: false, error: 'unknown sync op' }
      const r = await git(cwdOf(args), op, { timeoutMs: 90000 })
      return r.code === 0 ? { ok: true } : { ok: false, error: r.err || r.out || ('git ' + op + ' failed') }
    })

    harness.handle('ptySpawn', async (args) => {
      try {
        if (!subprocess || typeof subprocess.spawnTerminal !== 'function') return { ok: false, error: 'subprocess service unavailable' }
        const handle = await subprocess.spawnTerminal({
          argv: [process.env.SHELL || '/bin/sh'],
          cwd: cwdOf(args),
          rows: ptySize(args && args.rows, 'rows'),
          cols: ptySize(args && args.cols, 'cols'),
          graceMs: 2000,
        })
        ptyCounter += 1
        const session = { id: 'pty-' + ptyCounter, handle: handle, chunks: [], bytes: 0, seq: 0, waiters: new Set(), alive: true, pending: null }
        terminals.set(session.id, session)
        handle.output.on('data', (chunk) => appendChunk(session, chunk))
        // The stream ends after the terminal's queued output, so this wake is
        // the final one after exit; `done` settling marks the session not
        // alive. Any held partial UTF-8 sequence is flushed here: the stream
        // will not deliver more bytes after this point.
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
        return { ok: true, id: session.id, pid: handle.pid }
      } catch (e) {
        return { ok: false, error: String((e && e.message) || e) }
      }
    })

    harness.handle('ptyWrite', async (args) => {
      const id = args && args.id
      const session = terminals.get(id)
      if (!session) return { ok: false, error: 'unknown pty session: ' + id }
      try {
        const data = args && args.data
        await session.handle.write(data == null ? '' : String(data))
        return { ok: true }
      } catch (e) {
        return { ok: false, error: String((e && e.message) || e) }
      }
    })

    harness.handle('ptyPull', async (args) => {
      const id = args && args.id
      const session = terminals.get(id)
      if (!session) return { ok: false, error: 'unknown pty session: ' + id }
      const afterSeqRaw = args && args.afterSeq
      const afterSeq = typeof afterSeqRaw === 'number' && Number.isFinite(afterSeqRaw) ? afterSeqRaw : 0
      const first = readFrom(session, afterSeq)
      if (first.chunk !== '') return { ok: true, seq: first.seq, chunk: first.chunk, alive: session.alive }
      if (!session.alive) return { ok: true, seq: afterSeq, chunk: '', alive: false }
      // Long-poll: hold until new output lands (waiters re-read the ring) or
      // the ~1s hold elapses; a dead shell reports alive: false immediately.
      return await new Promise((resolve) => {
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
            finish({ ok: true, seq: read.seq, chunk: read.chunk, alive: session.alive })
          }
        }
        timer = setTimeout(() => finish({ ok: true, seq: afterSeq, chunk: '', alive: session.alive }), PULL_HOLD_MS)
        session.waiters.add(waiter)
      })
    })

    harness.handle('ptyKill', async (args) => {
      const id = args && args.id
      const session = terminals.get(id)
      if (!session) return { ok: false, error: 'unknown pty session: ' + id }
      try {
        await session.handle.terminate()
      } finally {
        session.alive = false
        wake(session)
      }
      terminals.delete(id)
      return { ok: true }
    })
  },
}
