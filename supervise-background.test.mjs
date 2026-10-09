import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const supervisorUrl = new URL('./supervise-background.mjs', import.meta.url).href
const fixtureServer = `
import http from 'node:http'
import { appendFileSync } from 'node:fs'
import path from 'node:path'
const service = process.env.TEST_SERVICE || 'market-dashboard'
const server = http.createServer((_request, response) => {
  response.setHeader('Content-Type', 'application/json')
  response.end(JSON.stringify({ ok: true, service, pid: process.pid }))
})
server.listen(Number(process.env.PORT), '127.0.0.1', () => {
  appendFileSync(path.join(process.cwd(), 'starts.jsonl'), JSON.stringify({ pid: process.pid, service }) + '\\n')
})
`

async function eventually(check, message, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const result = await check()
    if (result) return result
    await delay(40)
  }
  assert.fail(message)
}

async function freePort() {
  const server = net.createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = server.address().port
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  assert.notEqual(port, 4174, 'Tests must not use the production port')
  return port
}

async function terminate(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill()
  await eventually(() => child.exitCode !== null || child.signalCode !== null, 'Test child did not exit', 4000)
}

async function sandbox(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'market-supervisor-test-'))
  const port = await freePort()
  const processes = []
  let supervisor
  const read = async (name) => readFile(path.join(root, name), 'utf8').catch((error) => {
    if (error.code === 'ENOENT') return ''
    throw error
  })
  const starts = async () => (await read('starts.jsonl')).trim().split('\n').filter(Boolean).map(JSON.parse)
  const health = async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(300) })
      return await response.json()
    } catch {
      return null
    }
  }
  t.after(async () => {
    // Ask the isolated runner to deliver SIGTERM inside Node. Windows child.kill()
    // terminates immediately and would bypass the supervisor's child cleanup.
    if (supervisor && supervisor.exitCode === null && supervisor.signalCode === null) {
      supervisor.stdin.end('stop\n')
      try {
        await eventually(() => supervisor.exitCode !== null || supervisor.signalCode !== null, 'Supervisor did not stop', 4000)
      } catch {
        await terminate(supervisor)
      }
    }
    for (const child of processes) await terminate(child)
    // Only clean up a currently responding fixture whose identity matches this
    // sandbox's launch log. Historical PIDs may have been reused after exit.
    const remaining = await health()
    if (remaining && (await starts()).some(({ pid, service }) => pid === remaining.pid && service === remaining.service)) {
      try { process.kill(remaining.pid) } catch (error) { if (error.code !== 'ESRCH') throw error }
    }
    await eventually(async () => !(await health()), 'Fixture service remained running after cleanup', 4000)
    const resolvedRoot = path.resolve(root)
    assert.equal(path.dirname(resolvedRoot), path.resolve(os.tmpdir()), 'Cleanup target must be directly inside the temporary directory')
    assert.ok(path.basename(resolvedRoot).startsWith('market-supervisor-test-'), 'Cleanup target must be a supervisor test sandbox')
    await rm(resolvedRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })
  await writeFile(path.join(root, 'server.mjs'), fixtureServer)
  await writeFile(path.join(root, 'runner.mjs'), `
import { runSupervisor } from ${JSON.stringify(supervisorUrl)}
process.stdin.setEncoding('utf8')
process.stdin.on('data', () => process.emit('SIGTERM'))
await runSupervisor({ root: process.cwd(), port: Number(process.env.PORT), pollMs: 40, retryMs: 40, healthTimeoutMs: 300 })
process.stdin.destroy()
`)
  const spawnFixture = (file, env = {}) => {
    const child = spawn(process.execPath, [path.join(root, file)], {
      cwd: root, env: { ...process.env, PORT: String(port), ...env },
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    })
    processes.push(child)
    let output = ''
    child.stdout.on('data', (data) => { output += data })
    child.stderr.on('data', (data) => { output += data })
    child.once('error', (error) => { output += error.stack })
    child.diagnostics = () => output
    return child
  }
  return {
    root, port, read, starts, health,
    startServer: (service = 'market-dashboard') => spawnFixture('server.mjs', { TEST_SERVICE: service }),
    startSupervisor: () => { supervisor = spawnFixture('runner.mjs', { TEST_SERVICE: '' }); return supervisor },
  }
}

test('supervisor restarts its service after the real server process is killed', { timeout: 20000 }, async (t) => {
  const fixture = await sandbox(t)
  const supervisor = fixture.startSupervisor()
  const initial = await eventually(async () => {
    const health = await fixture.health()
    return health?.service === 'market-dashboard' && health
  }, 'Supervisor did not start the fixture service')
  process.kill(initial.pid)
  const recovered = await eventually(async () => {
    const health = await fixture.health()
    return health?.service === 'market-dashboard' && health.pid !== initial.pid && health
  }, 'Supervisor did not replace the killed service')
  assert.notEqual(recovered.pid, initial.pid)
  assert.equal(supervisor.exitCode, null, supervisor.diagnostics())
  assert.equal((await fixture.starts()).length, 2)
  assert.match(await fixture.read('startup.log'), new RegExp(`Dashboard PID ${initial.pid} exited:`))
  assert.equal(Number(await fixture.read('server.pid')), recovered.pid)
})

test('supervisor leaves an existing healthy dashboard running and takes over after it exits', { timeout: 20000 }, async (t) => {
  const fixture = await sandbox(t)
  const existing = fixture.startServer()
  await eventually(async () => (await fixture.health())?.pid === existing.pid, 'Existing fixture did not become healthy')
  const supervisor = fixture.startSupervisor()
  await eventually(async () => (await fixture.read('startup.log')).includes('monitoring without starting a duplicate'), 'Supervisor did not recognize the existing service')
  await delay(250)
  assert.equal((await fixture.health()).pid, existing.pid)
  assert.equal((await fixture.starts()).length, 1)
  assert.equal(await fixture.read('server.pid'), '', 'Supervisor must not claim the existing service as its child')
  await terminate(existing)
  const recovered = await eventually(async () => {
    const health = await fixture.health()
    return health?.service === 'market-dashboard' && health.pid !== existing.pid && health
  }, 'Supervisor did not take over after the existing service exited')
  assert.equal((await fixture.starts()).length, 2)
  assert.equal(Number(await fixture.read('server.pid')), recovered.pid)
  assert.equal(supervisor.exitCode, null, supervisor.diagnostics())
})

test('supervisor does not start a dashboard or kill an unrelated port owner', { timeout: 20000 }, async (t) => {
  const fixture = await sandbox(t)
  const unrelated = fixture.startServer('another-service')
  await eventually(async () => (await fixture.health())?.pid === unrelated.pid, 'Unrelated fixture did not become healthy')
  const supervisor = fixture.startSupervisor()
  await eventually(async () => (await fixture.read('startup.log')).includes('leaving the port owner running'), 'Supervisor did not recognize the occupied port')
  await delay(250)
  assert.deepEqual(await fixture.health(), { ok: true, service: 'another-service', pid: unrelated.pid })
  assert.equal((await fixture.starts()).length, 1)
  assert.equal(await fixture.read('server.pid'), '')
  assert.equal(unrelated.exitCode, null)
  assert.equal(supervisor.exitCode, null, supervisor.diagnostics())
})
