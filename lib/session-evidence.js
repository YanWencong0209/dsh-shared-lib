/** Host Session reader: exact recorded tool-result references, never arbitrary files. */
import { resolve } from 'node:path'

export function sessionEvidenceReader(sessions, allowedToolNames = []) {
  const tools = new Set(allowedToolNames)
  if (!sessions || typeof sessions.get !== 'function') throw new Error('Host sessions service required')
  return async ({ id, workspace, session, signal }) => {
    if (signal?.aborted) throw new Error('Evidence read cancelled')
    const live = sessions.get(session)
    if (!live || live.id !== session || typeof live.header?.cwd !== 'string' || resolve(live.header.cwd) !== resolve(workspace)) throw new Error('Session evidence scope mismatch')
    // Bound scanning without accessing unrelated conversation prose or tool arguments.
    const end = live.seq
    const events = live.snapshotEvents(Math.max(0, end - 1000), end)
    const call = events.find(e => e.type === 'tool/call' && e.data.callId === id)
    if (!call || !tools.has(call.data.name)) throw new Error('Evidence tool not allowed or call outside scan window')
    const result = events.find(e => e.type === 'tool/result' && e.data.message.toolCallId === id)
    if (!result) throw new Error('Recorded tool result unavailable')
    const blocks = result.data.message.content
    if (!Array.isArray(blocks)) throw new Error('Unsupported result content')
    let text = ''
    for (const block of blocks) {
      if (block.type !== 'text') continue
      if (typeof block.text !== 'string') throw new Error('Invalid result text')
      text += block.text + '\n'
      if (text.length > 2000) throw new Error('Recorded evidence exceeds text budget')
    }
    if (!text.trim()) throw new Error('No textual evidence')
    return text.trim()
  }
}
