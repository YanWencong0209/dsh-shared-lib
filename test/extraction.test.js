import test from 'node:test'
import assert from 'node:assert/strict'
import { extractCandidate } from '../lib/extraction.js'
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
