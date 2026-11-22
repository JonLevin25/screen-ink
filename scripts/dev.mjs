// Hot reload for development.
//
//   npm run dev                  builds, runs the app, and applies each change as you save
//   npm run dev -- --no-watch    the same, but changes wait for `npm run reload`
//   npm run reload               builds and applies the changes now, and says what it did
//   npm run reload -- --force    applies them even if they break connected sessions or interrupt the user
//
// A change to a page reloads only that window, and the page draws again what it showed. A change to the main process
// restarts the app, which saves what it shows and the last screenshot first and picks them up again. Connected agents
// keep working through a restart, since the MCP server is stateless and keeps its port and token. Changes wait until
// screen-ink isn't answering, drawing, speaking or serving a tool call. A change that would break connected sessions
// (an MCP tool removed or its parameters changed, the port moved, a setting's type changed) is held back until
// `--force`.
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
process.chdir(root)
const SOCKET = path.join(root, 'dist', 'dev.sock')
const STATE = path.join(root, 'dist', 'dev', 'state.json')
const DEBOUNCE_MS = 300
const BUSY_RETRY_MS = 2000
const READY_MS = 60_000

// Each build output, and what has to happen when it changes.
const OUTPUTS = {
  'main.js': 'main',
  'screen-ink-sense': 'main',
  'preload.js': 'overlay',
  'renderer/renderer.js': 'overlay',
  'renderer/index.html': 'overlay',
  'ask-preload.js': 'ask',
  'renderer/ask.js': 'ask',
  'renderer/ask.html': 'ask',
  'settings-preload.js': 'settings',
  'renderer/settings.js': 'settings',
  'renderer/settings.html': 'settings',
}
const WINDOW_NAMES = { overlay: 'the overlay', ask: 'the ask bar', settings: 'Settings' }

const log = (...a) => console.log('[dev]', ...a)
const args = process.argv.slice(2)

if (args[0] === 'reload') await reloadCommand()
else await runner()

// ---- npm run reload: ask the runner

async function reloadCommand() {
  const force = args.includes('--force')
  const sock = net.connect(SOCKET)
  sock.on('error', () => {
    console.error("screen-ink isn't running under `npm run dev`, so there is nothing to reload. Start it with `npm run dev`.")
    process.exit(1)
  })
  sock.write(JSON.stringify({ force }) + '\n')
  let buf = ''
  sock.on('data', d => (buf += d))
  sock.on('end', () => {
    const result = JSON.parse(buf)
    console.log(describe(result))
    process.exit({ held: 2, busy: 3, failed: 1 }[result.status] ?? 0)
  })
}

/** A result as a person (or an agent) reads it. */
function describe(r) {
  const notes = r.notes?.length ? `\n${r.notes.map(n => `  note: ${n}`).join('\n')}` : ''
  switch (r.status) {
    case 'up-to-date':
      return 'Up to date: the running app has every change.'
    case 'reloaded':
      return `Reloaded ${list(r.windows.map(w => WINDOW_NAMES[w]))}. Each page drew back what it showed.${notes}`
    case 'restarted':
      return `Restarted the app with the new main process. The drawing and the last screenshot carried over, and connected sessions keep working.${notes}`
    case 'started':
      return `Started the app.${notes}`
    case 'held':
      return (
        `Not reloaded: this change can break the Claude Code sessions connected to screen-ink, or the user's saved data:\n` +
        `${r.breaking.map(b => `  - ${b}`).join('\n')}${notes}\n` +
        'Ask the user before applying it with `npm run reload -- --force`.'
      )
    case 'busy':
      return `Not reloaded yet: ${list(r.reasons)}. Try again once it's done, or \`npm run reload -- --force\` to interrupt.`
    default:
      return `Failed: ${r.message}`
  }
}

