import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {CaseStore} from '../lib/cases.js'
test('candidate retrieval fails closed on malformed stored JSON',()=>{
 const root=mkdtempSync(join(tmpdir(),'candidate-corrupt-'));const s=new CaseStore(root)
 try{
  s.db.prepare("INSERT INTO memory_jobs(id,workspace,session,cursor,payload,state,created,candidate) VALUES(?,?,?,?,?,?,?,?)")
   .run('broken','/p','s',1,'{}','candidate',new Date().toISOString(),'{invalid}')
  assert.deepEqual(s.candidateSummaries('anything','/p'),[])
  assert.equal(s.candidateRead('broken','/p'),null)
  assert.equal(s.candidateRead('broken','/other'),null)
 }finally{s.close();rmSync(root,{recursive:true,force:true})}
})
