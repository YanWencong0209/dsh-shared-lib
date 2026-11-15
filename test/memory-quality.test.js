import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {CaseStore} from '../lib/cases.js'

const corpus=[
 ['npm peer dependency missing','npm ERESOLVE peer-deps missing npm package'],
 ['sqlite database locked','sqlite locked concurrent write'],
 ['node module not found','node ERR_MODULE_NOT_FOUND pnpm link bundle resolve package'],
 ['git timeout fetch','git fetch RPC reset timeout'],
 ['pnpm global store mismatch','pnpm global store path mismatch'],
 ['android permission denied','android permission denied device shell'],
 ['provider rate limit','llm provider 429 rate limit'],
 ['plugin stale runtime version','plugin stale restart runtime version'],
]
test('offline retrieval quality baseline reports recall@3 and MRR against full-context oracle',()=>{
 const root=mkdtempSync(join(tmpdir(),'memory-quality-'));const s=new CaseStore(root)
 try{
  for(let i=0;i<corpus.length;i++){
   const id=`candidate-${i}`
   s.db.prepare("INSERT INTO memory_jobs(id,workspace,session,cursor,payload,state,created,summary,candidate) VALUES(?,?,?,?,?,?,?,?,?)")
    .run(id,'/project','s',i,'{}','candidate',new Date(Date.now()+i).toISOString(),'{}',JSON.stringify({summary:corpus[i][0],sourceIds:[`source-${i}`],status:'candidate',taskVerified:false,trustedInstructions:false}))
  }
  const queries=corpus.map(([title,query],i)=>({query,expected:`candidate-${i}`}))
  const rr=[];let hits=0
  for(const q of queries){
   const ranked=s.candidateSummaries(q.query,'/project')
   const rank=ranked.findIndex(x=>x.id===q.expected)+1
   if(rank>0){hits++;rr.push(1/rank);if(rank>1)console.log('rank>1',q.query,rank,ranked.map(x=>x.id))}else {rr.push(0);console.log('miss',q.query,'got',ranked.map(x=>x.id))}
   assert.ok(ranked.length<=3)
   assert.ok(ranked.every(x=>x.status==='candidate'&&x.taskVerified===false))
  }
  const recallAt3=hits/queries.length,mrr=rr.reduce((a,b)=>a+b,0)/rr.length
  const fullContextChars=JSON.stringify(s.db.prepare("SELECT id,candidate FROM memory_jobs WHERE state='candidate' AND workspace=? ORDER BY created DESC").all('/project')).length
  const compactChars=queries.reduce((n,q)=>n+JSON.stringify(s.candidateSummaries(q.query,'/project')).length,0)
  const metrics={queries:queries.length,recallAt3:Number(recallAt3.toFixed(3)),mrr:Number(mrr.toFixed(3)),fullContextChars,aggregateCompactChars:compactChars}
  console.log(JSON.stringify(metrics))
  assert.equal(recallAt3,1);assert.ok(mrr>=0.875)
 }finally{s.close();rmSync(root,{recursive:true,force:true})}
})
