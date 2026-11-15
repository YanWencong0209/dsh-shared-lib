import test from 'node:test'
import assert from 'node:assert/strict'
import {memoryScheduler} from '../lib/memory-scheduler.js'
test('scheduler serializes drains, retries after failure, and closes cleanly',async()=>{
 let calls=0,active=0,peak=0,releaseFirst
 const first=new Promise(resolve=>releaseFirst=resolve)
 const scheduler=memoryScheduler({intervalMs:100000,drain:async signal=>{calls++;active++;peak=Math.max(peak,active);if(calls===1){await first;active--;throw Error('once')}active--;assert.equal(signal.aborted,false)},onError(){}})
 await new Promise(resolve=>setImmediate(resolve))
 assert.equal(calls,1)
 const joined=scheduler.kick();assert.equal(calls,1,'concurrent kick joins in-flight work')
 releaseFirst();await joined
 assert.equal(calls,2,'wake during active drain triggers a second pass');assert.equal(peak,1)
 await scheduler.kick();assert.equal(calls,3)
 await scheduler.close();await scheduler.kick();assert.equal(calls,3)
})
test('scheduler aborts in-flight work on disposal',async()=>{
 let seen
 const scheduler=memoryScheduler({intervalMs:100000,drain:signal=>new Promise(resolve=>{seen=signal;signal.addEventListener('abort',()=>resolve(),{once:true})})})
 await new Promise(r=>setImmediate(r));await scheduler.close();assert.equal(seen.aborted,true)
})

test('timer retries without another user message',async()=>{
 let calls=0,done
 const completed=new Promise(resolve=>done=resolve)
 const watchdog=setTimeout(()=>done('timeout'),500)
 const scheduler=memoryScheduler({intervalMs:5,drain:async()=>{if(++calls===2)done('retried')}})
 try{assert.equal(await completed,'retried')}finally{clearTimeout(watchdog);await scheduler.close()}
})
