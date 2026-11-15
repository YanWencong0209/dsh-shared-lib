import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {CaseStore} from '../lib/cases.js'

test('observation rolling window stays bounded and retains newest source IDs',()=>{
 const root=mkdtempSync(join(tmpdir(),'observation-retention-'));const s=new CaseStore(root)
 try{
  for(let i=0;i<10005;i++)assert.equal(s.observe({name:'tool',agent:{id:'s'},callId:`c${i}`},{isError:true},'/p'),true)
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM observations').get().n,10000)
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM observations WHERE call_id=?').get('c0').n,0)
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM observations WHERE call_id=?').get('c10004').n,1)
  assert.equal(s.observe({name:'tool',agent:{id:'s'},callId:'c10004'},{isError:true},'/p'),false)
 }finally{s.close();rmSync(root,{recursive:true,force:true})}
})
