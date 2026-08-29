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

    const openStore = createStore(false)
    const panelOpenStore = createStore(false)
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

    // ---------- Bottom Panel (ADR 0001) ----------
    // The shell frame has no bottom row, so the Panel is a plugin-local
    // fixed-position region. It mirrors the center conversation column's
    // box: the frame's second element child (the same structural fact the
    // padding rules below rely on). Measuring that element — instead of
    // the shell's layout store, which no plugin can read — means every
    // edge movement (drag-resizes, sidebar collapse/expand, Details Column
    // open/close, viewport changes) arrives as one ResizeObserver event.
    function BottomPanel() {
      const [rect, setRect] = React.useState(null)
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
      if (!rect) return null
      return h('section', {
        className: 'rsb-bottom-panel',
        'aria-label': 'Panel',
        style: { left: rect.left + 'px', width: rect.width + 'px' },
      })
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
      const panel = panelOpen ? h(BottomPanel) : null
      if (!layout) return panel
      // Two-button Rail bar in the VS Code layout style. The top button
      // toggles the Sidebar with the Rail's existing behavior; the second
      // toggles the bottom Panel. The two toggles are independent: each
      // owns its own store, and the Panel renders on every Rail return
      // path so either region works with or without the other. Glyphs
      // draw with currentColor so they follow the theme. The container
      // carries no onClick: Rail space outside the buttons does nothing.
      const rail = h('div', { className: 'rsb-rail' },
        h('button', {
          title: open ? 'Collapse workspace sidebar' : 'Open workspace sidebar',
          'aria-label': open ? 'Collapse workspace sidebar' : 'Open workspace sidebar',
          onClick: () => {
            if (open) {
              if (startedSession) layout.closeDetails()
              openStore.set(false)
            } else {
              if (startedSession) layout.openDetails()
              openStore.set(true)
            }
          },
        },
        h('svg', { width: 16, height: 16, viewBox: '0 0 16 16', 'aria-hidden': 'true' },
          h('rect', { x: '1.5', y: '2.5', width: '13', height: '11', rx: '1.5', fill: 'none', stroke: 'currentColor' }),
          h('rect', { x: '9', y: '4.5', width: '4', height: '7', fill: 'currentColor' }))),
        h('button', {
          title: panelOpen ? 'Close panel' : 'Open panel',
          'aria-label': panelOpen ? 'Close panel' : 'Open panel',
          'aria-pressed': panelOpen ? 'true' : 'false',
          onClick: () => panelOpenStore.set(!panelOpen),
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
      '.rsb-bottom-panel { position: fixed; bottom: 0; z-index: 58; box-sizing: border-box; height: var(--rsb-panel-h); border-top: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-base); box-shadow: 0 -8px 28px rgba(0,0,0,0.15); pointer-events: auto; }',
      'div:has(> [data-shell-overlay] .rsb-bottom-panel) > div:nth-child(2) { padding-bottom: var(--rsb-panel-h); }',
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
    ].join('\n'))

    slots.inject('details', () => slots.register({ name: 'details', priority: -1 }, (props) => h(SidebarPanel, props)))
    slots.inject('shell.overlay', () => slots.register({ name: 'shell.overlay', id: 'rside-rail', label: 'Workspace sidebar' }, (props) => h(Rail, props)))
  },
}
