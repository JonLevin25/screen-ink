// Development only: `npm run dev` runs the app under scripts/dev.mjs, which rebuilds on each change and asks the app
// here, over Node's IPC channel, what it is busy with, to reload some of its windows, or to save what it shows and
// quit so a new build can start with it. A packaged app, or one started without the runner, never does any of this.
import { app, BrowserWindow } from 'electron'
import fs from 'node:fs'
import type http from 'node:http'
import * as ask from './ask'
import * as canvas from './canvas'
import { answering } from './mcp'
import * as overlay from './overlay'
import * as voice from './voice'

/** Bumped whenever what is saved across a restart changes shape, so a new build ignores an old one. */
const STATE_VERSION = 1

type Saved = {
  version: number
  canvas: Awaited<ReturnType<typeof canvas.saved>>
  overlay: Awaited<ReturnType<typeof overlay.shown>>
}

type Request = { id: number; do: 'busy' } | { id: number; do: 'reload'; windows: string[] } | { id: number; do: 'save' }

// The page each window loads, by the name the runner uses for it.
const PAGES: Record<string, string> = { overlay: 'index.html', ask: 'ask.html', settings: 'settings.html' }

const send = (m: object) => process.send?.(m)

/** What would be lost or interrupted by a reload now. */
async function busy(): Promise<string[]> {
  return [
    ...ask.busy(),
    ...(answering() ? ['an agent is calling a tool'] : []),
    ...(voice.speaking() ? ['it is speaking'] : []),
    ...((await overlay.drawing()) ? ['a drawing is still being drawn'] : []),
  ]
}

/** Reloads the windows named; each page puts back what it showed. */
async function reload(names: string[]): Promise<void> {
  const pages = new Set(names.map(n => PAGES[n]).filter(Boolean))
  await Promise.all(
    BrowserWindow.getAllWindows()
      .filter(w => !w.isDestroyed() && pages.has(new URL(w.webContents.getURL() || 'file:///').pathname.split('/').pop()!))
      .map(w => {
        const done = new Promise<void>(r => w.webContents.once('did-finish-load', () => r()))
        w.webContents.reloadIgnoringCache()
        return done
      }),
  )
}

async function save(file: string): Promise<void> {
  const saved: Saved = { version: STATE_VERSION, canvas: await canvas.saved(), overlay: await overlay.shown() }
  fs.writeFileSync(file, JSON.stringify(saved), { mode: 0o600 })
}

async function restore(file: string): Promise<void> {
  let saved: Saved
  try {
    saved = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return
  } finally {
    fs.rmSync(file, { force: true })
  }
  if (saved.version !== STATE_VERSION) return console.log('screen-ink dev: the saved state is from an older build, so it starts empty.')
  if (saved.canvas) canvas.restore(saved.canvas)
  if (saved.overlay) await overlay.reshow(saved.overlay).catch(e => console.error(`screen-ink dev: couldn't redraw: ${e.message}`))
}

/** Answers the runner, if there is one. Call once the app is ready, with the MCP server. */
export async function start(server: http.Server): Promise<void> {
  const file = process.env.SCREEN_INK_DEV_STATE
  if (app.isPackaged || !process.env.SCREEN_INK_DEV || !process.send || !file) return
  process.on('message', async (m: Request) => {
    try {
      if (m.do === 'busy') return send({ id: m.id, reasons: await busy() })
      if (m.do === 'reload') {
        await reload(m.windows)
        return send({ id: m.id })
      }
      if (m.do === 'save') {
        await save(file)
        send({ id: m.id })
        setTimeout(() => app.exit(0), 50) // after the reply is out
      }
    } catch (e) {
      send({ id: m.id, error: (e as Error).message })
    }
  })
  await restore(file)
  if (server.listening) send({ event: 'ready' })
  else server.once('listening', () => send({ event: 'ready' }))
}
