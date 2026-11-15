import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {CaseStore} from '../lib/cases.js'

test('terminal history is bounded and cannot permanently block new jobs',()=>{
 const root=mkdtempSync(join(tmpdir(),'job-capacity-')),s=new CaseStore(root)
 try{
  const insert=s.db.prepare('INSERT INTO memory_jobs(id,workspace,session,cursor,payload,state,created) VALUES(?,?,?,?,?,?,?)')
  s.db.exec('BEGIN')
  for(let i=0;i<1005;i++)insert.run('old-'+i,'/p','old',i,'{}','failed',new Date(i).toISOString())
  s.db.exec('COMMIT')
  s.observe({agent:{id:'s'},callId:'new',name:'bash'},{isError:true},'/p')
  assert.equal(s.enqueueEpisodes('/p','s').queued,true)
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM memory_jobs WHERE state='failed'").get().n,1000)
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM memory_jobs WHERE state='awaiting-extractor'").get().n,1)
 }finally{s.close();rmSync(root,{recursive:true,force:true})}
})
