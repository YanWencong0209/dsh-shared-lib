import test from 'node:test'
import assert from 'node:assert/strict'
import { outcomeMetadata } from '../lib/cases.js'
const exec = {agent:{id:'s'},callId:'c',name:'bash'}
test('outcome capture never reads raw arguments or output',()=>{
 const e={...exec,get arguments(){throw Error('must not inspect commands')}}
 const result={isError:true,error:{info:{code:'ENOENT'}},get value(){throw Error('must not inspect body')},get content(){throw Error('must not inspect output')}}
 assert.deepEqual(outcomeMetadata(e,result),{session:'s',callId:'c',tool:'bash',outcome:'failed',code:'ENOENT',taskVerified:false})
})
test('success is returned only, not a verified fix; unknown remains unknown',()=>{
 assert.equal(outcomeMetadata(exec,{isError:false}).outcome,'returned')
 assert.equal(outcomeMetadata(exec,{}).outcome,'unknown')
 assert.equal(outcomeMetadata(exec,{isError:false}).taskVerified,false)
})
test('opaque error codes are not persisted and memory tools do not recurse',()=>{
 assert.equal(outcomeMetadata(exec,{isError:true,error:{info:{code:'token=private'}}}).code,'TOOL_ERROR')
 assert.equal(outcomeMetadata({...exec,name:'shared_cases'},{isError:false}),null)
 assert.equal(outcomeMetadata({...exec,name:'memory_search'},{isError:false}),null)
 assert.equal(outcomeMetadata({name:'bash'},{isError:true}),null)
})

import { CaseStore } from '../lib/cases.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
test('observations are durable, scoped and idempotent without promoting cases',()=>{
 const root=mkdtempSync(join(tmpdir(),'auto-observe-'));let store=new CaseStore(root)
 try {
  assert.equal(store.observe(exec,{isError:true},'/project/a'),true)
  assert.equal(store.observe(exec,{isError:true},'/project/a'),false)
  assert.equal(store.observe({...exec,callId:'c2'},{isError:false},'/project/a'),true)
  const rows=store.db.prepare('SELECT * FROM observations').all()
  assert.equal(rows.length,2);assert.ok(rows.every(x=>x.workspace==='/project/a'))
  assert.deepEqual(store.stats('/project/a'),{active:0,archived:0,sharedActive:0,projectActive:0})
  store.close();store=new CaseStore(root)
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM observations').get().n,2)
 }finally{store.close();rmSync(root,{recursive:true,force:true})}
})

test('episodes preserve failure and later return references without inventing a solution',()=>{
 const root=mkdtempSync(join(tmpdir(),'auto-episodes-'));const s=new CaseStore(root)
 try {
  s.observe(exec,{isError:true},'/a')
  s.observe({...exec,callId:'c2',name:'read'},{isError:false},'/a')
  s.observe({...exec,callId:'c3'},{isError:false},'/a')
  const r=s.episodes('/a','s')
  assert.equal(r.candidates.length,1)
  assert.equal(r.candidates[0].failureCall,'c')
  assert.equal(r.candidates[0].laterReturnedCall,'c3')
  assert.equal(r.candidates[0].taskVerified,false)
  assert.equal('solution' in r.candidates[0],false)
  assert.equal(s.episodes('/b','s').candidates.length,0)
  assert.equal(s.episodes('/a','other-session').candidates.length,0)
 }finally{s.close();rmSync(root,{recursive:true,force:true})}
})

test('turn queue is idempotent, bounded and does not call an extractor',()=>{
 const root=mkdtempSync(join(tmpdir(),'auto-queue-'));let s=new CaseStore(root)
 try {
  assert.equal(s.enqueueEpisodes('/a','s').reason,'no-observations')
  s.observe(exec,{isError:true},'/a')
  const job=s.enqueueEpisodes('/a','s')
  assert.equal(job.state,'awaiting-extractor')
  assert.equal(s.enqueueEpisodes('/a','s').reason,'duplicate')
  const row=s.db.prepare('SELECT * FROM memory_jobs WHERE id=?').get(job.id)
  assert.ok(Buffer.byteLength(row.payload)<=16384)
  assert.equal(JSON.parse(row.payload).candidates[0].taskVerified,false)
  assert.equal(s.enqueueEpisodes('/other','s').queued,false)
  s.close();s=new CaseStore(root)
  assert.equal(s.enqueueEpisodes('/a','s').reason,'duplicate')
  assert.equal(s.stats('/a').active,0)
 }finally{s.close();rmSync(root,{recursive:true,force:true})}
})

test('local summary consumes queued jobs once without generating a fix or prompt',()=>{
 const root=mkdtempSync(join(tmpdir(),'auto-summary-'));let s=new CaseStore(root)
 try {
  s.observe(exec,{isError:true},'/a')
  s.observe({...exec,callId:'r'},{isError:false},'/a')
  s.enqueueEpisodes('/a','s')
  const done=s.summarizeNext();assert.equal(done.state,'summarized-metadata')
  assert.equal(s.summarizeNext().processed,false)
  s.close();s=new CaseStore(root)
  const row=s.db.prepare('SELECT * FROM memory_jobs WHERE id=?').get(done.id)
  const summary=JSON.parse(row.summary)
  assert.equal(summary.items[0].failureCall,'c')
  assert.equal(summary.items[0].laterReturnedCall,'r')
  assert.equal(summary.items[0].taskVerified,false)
  assert.equal(summary.requiresEvidence,true)
  assert.equal(s.stats('/a').active,0)
 }finally{s.close();rmSync(root,{recursive:true,force:true})}
})

test('unrelated successful calls do not requeue old failures; consumer respects caller scope',()=>{
 const root=mkdtempSync(join(tmpdir(),'auto-scope-'));const s=new CaseStore(root)
 try {
  s.observe(exec,{isError:true},'/a');s.enqueueEpisodes('/a','s')
  s.observe({...exec,callId:'unrelated',name:'read'},{isError:false},'/a')
  assert.equal(s.enqueueEpisodes('/a','s').reason,'unchanged-episodes')
  assert.equal(s.summarizeNext('/b','s').processed,false)
  assert.equal(s.summarizeNext('/a','other').processed,false)
  assert.equal(s.summarizeNext('/a','s').processed,true)
 }finally{s.close();rmSync(root,{recursive:true,force:true})}
})
