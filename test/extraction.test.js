import test from 'node:test'
import assert from 'node:assert/strict'
import { extractCandidate } from '../lib/extraction.js'
import { hostExtractor } from '../lib/host-extractor.js'
import { hydrateEvidence } from '../lib/evidence.js'
const evidence=[{id:'call-1',text:'A bounded observed diagnostic'}]
test('extractor receives only explicit evidence and output remains an unverified candidate',async()=>{
 const result=await extractCandidate({evidence,extract:async({maxTokens,signal,evidence:input})=>{
  assert.equal(maxTokens,256);assert.equal(signal.aborted,false);assert.deepEqual(input,evidence)
  return{summary:'Diagnostic observed',sourceIds:['call-1']}
 }})
 assert.equal(result.status,'candidate');assert.equal(result.taskVerified,false)
 assert.equal(result.trustedInstructions,false)
})
test('budget, unsupported fields and invented citations fail closed',async()=>{
 await assert.rejects(extractCandidate({evidence,extract:async()=>({summary:'x',sourceIds:['invented']})}),/citation/)
 await assert.rejects(extractCandidate({evidence,extract:async()=>({summary:'x',sourceIds:['call-1'],verified:true})}),/Unexpected/)
 await assert.rejects(extractCandidate({evidence:[{id:'x',text:'x'.repeat(2001)}],extract:()=>{throw Error('not called')}}),/budget/)
})
test('timeout and cancellation terminate the caller wait without claiming success',async()=>{
 await assert.rejects(extractCandidate({evidence,timeoutMs:5,extract:()=>new Promise(()=>{})}),/timed out/)
 const controller=new AbortController();controller.abort()
 await assert.rejects(extractCandidate({evidence,signal:controller.signal,extract:()=>{throw Error('not called')}}),/cancelled/)
})
test('Host stream adapter selects an explicit route, untrusted fence and no tools',async()=>{
 let request
 const llm={async *stream(r){request=r;yield{type:'text-delta',text:'{"summary":"Observed diagnostic","sourceIds":["call-1"]}'};yield{type:'finish',reason:{kind:'stop'}}}}
 const value=await extractCandidate({evidence,extract:hostExtractor(llm,{provider:'test-provider',model:'test-model'})})
 assert.equal(request.provider,'test-provider');assert.equal(request.model,'test-model')
 assert.deepEqual(request.tools,[]);assert.equal(request.maxTokens,256)
 assert.match(request.messages[0].content[0].text,/BEGIN_UNTRUSTED_EVIDENCE_JSON/)
 assert.match(request.messages[0].content[0].text,/END_UNTRUSTED_EVIDENCE_JSON/)
 assert.equal(value.taskVerified,false)
})
test('Host adapter rejects provider errors, truncation and oversized streams',async()=>{
 for(const kind of ['error','aborted','max-tokens','tool-calls']){
  const llm={async *stream(){yield{type:'finish',reason:{kind}}}}
  await assert.rejects(extractCandidate({evidence,extract:hostExtractor(llm,{provider:'p',model:'m'})}),/finish successfully/)
 }
 const huge={async *stream(){yield{type:'text-delta',text:'x'.repeat(4097)}}}
 await assert.rejects(extractCandidate({evidence,extract:hostExtractor(huge,{provider:'p',model:'m'})}),/budget/)
 assert.throws(()=>hostExtractor({},{}),/service/)
 assert.throws(()=>hostExtractor({stream(){}},{}),/provider and model/)
})
test('evidence hydration reads only allowed IDs with explicit scope and masks known tokens',async()=>{
 const seen=[]
 const result=await hydrateEvidence({sourceIds:['a'],allowedIds:['a'],scope:{workspace:'/project',session:'s'},read:async args=>{seen.push(args);return 'token=private ghp_ABCDEF\u0000'}})
 assert.equal(seen[0].workspace,'/project');assert.equal(seen[0].session,'s')
 assert.equal(result[0].text,'token=[REDACTED] [REDACTED]')
 let called=false
 await assert.rejects(hydrateEvidence({sourceIds:['outside'],allowedIds:['a'],scope:{workspace:'/p',session:'s'},read:()=>{called=true}}),/Unauthorized/)
 assert.equal(called,false)
 await assert.rejects(hydrateEvidence({sourceIds:['a'],allowedIds:['a'],scope:{workspace:'/p',session:'s'},read:async()=>null}),/Missing/)
})
