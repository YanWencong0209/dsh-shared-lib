/** Fiber-owned, non-overlapping polling. The owner supplies bounded single-job work. */
export function memoryScheduler({ drain, onError = () => {}, intervalMs = 1000 }) {
  let active, timer, disposed = false, requested = false
  const controller = new AbortController()
  const kick = () => {
    if (disposed) return Promise.resolve()
    requested = true
    if (active) return active
    active = Promise.resolve().then(async () => {
      while (requested && !disposed) {
        requested = false
        try { await drain(controller.signal) } catch (error) { onError(error) }
      }
    }).finally(() => { active = undefined })
    return active
  }
  timer = setInterval(() => { void kick() }, intervalMs)
  timer.unref?.()
  void kick()
  return { kick, async close() { disposed = true; requested = false; clearInterval(timer); controller.abort(); await active } }
}
