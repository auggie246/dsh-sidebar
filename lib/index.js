/**
 * dsh-sidebar — host half (composition plugin).
 *
 * Mounts the `rsidebarGit` Typert remote service that the browser half
 * (lib/client.js) calls for git status/log/stage/unstage/commit/discard/sync
 * against the caller-supplied repo cwd. Composition row:
 *
 *   - insert:
 *       - id: sidebar
 *         name: 'dsh-sidebar'
 */
import { GitSidebarGateway, PACKAGE } from './remote.js'

export const name = 'sidebar'
export const inject = ['shell', 'typert']

const shq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'"
const text = (c) => (c && typeof c.text === 'string' ? c.text : '')

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

  async function git(cwd, args, opts) {
    const req = {
      command: 'git -C ' + shq(cwd) + ' ' + args,
      timeoutMs: opts && opts.timeoutMs ? opts.timeoutMs : 15000,
    }
    if (opts && opts.stdin !== undefined) req.stdin = opts.stdin
    const res = await ctx.shell.run(ctx.shell.resolve(req))
    return { code: res.exitCode, out: text(res.stdout), err: text(res.stderr).trim() }
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
        const rm = await ctx.shell.run(ctx.shell.resolve({ command: 'rm -f -- ' + shq(path), workdir: cwd, timeoutMs: 15000 }))
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
      const r = await git(cwd, op, { timeoutMs: 90000 })
      if (r.code !== 0) throw failure(r.err || r.out || ('git ' + op + ' failed'))
      return { ok: true }
    },
  }

  // The Typert loader discovers this package's host manifest; the gateway
  // supplies its implementations under the matching rsidebarGit service key.
  if (ctx.typert !== undefined) new GitSidebarGateway(ctx, controller)
  ctx.logger.info(`[${PACKAGE}] rsidebarGit remote service mounted (fallback root: ${fallbackRoot})`)
}