const list = xs => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`)

// ---- npm run dev: build, run, apply

async function runner() {
  if (await listening()) {
    console.error('screen-ink is already running under `npm run dev`. Use `npm run reload` to apply changes.')
    process.exit(1)
  }
  const { buildAll } = await import('../build.mjs')
  const electron = (await import('electron')).default
  fs.mkdirSync(path.dirname(STATE), { recursive: true })
  fs.rmSync(STATE, { force: true })

  let child = null
  let restarting = false
  let applied = null // the build the app runs: { hashes, contract }
  let lastId = 0
  const replies = new Map()
  let ready = null

  function startApp() {
    const c = (child = spawn(electron, ['.'], {
      stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
      env: { ...process.env, SCREEN_INK_DEV: '1', SCREEN_INK_DEV_STATE: STATE },
    }))
    ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("the app didn't start in time")), READY_MS)
      c.on('message', m => {
        if (m.event === 'ready') {
          clearTimeout(timer)
          resolve()
        }
        if (m.id && replies.has(m.id)) {
          replies.get(m.id)(m)
          replies.delete(m.id)
        }
      })
      c.on('exit', code => {
        clearTimeout(timer)
        reject(new Error(`the app quit (${code})`))
      })
    })
    ready.catch(() => {})
    c.on('exit', code => {
      if (child !== c) return
      child = null
      for (const done of replies.values()) done({ error: 'the app quit' })
      replies.clear()
      if (restarting) return
      if (code === 0) {
        log('screen-ink quit.')
        cleanup()
        process.exit(0)
      }
      log(`screen-ink stopped (${code}). Save a change or run \`npm run reload\` to start it again.`)
    })
    return ready
  }

  function ask(msg) {
    if (!child) return Promise.resolve({ error: 'the app is not running' })
    const id = ++lastId
    return new Promise(resolve => {
      replies.set(id, resolve)
      child.send({ id, ...msg })
    })
  }

  async function restart() {
    restarting = true
    try {
      const c = child
      if (c) {
        const gone = new Promise(r => c.once('exit', r))
        await ask({ do: 'save' })
        await Promise.race([gone, new Promise(r => setTimeout(r, 5000))])
        if (c.exitCode === null) {
          c.kill()
          await gone
        }
      }
      await startApp()
    } finally {
      restarting = false
    }
  }

  /** Builds, and applies what changed if it is safe now (or `force`). */
  async function apply({ force = false } = {}) {
    try {
      await buildAll({ logLevel: 'warning' })
    } catch (e) {
      return { status: 'failed', message: `the build failed: ${e.message}` }
    }
    const hashes = hashOutputs()
    if (!child) {
      fs.rmSync(STATE, { force: true })
      try {
        applied = { hashes, contract: await readContract() }
        await startApp()
        return { status: 'started' }
      } catch (e) {
        return { status: 'failed', message: e.message }
      }
    }
    const kinds = new Set(Object.keys(OUTPUTS).filter(f => hashes[f] !== applied.hashes[f]).map(f => OUTPUTS[f]))
    if (!kinds.size) return { status: 'up-to-date' }

    let contract = applied.contract
    let breaking = []
    let notes = []
    if (kinds.has('main')) {
      try {
        contract = await readContract()
        ;({ breaking, notes } = compare(applied.contract, contract))
      } catch (e) {
        contract = null
        breaking = [`couldn't read the new build's MCP tools to check them (${e.message.split('\n')[0]})`]
      }
    }
    if (breaking.length && !force) return { status: 'held', breaking, notes }
    if (!force) {
      const { reasons = [] } = await ask({ do: 'busy' })
      if (reasons.length) return { status: 'busy', reasons }
    }
    try {
      if (kinds.has('main')) await restart()
      else {
        const r = await ask({ do: 'reload', windows: [...kinds] })
        if (r.error) throw new Error(r.error)
      }
    } catch (e) {
      return { status: 'failed', message: e.message }
    }
    applied = { hashes, contract }
    return kinds.has('main') ? { status: 'restarted', notes } : { status: 'reloaded', windows: [...kinds], notes }
  }

  // One build and apply at a time.
  let queue = Promise.resolve()
  const run = fn => (queue = queue.then(fn, fn))

  // ---- start

  log('building…')
  const first = await run(() => apply())
  if (first.status !== 'started') {
    console.error(describe(first))
    process.exit(1)
  }
  log('screen-ink is running. Changes are applied as you save; `npm run reload` applies them now and says what it did.')

  // ---- npm run reload talks to us here

  fs.rmSync(SOCKET, { force: true })
  const server = net.createServer(sock => {
    let buf = ''
    sock.on('data', d => {
      buf += d
      if (!buf.includes('\n')) return
      const { force } = JSON.parse(buf)
      void run(async () => {
        const result = await apply({ force })
        log(describe(result))
        sock.end(JSON.stringify(result))
      })
    })
    sock.on('error', () => {})
  })
  server.listen(SOCKET)

  // ---- watching

  if (!args.includes('--no-watch')) {
    let timer = null
    let waiting = false
    const changed = () => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        if (waiting) return
        waiting = true
        void run(async () => {
          waiting = false
          const result = await apply()
          if (result.status === 'busy') setTimeout(changed, BUSY_RETRY_MS) // it goes in once screen-ink is free
          if (result.status !== 'up-to-date' && result.status !== 'busy') log(describe(result))
        })
      }, DEBOUNCE_MS)
    }
    for (const dir of ['src', 'native']) fs.watch(dir, { recursive: true }, changed)
  }

  function cleanup() {
    server.close()
    fs.rmSync(SOCKET, { force: true })
  }
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      cleanup()
      child?.kill()
      process.exit(0)
    })
  }
}

