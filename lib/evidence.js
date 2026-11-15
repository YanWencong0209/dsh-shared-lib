/** Read only caller-authorized source IDs through an explicit scoped reader. */
const sanitize = value => value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ').replace(/\r\n?/g, '\n').trim()
export async function hydrateEvidence({ sourceIds, allowedIds, read, scope, signal }) {
  if (typeof read !== 'function' || typeof scope?.workspace !== 'string' || typeof scope?.session !== 'string') throw new Error('Scoped evidence reader required')
  if (!Array.isArray(sourceIds) || sourceIds.length < 1 || sourceIds.length > 10 || !Array.isArray(allowedIds)) throw new Error('Invalid source list')
  const allowed = new Set(allowedIds), unique = new Set()
  for (const id of sourceIds) {
    if (typeof id !== 'string' || !id || id.length > 160 || !allowed.has(id) || unique.has(id)) throw new Error('Unauthorized or duplicate source ID')
    unique.add(id)
  }
  const result = []
  for (const id of unique) {
    if (signal?.aborted) throw new Error('Evidence read cancelled')
    const raw = await read({ id, workspace: scope.workspace, session: scope.session, signal })
    if (typeof raw !== 'string' || !raw.trim() || raw.length > 2000) throw new Error('Missing or oversized evidence')
    const text = sanitize(raw.replace(/\b(?:github_pat_|ghp_|sk-)[A-Za-z0-9_-]+/g, '[REDACTED]')
      .replace(/(bearer\s+)[^\s"']+/gi, '$1[REDACTED]')
      .replace(/\b(password|token|api[_-]?key|secret)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]'))
    result.push({ id, text })
    if (Buffer.byteLength(JSON.stringify(result)) > 8192) throw new Error('Evidence batch budget exceeded')
  }
  if (signal?.aborted) throw new Error('Evidence read cancelled')
  return result
}
