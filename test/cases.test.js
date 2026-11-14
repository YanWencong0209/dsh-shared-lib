import assert from 'node:assert/strict'
import test from 'node:test'
import { chmodSync, cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { CaseStore, redact, caseTool } from '../lib/cases.js'
const sample = {title:'SQLite database locked',problem:'Concurrent SQLite writes fail with database locked',environment:'Node 24 Linux sqlite',attempts:'Retry without busy_timeout failed',solution:'Set busy_timeout and serialize writes',evidence:'Two parallel writes completed; reopened database and checked both rows'}

test('cases persist, deduplicate, isolate projects and allow explicit shared cases', () => {
  const root = mkdtempSync(join(tmpdir(),'case-store-')); let s = new CaseStore(root)
  try {
    assert.throws(() => s.save({...sample,evidence:''},'/work/a'), /evidence/)
    const a = s.save(sample,'/work/a'); assert.equal(s.save(sample,'/work/a').id,a.id)
    assert.equal(s.search('sqlite locked','/work/b').matches.length,0)
    assert.equal(s.read(a.id,'/work/b'),null)
    assert.equal(s.search('sqlite','/work/a').matches[0].id,a.id)
    const shared = s.save({...sample,scope:'shared'},'/work/a')
    assert.equal(s.read(shared.id,'/work/b').trustedInstructions,false)
    s.close(); s = new CaseStore(root)
    assert.equal(s.read(a.id,'/work/a').solution,sample.solution)
  } finally { s.close(); rmSync(root,{recursive:true,force:true}) }
})
test('search returns bounded summaries rather than solutions and preserves evidence on read', () => {
  const root=mkdtempSync(join(tmpdir(),'case-bounds-'));const s=new CaseStore(root)
  try {
    for(let i=0;i<9;i++)s.save({...sample,title:`SQLite ${i}`,problem:`SQLite locked ${i}`},'/work')
    const found=s.search('sqlite','/work'); assert.equal(found.matches.length,5)
    assert.ok(found.matches.every(x=>!('solution' in x)&&x.summary.length<=180))
    assert.ok(JSON.stringify(found).length<3000)
    assert.equal(s.read(found.matches[0].id,'/work').evidence,sample.evidence)
  } finally {s.close();rmSync(root,{recursive:true,force:true})}
})
test('failure capture stores only metadata, deduplicates calls and stays session-local', () => {
  const root=mkdtempSync(join(tmpdir(),'case-events-'));const s=new CaseStore(root)
  try {
    const exec={agent:{id:'s1'},callId:'c1',name:'bash',arguments:{command:'secret=abc'}}
    const result={isError:true,error:{message:'secret=abc',info:{code:'EXIT'}}}
    s.incident(exec,result);s.incident(exec,result)
    assert.equal(s.pending('s1').length,1);assert.equal(s.pending('s2').length,0)
    assert.ok(!JSON.stringify(s.pending('s1')).includes('abc'))
    assert.equal(s.search('EXIT','/work').matches.length,0)
    assert.equal(redact('token=abc ghp_ABCDEFG bearer xyz'),'token=[REDACTED] [REDACTED] bearer [REDACTED]')
  } finally{s.close();rmSync(root,{recursive:true,force:true})}
})
test('tool follows search-read-save contract',async()=>{
  const root=mkdtempSync(join(tmpdir(),'case-tool-'));const s=new CaseStore(root)
  try{
    const tool=caseTool(s,()=>'/work');const exec={agent:{id:'s'}}
    const saved=await tool.execute({action:'save',...sample},exec)
    const found=await tool.execute({action:'search',query:'sqlite'},exec)
    assert.equal(found.matches[0].id,saved.id)
    assert.equal((await tool.execute({action:'read',id:saved.id},exec)).case.validation,'model-reported')
  }finally{s.close();rmSync(root,{recursive:true,force:true})}
})

test('archive hides a case from search/read and stats report counts only', () => {
  const root = mkdtempSync(join(tmpdir(), 'case-archive-')); const s = new CaseStore(root)
  try {
    const a = s.save(sample, '/work')
    s.save({ ...sample, scope: 'shared' }, '/work')
    assert.deepEqual(s.stats('/work'), { active: 2, archived: 0, sharedActive: 1, projectActive: 1 })
    assert.deepEqual(s.archive(a.id, '/work'), { archived: true, id: a.id })
    assert.equal(s.search('sqlite', '/work').matches.some(m => m.id === a.id), false)
    assert.equal(s.read(a.id, '/work'), null)
    assert.deepEqual(s.stats('/work'), { active: 1, archived: 1, sharedActive: 1, projectActive: 0 })
    // Project cases are isolated: another workspace can neither read nor archive them.
    const other = s.save({ ...sample, title: 'SQLite other', problem: 'SQLite locked in other' }, '/other')
    assert.deepEqual(s.archive(other.id, '/work'), { archived: false, reason: 'not-found' })
    // Shared cases are visible everywhere by design, so archiving one from any workspace is expected.
    const shared = s.search('sqlite', '/other').matches.find(m => m.id !== other.id)
    assert.deepEqual(s.archive(shared.id, '/other'), { archived: true, id: shared.id })
  } finally { s.close(); rmSync(root, { recursive: true, force: true }) }
})

test('existing databases migrate additively without losing cases', () => {
  const root = mkdtempSync(join(tmpdir(), 'case-migrate-'))
  try {
    const first = new CaseStore(root); const saved = first.save(sample, '/work'); first.close()
    const again = new CaseStore(root)
    assert.equal(again.read(saved.id, '/work').solution, sample.solution)
    assert.deepEqual(again.stats('/work'), { active: 1, archived: 0, sharedActive: 0, projectActive: 1 })
    again.close()
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('saving a case can claim this session\'s incident, leaving pending honest', async () => {
  const root = mkdtempSync(join(tmpdir(), 'case-link-')); const s = new CaseStore(root)
  try {
    const tool = caseTool(s, () => '/work')
    const exec = { agent: { id: 's1' } }
    s.incident({ agent: { id: 's1' }, callId: 'c1', name: 'bash' }, { isError: true, error: { info: { code: 'ENOENT' } } })
    s.incident({ agent: { id: 's1' }, callId: 'c2', name: 'read' }, { isError: true, error: { info: { code: 'EACCES' } } })
    const [inc] = s.pending('s1')
    const saved = await tool.execute({ action: 'save', ...sample, incidentId: inc.id }, exec)
    assert.equal(saved.incidentId, inc.id)
    assert.equal(s.pending('s1').length, 1, 'only the claimed incident is resolved')
    // A foreign session cannot claim this incident.
    const other = await tool.execute({ action: 'save', ...sample, title: 'other title', incidentId: inc.id }, { agent: { id: 's2' } })
    assert.equal(other.incidentId, null)
  } finally { s.close(); rmSync(root, { recursive: true, force: true }) }
})

test('recency ranking demotes old cases but keeps them findable; prune archives only stale ones', () => {
  const root = mkdtempSync(join(tmpdir(), 'case-decay-')); const s = new CaseStore(root)
  try {
    const newer = s.save({ ...sample, title: 'SQLite locked now' }, '/work')
    const older = s.save({ ...sample, title: 'SQLite locked old', problem: 'SQLite locked previously', solution: 'other fix' }, '/work')
    // Backdate the older case one year.
    s.db.prepare('UPDATE cases SET created=? WHERE id=?').run(new Date(Date.now() - 365 * 86400000).toISOString(), older.id)
    const ranked = s.search('sqlite locked', '/work')
    assert.equal(ranked.matches[0].id, newer.id, 'fresh case outranks the year-old one')
    assert.ok(ranked.matches.some(m => m.id === older.id), 'old case still findable')
    assert.match(ranked.ranking, /90d half-life/)

    assert.throws(() => s.prune('/work', 0), /positive/)
    assert.throws(() => s.prune('/work'), /positive/)
    assert.deepEqual(s.prune('/work', 90).archived, 1)
    assert.equal(s.search('sqlite locked', '/work').matches.some(m => m.id === older.id), false)
    assert.equal(s.read(older.id, '/work'), null)
    assert.deepEqual(s.stats('/work').archived, 1)
  } finally { s.close(); rmSync(root, { recursive: true, force: true }) }
})

const packageRoot = new URL('..', import.meta.url).pathname

test('cases CLI round-trips save/search/read/stats/archive and keeps workspaces apart', () => {
  const root = mkdtempSync(join(tmpdir(), 'cases-cli-'))
  const bin = join(root, 'bin'); mkdirSync(bin, { recursive: true })
  // Mirror the deployed layout: shared CLI + hidden cases module side by side.
  cpSync(join(packageRoot, 'assets', 'shared.sh'), join(bin, 'shared'))
  cpSync(join(packageRoot, 'lib', 'cases.js'), join(bin, '.shared-cases.mjs'))
  chmodSync(join(bin, 'shared'), 0o755)
  const ws = join(root, 'ws'); mkdirSync(ws, { recursive: true })
  const other = join(root, 'other'); mkdirSync(other, { recursive: true })
  const run = (cwd, args) => spawnSync('bash', [join(bin, 'shared'), 'cases', ...args], {
    cwd, encoding: 'utf8', env: { ...process.env, DSH_SHARED_ROOT: root, SHARED_LINK_DIR: join(root, 'path'), HOME: join(root, 'home') },
  })
  try {
    const save = run(ws, ['save', '--title', 'sqlite locked', '--problem', 'database is locked under concurrent writes',
      '--environment', 'node 24 / linux', '--attempts', 'plain retry failed', '--solution', 'set busy_timeout and serialize',
      '--evidence', 'two parallel writers completed; rows re-read and matched'])
    assert.equal(save.status, 0, save.stderr)
    const saved = JSON.parse(save.stdout)
    assert.ok(saved.id)

    const found = JSON.parse(run(ws, ['search', 'locked']).stdout)
    assert.equal(found.matches.length, 1)
    assert.equal(found.matches[0].id, saved.id)
    assert.equal(JSON.parse(run(other, ['search', 'locked']).stdout).matches.length, 0, 'other workspace must not see it')

    const read = JSON.parse(run(ws, ['read', saved.id]).stdout)
    assert.equal(read.case.solution, 'set busy_timeout and serialize')
    assert.equal(read.case.validation, 'model-reported')
    assert.equal(JSON.parse(run(ws, ['stats']).stdout).active, 1)

    assert.equal(run(ws, ['prune', '0']).status, 1, 'prune needs a positive window')
    assert.equal(run(ws, ['save', '--title', 'x']).status, 1, 'partial save must fail')
    assert.deepEqual(JSON.parse(run(ws, ['archive', saved.id]).stdout), { archived: true, id: saved.id })
    assert.equal(JSON.parse(run(ws, ['stats']).stdout).archived, 1)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('search reaches attempts/solution text and reports where it matched', () => {
  const root = mkdtempSync(join(tmpdir(), 'case-body-'))
  const s = new CaseStore(root)
  try {
    const head = s.save({ ...sample, title: 'busy timeout', problem: 'sqlite locked under load' }, '/w')
    const body = s.save({ ...sample, title: 'unrelated heading', problem: 'tool crashed on start',
      attempts: 'tried sqlite locked workaround first', solution: 'serialize writes' }, '/w')
    const found = s.search('locked', '/w')
    assert.equal(found.matches.length, 2)
    // Head match outranks body match.
    assert.equal(found.matches[0].id, head.id)
    const bodyHit = found.matches.find(m => m.id === body.id)
    assert.deepEqual(bodyHit.matchedIn, ['body'])
    assert.equal(found.matches[0].matchedIn.includes('head'), true)
    assert.match(found.ranking, /head 1\.0 \/ body 0\.5/)

    const limited = s.search('locked', '/w', Date.now(), { limit: 1 })
    assert.equal(limited.matches.length, 1)
    assert.equal(limited.limit, 1)
    assert.equal(s.search('locked', '/w', Date.now(), { limit: 999 }).matches.length, 2, 'limit is clamped, not rejected')
  } finally { s.close(); rmSync(root, { recursive: true, force: true }) }
})
