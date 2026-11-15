import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {pathToFileURL} from 'node:url'
import * as plugin from '../lib/bundle.js'
import {CaseStore} from '../lib/cases.js'
const base=process.env.DSH_HOST_TEST_PACKAGES

test('installed Cordis loads plugin, preserves serial listeners and disposes registrations',{skip:!base},async()=>{
 const load=name=>import(pathToFileURL(join(base,name,'lib/index.js')).href)
 const {Context}=await load('cordis'),{SystemPrompt}=await load('dsh-system-prompt'),{ToolsService}=await load('dsh-tools')
 const ctx=new Context(),root=mkdtempSync(join(tmpdir(),'cordis-memory-test-'))
 try{
  await ctx.plugin(SystemPrompt,{})
  await ctx.plugin(ToolsService)
  const fiber=await ctx.plugin(plugin,{root,linkDir:join(root,'links'),intercept:false})
  const agent={id:'isolated',session:{id:'isolated',header:{cwd:root}}}
  ctx.emit('tools/result',{agent,callId:'call',name:'bash'},{isError:true,error:{info:{code:'ENOENT'}}})
  let reached=0
  ctx.on('agent/turn-stopping',()=>{reached++})
  await ctx.serial('agent/turn-stopping',{agent,turn:1,signal:new AbortController().signal})
  assert.equal(reached,1)
  const store=new CaseStore(root)
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM observations').get().n,1)
  assert.equal(store.db.prepare('SELECT state FROM memory_jobs').get().state,'summarized-metadata')
  await fiber.dispose()
  ctx.emit('tools/result',{agent,callId:'after-dispose',name:'bash'},{isError:true})
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM observations').get().n,1)
  store.close()
 }finally{await ctx.fiber.dispose();rmSync(root,{recursive:true,force:true})}
})
