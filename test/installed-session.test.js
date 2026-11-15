import test from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { sessionEvidenceReader } from '../lib/session-evidence.js'
const modulePath = process.env.DSH_SESSION_TEST_MODULE

test('installed Host Session validates and resolves recorded evidence', {skip:!modulePath}, async()=>{
 const {Session}=await import(pathToFileURL(modulePath).href)
 const id='isolated-memory-contract',cwd='/tmp/isolated-memory-contract'
 const s=Session.create(id,[],{version:4,id,createdAt:Date.now(),isSeeded:false,cwd})
 const call=s.append('tool/call',{turn:1,step:1,callId:'c',name:'bash',arguments:{command:'fixture only'}})
 s.append('tool/result',{turn:1,step:1,message:{id:'result',role:'tool',source:{kind:'tool',callId:'c'},toolCallId:'c',content:[{type:'text',text:'ENOENT observed'}],isError:true}},{surfaceOp:'append',sourceEventSeqs:[call.seq]})
 const read=sessionEvidenceReader({get:key=>key===id?s:undefined},['bash'])
 assert.equal(await read({id:'c',session:id,workspace:cwd}),'ENOENT observed')
 await assert.rejects(read({id:'c',session:id,workspace:'/another-project'}),/scope mismatch/)
 await assert.rejects(read({id:'c',session:'unknown',workspace:cwd}),/scope mismatch/)
})
