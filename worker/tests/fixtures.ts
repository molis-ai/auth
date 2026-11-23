import { createHash, randomBytes } from 'node:crypto'
import { EventEmitter, once } from 'node:events'

// Test data only, never imported by the deployed Worker.
export const secret = () => randomBytes(32).toString('base64url')
export const hash = (value: string) => createHash('sha256').update(value).digest('hex')
export const challenge = (value: string) => createHash('sha256').update(value).digest('base64url')

export function captureAuthFailures() {
  const events = new EventEmitter()
  const failures: Array<{
    event: string
    request_id: string
    route: string
    phase: string
    code: string
    status: number
    elapsed_ms: number
  }> = []
  return {
    handleStructuredLogs({ message }: { message: string }) {
      if (!message.startsWith('{') || !message.includes('"auth.request.failure"')) return
      const failure = JSON.parse(message)
      failures.push(failure)
      events.emit('failure')
    },
    async forRequest(requestId: string, phases: string[]) {
      const signal = AbortSignal.timeout(3_000)
      for (;;) {
        const matched = failures.filter(({ request_id }) => request_id === requestId)
        if (phases.every((phase) => matched.some((failure) => failure.phase === phase))) {
          return matched
        }
        await once(events, 'failure', { signal })
      }
    },
  }
}
