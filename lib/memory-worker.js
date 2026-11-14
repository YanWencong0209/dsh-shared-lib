/** One leased extraction job; no primary-agent messages or implicit model route. */
import { hydrateEvidence } from './evidence.js'
import { extractCandidate } from './extraction.js'
export async function runMemoryJob({ store, workspace, session, read, extract, signal }) {
  if (signal?.aborted) return {processed:false,reason:'cancelled'}
  const job = store.claimExtraction(workspace,session)
  if (!job) return {processed:false,reason:'no-job'}
  try {
    const projection=JSON.parse(job.payload)
    const sourceIds=[...new Set(projection.candidates.flatMap(c=>[c.failureCall,c.laterReturnedCall]).filter(Boolean))].slice(0,10)
    const evidence=await hydrateEvidence({sourceIds,allowedIds:sourceIds,scope:{workspace,session},read,signal})
    const candidate=await extractCandidate({evidence,extract,signal,timeoutMs:10000})
    const accepted=store.finishExtraction(job.id,job.lease,candidate)
    return {processed:true,id:job.id,state:accepted?'candidate':'lease-lost'}
  } catch(error) {
    store.failExtraction(job.id,job.lease)
    return {processed:true,id:job.id,state:'attempt-failed'}
  }
}
