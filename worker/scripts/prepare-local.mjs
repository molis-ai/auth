import { randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
const path = new URL('../.dev.vars', import.meta.url)
const current = existsSync(path) ? readFileSync(path, 'utf8') : ''
if (!/^AUTH_WEB_SESSION_KEY=/m.test(current))
  writeFileSync(
    path,
    current +
      (current && !current.endsWith('\n') ? '\n' : '') +
      'AUTH_WEB_SESSION_KEY=' +
      randomBytes(32).toString('base64url') +
      '\n',
    { mode: 0o600 },
  )
