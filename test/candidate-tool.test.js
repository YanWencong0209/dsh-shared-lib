import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {CaseStore,caseTool} from '../lib/cases.js'

test('candidate tools expose bounded summaries and scoped unverified details',async()=>{
 const root=mkdtempSync(join(tmpdir(),'candidate-tool-'));const store=new CaseStore(root)
 try{
  store.observe({name:'bash',agent:{id:'s'},callId:'call1'},{isError:true},'/work/a')
  store.enqueueEpisodes('/work/a','s');store.summarizeNext('/work/a','s')
  const job=store.claimExtraction('/work/a','s')
  store.finishExtraction(job.id,job.lease,{summary:'ENOENT diagnostic detail',sourceIds:['call1'],status:'candidate',taskVerified:false,trustedInstructions:false})
  const tool=caseTool(store,()=>'/work/a'),exec={agent:{id:'s'}}
  const hits=await tool.execute({action:'candidate_search',query:'ENOENT'},exec)
  assert.equal(hits.candidates.length,1);assert.equal(hits.candidates[0].taskVerified,false)
  const read=await tool.execute({action:'candidate_read',id:job.id},exec)
  assert.equal(read.candidate.summary,'ENOENT diagnostic detail');assert.equal(read.candidate.trustedInstructions,false)
  const otherWorkspaceTool=caseTool(store,()=>'/work/b')
  assert.equal((await otherWorkspaceTool.execute({action:'candidate_read',id:job.id},exec)).candidate,null)
  assert.ok(JSON.stringify(hits).length<1500)
 }finally{store.close();rmSync(root,{recursive:true,force:true})}
})
