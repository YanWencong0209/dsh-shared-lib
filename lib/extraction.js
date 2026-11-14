/** Optional bounded extraction boundary. No default route, network or case promotion. */
export async function extractCandidate({ evidence, extract, signal, timeoutMs = 5000 }) {
  if (typeof extract !== 'function') throw new Error('An explicit extractor is required')
  if (!Array.isArray(evidence) || evidence.length < 1 || evidence.length > 10) throw new Error('Evidence count must be 1-10')
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new Error('timeoutMs must be 1-30000')
  const ids = new Set()
  const input = evidence.map(item => {
    if (typeof item.id !== 'string' || !item.id || item.id.length > 160 || ids.has(item.id)) throw new Error('Unique evidence IDs required')
    if (typeof item.text !== 'string' || item.text.length > 2000) throw new Error('Evidence text budget exceeded')
    ids.add(item.id)
    return { id: item.id, text: item.text }
  })
  if (Buffer.byteLength(JSON.stringify(input)) > 8192) throw new Error('Input budget exceeded')
  const controller = new AbortController()
  const onAbort = () => controller.abort(signal.reason)
  if (signal?.aborted) throw new Error('Extraction cancelled')
  signal?.addEventListener('abort', onAbort, { once: true })
  let timer
  try {
    const cancelled = new Promise((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(new Error('Extraction cancelled or timed out')), { once: true })
      timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs)
    })
    const value = await Promise.race([Promise.resolve().then(() => extract({ evidence: input, signal: controller.signal, maxTokens: 256 })), cancelled])
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid extractor result')
    if (Object.keys(value).some(k => !['summary','sourceIds'].includes(k))) throw new Error('Unexpected extractor fields')
    if (typeof value.summary !== 'string' || !value.summary.trim() || Buffer.byteLength(value.summary) > 1024) throw new Error('Summary budget exceeded')
    if (!Array.isArray(value.sourceIds) || !value.sourceIds.length || value.sourceIds.length > 10 || !value.sourceIds.every(id => ids.has(id))) throw new Error('Unknown evidence citation')
    return { summary: value.summary, sourceIds: [...new Set(value.sourceIds)], status: 'candidate', taskVerified: false, trustedInstructions: false }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}
