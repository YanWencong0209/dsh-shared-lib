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
  store.failExtraction(current.id,current.lease)
  await runMemoryJob({store,workspace:'/p',session:'s',read:async()=>{throw Error('not available')}})
  assert.equal(store.claimExtraction('/p','s'),null)
  assert.equal(store.db.prepare('SELECT state FROM memory_jobs').get().state,'failed')
 }finally{store.close();rmSync(root,{recursive:true,force:true})}
})
