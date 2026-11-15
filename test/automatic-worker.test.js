import test from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../lib/bundle.js'

test('automatic extraction is opt-in, serialized, and drains on disposal', async () => {
  const listeners = new Map(); let applyWork
  const tools = {register(){return ()=>{}},guard(){return ()=>{}}}
  const ctx = {
    logger:{warn(){}},
    inject(names, callback){
      const key=names[0]
      if(key==='tools') callback({tools,effect(fn){applyWork=fn},on:(event,listener)=>{listeners.set(event,listener);return ()=>listeners.delete(event)}})
      else if(key==='shellEnv') callback({shellEnv:{register(){}}})
      else if(key==='skills') callback({skills:{registerProvider(){return ()=>{}}}})
      else if(key==='systemPrompt') callback({systemPrompt:{section(){}}})
    },
  }
  apply(ctx,{root:'/tmp/auto-worker-disabled',intercept:false})
  assert.ok(listeners.has('agent/turn-stopping'))
  assert.equal(listeners.get('agent/turn-stopping')({agent:{id:'s',session:{id:'s',header:{cwd:'/tmp/p'}}}}),undefined,
    'missing provider/model must not request a model or return worker work')
  // Teardown is awaited even when no DB was opened.
  const dispose=applyWork(); await dispose()
})

test('explicit route extracts one scoped queued candidate and disposal waits', async () => {
  const listeners=new Map(); let started=0, disposed=false, disposeHook
  const tools={register(){return ()=>{}},guard(){return ()=>{}}}
  const ctx={
    logger:{warn(){}},
    get:name=>name==='llm'?{async *stream(request){started++;assert.equal(request.provider,'test');assert.equal(request.model,'model');yield{type:'text-delta',text:'{"summary":"ENOENT observed","sourceIds":["call-1"]}'};yield{type:'finish',reason:{kind:'stop'}}}}:name==='sessions'?{get:id=>({id,seq:2,header:{cwd:'/tmp/p'},snapshotEvents:()=>[{type:'tool/call',data:{callId:'call-1',name:'bash'}},{type:'tool/result',data:{message:{toolCallId:'call-1',content:[{type:'text',text:'ENOENT'}]}}}]})}:undefined,
    inject(names,cb){const key=names[0];if(key==='tools')cb({tools,effect(fn){disposeHook=fn},on:(e,l)=>{listeners.set(e,l);return ()=>listeners.delete(e)}});else if(key==='shellEnv')cb({shellEnv:{register(){}}});else if(key==='skills')cb({skills:{registerProvider(){return ()=>{}}}});else if(key==='systemPrompt')cb({systemPrompt:{section(){}}})},
  }
  const root='/tmp/automatic-worker-integration'
  const {rmSync}=await import('node:fs');rmSync(root,{recursive:true,force:true})
  apply(ctx,{root,intercept:false,automaticProvider:'test',automaticModel:'model',automaticTools:['bash']})
  const agent={id:'session-1',session:{id:'session-1',header:{cwd:'/tmp/p'}}}
  listeners.get('tools/result')({agent,callId:'call-1',name:'bash'}, {isError:true,error:{info:{code:'ENOENT'}}})
  const listener=listeners.get('agent/turn-stopping')
  const event={agent,turn:1,signal:new AbortController().signal}
  assert.equal(await listener(event),undefined,'must not bail Cordis serial listeners')
  assert.equal(started,1,'exactly one queued extraction ran')
  const storePath=root+'/state/cases/cases.sqlite'
  const {DatabaseSync}=await import('node:sqlite');const db=new DatabaseSync(storePath,{readOnly:true})
  const row=db.prepare('SELECT state,candidate FROM memory_jobs').get();db.close()
  assert.equal(row.state,'candidate');assert.match(row.candidate,/ENOENT observed/)
  const dispose=disposeHook();await dispose();disposed=true
  assert.equal(disposed,true)
  rmSync(root,{recursive:true,force:true})
})

test('concurrent turn stops serialize extraction per plugin instance', async () => {
  const listeners=new Map();let calls=0,disposeHook
  const root='/tmp/automatic-worker-concurrent';const {rmSync}=await import('node:fs');rmSync(root,{recursive:true,force:true})
  const tools={register(){return ()=>{}},guard(){return ()=>{}}}
  const sessions={get:id=>({id,seq:2,header:{cwd:'/tmp/p'},snapshotEvents:()=>[{type:'tool/call',data:{callId:'c',name:'bash'}},{type:'tool/result',data:{message:{toolCallId:'c',content:[{type:'text',text:'ENOENT'}]}}}]})}
  const ctx={logger:{warn(){}},get:name=>name==='llm'?{async *stream(){calls++;await new Promise(r=>setTimeout(r,20));yield{type:'text-delta',text:'{"summary":"ENOENT","sourceIds":["c"]}'};yield{type:'finish',reason:{kind:'stop'}}}}:name==='sessions'?sessions:undefined,
   inject(names,cb){const key=names[0];if(key==='tools')cb({tools,effect(fn){disposeHook=fn},on:(e,l)=>{listeners.set(e,l);return()=>listeners.delete(e)}});else if(key==='shellEnv')cb({shellEnv:{register(){}}});else if(key==='skills')cb({skills:{registerProvider(){return()=>{}}}});else if(key==='systemPrompt')cb({systemPrompt:{section(){}}})}}
  try{
   apply(ctx,{root,intercept:false,automaticProvider:'test',automaticModel:'model',automaticTools:['bash']})
   const agent={id:'s',session:{id:'s',header:{cwd:'/tmp/p'}}}
   listeners.get('tools/result')({agent,callId:'c',name:'bash'},{isError:true,error:{info:{code:'ENOENT'}}})
   const fn=listeners.get('agent/turn-stopping');await Promise.all([fn({agent,turn:1}),fn({agent,turn:2})])
   assert.equal(calls,1,'duplicate concurrent turn must not start a second extract after lease completion')
  }finally{await disposeHook?.()();rmSync(root,{recursive:true,force:true})}
})
