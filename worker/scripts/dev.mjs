process.argv.splice(2, 0, 'start')
await import('./environment-command.mjs')
