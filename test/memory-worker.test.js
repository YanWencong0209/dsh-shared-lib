import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {CaseStore} from '../lib/cases.js'
import {runMemoryJob} from '../lib/memory-worker.js'
function queued(store){store.observe({name:'bash',agent:{id:'s'},callId:'c'},{isError:true},'/p');store.enqueueEpisodes('/p','s');store.summarizeNext('/p','s')}
test('failure through leased extraction persists a searchable candidate, never a verified case',async()=>{
 const root=mkdtempSync(join(tmpdir(),'worker-e2e-'));const store=new CaseStore(root)
 try{
  queued(store)
  const result=await runMemoryJob({store,workspace:'/p',session:'s',read:async()=> 'ENOENT diagnostic',extract:async()=>({summary:'ENOENT diagnostic recorded',sourceIds:['c']})})
  assert.equal(result.state,'candidate')
  assert.equal(store.candidateSummaries('ENOENT','/p').length,1)
  assert.equal(store.candidateSummaries('ENOENT','/other').length,0)
  assert.equal(store.stats('/p').active,0)
  assert.equal((await runMemoryJob({store,workspace:'/p',session:'s'})).processed,false)
 }finally{store.close();rmSync(root,{recursive:true,force:true})}
})
test('three failures stop retries and stale leases cannot publish',async()=>{
 const root=mkdtempSync(join(tmpdir(),'worker-retry-'));const store=new CaseStore(root)
 try{
  queued(store)
  const old=store.claimExtraction('/p','s',0)
  const current=store.claimExtraction('/p','s',40000)
  assert.ok(current)
  assert.equal(store.finishExtraction(old.id,old.lease,{summary:'x',status:'candidate',taskVerified:false}),false)
  store.failExtraction(current.id,current.lease,'EXTRACTION_FAILED',40000)
  const blocked=await runMemoryJob({store,workspace:'/p',session:'s',now:40000,read:async()=>{throw Error('not available')}})
  assert.equal(blocked.reason,'no-job','backoff prevents immediate retry')
  let job=store.db.prepare('SELECT * FROM memory_jobs').get()
  assert.equal(job.failure,'EXTRACTION_FAILED','raw provider errors are not persisted')
  for(const now of [42000,46000]) {
    const claim=store.claimExtraction('/p','s',now);assert.ok(claim)
    store.failExtraction(claim.id,claim.lease,'EXTRACTION_FAILED',now)
    job=store.db.prepare('SELECT * FROM memory_jobs').get()
    if(job.state==='failed')break
  }
  assert.equal(store.db.prepare('SELECT state FROM memory_jobs').get().state,'failed')
  assert.equal(store.claimExtraction('/p','s',Date.now()+120000),null)
 }finally{store.close();rmSync(root,{recursive:true,force:true})}
})


test('crash on final lease becomes terminal after expiry',()=>{
 const root=mkdtempSync(join(tmpdir(),'worker-final-crash-'));const store=new CaseStore(root)
 try{
  queued(store)
  store.claimExtraction('/p','s',0)
  store.claimExtraction('/p','s',40000)
  const final=store.claimExtraction('/p','s',80000)
  assert.equal(final.attempts,3)
  assert.equal(store.claimExtraction('/p','s',120000),null)
  const row=store.db.prepare('SELECT state,failure FROM memory_jobs').get()
  assert.equal(row.state,'failed');assert.equal(row.failure,'LEASE_EXPIRED')
 }finally{store.close();rmSync(root,{recursive:true,force:true})}
})


test('mixed tools filter unauthorized evidence before hydration',async()=>{
 const root=mkdtempSync(join(tmpdir(),'worker-tools-'));const store=new CaseStore(root)
 try{
  for(const [name,callId] of [['bash','b'],['read','r']])store.observe({name,agent:{id:'s'},callId},{isError:true},'/p')
  store.enqueueEpisodes('/p','s');store.summarizeNext('/p','s')
  const ids=[]
  const result=await runMemoryJob({store,workspace:'/p',session:'s',allowedTools:['bash'],read:async({id})=>{ids.push(id);return 'diagnostic'},extract:async()=>({summary:'bash diagnostic',sourceIds:['b']})})
  assert.equal(result.state,'candidate');assert.deepEqual(ids,['b'])
 }finally{store.close();rmSync(root,{recursive:true,force:true})}
})
test('empty evidence allowlist skips job without inference or retry',async()=>{
 const root=mkdtempSync(join(tmpdir(),'worker-none-'));const store=new CaseStore(root)
 try{
  queued(store)
  const result=await runMemoryJob({store,workspace:'/p',session:'s',allowedTools:[],read:()=>{throw Error('must not read')},extract:()=>{throw Error('must not infer')}})
  assert.equal(result.state,'skipped-no-allowed-evidence')
  assert.equal(store.db.prepare('SELECT state FROM memory_jobs').get().state,'skipped')
 }finally{store.close();rmSync(root,{recursive:true,force:true})}
})