function listening() {
  return new Promise(resolve => {
    const s = net.connect(SOCKET)
    s.on('connect', () => {
      s.destroy()
      resolve(true)
    })
    s.on('error', () => resolve(false))
  })
}

function hashOutputs() {
  return Object.fromEntries(
    Object.keys(OUTPUTS).map(f => {
      try {
        return [f, createHash('sha1').update(fs.readFileSync(path.join('dist', f))).digest('hex')]
      } catch {
        return [f, '']
      }
    }),
  )
}

// ---- the contract other programs rely on (src/main/contract.ts)

async function readContract() {
  const { build } = await import('esbuild')
  const out = path.join('dist', 'dev', 'contract.cjs')
  await build({ entryPoints: ['src/main/contract.ts'], outfile: out, bundle: true, platform: 'node', format: 'cjs', target: 'es2022', packages: 'external', logLevel: 'warning' })
  const json = await new Promise((resolve, reject) =>
    execFile(process.execPath, ['-r', './scripts/stub.cjs', out], { maxBuffer: 16 << 20 }, (err, stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve(stdout))),
  )
  return JSON.parse(json)
}

/** A schema without its descriptions: they change what an agent reads, not what a call must look like. */
function shape(schema) {
  if (Array.isArray(schema)) return schema.map(shape)
  if (!schema || typeof schema !== 'object') return schema
  return Object.fromEntries(
    Object.entries(schema)
      .filter(([k]) => k !== 'description' && k !== 'title')
      // Under properties the keys are parameter names, which matter whatever they are called.
      .map(([k, v]) => [k, k === 'properties' && v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([p, s]) => [p, shape(s)])) : shape(v)]),
  )
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

/** What changes between two contracts: what breaks connected sessions or saved data, and what is only worth knowing. */
function compare(before, after) {
  const breaking = []
  const notes = []
  if (!before) return { breaking: ["the running build's MCP tools couldn't be read, so this change can't be checked"], notes }
  if (before.port !== after.port) breaking.push(`the MCP port moves from ${before.port} to ${after.port}: every connected session loses screen-ink`)
  const old = new Map(before.tools.map(t => [t.name, t]))
  const now = new Map(after.tools.map(t => [t.name, t]))
  for (const name of old.keys()) if (!now.has(name)) breaking.push(`the ${name} tool is removed`)
  for (const [name, t] of now) {
    const o = old.get(name)
    if (!o) {
      notes.push(`new tool ${name}: connected sessions see it once they reconnect (/mcp)`)
      continue
    }
    const a = shape(o.inputSchema)
    const b = shape(t.inputSchema)
    if (same(a, b)) {
      if (!same(o, t)) notes.push(`${name}'s descriptions change: connected sessions keep the old ones until they reconnect`)
      continue
    }
    const pa = a.properties ?? {}
    const pb = b.properties ?? {}
    const ra = new Set(a.required ?? [])
    const rb = new Set(b.required ?? [])
    const count = breaking.length
    for (const p of Object.keys(pa)) {
      if (!(p in pb)) breaking.push(`${name} loses its ${p} parameter`)
      else if (!same(pa[p], pb[p])) breaking.push(`${name}'s ${p} parameter changes what it accepts`)
      else if (!ra.has(p) && rb.has(p)) breaking.push(`${name}'s ${p} parameter becomes required`)
    }
    for (const p of Object.keys(pb)) {
      if (p in pa) continue
      if (rb.has(p)) breaking.push(`${name} needs a new ${p} parameter`)
      else notes.push(`${name} takes a new optional ${p} parameter: connected sessions see it once they reconnect (/mcp)`)
    }
    const rest = s => ({ ...s, properties: undefined, required: undefined })
    if (breaking.length === count && !same(rest(a), rest(b))) breaking.push(`${name}'s input schema changes`)
  }
  if (before.instructions !== after.instructions) notes.push("the server's instructions change: connected sessions keep the old ones until they reconnect")
  for (const [key, type] of Object.entries(after.settings)) {
    if (key in before.settings && before.settings[key] !== type) breaking.push(`the ${key} setting changes from a ${before.settings[key]} to a ${type}: the saved value is dropped`)
  }
  for (const key of Object.keys(before.settings)) if (!(key in after.settings)) notes.push(`the ${key} setting is removed`)
  return { breaking, notes }
}
