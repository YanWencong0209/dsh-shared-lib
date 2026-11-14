import test from 'node:test'
import assert from 'node:assert/strict'
import { outcomeMetadata } from '../lib/cases.js'
const exec = {agent:{id:'s'},callId:'c',name:'bash'}
test('outcome capture never reads raw arguments or output',()=>{
 const e={...exec,get arguments(){throw Error('must not inspect commands')}}
 const result={isError:true,error:{info:{code:'ENOENT'}},get value(){throw Error('must not inspect body')},get content(){throw Error('must not inspect output')}}
 assert.deepEqual(outcomeMetadata(e,result),{session:'s',callId:'c',tool:'bash',outcome:'failed',code:'ENOENT',taskVerified:false})
})
test('success is returned only, not a verified fix; unknown remains unknown',()=>{
 assert.equal(outcomeMetadata(exec,{isError:false}).outcome,'returned')
 assert.equal(outcomeMetadata(exec,{}).outcome,'unknown')
 assert.equal(outcomeMetadata(exec,{isError:false}).taskVerified,false)
})
test('opaque error codes are not persisted and memory tools do not recurse',()=>{
 assert.equal(outcomeMetadata(exec,{isError:true,error:{info:{code:'token=private'}}}).code,'TOOL_ERROR')
 assert.equal(outcomeMetadata({...exec,name:'shared_cases'},{isError:false}),null)
 assert.equal(outcomeMetadata({...exec,name:'memory_search'},{isError:false}),null)
 assert.equal(outcomeMetadata({name:'bash'},{isError:true}),null)
})

import { CaseStore } from '../lib/cases.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
test('observations are durable, scoped and idempotent without promoting cases',()=>{
 const root=mkdtempSync(join(tmpdir(),'auto-observe-'));let store=new CaseStore(root)
 try {
  assert.equal(store.observe(exec,{isError:true},'/project/a'),true)
  assert.equal(store.observe(exec,{isError:true},'/project/a'),false)
  assert.equal(store.observe({...exec,callId:'c2'},{isError:false},'/project/a'),true)
  const rows=store.db.prepare('SELECT * FROM observations').all()
  assert.equal(rows.length,2);assert.ok(rows.every(x=>x.workspace==='/project/a'))
  assert.deepEqual(store.stats('/project/a'),{active:0,archived:0,sharedActive:0,projectActive:0})
  store.close();store=new CaseStore(root)
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM observations').get().n,2)
 }finally{store.close();rmSync(root,{recursive:true,force:true})}
})
