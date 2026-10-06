import { spawn } from 'node:child_process'
import { appendFileSync, closeSync, openSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const root = path.dirname(fileURLToPath(import.meta.url))
const port = 4174
const healthUrl = `http://127.0.0.1:${port}/api/health`
const log = (message) => appendFileSync(path.join(root, 'startup.log'), `${new Date().toISOString()} ${message}\n`)

async function healthy() {
  try {
    const response = await fetch(healthUrl, { signal: AbortSignal.timeout(1500) })
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
    socket.setTimeout(1500, () => finish(true))
  })
}

async function main() {
  if (await healthy()) {
    log('Already running; no duplicate process started.')
    return
  }
  if (await portInUse()) {
    // Another launcher may be finishing startup. Never terminate an unknown port owner.
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await delay(500)
      if (await healthy()) return
    }
    throw new Error(`Port ${port} is occupied, but the dashboard health check failed.`)
  }

  const output = openSync(path.join(root, 'server.stdout.log'), 'a')
  const errors = openSync(path.join(root, 'server.stderr.log'), 'a')
  let child
  try {
    child = spawn(process.execPath, [path.join(root, 'server.mjs')], {
      cwd: root,
      env: { ...process.env, PORT: String(port) },
      detached: true,
      windowsHide: true,
      stdio: ['ignore', output, errors],
    })
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve)
      child.once('error', reject)
    })
    child.unref()
  } finally {
    closeSync(output)
    closeSync(errors)
  }

  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (await healthy()) {
      writeFileSync(path.join(root, 'server.pid'), String(child.pid))
      log(`Started dashboard PID ${child.pid} on port ${port}.`)
      return
    }
    await delay(500)
  }
  throw new Error('Dashboard did not become healthy. See server.stderr.log.')
}

main().catch((error) => {
  log(`Startup failed: ${error.message}`)
  process.exitCode = 1
})
