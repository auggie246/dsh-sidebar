/**
 * Host Typert contribution for the git sidebar: strict JSON codecs, the
 * invocation manifest the host loader discovers through this package's
 * `./typert` export, and the gateway service wrapper (service key
 * `rsidebarGit`). Mirrored on the client by the TYPERT_REMOTE mount in
 * lib/client.js — deliberately only for the methods with a client caller:
 * the pty* transport methods mount client-side together with the terminal
 * UI, so the client manifest may legitimately lag the host manifest.
 *
 * Codecs follow dsh-typert's runtime contract: `schema.parse(value)` with the
 * `_zod` marker satisfying the loader's shape check. Every value crossing the
 * wire is detached, JSON-safe data — never live git or Cordis objects.
 */
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'

export const PACKAGE = 'dsh-sidebar'
export const SERVICE = 'rsidebarGit'

function fail(message) {
  throw new Error(`dsh-sidebar remote: ${message}`)
}

/** Minimal strict codec accepted by Typert on both Host and Client. */
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

// ---------------------------------------------------------------------------
// Value codecs
// ---------------------------------------------------------------------------

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
  return {
    name: string(v.name, 'ref.name'),
    type: enumValue(v.type, ['branch', 'tag', 'remote'], 'ref.type'),
  }
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

export const StatusResultCodec = codec(`${PACKAGE}/StatusResult`, (value) => {
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

export const LogResultCodec = codec(`${PACKAGE}/LogResult`, (value) => {
  const v = record(value, 'log result')
  onlyKeys(v, ['commits', 'hasMore'], 'log result')
  return {
    commits: arrayOf((x) => CommitInfoCodec.schema.parse(x), v.commits, 'log.commits'),
    hasMore: bool(v.hasMore, 'log.hasMore'),
  }
})

export const OkResultCodec = codec(`${PACKAGE}/OkResult`, (value) => {
  const v = record(value, 'op result')
  onlyKeys(v, ['ok'], 'op result')
  return { ok: bool(v.ok, 'op.ok') }
})
export const ReadFileResultCodec = codec(`${PACKAGE}/ReadFileResult`, (value) => {
  const v = record(value, 'read file result')
  onlyKeys(v, ['content'], 'read file result')
  return { content: string(v.content, 'readFile.content') }
})

export const PtySpawnResultCodec = codec(`${PACKAGE}/PtySpawnResult`, (value) => {
  const v = record(value, 'pty spawn result')
  onlyKeys(v, ['id', 'pid'], 'pty spawn result')
  return { id: string(v.id, 'pty.id'), pid: finite(v.pid, 'pty.pid') }
})

export const PtyPullResultCodec = codec(`${PACKAGE}/PtyPullResult`, (value) => {
  const v = record(value, 'pty pull result')
  onlyKeys(v, ['seq', 'chunk', 'alive'], 'pty pull result')
  return { seq: finite(v.seq, 'pty.seq'), chunk: string(v.chunk, 'pty.chunk'), alive: bool(v.alive, 'pty.alive') }
})

// ---------------------------------------------------------------------------
// Parameter codecs
// ---------------------------------------------------------------------------

const CwdParam = codec(`${PACKAGE}/Cwd`, (value) => string(value, 'cwd'))
const SkipParam = codec(`${PACKAGE}/Skip`, (value) => finite(value, 'skip'))
const MaxParam = codec(`${PACKAGE}/Max`, (value) => finite(value, 'max'))
const PathsParam = codec(`${PACKAGE}/Paths`, (value) => arrayOf((x, l) => string(x, l), value, 'paths'))
const MessageParam = codec(`${PACKAGE}/Message`, (value) => string(value, 'message'))
const StageAllParam = codec(`${PACKAGE}/StageAll`, (value) => bool(value, 'stageAll'))
const PathParam = codec(`${PACKAGE}/Path`, (value) => string(value, 'path'))
const UntrackedParam = codec(`${PACKAGE}/Untracked`, (value) => bool(value, 'untracked'))
const SyncOpParam = codec(`${PACKAGE}/SyncOp`, (value) => enumValue(value, ['fetch', 'pull', 'push'], 'op'))
const PtyColsParam = codec(`${PACKAGE}/PtyCols`, (value) => Math.max(2, Math.floor(finite(value, 'cols'))))
const PtyRowsParam = codec(`${PACKAGE}/PtyRows`, (value) => Math.max(2, Math.floor(finite(value, 'rows'))))
const PtyIdParam = codec(`${PACKAGE}/PtyId`, (value) => string(value, 'id'))
const PtyDataParam = codec(`${PACKAGE}/PtyData`, (value) => string(value, 'data'))
const PtyAfterSeqParam = codec(`${PACKAGE}/PtyAfterSeq`, (value) => finite(value, 'afterSeq'))

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

/** Host manifest discovered by dsh-typert-loader from this package's ./typert export. */
export const TYPERT = Object.freeze({
  package: PACKAGE,
  face: 'host',
  schemas: [],
  invocations: [
    invocation('status', [CWD], result(StatusResultCodec)),
    invocation('log', [CWD, param('skip', SkipParam), param('max', MaxParam)], result(LogResultCodec)),
    invocation('stage', [CWD, param('paths', PathsParam)], result(OkResultCodec)),
    invocation('unstage', [CWD, param('paths', PathsParam)], result(OkResultCodec)),
    invocation('commit', [CWD, param('message', MessageParam), param('stageAll', StageAllParam)], result(OkResultCodec)),
    invocation('discard', [CWD, param('path', PathParam), param('untracked', UntrackedParam)], result(OkResultCodec)),
    invocation('sync', [CWD, param('op', SyncOpParam)], result(OkResultCodec)),
    invocation('ptySpawn', [CWD, param('cols', PtyColsParam), param('rows', PtyRowsParam)], result(PtySpawnResultCodec)),
    invocation('ptyWrite', [param('id', PtyIdParam), param('data', PtyDataParam)], result(OkResultCodec)),
    invocation('ptyPull', [param('id', PtyIdParam), param('afterSeq', PtyAfterSeqParam)], result(PtyPullResultCodec)),
    invocation('ptyKill', [param('id', PtyIdParam)], result(OkResultCodec)),
    invocation('readFile', [CWD, param('path', PathParam)], result(ReadFileResultCodec)),
    invocation('ptyResize', [param('id', PtyIdParam), param('cols', PtyColsParam), param('rows', PtyRowsParam)], result(OkResultCodec)),
  ],
  model: { services: [], events: [], objects: [] },
})

const remoteInitializers = []
function markRemote(ctor, method) {
  Remote(method)(ctor.prototype[method], {
    kind: 'method',
    name: method,
    static: false,
    private: false,
    addInitializer(initializer) {
      remoteInitializers.push(initializer)
    },
  })
}

const METHODS = [
  'status', 'log', 'stage', 'unstage', 'commit', 'discard', 'sync',
  'ptySpawn', 'ptyWrite', 'ptyPull', 'ptyKill',
  'readFile',
  'ptyResize',
]

/** Typert service wrapper over the host controller's operational interface. */
export class GitSidebarGateway extends TypertRemoteService {
  constructor(ctx, controller) {
    super(ctx, SERVICE)
    this.controller = controller
    for (const initializer of remoteInitializers) initializer.call(this)
  }
  status(cwd) { return this.controller.status(cwd) }
  log(cwd, skip, max) { return this.controller.log(cwd, skip, max) }
  stage(cwd, paths) { return this.controller.stage(cwd, paths) }
  unstage(cwd, paths) { return this.controller.unstage(cwd, paths) }
  commit(cwd, message, stageAll) { return this.controller.commit(cwd, message, stageAll) }
  discard(cwd, path, untracked) { return this.controller.discard(cwd, path, untracked) }
  sync(cwd, op) { return this.controller.sync(cwd, op) }
  ptySpawn(cwd, cols, rows) { return this.controller.ptySpawn(cwd, cols, rows) }
  ptyWrite(id, data) { return this.controller.ptyWrite(id, data) }
  ptyPull(id, afterSeq) { return this.controller.ptyPull(id, afterSeq) }
  ptyKill(id) { return this.controller.ptyKill(id) }
  readFile(cwd, path) { return this.controller.readFile(cwd, path) }
  ptyResize(id, cols, rows) { return this.controller.ptyResize(id, cols, rows) }
}
for (const method of METHODS) markRemote(GitSidebarGateway, method)
