import test from 'node:test'
import assert from 'node:assert/strict'
import { sessionEvidenceReader } from '../lib/session-evidence.js'
import { hydrateEvidence } from '../lib/evidence.js'
const events=[{type:'tool/call',data:{callId:'c1',name:'bash',get arguments(){throw Error('must not inspect args')}}},{type:'tool/result',data:{message:{toolCallId:'c1',content:[{type:'text',text:'secret=private\nENOENT'}]}}}]
const scope={session:'s',workspace:'/project'}
const sessions={get:id=>id==='s'?{id:'s',seq:2,header:{cwd:'/project'},snapshotEvents:()=>events}:undefined}
test('Host session evidence resolves exact recorded call, enforces scope and masks result',async()=>{
 const read=sessionEvidenceReader(sessions,['bash'])
 const evidence=await hydrateEvidence({sourceIds:['c1'],allowedIds:['c1'],scope,read})
 assert.equal(evidence[0].text,'secret=[REDACTED]\nENOENT')
 await assert.rejects(read({...scope,id:'c1',workspace:'/other'}),/scope/)
 await assert.rejects(read({...scope,id:'missing'}),/not allowed/)
 await assert.rejects(sessionEvidenceReader(sessions)( {...scope,id:'c1'}),/not allowed/)
})
test('result evidence is fail-closed when missing or oversized',async()=>{
 const missing={get:()=>({id:'s',seq:1,header:{cwd:'/project'},snapshotEvents:()=>events.slice(0,1)})}
 await assert.rejects(sessionEvidenceReader(missing,['bash'])({...scope,id:'c1'}),/unavailable/)
})
