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
  assert.equal(packageOf('ruff==0.9'), 'ruff', 'pip-style pin is stripped')
  assert.equal(packageOf('pkg[extra]>=2'), 'pkg')
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
    // pnpm became probeable once its real layout was observed; bun/conda/mise stay unverifiable.
    assert.equal(by['serve'].state, 'absent')
    rec('bun', 'serve-bun'); rec('mise', 'node@24')
    const by2 = Object.fromEntries(verifyDeclared(root).items.map(i => [i.spec, i]))
    assert.equal(by2['serve-bun'].state, 'unverifiable')
    assert.equal(by2['node@24'].state, 'unverifiable')
    // typescript present; ruff/ripgrep/serve absent (pnpm is probeable now); failed runs dropped.
    assert.equal(report.absent, 3)
    assert.equal(report.unverifiable, 0)
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

test('uninstall plans per manager and never invents a go uninstall', async () => {
  const { planUninstall } = await import('../assets/targets.mjs')
  const npm = planUninstall({ target: 'npm', spec: 'left-pad@1.3.0', root: '/tmp/s' })
  assert.equal(npm.action, 'uninstall')
  assert.equal(npm.package, 'left-pad', 'version selector must be stripped')
  assert.deepEqual(npm.args, ['uninstall', '--global', '--prefix', '/tmp/s/env/npm', 'left-pad'])
  assert.deepEqual(planUninstall({ target: 'uv-tool', spec: 'ruff==0.9', root: '/tmp/s' }).args, ['tool', 'uninstall', 'ruff'], 'uv wants the bare name')
  assert.deepEqual(planUninstall({ target: 'pipx', spec: 'ruff', root: '/tmp/s' }).args, ['uninstall', 'ruff'])
  assert.deepEqual(planUninstall({ target: 'cargo', spec: 'ripgrep', root: '/tmp/s' }).args, ['uninstall', '--root', '/tmp/s/env/cargo', 'ripgrep'])
  const pnpmUn = planUninstall({ target: 'pnpm', spec: 'left-pad@1.3.0', root: '/tmp/s' })
  assert.deepEqual(pnpmUn.args, ['remove', '--global', '--global-dir', '/tmp/s/env/pnpm', '--config.store-dir=/tmp/s/env/pnpm/store', 'left-pad'])
  // pnpm remove aborts unless its global bin dir is on PATH; executePlan prepends it.
  assert.equal(pnpmUn.env.PNPM_HOME, '/tmp/s/bin')
  assert.equal(planUninstall({ target: 'go', spec: 'example.com/t@v1', root: '/tmp/s' }).supported, false)
  assert.throws(() => planUninstall({ target: 'npm', spec: '-g' }))
  assert.throws(() => planUninstall({ target: 'nope', spec: 'x' }))
})

