import { createHash, randomBytes } from 'node:crypto'
import { EventEmitter, once } from 'node:events'

// Test data only, never imported by the deployed Worker.
export const secret = () => randomBytes(32).toString('base64url')
export const hash = (value: string) => createHash('sha256').update(value).digest('hex')
export const challenge = (value: string) => createHash('sha256').update(value).digest('base64url')

type AuthLog = {
  schema: number
  service: string
  env: string
  event: string
  request_id: string
  duration_ms: number
  route?: string
  phase?: string
  code?: string
  status?: number
  error_code?: string
  method?: string
  action?: string
  outcome?: string
  rounds?: number
  deleted?: Record<string, number | null>
  stop_reason?: string
}

export function captureAuthLogs() {
  const events = new EventEmitter()
  const records: AuthLog[] = []
  const lines: string[] = []
  async function waitFor(matches: (record: AuthLog) => boolean) {
    const signal = AbortSignal.timeout(3000)
    for (;;) {
      const record = records.find(matches)
      if (record) return record
      await once(events, 'record', { signal })
    }
  }
  return {
    records,
    lines,
    handleStructuredLogs({ message }: { message: string }) {
      lines.push(message)
      if (!message.startsWith('{') || !message.includes('"auth.')) return
      records.push(JSON.parse(message))
      events.emit('record')
    },
    waitFor,
  }
}

export function captureAuthFailures() {
  const logs = captureAuthLogs()
  const isFailure = (log: AuthLog, requestId: string) =>
    log.event === 'auth.request.failure' && log.request_id === requestId
  return {
    ...logs,
    async forRequest(requestId: string, phases: string[]) {
      for (const phase of phases)
        await logs.waitFor((log) => isFailure(log, requestId) && log.phase === phase)
      return logs.records.filter((log) => isFailure(log, requestId))
    },
  }
}
