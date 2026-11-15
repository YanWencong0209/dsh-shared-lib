/** One leased extraction job; no primary-agent messages or implicit model route. */
import { hydrateEvidence } from './evidence.js'
import { extractCandidate } from './extraction.js'
export async function runMemoryJob({ store, workspace, session, read, extract, signal, allowedTools, now = Date.now() }) {
  if (signal?.aborted) return {processed:false,reason:'cancelled'}
  const job = store.claimExtraction(workspace,session,now)
  if (!job) return {processed:false,reason:'no-job'}
  try {
    const projection=JSON.parse(job.payload)
    const selected = allowedTools === undefined ? projection.candidates : projection.candidates.filter(c=>allowedTools.includes(c.tool))
    if (!selected.length) {
      store.skipExtraction(job.id,job.lease)
      return {processed:true,id:job.id,state:'skipped-no-allowed-evidence'}
    }
    const sourceIds=[...new Set(selected.flatMap(c=>[c.failureCall,c.laterReturnedCall]).filter(Boolean))].slice(0,10)
    const evidence=await hydrateEvidence({sourceIds,allowedIds:sourceIds,scope:{workspace,session},read,signal})
    const candidate=await extractCandidate({evidence,extract,signal,timeoutMs:10000})
    const accepted=store.finishExtraction(job.id,job.lease,candidate)
    return {processed:true,id:job.id,state:accepted?'candidate':'lease-lost'}
  } catch(error) {
    store.failExtraction(job.id,job.lease,'EXTRACTION_FAILED',now)
    return {processed:true,id:job.id,state:'attempt-failed'}
  }
}
