// Assets serve public files first. The raw shell must live behind a Worker-first route.
import { mkdirSync, renameSync } from 'node:fs'

const output = new URL('../dist/', import.meta.url)
mkdirSync(new URL('account/', output), { recursive: true })
renameSync(new URL('index.html', output), new URL('account/index.html', output))
