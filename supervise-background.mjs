import { spawn } from 'node:child_process'
import { appendFileSync, closeSync, mkdirSync, openSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const projectRoot = path.dirname(fileURLToPath(import.meta.url))

export async function runSupervisor({ root = projectRoot, port = 4174, pollMs = 5000, retryMs = 2000, healthTimeoutMs = 1500 } = {}) {
  const log = (message) => appendFileSync(path.join(root, 'startup.log'), `${new Date().toISOString()} ${message}\n`)
  const diagnostics = path.join(root, 'data', 'runtime-diagnostics')
  mkdirSync(diagnostics, { recursive: true })
  let child = null
  let stopping = false
  let lastState = ''
  let failures = 0
  let nextStart = 0

  async function healthy() {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(healthTimeoutMs) })
      const data = await response.json()
      return response.ok && data.ok === true && data.service === 'market-dashboard'
    } catch {
      return false
    }
  }

  function portInUse() {
    return new Promise((resolve) => {
      const socket = net.connect({ host: '127.0.0.1', port })
      const finish = (inUse) => { socket.destroy(); resolve(inUse) }
      socket.once('connect', () => finish(true))
      socket.once('error', () => finish(false))
      socket.setTimeout(healthTimeoutMs, () => finish(true))
    })
  }

  function state(message) {
    if (lastState !== message) { log(message); lastState = message }
  }

  function launch() {
    const output = openSync(path.join(root, 'server.stdout.log'), 'a')
    const errors = openSync(path.join(root, 'server.stderr.log'), 'a')
    let launched
    try {
      launched = spawn(process.execPath, [
        '--report-uncaught-exception', '--report-on-fatalerror', `--report-directory=${diagnostics}`,
        path.join(root, 'server.mjs'),
      ], { cwd: root, env: { ...process.env, PORT: String(port) }, windowsHide: true, stdio: ['ignore', output, errors] })
      child = launched
    } finally {
      closeSync(output)
      closeSync(errors)
    }
    launched.once('spawn', () => {
      writeFileSync(path.join(root, 'server.pid'), String(launched.pid))
      log(`Supervisor started dashboard PID ${launched.pid} on port ${port}.`)
    })
    launched.once('error', (error) => {
      log(`Dashboard launch failed: ${error.message}`)
      if (child === launched) child = null
      nextStart = Date.now() + retryMs
    })
    launched.once('exit', (code, signal) => {
      log(`Dashboard PID ${launched.pid} exited: code=${code}, signal=${signal ?? 'none'}.`)
      if (child === launched) child = null
      failures = 0
      nextStart = Date.now() + retryMs
    })
    failures = 0
  }

  const stop = (signal) => {
    if (stopping) return
    stopping = true
    log(`Supervisor stopping: ${signal}.`)
    child?.kill()
  }
  const onInterrupt = () => stop('SIGINT')
  const onTerminate = () => stop('SIGTERM')
  const onException = (error) => log(`Supervisor exception: ${error.stack ?? error.message}`)
  process.on('SIGINT', onInterrupt)
  process.on('SIGTERM', onTerminate)
  process.on('uncaughtExceptionMonitor', onException)
  log(`Supervisor PID ${process.pid} started on port ${port}.`)

  try {
    while (!stopping) {
      if (await healthy()) {
        failures = 0
        state(child ? `Dashboard PID ${child.pid} is healthy.` : 'Existing dashboard is healthy; monitoring without starting a duplicate.')
      } else if (!stopping && child) {
        failures += 1
        if (failures >= 6) {
          state(`Dashboard PID ${child.pid} failed six health checks; restarting the supervised process.`)
          child.kill()
        }
      } else if (!stopping && await portInUse()) {
        state(`Port ${port} is occupied but dashboard health failed; leaving the port owner running.`)
      } else if (!stopping && Date.now() >= nextStart) {
        state('Dashboard is unavailable; starting it in the background.')
        launch()
      }
      if (!stopping) await delay(child ? pollMs : Math.min(pollMs, retryMs))
    }
  } finally {
    child?.kill()
    process.removeListener('SIGINT', onInterrupt)
    process.removeListener('SIGTERM', onTerminate)
    process.removeListener('uncaughtExceptionMonitor', onException)
    log('Supervisor stopped.')
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runSupervisor().catch((error) => {
    appendFileSync(path.join(projectRoot, 'startup.log'), `${new Date().toISOString()} Supervisor failed: ${error.stack ?? error.message}\n`)
    process.exitCode = 1
  })
}
