#!/usr/bin/env node
// Sync (fetch/pull/push) must survive the sandbox-masked ssh system config.
//
// Root cause this test locks down: the card's git runs under DSH's file
// sandbox, which masks metadata for paths outside the workspace — so ssh
// sees /etc/ssh/ssh_config* as owner nobody:nobody, fails its ownership
// check and refuses its config ("Bad owner or permissions on
// /etc/ssh/ssh_config.d/*.conf"). git dies before any network access while
// the user's own terminal (no sandbox) keeps working.
//
// The fix under test: when the first sync attempt fails with that exact
// error, the host retries the same op with `core.sshCommand` pointed at only
// the user's ~/.ssh/config — the file the sandbox does not mask — so host
// aliases, ports and IdentityFile settings still apply. Healthy machines
// never reach the retry.
//
// Like test-git-sandbox-policy.mjs this drives the real SandboxBashExecutor
// and real git; a `git` shim earlier in PATH plays the poisoned ssh: plain
// sync ops fail with OpenSSH's exact wording, anything carrying the
// core.sshCommand retry (and every non-sync op) is real git. Skips on
// machines without a DSH checkout.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'

const DSH_ROOT = process.env.DSH_ROOT
  ?? '/Users/augustine/.nvm/versions/node/v22.22.2/lib/node_modules/@deepseek-ai/dsh'
if (!existsSync(DSH_ROOT)) {
  console.log(`skipped: DSH runtime not available at ${DSH_ROOT} (set DSH_ROOT to run this check)`)
  process.exit(0)
}

const effects = []
const BAD_OWNER = 'Bad owner or permissions on /etc/ssh/ssh_config.d/20-omarchy-keepalive.conf'
const repo = realpathSync(mkdtempSync(join(tmpdir(), 'rsb-ssh-repo-')))
const remote = join(realpathSync(mkdtempSync(join(tmpdir(), 'rsb-ssh-remote-'))), 'remote.git')
const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim()

// ---------------------------------------------------------------------------
// Fixture: a real repo with upstream and one unpushed commit, exactly like a
// session the Source Control card follows.
// ---------------------------------------------------------------------------

const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' }
const gitRun = (args) => execFileSync(realGit, args, { env: gitEnv, stdio: 'ignore' })
execFileSync(realGit, ['init', '--bare', remote], { env: gitEnv, stdio: 'ignore' })
gitRun(['init', '-b', 'main', repo])
gitRun(['-C', repo, 'config', 'user.email', 'test@example.com'])
gitRun(['-C', repo, 'config', 'user.name', 'Test'])
writeFileSync(join(repo, 'a.txt'), 'one\n')
gitRun(['-C', repo, 'add', '-A'])
gitRun(['-C', repo, 'commit', '-m', 'init'])
gitRun(['-C', repo, 'remote', 'add', 'origin', remote])
gitRun(['-C', repo, 'push', '-u', 'origin', 'main'])
writeFileSync(join(repo, 'a.txt'), 'one\ntwo\n')
gitRun(['-C', repo, 'commit', '-am', 'second'])

// ---------------------------------------------------------------------------
// The `git` shim: plain sync ops die with OpenSSH's exact ownership-check
// error (the sandbox-masked config); a retry carrying core.sshCommand, and
// every non-sync op, reach real git. RSB_SHIM_FAIL_RETRY=1 also fails the
// retry so the both-attempts-failed error path is covered.
// ---------------------------------------------------------------------------

const shimDir = join(realpathSync(mkdtempSync(join(tmpdir(), 'rsb-ssh-shim-'))), 'bin')
mkdirSync(shimDir)
const shim = join(shimDir, 'git')
writeFileSync(shim, `#!/usr/bin/env bash
REAL_GIT=${JSON.stringify(realGit)}
for arg in "$@"; do
  case "$arg" in
    core.sshCommand=*"-F ~/.ssh/config"*)
      if [ "\${RSB_SHIM_NO_USER_CONFIG:-0}" = "1" ]; then
        echo "Can't open user config file \${HOME}/.ssh/config: No such file or directory" >&2
        exit 255
      fi
      exec "$REAL_GIT" "$@"
    ;;
    core.sshCommand=*"-F /dev/null"*)
      if [ "\${RSB_SHIM_FAIL_RETRY:-0}" = "1" ]; then
        echo "ssh: connect to host invalid.invalid port 22: Connection refused" >&2
        exit 255
      fi
      exec "$REAL_GIT" "$@"
    ;;
  esac
done
case "\${@: -1}" in
  push|pull|fetch)
    if [ "\${RSB_SHIM_FAIL_SYNC:-0}" = "1" ]; then
      echo ${JSON.stringify(BAD_OWNER)} >&2
      exit 128
    fi
  ;;
esac
exec "$REAL_GIT" "$@"
`)
chmodSync(shim, 0o755)
process.env.PATH = shimDir + ':' + process.env.PATH
process.env.RSB_SHIM_FAIL_SYNC = '1'

// ---------------------------------------------------------------------------
// Real DSH sandbox executor; only the platform wrap is recorded (nested
// sandbox-exec is not agent-runnable).
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

