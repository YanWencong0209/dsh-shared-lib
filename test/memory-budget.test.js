import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {CaseStore} from '../lib/cases.js'

test('repeat-task retrieval keeps first-use context bounded and retains source drill-down',()=>{
 const root=mkdtempSync(join(tmpdir(),'memory-budget-'));const s=new CaseStore(root)
 try{
  for(let i=0;i<10;i++){
   const sid=`session-${i}`,call=`call-${i}`
   s.observe({name:'bash',agent:{id:sid},callId:call},{isError:true},'/project')
   s.enqueueEpisodes('/project',sid);s.summarizeNext('/project',sid)
   const job=s.claimExtraction('/project',sid)
   s.finishExtraction(job.id,job.lease,{summary:`EACCES permission error. Verified context ${'detail '.repeat(80)} ${i}`,sourceIds:[call],status:'candidate',taskVerified:false,trustedInstructions:false})
  }
  const all=s.db.prepare("SELECT candidate FROM memory_jobs WHERE state='candidate' ORDER BY created").all().map(r=>JSON.parse(r.candidate))
  const full=JSON.stringify(all)
  const compact=JSON.stringify(s.candidateSummaries('EACCES','/project'))
  assert.ok(compact.length<full.length/4,`expected ≥75% char reduction: full=${full.length}, compact=${compact.length}`)
  assert.equal(s.candidateSummaries('unknown','/project').length,0)
  const selected=s.candidateSummaries('EACCES','/project')[0]
  const detail=s.candidateRead(selected.id,'/project')
  assert.ok(detail.sourceIds.length===1)
  assert.equal(detail.taskVerified,false)
  console.log(JSON.stringify({fixture:10,fullChars:full.length,compactChars:compact.length,reduction:(1-compact.length/full.length).toFixed(3),liveModelTokens:null,quality:null}))
 }finally{s.close();rmSync(root,{recursive:true,force:true})}
})
