import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { catalog, planInstall, executePlan } from '../assets/targets.mjs'

test('catalog separates configured memory from verified activation and unsupported sources', () => {
  const c = catalog()
  assert.equal(c.managers.length, 9)
  assert.equal(c.memory.length, 10)
  assert.ok(c.memory.every(x => x.activationVerified === false))
  assert.equal(c.sources.find(x => x.id === 'archive').status, 'not-implemented')
})
test('all adapters construct argv and isolate shared destinations', () => {
  for (const target of catalog().managers) {
    const p = planInstall({ target: target.id, spec: target.id === 'go' ? 'example.com/tool@v1' : 'tool@1', root: '/tmp/shared' })
    assert.equal(p.command, target.executable)
    assert.ok(p.args.includes(target.id === 'go' ? 'example.com/tool@v1' : 'tool@1'))
    assert.ok(Object.values(p.env).every(value => value.startsWith('/tmp/shared')))
  }
})
test('scopes and identifiers fail explicitly; shell metacharacters stay one argument', () => {
  assert.throws(() => planInstall({ target: 'npm', spec: '-g' }))
  assert.throws(() => planInstall({ target: 'go', spec: 'example.com/tool' }))
  assert.throws(() => planInstall({ target: 'npm', spec: 'x', scope: 'project' }))
  assert.throws(() => planInstall({ target: 'mise', spec: 'node@24', platform: 'unknown' }))
  assert.equal(planInstall({ target: 'npm', spec: 'x;touch-pwn' }).args.at(-1), 'x;touch-pwn')
  assert.deepEqual(planInstall({ target: 'mise', spec: 'node@24', scope: 'project' }).args, ['use', 'node@24'])
})
test('execution probes first, preserves failures, never uses shell', () => {
  const root = mkdtempSync(join(tmpdir(), 'target-exec-'))
  try {
    const plan = planInstall({ target: 'uv-tool', spec: 'ruff==0.1', root })
    assert.throws(() => executePlan(plan, { spawn: () => ({ status: 127 }) }), /unavailable/)
    assert.equal(existsSync(join(root, 'bin')), false)
    const calls = []
    const status = executePlan(plan, { spawn: (cmd, argv, options) => { calls.push({cmd, argv, options}); return {status: calls.length === 1 ? 0 : 7} } })
    assert.equal(status, 7)
    const runs = join(root, 'state', 'target-runs')
    const records = readdirSync(runs).map(name => JSON.parse(readFileSync(join(runs, name), 'utf8')))
    assert.equal(records.length, 1)
    assert.equal(records[0].state, 'failed')
    assert.equal(records[0].exitCode, 7)
    assert.ok(records[0].finishedAt)
    assert.ok(calls.every(x => x.options.shell === false))
    assert.equal(calls[1].options.env.UV_TOOL_BIN_DIR, join(root, 'bin'))
  } finally { rmSync(root, { recursive: true, force: true }) }
})
test('legacy CLI delegates with root and defaults to plan only', () => {
  const root = mkdtempSync(join(tmpdir(), 'target-cli-'))
  try {
    const r = spawnSync('bash', ['assets/shared.sh', 'install-target', 'pipx', 'ruff==0.1'], { encoding: 'utf8', env: {...process.env, DSH_SHARED_ROOT: root} })
    assert.equal(r.status, 0, r.stderr)
    const p = JSON.parse(r.stdout)
    assert.equal(p.executed, false)
    assert.equal(p.root, root)
    assert.equal(existsSync(join(root, 'bin')), false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})


test('deployed CLI finds its hidden target module', async () => {
  const root = mkdtempSync(join(tmpdir(), 'target-seed-'))
  try {
    const { init } = await import('../lib/bundle.js')
    init(root, join(root, 'path'))
    const r = spawnSync(join(root, 'bin', 'shared'), ['targets'], { encoding: 'utf8', env: {...process.env, DSH_SHARED_ROOT: root} })
    assert.equal(r.status, 0, r.stderr)
    assert.equal(JSON.parse(r.stdout).managers.length, 9)
    assert.equal(existsSync(join(root, 'path', '.shared-targets.mjs')), false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})


test('real child process receives isolated environment and writes durable success history', () => {
  const root = mkdtempSync(join(tmpdir(), 'target-child-'))
  try {
    const tools = join(root, 'upstream'); mkdirSync(tools)
    const executable = join(tools, 'go')
    writeFileSync(executable, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo fixture; exit 0; fi\nprintf "%s" "$GOBIN" > "$GOBIN/observed"\n', {mode:0o755})
    const plan = planInstall({target:'go', spec:'example.com/tool@v1', root})
    assert.equal(executePlan(plan, {inheritedEnv:{...process.env, PATH:tools+':'+process.env.PATH}}),0)
    assert.equal(readFileSync(join(root,'bin','observed'),'utf8'),join(root,'bin'))
    const records = readdirSync(join(root,'state','target-runs'))
    assert.equal(records.length,1)
    assert.equal(JSON.parse(readFileSync(join(root,'state','target-runs',records[0]),'utf8')).state,'succeeded')
  } finally {rmSync(root,{recursive:true,force:true})}
})

test('verify proves presence from layout and never guesses success', async () => {
  const { verifyDeclared, packageOf } = await import('../assets/targets.mjs')
  assert.equal(packageOf('@scope/pkg@1.2.3'), '@scope/pkg')
  assert.equal(packageOf('ruff==0.9'), 'ruff==0.9')
  const root = mkdtempSync(join(tmpdir(), 'target-verify-'))
  try {
    const runs = join(root, 'state', 'target-runs'); mkdirSync(runs, { recursive: true })
    const rec = (target, spec, state = 'succeeded') => writeFileSync(join(runs, `${target}-${spec.replace(/\W/g, '_')}.json`),
      JSON.stringify({ target, state, args: ['x', spec] }))
    rec('npm', 'typescript@5')
    rec('uv-tool', 'ruff==0.9')
    rec('cargo', 'ripgrep')
    rec('pnpm', 'serve')
    rec('npm', 'failed-pkg@1', 'failed')          // failed runs are ignored
    mkdirSync(join(root, 'env/npm/lib/node_modules/typescript'), { recursive: true })
    writeFileSync(join(root, 'env/npm/lib/node_modules/typescript/package.json'), '{"name":"typescript"}')
    mkdirSync(join(root, 'env/cargo/bin'), { recursive: true })
    writeFileSync(join(root, 'env/cargo/bin/rg'), '')   // different binary name -> absent, not guessed

    const report = verifyDeclared(root)
    const by = Object.fromEntries(report.items.map(i => [i.spec, i]))
    assert.equal(by['typescript@5'].state, 'present')
    assert.equal(by['ruff==0.9'].state, 'absent')
    assert.equal(by['ripgrep'].state, 'absent', 'must not claim present from an unrelated binary')
    assert.equal(by['serve'].state, 'unverifiable')
    assert.equal(report.absent, 2)
    assert.equal(report.unverifiable, 1)
    assert.equal(report.items.some(i => i.spec === 'failed-pkg@1'), false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('export carries reproducible target installs; import only prints commands', () => {
  const root = mkdtempSync(join(tmpdir(), 'target-export-'))
  try {
    const env = { ...process.env, DSH_SHARED_ROOT: root, SHARED_LINK_DIR: join(root, 'path'), HOME: join(root, 'home') }
    const run = args => spawnSync('bash', ['assets/shared.sh', ...args], { cwd: process.cwd(), encoding: 'utf8', env })
    const runs = join(root, 'state', 'target-runs'); mkdirSync(runs, { recursive: true })
    writeFileSync(join(runs, 'a.json'), JSON.stringify({ target: 'uv-tool', scope: 'shared', state: 'succeeded', args: ['tool', 'install', 'ruff==0.9'], finishedAt: 't1' }))
    writeFileSync(join(runs, 'b.json'), JSON.stringify({ target: 'npm', scope: 'shared', state: 'failed', args: ['install', '-g', 'x'] }))
    const snapshot = JSON.parse(run(['export']).stdout)
    assert.deepEqual(snapshot.targets.map(t => [t.target, t.spec]), [['uv-tool', 'ruff==0.9']])

    const file = join(root, 'snap.json'); writeFileSync(file, JSON.stringify(snapshot))
    const imported = run(['import', file, '--force'])
    assert.match(imported.stdout, /shared install-target uv-tool ruff==0\.9 --execute/)
    assert.equal(existsSync(join(root, 'env/uv-tools')), false, 'import must not execute upstream managers')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('windows plans use shim candidates while execution stays blocked', async () => {
  const { planInstall, commandCandidates, executePlan } = await import('../assets/targets.mjs')
  assert.deepEqual(commandCandidates('npm', 'win32'), ['npm.cmd', 'npm.exe', 'npm'])
  assert.deepEqual(commandCandidates('npm', 'darwin'), ['npm'])
  const win = planInstall({ target: 'npm', spec: 'typescript@5', platform: 'win32' })
  assert.equal(win.command, 'npm.cmd')
  assert.deepEqual(win.commandCandidates, ['npm.cmd', 'npm.exe', 'npm'])
  const mac = planInstall({ target: 'uv-tool', spec: 'ruff==0.9', platform: 'darwin' })
  assert.equal(mac.command, 'uv')
  if (process.platform !== 'win32') {
    assert.throws(() => executePlan(win), /Cross-platform execution is not supported/)
  }
})
