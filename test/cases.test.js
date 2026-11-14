import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
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
