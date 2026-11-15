import {writeFileSync,mkdtempSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {hostExtractor} from '../../lib/host-extractor.js'
import {CaseStore} from '../../lib/cases.js'
import {runMemoryJob} from '../../lib/memory-worker.js'
import {memoryScheduler} from '../../lib/memory-scheduler.js'
export const name='shared-memory-live-smoke'
export const inject=['llm']
export function apply(ctx){
 let started=false
 ctx.on('tools/result',()=>{if(started)return;started=true;void(async()=>{
  const root=mkdtempSync(join(tmpdir(),'memory-queue-smoke-')),store=new CaseStore(root)
  const workspace='/synthetic',session='synthetic',agent={id:session}
  const texts={failure:'Synthetic ENOENT demo diagnostic: demo was missing in an isolated test prefix.',returned:'Synthetic fixture: installed demo to the isolated test prefix; rerun printed version 1.0.0. This is only a tool return, not verified task success.'}
  let usage=null,finish=null,result=null,scheduler
  const observed={async *stream(request){for await(const chunk of ctx.llm.stream(request)){if(chunk.type==='usage')usage=chunk.usage;if(chunk.type==='finish')finish=chunk.reason;yield chunk}}}
  const report={synthetic:true,provider:'gtp',model:'gpt-6.1-sol',isolatedRoot:root}
  try{
   store.observe({name:'bash',agent,callId:'failure'},{isError:true,error:{info:{code:'ENOENT'}}},workspace)
   store.observe({name:'bash',agent,callId:'returned'},{isError:false},workspace)
   store.enqueueEpisodes(workspace,session);store.summarizeNext(workspace,session)
   scheduler=memoryScheduler({intervalMs:60000,drain:async signal=>{if(!result)result=await runMemoryJob({store,workspace,session,allowedTools:['bash'],read:async({id})=>texts[id],extract:hostExtractor(observed,{provider:'gtp',model:'gpt-6.1-sol'}),signal})}})
   await scheduler.kick()
   const hits=store.candidateSummaries('demo',workspace)
   const row=store.db.prepare('SELECT state,candidate FROM memory_jobs').get()
   const candidate=row?.candidate?JSON.parse(row.candidate):null
   Object.assign(report,{result,observations:store.db.prepare('SELECT count(*) n FROM observations').get().n,state:row?.state,searchHits:hits.length,crossWorkspaceHits:store.candidateSummaries('demo','/other').length,verifiedCases:store.stats(workspace).active,shape:candidate?{status:candidate.status,taskVerified:candidate.taskVerified,sourceIds:candidate.sourceIds}:null,usage,finish})
  }catch(error){report.diagnostic=String(error.message).slice(0,160)}finally{await scheduler?.close();store.close()}
  writeFileSync(fileURLToPath(new URL('./queue-smoke-result.json',import.meta.url)),JSON.stringify(report,null,2))
 })()})
}
