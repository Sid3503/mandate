/**
 * What the process does when something nobody planned for happens.
 *
 * A promise nobody awaited that rejects is logged and the server carries on: the request or timer it belonged to
 * already has its own error handling, and one stray rejection should not take down a server that holds money in flight.
 * An exception that escaped everything means the process state is unknown, so it is logged and the process exits for a
 * supervisor to restart it. Every request that matters is idempotent and every state change is a committed SQLite
 * transaction, so a restart loses nothing.
 */
export function installProcessGuards(options: { log?: (line: string) => void; exit?: (code: number) => void } = {}): void {
  const log = options.log ?? ((line) => console.error(line))
  const exit = options.exit ?? ((code) => process.exit(code))
  const describe = (value: unknown) => (value instanceof Error ? { name: value.name, detail: value.message.slice(0, 300), stack: (value.stack ?? '').split('\n').slice(0, 6).join('\n') } : { detail: String(value).slice(0, 300) })
  process.on('unhandledRejection', (reason) => {
    log(JSON.stringify({ level: 'error', message: 'unhandled rejection', ...describe(reason) }))
  })
  process.on('uncaughtException', (error) => {
    log(JSON.stringify({ level: 'fatal', message: 'uncaught exception, exiting for a restart', ...describe(error) }))
    setTimeout(() => exit(1), 200).unref()
  })
}
