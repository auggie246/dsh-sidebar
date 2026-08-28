/*
 * dsh-sidebar — browser half (composition client plugin).
 *
 * dsh-client-modules consumes prebuilt client halves as lazy CJS factories;
 * keep this wrapper format (rather than native ESM). The factory requires
 * `react` from the shared loader registry; Cordis services (`slots`,
 * `remote`, `timer`) arrive through the plugin context declared in
 * module.exports.inject.
 */
window.__ModuleLoader__.load({
  id: 'dsh-sidebar',
  factory: (require) => {
    const module = { exports: {} }
    const React = require('react')
    const h = React.createElement
    const PACKAGE = 'dsh-sidebar'
    const SERVICE = 'rsidebarGit'

    // ------------------------------------------------------------------
    // Client Typert manifest mirroring lib/remote.js (deliberate duplicate:
    // the browser bundle cannot import the host module).
    // ------------------------------------------------------------------
    function fail(message) { throw new Error(`${PACKAGE} remote: ${message}`) }
    function codec(typeSymbol, parse) {
      return Object.freeze({ mode: 'strict', typeSymbol, schema: Object.freeze({ _zod: {}, parse }) })
    }
    function record(value, label) {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`)
      return value
    }
    function string(value, label) {
      if (typeof value !== 'string') fail(`${label} must be a string`)
      return value
    }
    function bool(value, label) {
      if (typeof value !== 'boolean') fail(`${label} must be a boolean`)
      return value
    }
    function finite(value, label) {
      if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${label} must be a finite number`)
      return value
    }
    function enumValue(value, values, label) {
      if (!values.includes(value)) fail(`${label} is invalid`)
      return value
    }
    function arrayOf(item, value, label) {
      if (!Array.isArray(value)) fail(`${label} must be an array`)
      return value.map((entry, i) => item(entry, `${label}[${i}]`))
    }
    function onlyKeys(object, keys, label) {
      for (const key of Object.keys(object)) if (!keys.includes(key)) fail(`${label}.${key} is not allowed`)
    }

    const FileInfoCodec = codec(`${PACKAGE}/FileInfo`, (value) => {
      const v = record(value, 'file')
      onlyKeys(v, ['path', 'status', 'untracked', 'origPath'], 'file')
      return {
        path: string(v.path, 'file.path'),
        status: string(v.status, 'file.status'),
        untracked: bool(v.untracked, 'file.untracked'),
        origPath: v.origPath === null ? null : string(v.origPath, 'file.origPath'),
      }
    })
    const RefInfoCodec = codec(`${PACKAGE}/RefInfo`, (value) => {
      const v = record(value, 'ref')
      onlyKeys(v, ['name', 'type'], 'ref')
      return { name: string(v.name, 'ref.name'), type: enumValue(v.type, ['branch', 'tag', 'remote'], 'ref.type') }
    })
    const CommitInfoCodec = codec(`${PACKAGE}/CommitInfo`, (value) => {
      const v = record(value, 'commit')
      onlyKeys(v, ['hash', 'short', 'parents', 'author', 'time', 'refs', 'subject'], 'commit')
      return {
        hash: string(v.hash, 'commit.hash'),
        short: string(v.short, 'commit.short'),
        parents: arrayOf((x, l) => string(x, l), v.parents, 'commit.parents'),
        author: string(v.author, 'commit.author'),
        time: finite(v.time, 'commit.time'),
        refs: arrayOf((x) => RefInfoCodec.schema.parse(x), v.refs, 'commit.refs'),
        subject: string(v.subject, 'commit.subject'),
      }
    })
    const StatusResultCodec = codec(`${PACKAGE}/StatusResult`, (value) => {
      const v = record(value, 'status result')
      onlyKeys(v, ['repo', 'root', 'branch', 'detached', 'upstream', 'ahead', 'behind', 'staged', 'unstaged', 'conflicts', 'fingerprint'], 'status result')
      return {
        repo: bool(v.repo, 'status.repo'),
        root: string(v.root, 'status.root'),
        branch: string(v.branch, 'status.branch'),
        detached: bool(v.detached, 'status.detached'),
        upstream: v.upstream === null ? null : string(v.upstream, 'status.upstream'),
        ahead: finite(v.ahead, 'status.ahead'),
        behind: finite(v.behind, 'status.behind'),
        staged: arrayOf((x) => FileInfoCodec.schema.parse(x), v.staged, 'status.staged'),
        unstaged: arrayOf((x) => FileInfoCodec.schema.parse(x), v.unstaged, 'status.unstaged'),
        conflicts: arrayOf((x) => FileInfoCodec.schema.parse(x), v.conflicts, 'status.conflicts'),
        fingerprint: string(v.fingerprint, 'status.fingerprint'),
      }
    })
    const LogResultCodec = codec(`${PACKAGE}/LogResult`, (value) => {
      const v = record(value, 'log result')
      onlyKeys(v, ['commits', 'hasMore'], 'log result')
      return {
        commits: arrayOf((x) => CommitInfoCodec.schema.parse(x), v.commits, 'log.commits'),
        hasMore: bool(v.hasMore, 'log.hasMore'),
      }
    })
    const OkResultCodec = codec(`${PACKAGE}/OkResult`, (value) => {
      const v = record(value, 'op result')
      onlyKeys(v, ['ok'], 'op result')
      return { ok: bool(v.ok, 'op.ok') }
    })
    const CwdParam = codec(`${PACKAGE}/Cwd`, (value) => string(value, 'cwd'))
    const SkipParam = codec(`${PACKAGE}/Skip`, (value) => finite(value, 'skip'))
    const MaxParam = codec(`${PACKAGE}/Max`, (value) => finite(value, 'max'))
    const PathsParam = codec(`${PACKAGE}/Paths`, (value) => arrayOf((x, l) => string(x, l), value, 'paths'))
    const MessageParam = codec(`${PACKAGE}/Message`, (value) => string(value, 'message'))
    const StageAllParam = codec(`${PACKAGE}/StageAll`, (value) => bool(value, 'stageAll'))
    const PathParam = codec(`${PACKAGE}/Path`, (value) => string(value, 'path'))
    const UntrackedParam = codec(`${PACKAGE}/Untracked`, (value) => bool(value, 'untracked'))
    const SyncOpParam = codec(`${PACKAGE}/SyncOp`, (value) => enumValue(value, ['fetch', 'pull', 'push'], 'op'))

    function param(name, c) {
      return { name, wire: name, source: 'json', codec: { mode: 'strict', typeSymbol: c.typeSymbol, schema: c.schema } }
    }
    function result(c) {
      return { mode: 'strict', typeSymbol: c.typeSymbol, schema: c.schema }
    }
    function invocation(method, parameters, res) {
      return {
        id: `${PACKAGE}#${SERVICE}/${method}`,
        service: SERVICE,
        namespace: SERVICE,
        method,
        invocation: { kind: 'direct' },
        parameters,
        result: res,
      }
    }
    const CWD = param('cwd', CwdParam)
    const TYPERT_REMOTE = Object.freeze({
      package: PACKAGE,
      descriptors: [
        invocation('status', [CWD], result(StatusResultCodec)),
        invocation('log', [CWD, param('skip', SkipParam), param('max', MaxParam)], result(LogResultCodec)),
        invocation('stage', [CWD, param('paths', PathsParam)], result(OkResultCodec)),
        invocation('unstage', [CWD, param('paths', PathsParam)], result(OkResultCodec)),
        invocation('commit', [CWD, param('message', MessageParam), param('stageAll', StageAllParam)], result(OkResultCodec)),
        invocation('discard', [CWD, param('path', PathParam), param('untracked', UntrackedParam)], result(OkResultCodec)),
        invocation('sync', [CWD, param('op', SyncOpParam)], result(OkResultCodec)),
      ],
    })

    // ------------------------------------------------------------------
    // Plugin
    // ------------------------------------------------------------------
    const inject = ['slots', 'remote', 'timer']

    /** Unwrap the { ok, value, error } envelope the remote bridge returns. */
    function remoteValue(result) {
      if (!result || !result.ok) throw new Error((result && result.error && result.error.message) || 'The DSH server rejected this request.')
      return result.value
    }

    function apply(ctx) {
      // Call-time facade: an early render reports "initializing" and later
      // calls hit the mounted service without re-registering any UI.
      const git = {}
      for (const method of ['status', 'log', 'stage', 'unstage', 'commit', 'discard', 'sync']) {
        git[method] = (...args) => {
          const target = ctx.get('remote.' + SERVICE)
          if (!target || typeof target[method] !== 'function') {
            return Promise.resolve({ ok: false, error: { message: 'The git sidebar service is still initializing. Try again in a moment.' } })
          }
          return target[method](...args)
        }
      }

      ctx.effect(async () => {
        const disposeRemote = await ctx.remote.$mount(TYPERT_REMOTE)
        return async () => { await disposeRemote() }
      }, `${PACKAGE}: git remote bridge`)

      const layout = ctx.get('layout')

      // ---------- tiny reactive store ----------
      function createStore(initial) {
        let value = initial
        const listeners = new Set()
        return {
          get: () => value,
          set: (v) => {
            value = v
            listeners.forEach((l) => { l() })
          },
          subscribe: (fn) => {
            listeners.add(fn)
            return () => { listeners.delete(fn) }
          },
        }
      }
      function useStore(store) {
        const [v, setV] = React.useState(store.get())
        React.useEffect(() => store.subscribe(() => setV(store.get())), [store])
        return v
      }

      function lsGet(k) {
        try {
          if (typeof localStorage !== 'undefined') return localStorage.getItem(k)
        } catch (e) {}
        return null
      }
      function lsSet(k, v) {
        try {
          if (typeof localStorage !== 'undefined') localStorage.setItem(k, v)
        } catch (e) {}
      }

      const VIS_KEY = 'dsh.rsidebar.cards.v1'
      let initialVis = {}
      const rawVis = lsGet(VIS_KEY)
      if (rawVis) {
        try { const parsed = JSON.parse(rawVis); if (parsed && typeof parsed === 'object') initialVis = parsed } catch (e) {}
      }
      const visStore = createStore(initialVis)
      const setCardVis = (id, on) => {
        const cur = Object.assign({}, visStore.get())
        cur[id] = on
        visStore.set(cur)
        lsSet(VIS_KEY, JSON.stringify(cur))
      }

      const openStore = createStore(false)
      const fpStore = createStore('')
      const cwdStore = createStore('')
      const cwdBySession = new Map()

      function relTime(ts) {
        try {
          const s = Math.max(0, Math.floor(Date.now() / 1000) - ts)
          if (s < 60) return s + 's'
          const m = Math.floor(s / 60)
          if (m < 60) return m + 'm'
          const hh = Math.floor(m / 60)
          if (hh < 24) return hh + 'h'
          return Math.floor(hh / 24) + 'd'
        } catch (e) { return '' }
      }
      function baseName(p) {
        const i = p.lastIndexOf('/')
        return i === -1 ? p : p.slice(i + 1)
      }
      function dirName(p) {
        const i = p.lastIndexOf('/')
        return i === -1 ? '' : p.slice(0, i)
      }
      async function copyText(text) {
        try {
          if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(text)
            return true
          }
        } catch (e) {}
        try {
          if (typeof document !== 'undefined') {
            const ta = document.createElement('textarea')
            ta.value = text
            ta.style.position = 'fixed'
            ta.style.opacity = '0'
            document.body.appendChild(ta)
            ta.focus()
            ta.select()
            const ok = document.execCommand ? document.execCommand('copy') : false
            document.body.removeChild(ta)
            return !!ok
          }
        } catch (e) {}
        return false
      }

      const cwd = () => cwdStore.get()

      // ---------- Git Status card ----------
      function GitStatusCard() {
        const [inst] = React.useState(() => ({ seq: 0 }))
        const [data, setData] = React.useState(null)
        const [err, setErr] = React.useState('')
        const [busy, setBusy] = React.useState('')
        const [msg, setMsg] = React.useState('')
        const [confirmPath, setConfirmPath] = React.useState('')

        async function refresh() {
          const my = ++inst.seq
          try {
            const r = remoteValue(await git.status(cwd()))
            if (my !== inst.seq) return
            setData(r)
            setErr('')
            if (r.repo && r.fingerprint) fpStore.set(String(r.fingerprint))
          } catch (e) {
            if (my !== inst.seq) return
            setErr(String((e && e.message) || e))
          }
        }

        React.useEffect(() => {
          refresh()
          return ctx.interval(() => { refresh() }, 3000)
        }, [])

        async function act(run) {
          setBusy('op')
          try {
            remoteValue(await run())
            await refresh()
            return true
          } catch (e) {
            setErr(String((e && e.message) || e))
            return false
          } finally {
            setBusy('')
          }
        }

        function commit() {
          if (!data || !data.repo || busy !== '' || !/\S/.test(msg)) return
          const stageAll = data.staged.length === 0 && data.unstaged.length > 0
          setBusy('commit')
          git.commit(cwd(), msg, stageAll).then((r) => {
            try { remoteValue(r); setMsg('') } catch (e) { setErr(String((e && e.message) || e)) } finally { setBusy(''); refresh() }
          }).catch((e) => { setErr(String((e && e.message) || e)); setBusy('') })
        }

        if (!data) {
          return h('div', { className: 'rsb-empty' }, err ? 'Error: ' + err : 'Loading git status…')
        }
        if (!data.repo) {
          return h('div', { className: 'rsb-empty' },
            'Not a git repository.',
            h('div', { className: 'rsb-empty-sub' }, data.root ? 'Resolved: ' + data.root : 'This card follows the current session workspace.'))
        }

        const noUpstream = !data.upstream
        const changeCount = data.staged.length + data.unstaged.length + data.conflicts.length
        const commitDisabled = busy !== '' || !/\S/.test(msg) || changeCount === 0

        function statusChip(f) {
          return h('span', { className: 'rsb-chip rsb-chip-' + f.status }, f.status)
        }

        function fileRow(f, kind) {
          const actions = []
          if (kind === 'staged') {
            actions.push(h('button', { key: 'u', className: 'rsb-act', title: 'Unstage', disabled: busy !== '', onClick: () => act(() => git.unstage(cwd(), [f.path])) }, '−'))
          } else if (kind === 'conflicts') {
            actions.push(h('button', { key: 's', className: 'rsb-act', title: 'Mark resolved (stage)', disabled: busy !== '', onClick: () => act(() => git.stage(cwd(), [f.path])) }, '+'))
          } else {
            actions.push(h('button', { key: 's', className: 'rsb-act', title: 'Stage', disabled: busy !== '', onClick: () => act(() => git.stage(cwd(), [f.path])) }, '+'))
            if (confirmPath === f.path) {
              actions.push(h('button', { key: 'dy', className: 'rsb-act rsb-act-danger', title: 'Confirm discard', onClick: () => { setConfirmPath(''); act(() => git.discard(cwd(), f.path, f.untracked)) } }, '✓'))
              actions.push(h('button', { key: 'dn', className: 'rsb-act', title: 'Cancel', onClick: () => setConfirmPath('') }, '×'))
            } else {
              actions.push(h('button', { key: 'd', className: 'rsb-act', title: 'Discard changes', disabled: busy !== '', onClick: () => setConfirmPath(f.path) }, '↺'))
            }
          }
          return h('div', { key: kind + ':' + f.path, className: 'rsb-file', title: f.path },
            statusChip(f),
            h('span', { className: 'rsb-fname' }, baseName(f.path)),
            h('span', { className: 'rsb-fdir' }, dirName(f.path)),
            h('span', { className: 'rsb-fact' }, actions))
        }

        function group(title, files, kind) {
          if (!files.length) return null
          const headActs = []
          if (kind === 'staged') headActs.push(h('button', { key: 'ua', className: 'rsb-act', title: 'Unstage all', disabled: busy !== '', onClick: () => act(() => git.unstage(cwd(), files.map((f) => f.path))) }, '−'))
          if (kind === 'changes') headActs.push(h('button', { key: 'sa', className: 'rsb-act', title: 'Stage all', disabled: busy !== '', onClick: () => act(() => git.stage(cwd(), files.map((f) => f.path))) }, '+'))
          return h('div', { key: kind, className: 'rsb-group' },
            h('div', { className: 'rsb-group-head' },
              h('span', { className: 'rsb-group-title' }, title),
              h('span', { className: 'rsb-count' }, String(files.length)),
              h('span', { className: 'rsb-fact' }, headActs)),
            files.map((f) => fileRow(f, kind)))
        }

        return h('div', { className: 'rsb-status' },
          h('div', { className: 'rsb-branchrow', title: data.root },
            h('span', { className: 'rsb-branch' }, '⎇ ' + (data.branch || '(unknown)')),
            (data.ahead || data.behind) ? h('span', { className: 'rsb-ab' },
              data.ahead ? '↑' + data.ahead : '',
              data.ahead && data.behind ? ' ' : '',
              data.behind ? '↓' + data.behind : '') : null,
            h('span', { className: 'rsb-spacer' }),
            h('button', { className: 'rsb-act', title: 'Fetch', disabled: busy !== '', onClick: () => act(() => git.sync(cwd(), 'fetch')) }, '⟳'),
            h('button', { className: 'rsb-act', title: noUpstream ? 'Pull (no upstream configured)' : 'Pull from ' + data.upstream, disabled: busy !== '' || noUpstream, onClick: () => act(() => git.sync(cwd(), 'pull')) }, '↓'),
            h('button', { className: 'rsb-act', title: noUpstream ? 'Push (no upstream configured)' : 'Push to ' + data.upstream, disabled: busy !== '' || noUpstream, onClick: () => act(() => git.sync(cwd(), 'push')) }, '↑'),
            h('button', { className: 'rsb-act', title: 'Refresh', disabled: busy !== '', onClick: () => refresh() }, '↻')),
          h('div', { className: 'rsb-rootline', title: data.root }, baseName(data.root || '') || data.root),
          h('textarea', {
            className: 'rsb-msg',
            placeholder: 'Commit message (⌘/Ctrl+Enter to commit)',
            value: msg,
            rows: 2,
            onChange: (e) => setMsg(e.target.value),
            onKeyDown: (e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); commit() } },
          }),
          h('button', { className: 'rsb-commit', disabled: commitDisabled, onClick: commit },
            busy === 'commit' ? 'Committing…' : 'Commit' + (changeCount ? ' (' + changeCount + ')' : '')),
          err ? h('div', { className: 'rsb-error', onClick: () => setErr(''), title: 'Click to dismiss' }, err) : null,
          group('Merge Conflicts', data.conflicts, 'conflicts'),
          group('Staged Changes', data.staged, 'staged'),
          group('Changes', data.unstaged, 'changes'),
          changeCount === 0 && !err ? h('div', { className: 'rsb-empty' }, 'Working tree clean.') : null)
      }

      // ---------- lane computation ----------
      function computeGraph(commits) {
        let lanes = []
        let maxLanes = 1
        const rows = []
        for (const c of commits) {
          let idx = lanes.indexOf(c.hash)
          if (idx === -1) {
            lanes.push(c.hash)
            idx = lanes.length - 1
          }
          const post = lanes.slice()
          const firstParent = c.parents[0]
          if (firstParent === undefined) {
            post[idx] = null
          } else {
            const existing = post.indexOf(firstParent)
            if (existing !== -1 && existing !== idx) post[idx] = null
            else post[idx] = firstParent
          }
          for (let pi = 1; pi < c.parents.length; pi++) {
            const p = c.parents[pi]
            if (post.indexOf(p) === -1) post.push(p)
          }
          const lanesOut = post.filter((x) => x !== null)
          const edges = []
          for (let i = 0; i < lanes.length; i++) {
            if (i === idx || lanes[i] === null) continue
            const j = lanesOut.indexOf(lanes[i])
            if (j !== -1) edges.push({ x1: i, x2: j })
          }
          const nodeEdges = []
          for (const p of c.parents) {
            const j = lanesOut.indexOf(p)
            if (j !== -1) nodeEdges.push({ x2: j })
          }
          rows.push({ nodeX: idx, edges: edges, nodeEdges: nodeEdges })
          lanes = lanesOut
          if (lanes.length > maxLanes) maxLanes = lanes.length
        }
        return { rows: rows, width: maxLanes }
      }

      const GW = 14
      const GH = 26
      const GPAD = 4
      const GCOLORS = ['#4fc1ff', '#ce9178', '#4ec9b0', '#c586c0', '#dcdcaa', '#f48771', '#9cdcfe', '#b5cea8']
      const laneColor = (i) => GCOLORS[((i % GCOLORS.length) + GCOLORS.length) % GCOLORS.length]
      const laneX = (x) => GPAD + x * GW + GW / 2

      // ---------- Commit Graph card ----------
      function GitGraphCard() {
        const [inst] = React.useState(() => ({ seen: new Set(), lastFp: '', busyLoading: false }))
        const [commits, setCommits] = React.useState([])
        const [hasMore, setHasMore] = React.useState(false)
        const [loading, setLoading] = React.useState(false)
        const [gerr, setGerr] = React.useState('')
        const [menu, setMenu] = React.useState(null)
        const [copied, setCopied] = React.useState('')
        const fp = useStore(fpStore)

        async function load(skip, replace) {
          if (inst.busyLoading) return
          inst.busyLoading = true
          setLoading(true)
          try {
            const r = remoteValue(await git.log(cwd(), skip, 100))
            if (replace) inst.seen.clear()
            const fresh = []
            for (const c of (r.commits || [])) {
              if (inst.seen.has(c.hash)) continue
              inst.seen.add(c.hash)
              fresh.push(c)
            }
            setCommits((prev) => (replace ? fresh : prev.concat(fresh)))
            setHasMore(!!r.hasMore)
            setGerr('')
          } catch (e) {
            setGerr(String((e && e.message) || e))
          } finally {
            inst.busyLoading = false
            setLoading(false)
          }
        }

        React.useEffect(() => {
          if (fp && fp !== inst.lastFp) {
            inst.lastFp = fp
            load(0, true)
          }
        }, [fp])

        function onScroll(e) {
          const el = e.currentTarget
          if (hasMore && !loading && el.scrollTop + el.clientHeight > el.scrollHeight - 80) {
            load(commits.length, false)
          }
        }

        async function doCopy(text, label) {
          const ok = await copyText(text)
          setCopied(ok ? label : 'Copy failed')
          setMenu(null)
          ctx.timeout(() => setCopied(''), 2200)
        }

        const graph = computeGraph(commits)

        function svgRow(row) {
          const wpx = graph.width * GW + GPAD * 2
          const parts = []
          row.edges.forEach((e, i) => {
            parts.push(h('line', { key: 'e' + i, x1: laneX(e.x1), y1: 0, x2: laneX(e.x2), y2: GH, stroke: laneColor(e.x2), strokeWidth: 1.5 }))
          })
          row.nodeEdges.forEach((e, i) => {
            const nx = laneX(row.nodeX)
            const tx = laneX(e.x2)
            if (nx === tx) {
              parts.push(h('line', { key: 'n' + i, x1: nx, y1: GH / 2, x2: tx, y2: GH, stroke: laneColor(e.x2), strokeWidth: 1.5 }))
            } else {
              parts.push(h('path', { key: 'n' + i, d: 'M ' + nx + ' ' + (GH / 2) + ' C ' + nx + ' ' + GH + ', ' + tx + ' ' + (GH / 2) + ', ' + tx + ' ' + GH, fill: 'none', stroke: laneColor(e.x2), strokeWidth: 1.5 }))
            }
          })
          parts.push(h('circle', { key: 'c', cx: laneX(row.nodeX), cy: GH / 2, r: 4, fill: laneColor(row.nodeX), stroke: 'var(--dsw-alias-bg-layer-1)', strokeWidth: 1.2 }))
          return h('svg', { width: wpx, height: GH, viewBox: '0 0 ' + wpx + ' ' + GH, className: 'rsb-gsvg' }, parts)
        }

        function commitRow(c, i) {
          const row = graph.rows[i]
          if (!row) return null
          const badges = c.refs.map((r, j) => h('span', { key: 'r' + j, className: 'rsb-badge rsb-badge-' + r.type, title: r.type }, r.name))
          return h('div', {
            key: c.hash,
            className: 'rsb-grow',
            title: c.subject + '\n' + c.hash,
            onContextMenu: (e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, hash: c.hash, subject: c.subject }) },
          },
            svgRow(row),
            h('div', { className: 'rsb-gtext' },
              h('div', { className: 'rsb-gsubj' }, badges, h('span', { className: 'rsb-gsubjtext' }, c.subject)),
              h('div', { className: 'rsb-gmeta' },
                h('span', { className: 'rsb-ghash' }, c.short),
                h('span', { className: 'rsb-gauthor' }, c.author),
                h('span', { className: 'rsb-gtime' }, relTime(c.time)))))
        }

        return h('div', { className: 'rsb-graph' },
          h('div', { className: 'rsb-graph-head' },
            h('button', { className: 'rsb-act', title: 'Refresh graph', onClick: () => load(0, true) }, '↻'),
            copied ? h('span', { className: 'rsb-copied' }, copied) : null),
          gerr ? h('div', { className: 'rsb-error', onClick: () => setGerr(''), title: 'Click to dismiss' }, gerr) : null,
          h('div', { className: 'rsb-gscroll', onScroll: onScroll },
            commits.length === 0 && !loading && !gerr ? h('div', { className: 'rsb-empty' }, 'No commits yet.') : null,
            commits.map((c, i) => commitRow(c, i)),
            loading ? h('div', { key: 'ld', className: 'rsb-loading' }, 'Loading…') : null,
            !hasMore && commits.length > 0 ? h('div', { key: 'end', className: 'rsb-end' }, '— end of history —') : null),
          menu ? h('div', { className: 'rsb-menu-bg', onClick: () => setMenu(null), onContextMenu: (e) => { e.preventDefault(); setMenu(null) } },
            h('div', { className: 'rsb-menu', style: { left: menu.x + 'px', top: menu.y + 'px' } },
              h('button', { className: 'rsb-menu-item', onClick: () => doCopy(menu.hash, 'Hash copied') }, 'Copy commit hash'),
              h('button', { className: 'rsb-menu-item', onClick: () => doCopy(menu.subject, 'Message copied') }, 'Copy commit message'))) : null)
      }

      // ---------- manifest, panel, rail ----------
      const CARD_MANIFEST = [
        { id: 'git-status', title: 'Source Control', order: 10, render: GitStatusCard },
        { id: 'git-graph', title: 'Commit Graph', order: 20, render: GitGraphCard },
      ]

      function SidebarPanel(props) {
        const [gearOpen, setGearOpen] = React.useState(false)
        const vis = useStore(visStore)
        // The details slot has session scope, so its framework-owned sessionId
        // is the authority. Global current selection can be temporarily absent.
        const sessionId = (props && props.sessionId) || ''
        const resolvedCwd = props && props.useWorkspaces
          ? props.useWorkspaces((s) => {
              if (!s || !s.items) return ''
              for (const w of s.items) {
                if (w.sessionIds && sessionId && w.sessionIds.indexOf(sessionId) !== -1) return w.path
              }
              return ''
            })
          : ''
        if (sessionId && resolvedCwd) cwdBySession.set(sessionId, resolvedCwd)
        const effectiveCwd = sessionId ? (resolvedCwd || cwdBySession.get(sessionId) || '') : ''
        // Child mount effects run before parent effects. Publish the cwd during
        // render so Source Control's first refresh cannot fall back to home.
        cwdStore.set(effectiveCwd)
        React.useEffect(() => { fpStore.set('') }, [effectiveCwd])
        const cards = CARD_MANIFEST.filter((c) => vis[c.id] !== false).sort((a, b) => a.order - b.order)
        return h('div', { className: 'rsb-panel' },
          h('div', { className: 'rsb-header' },
            h('span', { className: 'rsb-title' }, 'WORKSPACE'),
            h('span', { className: 'rsb-spacer' }),
            h('button', { className: 'rsb-iconbtn', title: 'Sidebar settings (show/hide cards)', onClick: () => setGearOpen(!gearOpen) }, '⚙'),
            h('button', { className: 'rsb-iconbtn', title: 'Collapse sidebar', onClick: () => { if (layout) layout.closeDetails(); openStore.set(false) } }, '»')),
          gearOpen ? h('div', { className: 'rsb-gear' },
            h('div', { className: 'rsb-gear-title' }, 'CARDS'),
            CARD_MANIFEST.map((c) => h('label', { key: c.id, className: 'rsb-gear-item' },
              h('input', { type: 'checkbox', checked: vis[c.id] !== false, onChange: (e) => setCardVis(c.id, e.target.checked) }),
              h('span', null, c.title)))) : null,
          h('div', { className: 'rsb-body' },
            cards.length === 0 ? h('div', { className: 'rsb-empty' }, 'All cards hidden — open ⚙ to re-enable.') : null,
            cards.map((c) => h('section', { key: c.id, className: 'rsb-card' },
              h('div', { className: 'rsb-card-title' }, c.title),
              h(c.render, null)))))
      }

      function Rail(props) {
        const open = useStore(openStore)
        const startedSessionId = props && props.useSessions
          ? props.useSessions((s) => {
              const current = s && s.current
              return current !== undefined && s.byId && s.byId[current] && s.byId[current].blank === false
                ? current
                : undefined
            })
          : (props && props.sessionId) || undefined
        const startedSession = startedSessionId !== undefined
        React.useEffect(() => {
          if (!startedSession || !layout) return
          if (open) layout.openDetails()
          else layout.closeDetails()
        }, [startedSessionId, open])
        if (!layout) return null
        const rail = h('button', {
          className: 'rsb-rail',
          title: open ? 'Collapse workspace sidebar' : 'Open workspace sidebar',
          onClick: () => {
            if (open) {
              if (startedSession) layout.closeDetails()
              openStore.set(false)
            } else {
              if (startedSession) layout.openDetails()
              openStore.set(true)
            }
          },
        }, h('span', null, open ? '▶' : '◀'))
        if (!open || startedSession) return rail
        return h(React.Fragment, null,
          h('aside', { className: 'rsb-overlay-panel' }, h(SidebarPanel, props)),
          rail)
      }

      // ---------- styles ----------
      const CSS = [
        // One shared panel width so the floating panel and the space reserved
        // for it can never drift apart.
        ':root { --rsb-panel-w: min(360px, calc(100vw - 22px)); }',
        '.rsb-rail { position: fixed; top: 50%; right: 0; transform: translateY(-50%); z-index: 60; width: 22px; height: 72px; border: 1px solid var(--dsw-alias-border-l1); border-right: none; border-radius: 8px 0 0 8px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-secondary); cursor: pointer; pointer-events: auto; padding: 0; font-size: 11px; }',
        '.rsb-rail:hover { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-2); }',
        '.rsb-overlay-panel { position: fixed; top: 0; right: 0; bottom: 0; z-index: 59; box-sizing: border-box; width: var(--rsb-panel-w); border-left: 1px solid var(--dsw-alias-border-l1); box-shadow: -8px 0 28px rgba(0,0,0,0.2); }',
        // The shell frame hard-zeros its Details Column until a session has
        // started, so the new-session Sidebar floats in the overlay layer. The
        // frame carries data-details-collapsed in that state, and its second
        // element child is the center conversation column (sidebar, center,
        // details, overlay layer follow). Reserving the panel width there makes
        // the conversation resize instead of being covered.
        '[data-details-collapsed]:has([data-shell-overlay] .rsb-overlay-panel) > div:nth-child(2) { padding-right: var(--rsb-panel-w); transition: padding-right var(--ds-transition-duration-slow) var(--ds-ease-in-out); }',
        '.rsb-panel { position: relative; display: flex; flex-direction: column; height: 100%; min-height: 0; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font-size: 12px; }',
        '.rsb-header { display: flex; align-items: center; gap: 4px; padding: 7px 10px; background: var(--dsw-specific-sidebar-fill); border-bottom: 1px solid var(--dsw-alias-border-l1); flex-shrink: 0; }',
        '.rsb-title { font-size: 11px; font-weight: 600; letter-spacing: 0.08em; color: var(--dsw-alias-label-secondary); }',
        '.rsb-spacer { flex: 1; }',
        '.rsb-iconbtn { background: none; border: none; cursor: pointer; color: var(--dsw-alias-label-secondary); padding: 2px 5px; font-size: 13px; border-radius: 4px; line-height: 1; }',
        '.rsb-iconbtn:hover { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-2); }',
        '.rsb-gear { position: absolute; top: 34px; right: 8px; z-index: 30; background: var(--dsw-alias-bg-overlay); border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; padding: 8px 10px; box-shadow: 0 8px 28px rgba(0,0,0,0.28); min-width: 160px; }',
        '.rsb-gear-title { font-size: 10px; font-weight: 600; letter-spacing: 0.08em; color: var(--dsw-alias-label-secondary); margin-bottom: 4px; }',
        '.rsb-gear-item { display: flex; align-items: center; gap: 6px; padding: 3px 0; cursor: pointer; color: var(--dsw-alias-label-primary); }',
        '.rsb-body { flex: 1; min-height: 0; overflow-y: auto; padding: 8px; display: flex; flex-direction: column; gap: 8px; }',
        '.rsb-card { background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; padding: 8px; display: flex; flex-direction: column; gap: 6px; flex-shrink: 0; }',
        '.rsb-card-title { font-size: 10px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: var(--dsw-alias-label-secondary); }',
        '.rsb-status { display: flex; flex-direction: column; gap: 6px; font-size: 12px; }',
        '.rsb-branchrow { display: flex; align-items: center; gap: 4px; }',
        '.rsb-rootline { font-size: 10px; color: var(--dsw-alias-label-secondary); margin-top: -4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
        '.rsb-branch { color: var(--dsw-alias-brand-primary); font-weight: 600; }',
        '.rsb-ab { color: var(--dsw-alias-label-secondary); font-size: 11px; }',
        '.rsb-act { border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); border-radius: 4px; padding: 0 5px; cursor: pointer; font-size: 11px; line-height: 17px; }',
        '.rsb-act:hover:not(:disabled) { border-color: var(--dsw-alias-border-l2); }',
        '.rsb-act:disabled { opacity: 0.4; cursor: default; }',
        '.rsb-act-danger { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); }',
        '.rsb-msg { width: 100%; box-sizing: border-box; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; padding: 6px; font: inherit; resize: vertical; }',
        '.rsb-msg:focus { outline: 1px solid var(--dsw-alias-brand-primary); }',
        '.rsb-commit { background: var(--dsw-alias-brand-primary); color: #ffffff; border: none; border-radius: 6px; padding: 6px; cursor: pointer; font-weight: 600; }',
        '.rsb-commit:disabled { opacity: 0.5; cursor: default; }',
        '.rsb-error { border: 1px solid var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); border-radius: 6px; padding: 6px; cursor: pointer; word-break: break-word; font-size: 11px; }',
        '.rsb-group { display: flex; flex-direction: column; gap: 1px; }',
        '.rsb-group-head { display: flex; align-items: center; gap: 6px; margin-top: 4px; }',
        '.rsb-group-title { font-weight: 600; color: var(--dsw-alias-label-secondary); }',
        '.rsb-count { background: var(--dsw-alias-bg-layer-2); border-radius: 8px; padding: 0 6px; font-size: 10px; color: var(--dsw-alias-label-secondary); }',
        '.rsb-file { display: flex; align-items: center; gap: 6px; padding: 2px 4px; border-radius: 4px; }',
        '.rsb-file:hover { background: var(--dsw-alias-bg-layer-2); }',
        '.rsb-fname { color: var(--dsw-alias-label-primary); white-space: nowrap; }',
        '.rsb-fdir { color: var(--dsw-alias-label-secondary); font-size: 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0; }',
        '.rsb-fact { display: flex; gap: 2px; margin-left: auto; }',
        '.rsb-chip { font-size: 9px; min-width: 15px; text-align: center; border-radius: 3px; padding: 0 2px; font-weight: 700; color: var(--dsw-alias-label-secondary); }',
        '.rsb-chip-M { color: var(--dsw-alias-state-warn-primary); }',
        '.rsb-chip-A, .rsb-chip-U { color: var(--dsw-alias-state-success-primary); }',
        '.rsb-chip-D { color: var(--dsw-alias-state-error-primary); }',
        '.rsb-chip-R { color: var(--dsw-alias-brand-primary); }',
        '.rsb-chip-UU, .rsb-chip-AA, .rsb-chip-DD, .rsb-chip-UD, .rsb-chip-DU, .rsb-chip-UA, .rsb-chip-AU { color: var(--dsw-alias-state-error-primary); }',
        '.rsb-empty { color: var(--dsw-alias-label-secondary); padding: 8px 4px; text-align: center; }',
        '.rsb-empty-sub { font-size: 10px; color: var(--dsw-alias-label-secondary); margin-top: 4px; word-break: break-all; }',
        '.rsb-graph { display: flex; flex-direction: column; gap: 6px; font-size: 12px; min-height: 0; }',
        '.rsb-graph-head { display: flex; align-items: center; gap: 6px; }',
        '.rsb-copied { color: var(--dsw-alias-state-success-primary); font-size: 11px; }',
        '.rsb-gscroll { max-height: 38vh; overflow-y: auto; border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; background: var(--dsw-alias-bg-base); }',
        '.rsb-grow { display: flex; align-items: center; gap: 4px; padding: 0 6px 0 0; }',
        '.rsb-grow:hover { background: var(--dsw-alias-bg-layer-2); }',
        '.rsb-gsvg { flex-shrink: 0; display: block; }',
        '.rsb-gtext { flex: 1; min-width: 0; display: flex; align-items: center; gap: 8px; }',
        '.rsb-gsubj { flex: 1; min-width: 0; display: flex; align-items: center; gap: 4px; overflow: hidden; }',
        '.rsb-gsubjtext { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; color: var(--dsw-alias-label-primary); }',
        '.rsb-badge { font-size: 9px; padding: 0 5px; border-radius: 8px; white-space: nowrap; border: 1px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-secondary); }',
        '.rsb-badge-branch { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); }',
        '.rsb-badge-tag { border-color: var(--dsw-alias-state-warn-primary); color: var(--dsw-alias-state-warn-primary); }',
        '.rsb-badge-remote { border-color: var(--dsw-alias-state-success-primary); color: var(--dsw-alias-state-success-primary); }',
        '.rsb-gmeta { display: flex; gap: 6px; font-size: 10px; color: var(--dsw-alias-label-secondary); white-space: nowrap; }',
        '.rsb-ghash { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }',
        '.rsb-loading, .rsb-end { text-align: center; color: var(--dsw-alias-label-secondary); padding: 6px; font-size: 11px; }',
        '.rsb-menu-bg { position: fixed; inset: 0; z-index: 100; pointer-events: auto; }',
        '.rsb-menu { position: fixed; z-index: 101; background: var(--dsw-alias-bg-overlay); border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; padding: 4px; display: flex; flex-direction: column; gap: 2px; box-shadow: 0 8px 28px rgba(0,0,0,0.28); min-width: 170px; }',
        '.rsb-menu-item { background: none; border: none; text-align: left; padding: 5px 10px; border-radius: 5px; color: var(--dsw-alias-label-primary); cursor: pointer; font-size: 12px; }',
        '.rsb-menu-item:hover { background: var(--dsw-alias-bg-layer-2); }',
      ].join('\n')

      ctx.effect(() => {
        if (typeof document === 'undefined') return () => {}
        const el = document.createElement('style')
        el.id = 'dsh-sidebar-styles'
        el.textContent = CSS
        document.head.appendChild(el)
        return () => { el.remove() }
      }, `${PACKAGE}: stylesheet`)

      ctx.slots.inject('details', () => ctx.slots.register({ name: 'details', priority: -1 }, (props) => h(SidebarPanel, props)))
      ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'rside-rail', label: 'Workspace sidebar' }, (props) => h(Rail, props)))
    }

    module.exports.apply = apply
    module.exports.inject = inject
    return module.exports
  },
})