test('an uninstall record removes the declaration from verify', async () => {
  const { verifyDeclared } = await import('../assets/targets.mjs')
  const root = mkdtempSync(join(tmpdir(), 'target-un-'))
  try {
    const runs = join(root, 'state', 'target-runs'); mkdirSync(runs, { recursive: true })
    writeFileSync(join(runs, 'i.json'), JSON.stringify({ action: 'install', target: 'npm', spec: 'left-pad@1.3', state: 'succeeded', args: ['install', '-g', 'left-pad@1.3'], startedAt: '2026-01-01T00:00:00Z' }))
    assert.equal(verifyDeclared(root).items.length, 1)
    writeFileSync(join(runs, 'u.json'), JSON.stringify({ action: 'uninstall', target: 'npm', spec: 'left-pad@1.3', state: 'uninstalled', args: ['uninstall', '-g', 'left-pad'], startedAt: '2026-01-02T00:00:00Z' }))
    const after = verifyDeclared(root)
    assert.equal(after.items.length, 0, 'uninstalled target must not stay declared')
    assert.equal(after.absent, 0)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('export drops targets that were later uninstalled', () => {
  const root = mkdtempSync(join(tmpdir(), 'target-export-un-'))
  try {
    const env = { ...process.env, DSH_SHARED_ROOT: root, SHARED_LINK_DIR: join(root, 'path'), HOME: join(root, 'home') }
    const run = args => spawnSync('bash', ['assets/shared.sh', ...args], { cwd: process.cwd(), encoding: 'utf8', env })
    const runs = join(root, 'state', 'target-runs'); mkdirSync(runs, { recursive: true })
    writeFileSync(join(runs, 'a.json'), JSON.stringify({ action: 'install', target: 'npm', spec: 'left-pad@1.3', state: 'succeeded', args: ['install', '-g', 'left-pad@1.3'], startedAt: '2026-01-01T00:00:00Z' }))
    writeFileSync(join(runs, 'b.json'), JSON.stringify({ action: 'install', target: 'npm', spec: 'is-number@7', state: 'succeeded', args: ['install', '-g', 'is-number@7'], startedAt: '2026-01-01T00:00:01Z' }))
    writeFileSync(join(runs, 'c.json'), JSON.stringify({ action: 'uninstall', target: 'npm', spec: 'left-pad@1.3', state: 'uninstalled', args: ['uninstall', '-g', 'left-pad'], startedAt: '2026-01-02T00:00:00Z' }))
    const snapshot = JSON.parse(run(['export']).stdout)
    assert.deepEqual(snapshot.targets.map(t => t.spec), ['is-number@7'])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('pnpm install keeps the store out of bin and is now probeable', async () => {
  const { planInstall, verifyDeclared } = await import('../assets/targets.mjs')
  const plan = planInstall({ target: 'pnpm', spec: 'left-pad@1.3.0', root: '/tmp/s' })
  assert.equal(plan.env.PNPM_HOME, '/tmp/s/bin', 'global bin dir must be the shared bin')
  assert.ok(plan.args.includes('--store-dir'), 'store must be pinned inside the shared root')
  assert.equal(plan.args[plan.args.indexOf('--store-dir') + 1], '/tmp/s/env/pnpm/store')
  assert.ok(plan.args.includes('--global-bin-dir'))
  assert.equal(plan.args.at(-1), 'left-pad@1.3.0')

  const root = mkdtempSync(join(tmpdir(), 'pnpm-probe-'))
  try {
    const runs = join(root, 'state', 'target-runs'); mkdirSync(runs, { recursive: true })
    writeFileSync(join(runs, 'a.json'), JSON.stringify({ action: 'install', target: 'pnpm', spec: 'left-pad@1.3.0', state: 'succeeded', args: ['add', '--global', 'left-pad@1.3.0'], startedAt: '2026-01-01T00:00:00Z' }))
    assert.equal(verifyDeclared(root).items[0].state, 'absent')
    // Real layout observed on 2026-11-14: env/pnpm/<pnpm-major>/node_modules/<pkg>.
    const nm = join(root, 'env/pnpm/10/node_modules/left-pad'); mkdirSync(nm, { recursive: true })
    writeFileSync(join(nm, 'package.json'), '{"name":"left-pad"}')
    const hit = verifyDeclared(root).items[0]
    assert.equal(hit.state, 'present')
    assert.match(hit.evidence, /env\/pnpm\/10\/node_modules\/left-pad\/package\.json$/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('summary is a compact, accurate one-screen view', async () => {
  const { summaryText } = await import('../assets/targets.mjs')
  const root = mkdtempSync(join(tmpdir(), 'targets-summary-'))
  try {
    const runs = join(root, 'state', 'target-runs'); mkdirSync(runs, { recursive: true })
    writeFileSync(join(runs, 'a.json'), JSON.stringify({ action: 'install', target: 'npm', spec: 'left-pad@1.3', state: 'succeeded', args: ['install', '-g', 'left-pad@1.3'], startedAt: '2026-01-01T00:00:00Z' }))
    const text = summaryText(root)
    assert.match(text, /managers\(9\): npm, pnpm, bun, uv-tool, pipx, cargo, go, conda, mise/)
    assert.match(text, /unimplemented: archive, source-build, container/)
    assert.match(text, /declared installs: 1 \| absent: 1/)
    assert.match(text, /npm left-pad@1\.3 → absent/)
    assert.ok(text.length < 1000, `summary must stay small, got ${text.length}`)
    // The full catalog is an order of magnitude bigger; that is why --summary exists.
    assert.ok(JSON.stringify((await import('../assets/targets.mjs')).catalog()).length > 2000)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('verify flags version drift instead of only presence', async () => {
  const { verifyDeclared } = await import('../assets/targets.mjs')
  const root = mkdtempSync(join(tmpdir(), 'target-drift-'))
  try {
    const runs = join(root, 'state', 'target-runs'); mkdirSync(runs, { recursive: true })
    const rec = (name, spec) => writeFileSync(join(runs, `${name}.json`), JSON.stringify({ action: 'install', target: 'npm', spec, state: 'succeeded', args: ['install', '-g', spec], startedAt: '2026-01-01T00:00:00Z' }))
    rec('a', 'left-pad@1.3.0'); rec('b', 'is-number@7.0.0'); rec('c', 'no-version-pkg')
    for (const [name, version] of [['left-pad', '1.3.0'], ['is-number', '7.0.1'], ['no-version-pkg', '1.0.0']]) {
      const dir = join(root, 'env/npm/lib/node_modules', name); mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version }))
    }
    const report = verifyDeclared(root)
    const by = Object.fromEntries(report.items.map(i => [i.spec, i]))
    assert.equal(by['left-pad@1.3.0'].matchesSpec, true)
    assert.equal(by['left-pad@1.3.0'].installedVersion, '1.3.0')
    assert.equal(by['is-number@7.0.0'].matchesSpec, false, 'silent upgrade must be visible')
    assert.equal(by['is-number@7.0.0'].installedVersion, '7.0.1')
    assert.equal(by['no-version-pkg'].matchesSpec, null, 'a versionless spec cannot be judged')
    assert.equal(report.drifted, 1)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('uv-tool is probeable with version from dist-info metadata', async () => {
  const { verifyDeclared, packageOf, planUninstall } = await import('../assets/targets.mjs')
  assert.equal(packageOf('ruff==0.9.0'), 'ruff')
  const root = mkdtempSync(join(tmpdir(), 'uv-probe-'))
  try {
    const runs = join(root, 'state', 'target-runs'); mkdirSync(runs, { recursive: true })
    writeFileSync(join(runs, 'a.json'), JSON.stringify({ action: 'install', target: 'uv-tool', spec: 'ruff==0.9.0', state: 'succeeded', args: ['tool', 'install', 'ruff==0.9.0'], startedAt: '2026-01-01T00:00:00Z' }))
    // Real layout observed 2026-11-14: env/uv-tools/<name>/lib/pythonX.Y/site-packages/<name>-<ver>.dist-info/METADATA
    const dist = join(root, 'env/uv-tools/ruff/lib/python3.12/site-packages/ruff-0.9.0.dist-info')
    mkdirSync(dist, { recursive: true })
    writeFileSync(join(dist, 'METADATA'), 'Metadata-Version: 2.1\nName: ruff\nVersion: 0.9.0\n')
    const hit = verifyDeclared(root).items[0]
    assert.equal(hit.state, 'present')
    assert.match(hit.evidence, /env\/uv-tools\/ruff$/)
    assert.equal(hit.installedVersion, '0.9.0')
    assert.equal(hit.matchesSpec, true)
    assert.deepEqual(planUninstall({ target: 'uv-tool', spec: 'ruff==0.9.0', root: '/tmp/s' }).args, ['tool', 'uninstall', 'ruff'])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('shared get never links archive files as commands', () => {
  const packageRoot = new URL('..', import.meta.url).pathname
  const root = mkdtempSync(join(tmpdir(), 'get-archive-'))
  try {
    const bin = join(root, 'bin'), path = join(root, 'path')
    mkdirSync(bin, { recursive: true }); mkdirSync(path, { recursive: true })
    writeFileSync(join(bin, 'realtool'), '#!/bin/sh\n', { mode: 0o755 })
    writeFileSync(join(bin, 'bundle.tar.gz'), 'x')
    const run = spawnSync('bash', [join(packageRoot, 'assets', 'shared.sh'), 'link'], {
      cwd: root, encoding: 'utf8', env: { ...process.env, DSH_SHARED_ROOT: root, SHARED_LINK_DIR: path, HOME: join(root, 'home') },
    })
    assert.equal(run.status, 0, run.stderr)
    assert.equal(existsSync(join(path, 'realtool')), true)
    assert.equal(existsSync(join(path, 'bundle.tar.gz')), false, 'archives must not be exposed as executables')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('execution records the upstream CLI version as provenance', () => {
  const root = mkdtempSync(join(tmpdir(), 'target-prov-'))
  try {
    const tools = join(root, 'upstream'); mkdirSync(tools)
    const exe = join(tools, 'go')
    writeFileSync(exe, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "go version go1.24.0 linux/arm64"; exit 0; fi\nexit 0\n', { mode: 0o755 })
    const plan = planInstall({ target: 'go', spec: 'example.com/tool@v1', root })
    executePlan(plan, { inheritedEnv: { ...process.env, PATH: tools + ':' + process.env.PATH } })
    const runs = readdirSync(join(root, 'state', 'target-runs'))
    const record = JSON.parse(readFileSync(join(root, 'state', 'target-runs', runs[0]), 'utf8'))
    assert.match(record.commandVersion, /^go version go1\.24\.0/)
    assert.equal(record.state, 'succeeded')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('pipx reports the installed version from the venv metadata', async () => {
  const { verifyDeclared } = await import('../assets/targets.mjs')
  const root = mkdtempSync(join(tmpdir(), 'pipx-probe-'))
  try {
    const runs = join(root, 'state', 'target-runs'); mkdirSync(runs, { recursive: true })
    writeFileSync(join(runs, 'a.json'), JSON.stringify({ action: 'install', target: 'pipx', spec: 'black==24.1.0', state: 'succeeded', args: ['install', 'black==24.1.0'], startedAt: '2026-01-01T00:00:00Z' }))
    const venv = join(root, 'env/pipx/venvs/black')
    mkdirSync(join(venv, 'lib/python3.12/site-packages/black-24.1.0.dist-info'), { recursive: true })
    writeFileSync(join(venv, 'pyvenv.cfg'), 'version = 3.12.0\n')
    writeFileSync(join(venv, 'lib/python3.12/site-packages/black-24.1.0.dist-info/METADATA'), 'Name: black\nVersion: 24.1.0\n')
    const hit = verifyDeclared(root).items[0]
    assert.equal(hit.state, 'present')
    assert.equal(hit.installedVersion, '24.1.0')
    assert.equal(hit.matchesSpec, true)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
