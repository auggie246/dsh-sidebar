// rside-2 — Client half (Cordis dynamic plugin, package pkg-4)
// This file is the exact `code.client` function body passed to cordis_define:
// plain JavaScript, no imports/JSX/TS, evaluated as a function body that
// returns a Cordis Plugin. React code uses React.createElement only.
// Reinstall by feeding this text back as code.client.

return {
  inject: ['timer'],
  apply(ctx) {
    const slots = ctx.get('slots')
    if (slots === undefined) {
      console.error('rside: slots service unavailable')
      return
    }
    const layout = ctx.get('layout')
    const h = React.createElement

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

    // ---------- layout persistence (ticket #4) ----------
    // Sidebar open/closed, Panel open/closed, and Panel height persist in
    // one JSON blob under dsh.rsidebar.panel.v1, following the
    // card-visibility pattern above. Malformed or mistyped values fall
    // back to the defaults; the height is re-clamped to the current
    // viewport on every restore, so a height saved on a tall window
    // cannot come back oversized.
    const PANEL_KEY = 'dsh.rsidebar.panel.v1'
    const DEFAULT_PANEL_H = 240
    const PANEL_MIN_H = 120
    const DEFAULT_PANEL_STATE = { sidebarOpen: false, panelOpen: false, panelHeight: DEFAULT_PANEL_H }
    function readPanelState() {
      const raw = lsGet(PANEL_KEY)
      if (!raw) return DEFAULT_PANEL_STATE
      try {
        const p = JSON.parse(raw)
        if (!p || typeof p !== 'object' || Array.isArray(p)) return DEFAULT_PANEL_STATE
        return {
          sidebarOpen: typeof p.sidebarOpen === 'boolean' ? p.sidebarOpen : false,
          panelOpen: typeof p.panelOpen === 'boolean' ? p.panelOpen : false,
          panelHeight: typeof p.panelHeight === 'number' && Number.isFinite(p.panelHeight) ? p.panelHeight : DEFAULT_PANEL_H,
        }
      } catch (e) { return DEFAULT_PANEL_STATE }
    }
    const initialPanelState = readPanelState()
    const openStore = createStore(initialPanelState.sidebarOpen)
    const panelOpenStore = createStore(initialPanelState.panelOpen)
    const panelHeightStore = createStore(DEFAULT_PANEL_H)
    function persistPanelState() {
      lsSet(PANEL_KEY, JSON.stringify({
        sidebarOpen: openStore.get() === true,
        panelOpen: panelOpenStore.get() === true,
        panelHeight: panelHeightStore.get(),
      }))
    }
    function setSidebarOpen(v) { openStore.set(v === true); persistPanelState() }
    function setPanelOpen(v) { panelOpenStore.set(v === true); persistPanelState() }
    function viewportPanelMaxH() {
      const vh = typeof window !== 'undefined' ? window.innerHeight : undefined
      return typeof vh === 'number' && Number.isFinite(vh) && vh > 0 ? 0.6 * vh : Infinity
    }
    function clampPanelH(v) {
      // A viewport shorter than 200px puts the 60% cap below the 120px
      // floor; the floor wins so the Panel stays usable.
      if (typeof v !== 'number' || !Number.isFinite(v)) return DEFAULT_PANEL_H
      return Math.min(Math.max(Math.round(v), PANEL_MIN_H), Math.max(PANEL_MIN_H, viewportPanelMaxH()))
    }
    // The Panel and the center column's reservation share the
    // --rsb-panel-h variable, so the drag handler applies the height by
    // rewriting that one variable and both follow.
    function applyPanelH(v) {
      const height = clampPanelH(v)
      panelHeightStore.set(height)
      if (typeof document !== 'undefined' && document.documentElement && document.documentElement.style
          && typeof document.documentElement.style.setProperty === 'function') {
        document.documentElement.style.setProperty('--rsb-panel-h', height + 'px')
      }
      return height
    }
    applyPanelH(initialPanelState.panelHeight)

    // ---------- Panel Tabs (ticket #6) ----------
    // A Panel holds an ordered strip of Panel Tabs (CONTEXT.md). The open
    // tab list and the active tab persist per session under
    // dsh.rsidebar.panels.v1.<sessionId>, following the panel-state pattern
    // above. Per-type behavior lives in the TAB_TYPES registry below.
    const TABS_KEY_BASE = 'dsh.rsidebar.panels.v1.'
      const TAB_TYPE_HTML_FILE = 'html-file'
      const TAB_TYPE_MARKDOWN_FILE = 'markdown-file'
    const TAB_TYPE_LOCALHOST_URL = 'localhost-url'
    function tabsStorageKey(sessionId) { return TABS_KEY_BASE + sessionId }
    function normalizeTabUrl(raw) {
      let s = String(raw || '').trim()
      if (!s) return ''
      if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'http://' + s
      if (!/^https?:\/\/\S+$/i.test(s)) return ''
      return s
    }
    // Identity of a Panel Tab URL: the scheme is made explicit, scheme and
    // host are case-folded (hosts are case-insensitive; paths are not), and
    // trailing slashes are dropped, so `localhost:5173`,
    // `HTTP://LocalHost:5173/` and `http://localhost:5173` dedupe onto one
    // tab. An explicit scheme other than http/https is refused, which also
    // refuses javascript: URLs.
    function tabIdentity(url) {
      const s = String(url || '')
      const at = s.indexOf('://')
      if (at === -1) return s.replace(/\/+$/, '')
      const pathStart = s.indexOf('/', at + 3)
      const authority = pathStart === -1 ? s.slice(at + 3) : s.slice(at + 3, pathStart)
      const rest = pathStart === -1 ? '' : s.slice(pathStart)
      return (s.slice(0, at).toLowerCase() + '://' + authority.toLowerCase() + rest).replace(/\/+$/, '')
    }
    function newTabId() {
      return 'tab-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
    }
    function makeTab(url, id) {
      return { id: typeof id === 'string' && id ? id : newTabId(), type: TAB_TYPE_LOCALHOST_URL, url }
    }
    function findTabByIdentity(tabs, identity) {
      return tabs.find((t) => tabIdentity(t.url) === identity)
    }
    // Per-type Panel Tab seam: one entry per tab type. identity maps a tab
    // to its dedupe key, restore rebuilds a tab from persisted storage
    // state (null drops the entry), render returns the content children of
    // .rsb-tabcontent while the tab is active, dispose releases per-tab
    // resources when the tab closes. A type this build does not know is
    // dropped from storage, so a tab it cannot render never comes back.
    const TAB_TYPES = {
      [TAB_TYPE_LOCALHOST_URL]: {
        identity(tab) { return tabIdentity(tab.url) },
        restore(entry) {
          if (typeof entry.url !== 'string' || !entry.url) return null
          return makeTab(entry.url, entry.id)
        },
        render(tab) {
          // The sandbox allows scripts but not same-origin: scripts run in
          // every preview, while a preview of the GUI's own origin can
          // never reach the parent page or the dsh.rsidebar.* storage
          // keys. The one-line hint keeps the iframe-refusal warning
          // visible for the tab's whole life, not only inside the form.
          return [
            h('div', { className: 'rsb-tabframe-hint' },
              'Some sites refuse to load inside an iframe — a blank preview means refusal.'),
            h('iframe', {
              className: 'rsb-tabframe',
              src: tab.url,
              title: tab.url,
              sandbox: 'allow-scripts allow-forms allow-popups',
            }),
          ]
        },
      },
      // File previews (ticket #7): one entry per type, both backed by the
      // FilePreviewTab component below. Identity is the trimmed path, so
      // re-opening a path re-focuses its tab; dedupe stays per type, so
      // the same file can be open once as HTML and once as Markdown.
      [TAB_TYPE_HTML_FILE]: {
        identity(tab) { return String(tab.path || '').trim() },
        restore(entry) {
          if (typeof entry.path !== 'string' || !entry.path.trim()) return null
          return { id: typeof entry.id === 'string' && entry.id ? entry.id : newTabId(), type: TAB_TYPE_HTML_FILE, path: entry.path.trim() }
        },
        strip(tab) { return { title: tab.path, label: baseName(tab.path) } },
        render(tab) { return [h(FilePreviewTab, { key: tab.id, tab })] },
      },
      [TAB_TYPE_MARKDOWN_FILE]: {
        identity(tab) { return String(tab.path || '').trim() },
        restore(entry) {
          if (typeof entry.path !== 'string' || !entry.path.trim()) return null
          return { id: typeof entry.id === 'string' && entry.id ? entry.id : newTabId(), type: TAB_TYPE_MARKDOWN_FILE, path: entry.path.trim() }
        },
        strip(tab) { return { title: tab.path, label: baseName(tab.path) } },
        render(tab) { return [h(FilePreviewTab, { key: tab.id, tab })] },
      },
      // seam(#7): add the file-preview tab type entries directly above this line
      // seam(#8): add the terminal tab type entry directly above this line
    }
    function tabOfType(entry) {
      const def = entry && TAB_TYPES[entry.type]
      return def && def.restore ? def.restore(entry) : null
    }
    function readPanelTabs(sessionId) {
      const empty = { tabs: [], active: null }
      if (!sessionId) return empty
      const raw = lsGet(tabsStorageKey(sessionId))
      if (!raw) return empty
      try {
        const p = JSON.parse(raw)
        if (!p || typeof p !== 'object' || Array.isArray(p)) return empty
        const seen = new Set()
        const tabs = []
        for (const entry of (Array.isArray(p.tabs) ? p.tabs : [])) {
          if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
          const tab = tabOfType(entry)
          if (!tab) continue
          const key = tab.type + '\n' + TAB_TYPES[tab.type].identity(tab)
          if (seen.has(key)) continue
          seen.add(key)
          tabs.push(tab)
        }
        const active = tabs.some((t) => t.id === p.active) ? p.active : (tabs.length ? tabs[0].id : null)
        return { tabs, active }
      } catch (e) { return empty }
    }
    function persistPanelTabs(sessionId, state) {
      if (!sessionId) return
      lsSet(tabsStorageKey(sessionId), JSON.stringify({ tabs: state.tabs, active: state.active }))
    }

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

    function withCwd(args) {
      return Object.assign({ cwd: cwdStore.get() }, args || {})
    }

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
          const r = await host.call('status', withCwd())
          if (my !== inst.seq) return
          if (r && r.ok) {
            setData(r)
            setErr('')
            if (r.repo && r.fingerprint) fpStore.set(String(r.fingerprint))
          } else {
            setErr((r && r.error) || 'git status failed')
          }
        } catch (e) {
          if (my !== inst.seq) return
          setErr(String((e && e.message) || e))
        }
      }

      React.useEffect(() => {
        refresh()
        return ctx.interval(() => { refresh() }, 3000)
      }, [])

      async function act(method, args) {
        setBusy(method)
        try {
          const r = await host.call(method, withCwd(args))
          if (r && r.ok) {
            await refresh()
            return true
          }
          setErr((r && r.error) || (method + ' failed'))
          return false
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
        act('commit', { message: msg, stageAll: stageAll }).then((ok) => { if (ok) setMsg('') })
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
          actions.push(h('button', { key: 'u', className: 'rsb-act', title: 'Unstage', disabled: busy !== '', onClick: () => act('unstage', { paths: [f.path] }) }, '−'))
        } else if (kind === 'conflicts') {
          actions.push(h('button', { key: 's', className: 'rsb-act', title: 'Mark resolved (stage)', disabled: busy !== '', onClick: () => act('stage', { paths: [f.path] }) }, '+'))
        } else {
          actions.push(h('button', { key: 's', className: 'rsb-act', title: 'Stage', disabled: busy !== '', onClick: () => act('stage', { paths: [f.path] }) }, '+'))
          if (confirmPath === f.path) {
            actions.push(h('button', { key: 'dy', className: 'rsb-act rsb-act-danger', title: 'Confirm discard', onClick: () => { setConfirmPath(''); act('discard', { path: f.path, untracked: !!f.untracked }) } }, '✓'))
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
        if (kind === 'staged') headActs.push(h('button', { key: 'ua', className: 'rsb-act', title: 'Unstage all', disabled: busy !== '', onClick: () => act('unstage', { paths: files.map((f) => f.path) }) }, '−'))
        if (kind === 'changes') headActs.push(h('button', { key: 'sa', className: 'rsb-act', title: 'Stage all', disabled: busy !== '', onClick: () => act('stage', { paths: files.map((f) => f.path) }) }, '+'))
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
          h('button', { className: 'rsb-act', title: 'Fetch', disabled: busy !== '', onClick: () => act('sync', { op: 'fetch' }) }, '⟳'),
          h('button', { className: 'rsb-act', title: noUpstream ? 'Pull (no upstream configured)' : 'Pull from ' + data.upstream, disabled: busy !== '' || noUpstream, onClick: () => act('sync', { op: 'pull' }) }, '↓'),
          h('button', { className: 'rsb-act', title: noUpstream ? 'Push (no upstream configured)' : 'Push to ' + data.upstream, disabled: busy !== '' || noUpstream, onClick: () => act('sync', { op: 'push' }) }, '↑'),
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
          const r = await host.call('log', withCwd({ skip: skip, max: 100 }))
          if (r && r.ok) {
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
          } else {
            setGerr((r && r.error) || 'git log failed')
          }
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
          h('button', { className: 'rsb-iconbtn', title: 'Sidebar settings (show/hide cards)', onClick: () => setGearOpen(!gearOpen) }, '⚙')),
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

    // ---------- file preview tabs (ticket #7) ----------
    // One component backs both file preview types: it loads the file's
    // bytes through the readFile RPC once per mount and keeps them in
    // local state. A mount-time instance seq guards the async load the
    // way GitStatusCard.refresh does, so a slow reply from a superseded
    // load can never write into the current one.
    function FilePreviewTab(props) {
      const tab = props && props.tab
      const [inst] = React.useState(() => ({ seq: 0 }))
      const [content, setContent] = React.useState(null)
      const [error, setError] = React.useState('')

      async function load() {
        const my = ++inst.seq
        try {
          const r = await host.call('readFile', withCwd({ path: tab.path }))
          if (my !== inst.seq) return
          if (r && r.ok) {
            setContent(r.content)
            setError('')
          } else {
            setError(String((r && r.error) || 'readFile failed'))
          }
        } catch (e) {
          if (my !== inst.seq) return
          setError(String((e && e.message) || e))
        }
      }

      React.useEffect(() => {
        load()
      }, [])

      if (error) return h('div', { className: 'rsb-error', title: 'Click to dismiss', onClick: () => setError('') }, error)
      if (content === null) return h('div', { className: 'rsb-empty' }, 'Loading…')
      if (tab.type === TAB_TYPE_MARKDOWN_FILE) {
        // No sandbox permissions at all: the renderer escapes every raw
        // tag, so the document is inert and needs no scripts.
        return [
          h('div', { className: 'rsb-tabframe-hint' },
            'Rendered from the file — scripts are stripped and links stay inside the frame.'),
          h('iframe', {
            className: 'rsb-tabframe',
            srcdoc: markdownDocument(content),
            title: tab.path,
            sandbox: '',
          }),
        ]
      }
      // Scripts run, but the frame gets no same-origin access, so a
      // preview can never reach the parent page or the dsh.rsidebar.*
      // storage keys (ticket #6 decision).
      return [
        h('div', { className: 'rsb-tabframe-hint' },
          'Scripts run inside the preview — a blank frame means the file rendered nothing.'),
        h('iframe', {
          className: 'rsb-tabframe',
          srcdoc: content,
          title: tab.path,
          sandbox: 'allow-scripts',
        }),
      ]
    }

    // Minimal Markdown renderer for the preview tab (ticket #7). The
    // source is HTML-escaped first, so no raw markup can survive; the
    // line parser and the inline spans then run on the escaped text.
    // Because the escape runs first, a blockquote marker appears in its
    // escaped form (&gt;). Link URLs are accepted only when they start
    // with http(s)://, / or #, so javascript: and every other scheme
    // renders as literal text.
    function escapeHtml(s) {
      return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    }
    function inlineMarkdown(s) {
      let out = ''
      let i = 0
      while (i < s.length) {
        const ch = s[i]
        if (ch === '`') {
          const end = s.indexOf('`', i + 1)
          if (end !== -1) { out += '<code>' + s.slice(i + 1, end) + '</code>'; i = end + 1; continue }
        } else if (ch === '*') {
          if (s[i + 1] === '*') {
            const end = s.indexOf('**', i + 2)
            if (end !== -1) { out += '<strong>' + s.slice(i + 2, end) + '</strong>'; i = end + 2; continue }
          } else {
            const end = s.indexOf('*', i + 1)
            if (end !== -1) { out += '<em>' + s.slice(i + 1, end) + '</em>'; i = end + 1; continue }
          }
        } else if (ch === '[') {
          const close = s.indexOf(']', i + 1)
          if (close !== -1 && s[close + 1] === '(') {
            const end = s.indexOf(')', close + 2)
            if (end !== -1) {
              const text = s.slice(i + 1, close)
              const url = s.slice(close + 2, end)
              if (/^(https?:\/\/|\/|#)/.test(url)) {
                out += '<a href="' + url.replace(/"/g, '%22') + '">' + text + '</a>'
                i = end + 1
                continue
              }
            }
          }
        }
        out += ch
        i += 1
      }
      return out
    }
    function renderMarkdown(src) {
      const lines = escapeHtml(String(src == null ? '' : src)).split('\n')
      const out = []
      let i = 0
      while (i < lines.length) {
        const line = lines[i]
        if (!line.trim()) { i += 1; continue }
        if (/^\s*```/.test(line)) {
          const buf = []
          i += 1
          while (i < lines.length && !/^\s*```/.test(lines[i])) { buf.push(lines[i]); i += 1 }
          i += 1
          out.push('<pre><code>' + buf.join('\n') + '</code></pre>')
          continue
        }
        let m = /^(#{1,6})\s+(.*)$/.exec(line)
        if (m) {
          out.push('<h' + m[1].length + '>' + inlineMarkdown(m[2].trim()) + '</h' + m[1].length + '>')
          i += 1
          continue
        }
        if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) { out.push('<hr>'); i += 1; continue }
        if (/^&gt;\s?/.test(line)) {
          const buf = []
          while (i < lines.length && /^&gt;\s?/.test(lines[i])) {
            buf.push(lines[i].replace(/^&gt;\s?/, ''))
            i += 1
          }
          out.push('<blockquote>' + buf.map((l) => inlineMarkdown(l.trim())).join('<br>') + '</blockquote>')
          continue
        }
        if (/^\s*[-*+]\s+/.test(line)) {
          const buf = []
          while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
            buf.push('<li>' + inlineMarkdown(lines[i].replace(/^\s*[-*+]\s+/, '')) + '</li>')
            i += 1
          }
          out.push('<ul>' + buf.join('') + '</ul>')
          continue
        }
        if (/^\s*\d+\.\s+/.test(line)) {
          const buf = []
          while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
            buf.push('<li>' + inlineMarkdown(lines[i].replace(/^\s*\d+\.\s+/, '')) + '</li>')
            i += 1
          }
          out.push('<ol>' + buf.join('') + '</ol>')
          continue
        }
        const buf = []
        while (i < lines.length && lines[i].trim()
          && !/^\s*```/.test(lines[i])
          && !/^(#{1,6})\s+/.test(lines[i])
          && !/^\s*(-{3,}|\*{3,})\s*$/.test(lines[i])
          && !/^&gt;\s?/.test(lines[i])
          && !/^\s*[-*+]\s+/.test(lines[i])
          && !/^\s*\d+\.\s+/.test(lines[i])) {
          buf.push(lines[i])
          i += 1
        }
        out.push('<p>' + buf.map((l) => inlineMarkdown(l.trim())).join('<br>') + '</p>')
      }
      return out.join('\n')
    }
    // The full srcdoc document: rendered body plus an embedded style
    // block, so the preview carries its own readable typography in both
    // color schemes.
    function markdownDocument(src) {
      return '<!doctype html><html><head><meta charset="utf-8"><style>'
        + 'body { margin: 0; padding: 14px 16px; font: 13px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #1f2328; background: #ffffff; word-wrap: break-word; }'
        + 'h1, h2, h3, h4, h5, h6 { line-height: 1.25; margin: 18px 0 8px; }'
        + 'h1 { font-size: 1.7em; border-bottom: 1px solid #d0d7de; padding-bottom: 4px; }'
        + 'h2 { font-size: 1.4em; border-bottom: 1px solid #d0d7de; padding-bottom: 3px; }'
        + 'h3 { font-size: 1.18em; } h4 { font-size: 1.05em; } h5, h6 { font-size: 1em; color: #57606a; }'
        + 'pre { background: #f6f8fa; border: 1px solid #d0d7de; border-radius: 6px; padding: 10px; overflow: auto; }'
        + 'code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.92em; background: #f6f8fa; border-radius: 4px; padding: 1px 4px; }'
        + 'pre code { background: none; padding: 0; }'
        + 'blockquote { margin: 10px 0; padding: 2px 12px; border-left: 4px solid #d0d7de; color: #57606a; }'
        + 'a { color: #0969da; }'
        + 'hr { border: none; border-top: 1px solid #d0d7de; margin: 16px 0; }'
        + 'ul, ol { padding-left: 24px; }'
        + '@media (prefers-color-scheme: dark) { body { color: #e6edf3; background: #0d1117; } h1, h2 { border-color: #30363d; } h5, h6 { color: #8b949e; } pre, code { background: #161b22; } pre { border-color: #30363d; } blockquote { border-color: #30363d; color: #8b949e; } a { color: #58a6ff; } hr { border-color: #30363d; } }'
        + '</style></head><body>' + renderMarkdown(src) + '</body></html>'
    }
    // ---------- Bottom Panel (ADR 0001) ----------
    // The shell frame has no bottom row, so the Panel is a plugin-local
    // fixed-position region. It mirrors the center conversation column's
    // box: the frame's second element child (the same structural fact the
    // padding rules below rely on). Measuring that element — instead of
    // the shell's layout store, which no plugin can read — means every
    // edge movement (drag-resizes, sidebar collapse/expand, Details Column
    // open/close, viewport changes) arrives as one ResizeObserver event.
    function BottomPanel(props) {
      const sessionId = (props && props.sessionId) || ''
      const [rect, setRect] = React.useState(null)
      // Panel Tab state (ticket #6): read once per mount from
      // dsh.rsidebar.panels.v1.<sessionId> and rewritten on every change.
      // The Rail keys this component by session, so a session switch
      // remounts it and re-reads that session's list.
      const [tabs, setTabs] = React.useState(() => readPanelTabs(sessionId))
      // Type picker state (ticket #6): null hides the picker, 'types' lists
      // the tab types, 'url' is the Localhost URL entry form.
      const [picker, setPicker] = React.useState(null)
      const [draft, setDraft] = React.useState('')
      const [formErr, setFormErr] = React.useState('')
      // Drag state lives on an instance object (ticket #4): pointermove
      // only records the pointer, and one rAF per frame applies the
      // height, so a storm of pointer events costs one layout write per
      // frame. With pointer capture the move/up events keep arriving on
      // the handle after the pointer leaves the strip; losing capture
      // ends the drag like a release would.
      const [inst] = React.useState(() => ({ dragging: false, startY: 0, startH: 0, pendingY: null, raf: 0 }))
      React.useEffect(() => {
        if (typeof document === 'undefined') return () => {}
        const overlayEl = document.querySelector('[data-shell-overlay]')
        const center = overlayEl && overlayEl.parentElement ? overlayEl.parentElement.children[1] : null
        if (!center || typeof center.getBoundingClientRect !== 'function') return () => {}
        const measure = () => {
          const r = center.getBoundingClientRect()
          setRect({ left: r.left, width: r.width })
        }
        measure()
        if (typeof ResizeObserver !== 'function') return () => {}
        const observer = new ResizeObserver(measure)
        observer.observe(center)
        return () => observer.disconnect()
      }, [])
      function applyDrag() {
        if (inst.pendingY === null) return
        applyPanelH(inst.startH + (inst.startY - inst.pendingY))
      }
      function onDragStart(e) {
        if (!e || typeof e.clientY !== 'number' || !Number.isFinite(e.clientY)) return
        e.preventDefault()
        inst.dragging = true
        inst.startY = e.clientY
        inst.startH = panelHeightStore.get()
        inst.pendingY = null
        if (e.pointerId !== undefined && e.currentTarget && typeof e.currentTarget.setPointerCapture === 'function') {
          try { e.currentTarget.setPointerCapture(e.pointerId) } catch (err) {}
        }
      }
      function onDragMove(e) {
        if (!inst.dragging || !e || typeof e.clientY !== 'number' || !Number.isFinite(e.clientY)) return
        inst.pendingY = e.clientY
        if (inst.raf) return
        const schedule = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (fn) => { fn(); return 0 }
        inst.raf = schedule(() => { inst.raf = 0; applyDrag() })
      }
      function onDragEnd(e) {
        if (!inst.dragging) return
        inst.dragging = false
        if (inst.raf) {
          if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(inst.raf)
          inst.raf = 0
        }
        applyDrag()
        inst.pendingY = null
        if (e && e.pointerId !== undefined && e.currentTarget && typeof e.currentTarget.releasePointerCapture === 'function') {
          try { e.currentTarget.releasePointerCapture(e.pointerId) } catch (err) {}
        }
        persistPanelState()
      }
      // Panel Tab mutations (ticket #6): every change rewrites the session
      // key, so the list and the active tab survive reloads and Panel
      // close/reopen cycles.
      function setAndPersistTabs(next) {
        setTabs(next)
        persistPanelTabs(sessionId, next)
      }
      // One submit either focuses the tab that already owns this URL
      // identity or appends a new tab; both paths persist.
      function submitDraftUrl() {
        const url = normalizeTabUrl(draft)
        if (!url) {
          setFormErr('Enter an http:// or https:// URL.')
          return
        }
        const existing = findTabByIdentity(tabs.tabs, tabIdentity(url))
        if (existing) {
          setAndPersistTabs({ tabs: tabs.tabs, active: existing.id })
        } else {
          const tab = makeTab(url)
          setAndPersistTabs({ tabs: tabs.tabs.concat([tab]), active: tab.id })
        }
        setPicker(null)
        setDraft('')
        setFormErr('')
      }
      function closeTab(id, e) {
        if (e && e.stopPropagation) e.stopPropagation()
        const idx = tabs.tabs.findIndex((t) => t.id === id)
        if (idx === -1) return
        const closed = tabs.tabs[idx]
        if (closed) {
          const def = TAB_TYPES[closed.type]
          if (def && def.dispose) def.dispose(closed)
        }
        const rest = tabs.tabs.filter((t) => t.id !== id)
        // Closing the active tab activates its nearest surviving neighbor;
        // closing the last tab leaves the Panel open but empty.
        const active = tabs.active === id
          ? (rest.length ? rest[Math.min(idx, rest.length - 1)].id : null)
          : tabs.active
        setAndPersistTabs({ tabs: rest, active })
        if (rest.length === 0) setPicker(null)
      }
      function focusTab(id) {
        if (tabs.active !== id) setAndPersistTabs({ tabs: tabs.tabs, active: id })
      }
      function tabContentOf(tab) {
        const def = TAB_TYPES[tab.type]
        return def && def.render ? def.render(tab) : []
      }
      if (!rect) return null
      const activeTab = tabs.tabs.find((t) => t.id === tabs.active) || null
      return h('section', {
        className: 'rsb-bottom-panel',
        'aria-label': 'Panel',
        style: { left: rect.left + 'px', width: rect.width + 'px' },
      },
        h('div', {
          className: 'rsb-panel-drag',
          title: 'Drag to resize the panel',
          'aria-label': 'Resize panel',
          role: 'separator',
          'aria-orientation': 'horizontal',
          onPointerDown: onDragStart,
          onPointerMove: onDragMove,
          onPointerUp: onDragEnd,
          onPointerCancel: onDragEnd,
          onLostPointerCapture: onDragEnd,
        }),
        // Tab strip header (tickets #5 and #6). The + affordance opens the
        // type picker; Localhost URL is its first working type. Each Panel
        // Tab shows its URL, focuses on click, and closes with its own X.
        h('div', { className: 'rsb-tabstrip' },
          h('button', {
            className: 'rsb-tabstrip-add',
            title: 'New panel tab',
            'aria-label': 'New panel tab',
            'aria-expanded': picker ? 'true' : 'false',
            onClick: () => { setPicker((v) => (v ? null : 'types')); setFormErr('') },
          }, '+'),
          tabs.tabs.map((t) => h('div', {
            key: t.id,
            className: 'rsb-tab' + (t.id === tabs.active ? ' rsb-tab-active' : ''),
            role: 'tab',
            'aria-selected': t.id === tabs.active ? 'true' : 'false',
            title: t.url,
            onClick: () => focusTab(t.id),
          },
            h('span', { className: 'rsb-tab-label' }, t.url),
            h('button', {
              className: 'rsb-tab-close',
              title: 'Close tab',
              'aria-label': 'Close tab',
              onClick: (e) => closeTab(t.id, e),
            }, '×')))),
        picker === 'types' ? h('div', { className: 'rsb-tab-picker' },
          h('button', {
            className: 'rsb-tab-picker-item',
            title: 'Preview a URL in an iframe',
            onClick: () => { setPicker('url'); setDraft(''); setFormErr('') },
          },
            h('span', { className: 'rsb-tab-picker-title' }, 'Localhost URL'),
            h('span', { className: 'rsb-tab-picker-sub' }, 'Preview a URL in an iframe')),
            h('button', {
            className: 'rsb-tab-picker-item',
            title: 'Preview a repo file in an iframe',
            onClick: () => { setPicker(TAB_TYPE_HTML_FILE); setDraft(''); setFormErr('') },
          },
            h('span', { className: 'rsb-tab-picker-title' }, 'HTML file'),
            h('span', { className: 'rsb-tab-picker-sub' }, 'Preview a repo file in an iframe')),
          h('button', {
            className: 'rsb-tab-picker-item',
            title: 'Render a repo Markdown file',
            onClick: () => { setPicker(TAB_TYPE_MARKDOWN_FILE); setDraft(''); setFormErr('') },
          },
            h('span', { className: 'rsb-tab-picker-title' }, 'Markdown file'),
            h('span', { className: 'rsb-tab-picker-sub' }, 'Render a repo Markdown file')),
          
        // seam(#7): add the HTML file and Markdown file picker items directly above this line
          // seam(#8): add the Terminal picker item directly above this line
        ) : null,
        picker === 'url' ? h('form', { className: 'rsb-tab-picker-form', onSubmit: (e) => { if (e && e.preventDefault) e.preventDefault(); submitDraftUrl() } },
          h('div', { className: 'rsb-tab-picker-head' }, 'LOCALHOST URL'),
          h('input', {
            className: 'rsb-tab-picker-input',
            type: 'text',
            placeholder: 'http://localhost:3000',
            value: draft,
            autoFocus: true,
            onChange: (e) => { setDraft(e.target.value); setFormErr('') },
            onKeyDown: (e) => { if (e && e.key === 'Escape') setPicker(null) },
          }),
          formErr ? h('div', { className: 'rsb-tab-picker-error' }, formErr) : null,
          h('div', { className: 'rsb-tab-picker-warning' },
            'Some sites refuse to load inside an iframe. If the preview stays blank, open the URL in a normal browser tab.'),
          h('div', { className: 'rsb-tab-picker-actions' },
            h('button', { type: 'button', className: 'rsb-act', onClick: () => setPicker('types') }, 'Back'),
            h('button', { type: 'submit', className: 'rsb-tab-picker-open', disabled: !/\S/.test(draft) }, 'Open'))) : null,
        // File previews (ticket #7): one shared path-entry form for both
        // file types. The submit is the submitDraftPath flow: a blank
        // draft shows the form error, a same-type tab with the same
        // trimmed path re-focuses (no RPC call), and anything else
        // appends a { id, type, path } tab and focuses it. Both paths
        // persist; success closes the picker.
        picker === TAB_TYPE_HTML_FILE || picker === TAB_TYPE_MARKDOWN_FILE ? h('form', { className: 'rsb-tab-picker-form', onSubmit: (e) => {
          if (e && e.preventDefault) e.preventDefault()
          const path = draft.trim()
          if (!path) {
            setFormErr('Enter a file path from the Working Repository root.')
            return
          }
          const existing = tabs.tabs.find((t) => t.type === picker && String(t.path || '').trim() === path)
          if (existing) {
            setAndPersistTabs({ tabs: tabs.tabs, active: existing.id })
          } else {
            const tab = { id: newTabId(), type: picker, path }
            setAndPersistTabs({ tabs: tabs.tabs.concat([tab]), active: tab.id })
          }
          setPicker(null)
          setDraft('')
          setFormErr('')
        } },
          h('div', { className: 'rsb-tab-picker-head' }, picker === TAB_TYPE_MARKDOWN_FILE ? 'MARKDOWN FILE' : 'HTML FILE'),
          h('input', {
            className: 'rsb-tab-picker-input',
            type: 'text',
            placeholder: 'path/to/file.html',
            value: draft,
            autoFocus: true,
            onChange: (e) => { setDraft(e.target.value); setFormErr('') },
            onKeyDown: (e) => { if (e && e.key === 'Escape') setPicker(null) },
          }),
          formErr ? h('div', { className: 'rsb-tab-picker-error' }, formErr) : null,
          h('div', { className: 'rsb-tab-picker-actions' },
            h('button', { type: 'button', className: 'rsb-act', onClick: () => setPicker('types') }, 'Back'),
            h('button', { type: 'submit', className: 'rsb-tab-picker-open', disabled: !/\S/.test(draft) }, 'Open'))) : null,
        
        // seam(#7): add the HTML file and Markdown file path-entry forms directly above this line
        // seam(#8): the Terminal type needs no entry form
        // Content area (ticket #6): the active Panel Tab's content, or the
        // empty state while no tabs exist. Closing the last tab returns
        // here without closing the Panel. Per-type rendering lives in the
        // TAB_TYPES registry.
        activeTab
          ? h('div', { className: 'rsb-tabcontent' },
              ...tabContentOf(activeTab))
          : h('div', { className: 'rsb-panel-empty' },
              h('div', { className: 'rsb-panel-empty-title' }, 'No tabs open.'),
              h('div', { className: 'rsb-panel-empty-sub' }, 'Panel tabs will appear here.')))
    }

    function Rail(props) {
      const open = useStore(openStore)
      const panelOpen = useStore(panelOpenStore)
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
      // The Panel exists only after the session has started (ticket #5):
      // before that the region stays unmounted and its Rail button stays
      // inert, matching the startedSession gate the Sidebar toggle uses.
      // The Panel is keyed by session (ticket #6): each session's Panel
      // Tabs live under their own dsh.rsidebar.panels.v1.<sessionId> key,
      // and the key forces a remount — and a re-read — on session switch.
      const panel = panelOpen && startedSession
        ? h(BottomPanel, { key: startedSessionId, sessionId: startedSessionId })
        : null
      if (!layout) return panel
      // Two-button Rail bar in the VS Code layout style. The top button
      // toggles the Sidebar with the Rail's existing behavior; the second
      // toggles the bottom Panel. The two toggles are independent: each
      // owns its own store, and the Panel renders on every Rail return
      // path so either region works with or without the other. Glyphs
      // draw with currentColor so they follow the theme. The container
      // carries no onClick: Rail space outside the buttons does nothing.
      // The Panel button re-checks startedSession inside onClick: the
      // disabled attribute gates the pointer path, the check gates every
      // path a disabled attribute cannot cover.
      const rail = h('div', { className: 'rsb-rail' },
        h('button', {
          title: open ? 'Collapse workspace sidebar' : 'Open workspace sidebar',
          'aria-label': open ? 'Collapse workspace sidebar' : 'Open workspace sidebar',
          onClick: () => {
            if (open) {
              if (startedSession) layout.closeDetails()
              setSidebarOpen(false)
            } else {
              if (startedSession) layout.openDetails()
              setSidebarOpen(true)
            }
          },
        },
        h('svg', { width: 16, height: 16, viewBox: '0 0 16 16', 'aria-hidden': 'true' },
          h('rect', { x: '1.5', y: '2.5', width: '13', height: '11', rx: '1.5', fill: 'none', stroke: 'currentColor' }),
          h('rect', { x: '9', y: '4.5', width: '4', height: '7', fill: 'currentColor' }))),
        h('button', {
          title: !startedSession ? 'Panel opens once the session starts' : panelOpen ? 'Close panel' : 'Open panel',
          'aria-label': !startedSession ? 'Panel opens once the session starts' : panelOpen ? 'Close panel' : 'Open panel',
          'aria-pressed': startedSession && panelOpen ? 'true' : 'false',
          disabled: startedSession ? undefined : true,
          onClick: () => { if (startedSession) setPanelOpen(!panelOpen) },
        },
        h('svg', { width: 16, height: 16, viewBox: '0 0 16 16', 'aria-hidden': 'true' },
          h('rect', { x: '1.5', y: '2.5', width: '13', height: '11', rx: '1.5', fill: 'none', stroke: 'currentColor' }),
          h('rect', { x: '3.5', y: '9', width: '9', height: '2.5', fill: 'currentColor' }))))
      if (!open || startedSession) return h(React.Fragment, null, panel, rail)
      return h(React.Fragment, null,
        panel,
        h('aside', { className: 'rsb-overlay-panel' }, h(SidebarPanel, props)),
        rail)
    }

    styles.insert([
      // One shared panel width and one shared Panel height, so each
      // floating region and the space reserved for it can never drift
      // apart.
      ':root { --rsb-panel-w: min(360px, calc(100vw - 22px)); --rsb-panel-h: 240px; }',
      '.rsb-rail { position: fixed; top: 50%; right: 0; transform: translateY(-50%); z-index: 60; width: 22px; height: 72px; display: flex; flex-direction: column; border: 1px solid var(--dsw-alias-border-l1); border-right: none; border-radius: 8px 0 0 8px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-secondary); pointer-events: auto; overflow: hidden; }',
      '.rsb-rail button { appearance: none; box-sizing: border-box; width: 100%; height: 36px; display: flex; align-items: center; justify-content: center; margin: 0; padding: 0; border: none; background: none; color: inherit; cursor: pointer; }',
      '.rsb-rail button:hover:not(:disabled) { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-2); }',
      '.rsb-rail button:disabled { opacity: 0.4; cursor: default; }',
      '.rsb-overlay-panel { position: fixed; top: 0; right: 0; bottom: 0; z-index: 59; box-sizing: border-box; width: var(--rsb-panel-w); border-left: 1px solid var(--dsw-alias-border-l1); box-shadow: -8px 0 28px rgba(0,0,0,0.2); }',
      // The shell frame hard-zeros its Details Column until a session has
      // started, so the new-session Sidebar floats in the overlay layer. The
      // frame carries data-details-collapsed in that state, and its second
      // element child is the center conversation column (sidebar, center,
      // details, overlay layer follow). Reserving the panel width there makes
      // the conversation resize instead of being covered.
      '[data-details-collapsed]:has([data-shell-overlay] .rsb-overlay-panel) > div:nth-child(2) { padding-right: var(--rsb-panel-w); transition: padding-right var(--ds-transition-duration-slow) var(--ds-ease-in-out); }',
      // The Panel (ADR 0001): a plugin-local fixed region mirroring
      // the center conversation column's box. The reservation rule walks
      // the same structure the BottomPanel measurement does: the frame is
      // the overlay layer's direct parent, and its second element child is
      // the center column. While the Panel is mounted, that column's
      // bottom padding equals the Panel height, so no conversation content
      // is covered.
      '.rsb-bottom-panel { position: fixed; bottom: 0; z-index: 58; box-sizing: border-box; display: flex; flex-direction: column; height: var(--rsb-panel-h); border-top: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-base); box-shadow: 0 -8px 28px rgba(0,0,0,0.15); pointer-events: auto; }',
      'div:has(> [data-shell-overlay] .rsb-bottom-panel) > div:nth-child(2) { padding-bottom: var(--rsb-panel-h); }',
      // Top-edge drag handle (ticket #4): a thin full-width strip that
      // overhangs the Panel border for a comfortable grab zone. The height
      // itself lives in --rsb-panel-h, which the drag handler rewrites and
      // the reservation rule above reads, so the Panel and the space
      // reserved for it can never drift apart.
      '.rsb-panel-drag { position: absolute; top: -3px; left: 0; right: 0; height: 6px; z-index: 2; cursor: row-resize; touch-action: none; }',
      '.rsb-panel-drag:hover { background: var(--dsw-alias-border-l2); }',
      // Tab strip header and empty state (tickets #5 and #6). The type
      // picker floats over the Panel content, anchored under the strip.
      '.rsb-tabstrip { display: flex; align-items: center; gap: 4px; min-height: 30px; padding: 0 6px; background: var(--dsw-specific-sidebar-fill); border-bottom: 1px solid var(--dsw-alias-border-l1); flex-shrink: 0; }',
      '.rsb-tabstrip-add { appearance: none; background: none; border: 1px solid transparent; border-radius: 4px; color: var(--dsw-alias-label-secondary); cursor: pointer; font-size: 14px; line-height: 1; padding: 2px 7px; }',
      '.rsb-tabstrip-add:hover:not(:disabled) { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-2); }',
      '.rsb-tab-picker { position: absolute; top: 36px; left: 6px; z-index: 40; width: 280px; box-sizing: border-box; display: flex; flex-direction: column; gap: 6px; padding: 8px; background: var(--dsw-alias-bg-overlay); border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; box-shadow: 0 8px 28px rgba(0,0,0,0.28); }',
      '.rsb-tab-picker-item { appearance: none; background: none; border: none; border-radius: 6px; text-align: left; padding: 6px 8px; cursor: pointer; display: flex; flex-direction: column; gap: 2px; color: var(--dsw-alias-label-primary); }',
      '.rsb-tab-picker-item:hover { background: var(--dsw-alias-bg-layer-2); }',
      '.rsb-tab-picker-title { font-size: 12px; font-weight: 600; }',
      '.rsb-tab-picker-sub { font-size: 10px; color: var(--dsw-alias-label-secondary); }',
      '.rsb-tab-picker-head { font-size: 10px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: var(--dsw-alias-label-secondary); }',
      '.rsb-tab-picker-input { width: 100%; box-sizing: border-box; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; padding: 5px 6px; font: inherit; }',
      '.rsb-tab-picker-input:focus { outline: 1px solid var(--dsw-alias-brand-primary); }',
      '.rsb-tab-picker-warning { font-size: 10px; line-height: 1.45; color: var(--dsw-alias-label-secondary); }',
      '.rsb-tab-picker-error { font-size: 10px; color: var(--dsw-alias-state-error-primary); }',
      '.rsb-tab-picker-actions { display: flex; justify-content: flex-end; gap: 6px; }',
      '.rsb-tab-picker-open { appearance: none; background: var(--dsw-alias-brand-primary); color: #ffffff; border: none; border-radius: 6px; padding: 4px 10px; cursor: pointer; font-weight: 600; font-size: 11px; line-height: 1.4; }',
      '.rsb-tab-picker-open:disabled { opacity: 0.5; cursor: default; }',
      // Panel Tabs (ticket #6): chips in the strip, their close control,
      // and the iframe content area of the active tab.
      '.rsb-tab { display: flex; align-items: center; gap: 3px; flex: 0 1 auto; min-width: 0; max-width: 180px; margin-left: 2px; padding: 3px 4px 3px 8px; border: 1px solid transparent; border-radius: 6px; color: var(--dsw-alias-label-secondary); cursor: pointer; font-size: 11px; line-height: 1.2; user-select: none; }',
      '.rsb-tab:hover { background: var(--dsw-alias-bg-layer-2); }',
      '.rsb-tab-active, .rsb-tab-active:hover { background: var(--dsw-alias-bg-layer-2); border-color: var(--dsw-alias-border-l1); color: var(--dsw-alias-label-primary); }',
      '.rsb-tab-label { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }',
      '.rsb-tab-close { appearance: none; background: none; border: none; border-radius: 3px; color: inherit; cursor: pointer; padding: 0 3px; font-size: 12px; line-height: 1; opacity: 0.55; flex-shrink: 0; }',
      '.rsb-tab-close:hover { opacity: 1; }',
      '.rsb-tabcontent { position: relative; flex: 1; min-height: 0; display: flex; flex-direction: column; background: var(--dsw-alias-bg-base); }',
      '.rsb-tabframe-hint { flex-shrink: 0; padding: 3px 8px; font-size: 10px; line-height: 1.4; color: var(--dsw-alias-label-secondary); background: var(--dsw-specific-sidebar-fill); border-bottom: 1px solid var(--dsw-alias-border-l1); }',
      '.rsb-tabframe { flex: 1; min-height: 0; width: 100%; border: none; background: var(--dsw-alias-bg-base); }',
      '.rsb-panel-empty { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; color: var(--dsw-alias-label-secondary); text-align: center; padding: 12px; }',
      '.rsb-panel-empty-title { font-size: 12px; }',
      '.rsb-panel-empty-sub { font-size: 10px; }',
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
      // File previews (ticket #7): the loading and error states live
      // directly inside the tab content column, so they center and pad
      // instead of hugging the top edge.
      '.rsb-tabcontent > .rsb-empty { flex: 1; display: flex; align-items: center; justify-content: center; }',
      '.rsb-tabcontent > .rsb-error { margin: 8px; }',
      
      // seam(#7): add file-preview styles directly above this line
      // seam(#8): add terminal styles directly above this line
    ].join('\n'))

    slots.inject('details', () => slots.register({ name: 'details', priority: -1 }, (props) => h(SidebarPanel, props)))
    slots.inject('shell.overlay', () => slots.register({ name: 'shell.overlay', id: 'rside-rail', label: 'Workspace sidebar' }, (props) => h(Rail, props)))
  },
}
