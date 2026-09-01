#!/usr/bin/env node
// Git write actions must carry a workspace-write sandbox policy (source
// control ticket: stage/commit/push failed in every session).
//
// Root cause this test locks down: the controller's ctx.shell calls are
// DIRECT calls, so SandboxBashExecutor resolves them against the DEPLOYMENT
// policy (mode default 'read-only', the user-install shape — settings.yaml
// sets no sandbox section). Under read-only, seatbelt/Landlock deny every
// write, so git add/commit/push always fail while status (pure reads) works.
//
// The fix under test: every shell request the controller issues stamps
// `sandboxPolicy: { mode: 'workspace-write', workspaceRoot: <repo> }` —
// the same complete per-call policy the tool layer passes, scoped to the
// Working Repository the card operates on. The seam is the executor's
// `confine(argv, policy)` call: a recording provider captures the policy the
// real SandboxBashExecutor resolved for each spawn, and the real
// LocalSubprocessRuntime runs real git so the action outcomes stay honest.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'

const DSH_ROOT = process.env.DSH_ROOT
  ?? '/Users/augustine/.nvm/versions/node/v22.22.2/lib/node_modules/@deepseek-ai/dsh'
// This test drives the real SandboxBashExecutor and SandboxPolicyService from
// the host's DSH checkout. That runtime is not an npm dependency, so
// environments without a DSH checkout — CI runners — skip instead of failing.
if (!existsSync(DSH_ROOT)) {
  console.log(`skipped: DSH runtime not available at ${DSH_ROOT} (set DSH_ROOT to run this check)`)
  process.exit(0)
}

const effects = []
const repo = realpathSync(mkdtempSync(join(tmpdir(), 'rsb-policy-')))
const remote = join(realpathSync(mkdtempSync(join(tmpdir(), 'rsb-policy-remote-'))), 'remote.git')

// ---------------------------------------------------------------------------
// Fixture: a real repo with upstream and a dirty tree, exactly like a session
// the Source Control card follows.
// ---------------------------------------------------------------------------

const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' }
execFileSync('git', ['init', '--bare', remote], { stdio: 'ignore' })
execFileSync('git', ['init', '-b', 'main', repo], { stdio: 'ignore' })
execFileSync('git', ['-C', repo, 'config', 'user.email', 'test@example.com'], { stdio: 'ignore' })
execFileSync('git', ['-C', repo, 'config', 'user.name', 'Test'], { stdio: 'ignore' })
writeFileSync(join(repo, 'a.txt'), 'one\n')
execFileSync('git', ['-C', repo, 'add', '-A'], { stdio: 'ignore' })
execFileSync('git', ['-C', repo, 'commit', '-m', 'init'], { stdio: 'ignore' })
execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', remote], { stdio: 'ignore' })
execFileSync('git', ['-C', repo, 'push', '-u', 'origin', 'main'], { stdio: 'ignore' })
writeFileSync(join(repo, 'a.txt'), 'one\ntwo\n')
writeFileSync(join(repo, 'b.txt'), 'new\n')

// ---------------------------------------------------------------------------
// Real DSH sandbox executor + REAL deployment policy defaults; only the
// platform wrap is recorded (nested sandbox-exec is not agent-runnable).
// ---------------------------------------------------------------------------

const { SandboxBashExecutor } = await import(`${DSH_ROOT}/node_modules/@deepseek-ai/dsh-bash-sandbox/lib/index.js`)
const { SandboxPolicyService } = await import(`${DSH_ROOT}/node_modules/@deepseek-ai/dsh-sandbox-policy/lib/index.js`)
const { LocalSubprocessRuntime } = await import(`${DSH_ROOT}/node_modules/@deepseek-ai/dsh-subprocess-local/lib/index.js`)

const confined = []
const recordingSandbox = {
  confine(argv, policy) {
    confined.push({ argv: [...argv], policy: { ...policy } })
    return { argv: [...argv], enforcement: 'recorded', denialSignatures: [], runnerFailureRules: [] }
  },
}

function serviceCtx() {
  return {
    inject() {},
    effect() {},
    reflect: { provide() {} },
    logger: { info() {}, error() {} },
  }
}

// The user-install shape: no sandbox section anywhere, so the deployment
// default decides. The loader parses the config (schemastery default mode
// 'read-only') before construction — mirror that here.
const realPolicy = new SandboxPolicyService(serviceCtx(), SandboxPolicyService.Config({ workspaceRoot: process.cwd() }))
assert.equal(realPolicy.defaultMode, 'read-only', 'deployment default must be read-only for this test to mean anything')

const runtime = new LocalSubprocessRuntime(serviceCtx())
const shellExecutor = new SandboxBashExecutor(
  { subprocess: runtime, sandbox: recordingSandbox, sandboxPolicy: realPolicy, ...serviceCtx() },
  { cwd: repo, timeoutMs: 120000, maxTimeoutMs: 600000, maxOutputBytes: 64 * 1024, maxSpillBytes: 64 * 1024 * 1024, graceMs: 3000 },
)

const provided = new Map()
const ctx = {
  get(name) { return name === 'sandboxPolicy' ? realPolicy : undefined },
  effect(fn) { const dispose = fn(); if (typeof dispose === 'function') effects.push(dispose) },
  reflect: { provide(name, service) { provided.set(name, service) } },
  logger: { info() {}, error() {} },
  shell: shellExecutor,
  typert: {},
  subprocess: runtime,
}

apply(ctx)
const gateway = provided.get('rsidebarGit')
assert.ok(gateway, 'apply must mount the rsidebarGit gateway')

// ---------------------------------------------------------------------------
// Assertions: every controller shell spawn must ride a workspace-write policy
// scoped to the Working Repository — not the deployment default.
// ---------------------------------------------------------------------------

const gitPolicies = () => confined
  .filter((c) => c.argv.length >= 3 && c.argv[0] === 'bash' && c.argv[1] === '-c' && c.argv[2].startsWith('git -C '))
  .map((c) => c.policy)

try {
  const st = await gateway.status(repo)
  assert.equal(st.repo, true, 'status must see the fixture repository')
  assert.ok(st.unstaged.length >= 1, 'status must list the dirty tree')

  await gateway.stage(repo, ['a.txt', 'b.txt'])
  await gateway.unstage(repo, ['b.txt'])
  await gateway.commit(repo, 'sandbox policy regression', true)
  await gateway.sync(repo, 'push')
  const remoteHead = execFileSync('git', ['-C', remote, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  const localHead = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  assert.equal(remoteHead, localHead, 'push must reach the remote')

  writeFileSync(join(repo, 'b.txt'), 'changed\n')
  await gateway.discard(repo, 'b.txt', false)
  const restored = execFileSync('git', ['-C', repo, 'show', 'HEAD:b.txt'], { encoding: 'utf8' })
  assert.equal(restored, 'new\n', 'discard must restore the tracked file')

  const policies = gitPolicies()
  assert.ok(policies.length >= 5, `the controller must have spawned git through the sandboxed executor (got ${policies.length})`)
  for (const policy of policies) {
    assert.equal(policy.mode, 'workspace-write', `every git spawn must request workspace-write, got ${JSON.stringify(policy.mode)}`)
    assert.equal(policy.workspaceRoot, repo, `every git spawn must scope writes to the Working Repository, got ${JSON.stringify(policy.workspaceRoot)}`)
  }
  console.log('git sandbox policy check passed')
} finally {
  for (const dispose of effects) {
    try { await dispose() } catch {}
  }
  rmSync(repo, { recursive: true, force: true })
  rmSync(remote, { recursive: true, force: true })
}
console.log('git sandbox policy check passed (end)')