const runtime = new LocalSubprocessRuntime(serviceCtx())
const shellExecutor = new SandboxBashExecutor(
  { subprocess: runtime, sandbox: recordingSandbox, sandboxPolicy: new SandboxPolicyService(serviceCtx(), SandboxPolicyService.Config({ workspaceRoot: process.cwd() })), ...serviceCtx() },
  { cwd: repo, timeoutMs: 120000, maxTimeoutMs: 600000, maxOutputBytes: 64 * 1024, maxSpillBytes: 64 * 1024 * 1024, graceMs: 3000 },
)

const provided = new Map()
const ctx = {
  get() { return undefined },
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

const syncSpawns = (op) => confined
  .filter((c) => c.argv[0] === 'bash' && c.argv[1] === '-c' && c.argv[2].endsWith(' ' + op))
  .map((c) => c.argv[2])
// The bare remote's HEAD symref may sit on an unborn default branch, so the
// comparison ref is the pushed branch itself: --verify fails loudly when the
// push never landed.
const remoteHead = () => execFileSync(realGit, ['-C', remote, 'rev-parse', '--verify', 'refs/heads/main'], { encoding: 'utf8' }).trim()
const localHead = () => execFileSync(realGit, ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()

try {
  // Poisoned first attempt: push must retry under core.sshCommand and reach
  // the remote.
  await gateway.sync(repo, 'push')
  assert.equal(remoteHead(), localHead(), 'the retry push must reach the remote')
  const pushes = syncSpawns('push')
  assert.equal(pushes.length, 2, `push must spawn exactly twice — plain attempt, then the retry (got ${pushes.length})`)
  assert.ok(!pushes[0].includes('core.sshCommand'), 'the first attempt must stay plain')
  assert.ok(pushes[1].includes("core.sshCommand='ssh -F ~/.ssh/config'"), `the retry must set core.sshCommand to the user config, got ${pushes[1]}`)
  for (const argv2 of pushes) {
    assert.ok(argv2.startsWith('git -C '), `every sync spawn must stay the card's sandboxed git spawn, got ${argv2}`)
  }

  // The other sync ops ride the same retry.
  await gateway.sync(repo, 'fetch')
  assert.equal(syncSpawns('fetch').length, 2, 'fetch must retry the same way')
  await gateway.sync(repo, 'pull')
  assert.equal(syncSpawns('pull').length, 2, 'pull must retry the same way')

  // Healthy machine: no ssh ownership failure, so the first attempt succeeds
  // and no retry — no core.sshCommand anywhere.
  delete process.env.RSB_SHIM_FAIL_SYNC
  await gateway.sync(repo, 'push')
  const healthyPushes = syncSpawns('push')
  assert.equal(healthyPushes.length, 3, 'the healthy push must add exactly one spawn')
  assert.ok(!healthyPushes[2].includes('core.sshCommand'), 'a healthy first attempt must not be wrapped')

  // No readable user config (some users have none): the walk continues to a
  // config-free ssh command, whose default identity probing and agent need
  // no hard-coded key name.
  process.env.RSB_SHIM_FAIL_SYNC = '1'
  process.env.RSB_SHIM_NO_USER_CONFIG = '1'
  await gateway.sync(repo, 'push')
  const chainedPushes = syncSpawns('push')
  assert.equal(chainedPushes.length, 6, 'the fallback walk must add exactly three spawns: plain, user config, config-free')
  assert.ok(!chainedPushes[3].includes('core.sshCommand'), 'the failed first attempt must stay plain')
  assert.ok(chainedPushes[4].includes('-F ~/.ssh/config'), 'the first retry must try the user config')
  assert.ok(chainedPushes[5].includes('-F /dev/null'), `the second retry must go config-free, got ${chainedPushes[5]}`)
  assert.equal(remoteHead(), localHead(), 'the config-free fallback push must reach the remote')

  // Every attempt failing: the last attempt's error is what the card shows.
  process.env.RSB_SHIM_FAIL_RETRY = '1'
  await assert.rejects(
    () => gateway.sync(repo, 'push'),
    /Connection refused/,
    'when the retry also fails, its error must surface to the card',
  )

  // The dynamic one-session bundle must carry the same fix.
  const dynamicHost = readFileSync(new URL('../dynamic/host.js', import.meta.url), 'utf8')
  assert.match(dynamicHost, /Bad owner or permissions/, 'dynamic/host.js must gate the retry on the same error')
  assert.ok(dynamicHost.includes("ssh -F ~/.ssh/config"), 'dynamic/host.js must retry with the user ssh config')
  assert.ok(dynamicHost.includes('ssh -F /dev/null'), 'dynamic/host.js must carry the config-free fallback')

  console.log('sync ssh retry check passed')
} finally {
  delete process.env.RSB_SHIM_FAIL_SYNC
  delete process.env.RSB_SHIM_NO_USER_CONFIG
  delete process.env.RSB_SHIM_FAIL_RETRY
  for (const dispose of effects) {
    try { await dispose() } catch {}
  }
  rmSync(repo, { recursive: true, force: true })
  rmSync(remote, { recursive: true, force: true })
  rmSync(shimDir, { recursive: true, force: true })
}
