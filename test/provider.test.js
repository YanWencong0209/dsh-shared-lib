import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const packageRoot = new URL('..', import.meta.url).pathname

test('nested skill directories are discovered recursively', async () => {
  const work = mkdtempSync(join(tmpdir(), 'shared-skills-'))
  const pkg = join(work, 'pkg')
  const root = join(work, 'shared')
  try {
    mkdirSync(root, { recursive: true })
    mkdirSync(join(root, 'skills', 'team', 'nested-tool'), { recursive: true })
    mkdirSync(join(root, 'skills', 'team', 'nested-tool'), { recursive: true })
    writeFileSync(join(root, 'skills', 'team', 'nested-tool', 'SKILL.md'), '---\nname: nested-tool\ndescription: nested\n---\n\nbody\n')
    const { apply } = await import(join(packageRoot, 'lib', 'bundle.js'))
    let provider
    const ctx = {
      inject(names, callback) {
        const service = names[0] === 'skills'
          ? { skills: { registerProvider(factory) { provider = factory({ signal: new AbortController().signal, invalidate() {} }); return () => {} } } }
          : names[0] === 'tools'
            ? { tools: { register() { return () => {} }, guard() { return () => {} } } }
            : names[0] === 'systemPrompt'
              ? { systemPrompt: { section() { return () => {} } } }
              : { shellEnv: { register() { return () => {} } } }
        callback(service)
      },
      logger: { warn() {} },
    }
    apply(ctx, { root, linkDir: join(root, 'bin'), intercept: false })
    const skills = await provider.list()
    assert.ok(skills.some(skill => skill.name === 'nested-tool'))
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
})
