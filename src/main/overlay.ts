// The overlay: one transparent, click-through window that sits over a whole display, above everything.
import { app, BrowserWindow, clipboard, ipcMain, screen, shell, type Display } from 'electron'
import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { speaksCaption, words } from '../shared/caption'
import type { DrawPayload } from '../shared/marks'
import * as handoff from './handoff'
import * as lessons from './lessons'
import * as sense from './sense'
import * as settings from './settings'
import * as voice from './voice'

const FIRST_WORDS_WAIT_MS = 1500 // the most a drawing waits for its first words to be ready

let win: BrowserWindow | null = null
let loaded: Promise<void> = Promise.resolve()

function overlayWindow(): BrowserWindow {
  if (win && !win.isDestroyed()) return win
  win = new BrowserWindow({
    ...(process.platform === 'darwin' ? { type: 'panel' } : {}), // floats over full-screen apps without taking focus
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    fullscreenable: false,
    enableLargerThanScreen: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      autoplayPolicy: 'no-user-gesture-required', // the pen's sounds start without a click
    },
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  // Clicks go through to the apps below, but moves still reach the page, so it can take the mouse while it is over
  // a figure's card (to turn it or ask about a part) and let it go again after.
  win.setIgnoreMouseEvents(true, { forward: true })
  // Keep our own ink out of screenshots where macOS honours it; capture also hides the window (see hiddenWhile).
  win.setContentProtection(true)
  loaded = win.loadFile(path.join(__dirname, 'renderer', 'index.html'))
  return win
}

ipcMain.on('ink:pointer', (e, over: unknown) => {
  if (win && !win.isDestroyed() && e.sender === win.webContents) win.setIgnoreMouseEvents(over !== true, { forward: true })
})

/** The overlay page, to check who is talking. */
export const page = () => (win && !win.isDestroyed() ? win.webContents : null)

export const captionsOn = () => settings.get().captions
export const setCaptions = (value: boolean) => settings.set({ captions: value })
export const soundsOn = () => settings.get().sounds
export const setSounds = (value: boolean) => settings.set({ sounds: value })

// The page asks for each mark's words as it draws; the answer comes once they are said. Meanwhile it is told when
// they start and how long they take, to caption them.
ipcMain.handle('ink:speak', (e, text: unknown) => {
  if (!win || win.isDestroyed() || e.sender !== win.webContents || typeof text !== 'string') return
  const page = win.webContents
  return voice.speak(text, seconds => captionsOn() && !page.isDestroyed() && page.send('ink:saying', { text, seconds }))
})

// Going back over a drawing: the page stops the words being said, has the lines from there rendered ahead, and says
// which line it is on, for whoever lists the lines (onLines).
ipcMain.on('ink:hush', e => e.sender === page() && voice.stop())
ipcMain.on('ink:prepare', (e, lines: unknown) => {
  if (e.sender !== page() || !Array.isArray(lines)) return
  const texts = lines.filter((l): l is string => typeof l === 'string' && l.length <= 2000).slice(0, 100)
  if (texts.length) void voice.prepare(texts)
})
let lineListeners: ((lines: string[], current: number) => void)[] = []
/** Calls `fn` with the spoken lines of the drawing on screen as each starts, and which one it is. */
export const onLines = (fn: (lines: string[], current: number) => void) => void lineListeners.push(fn)
ipcMain.on('ink:lines', (e, lines: unknown, current: unknown) => {
  if (e.sender !== page() || !Array.isArray(lines) || typeof current !== 'number') return
  const texts = lines.map(l => (typeof l === 'string' ? l : ''))
  for (const fn of lineListeners) fn(texts, current)
})

/** Plays the drawing on screen, or the last one if it has gone, again from spoken line `line`. */
export function replay(line = 0): void {
  if (!win || win.isDestroyed()) return
  win.showInactive()
  win.webContents.send('ink:replay', line)
}

// A figure saved as a 3D model goes in Downloads, shown in Finder.
ipcMain.handle('ink:save', async (e, name: unknown, usdz: unknown) => {
  if (e.sender !== page() || typeof name !== 'string' || !(usdz instanceof Uint8Array) || usdz.length > 64e6) return null
  const base = name.replace(/[^\p{L}\p{N} ._-]+/gu, ' ').trim().slice(0, 60) || 'figure'
  const dir = app.getPath('downloads')
  let file = path.join(dir, `${base}.usdz`)
  for (let i = 2; existsSync(file); i++) file = path.join(dir, `${base} ${i}.usdz`)
  await writeFile(file, usdz)
  shell.showItemInFolder(file)
  return file
})

// A button the user clicked on a card: copy its text, open its link, type its text into the app in front (the
// overlay never takes focus, so that is still the app they were in), or hand its task to Claude Code. Only links to
// web pages and System Settings open, and text with line breaks is copied rather than typed, so a button can't press
// Return for anyone.
const OPENABLE = /^(https:\/\/|x-apple\.systempreferences:)/
let walking: ((start: boolean) => boolean) | null = null
/** Who takes a walkthrough's "Do it for me" and "Stop" buttons. */
export const onWalk = (fn: (start: boolean) => boolean) => void (walking = fn)
ipcMain.handle('ink:act', async (e, what: unknown, value: unknown, folder: unknown): Promise<'done' | 'copied' | null> => {
  if (e.sender !== page() || typeof value !== 'string' || value.length > 2000) return null
  if (what === 'walk') return walking?.(value !== 'stop') ? 'done' : null
  if (what === 'agent') return (await handoff.start(value, typeof folder === 'string' ? folder : undefined)) ? 'done' : null
  if (what === 'copy' || (what === 'type' && /[\r\n]/.test(value))) {
    clipboard.writeText(value)
    return what === 'copy' ? 'done' : 'copied'
  }
  if (what === 'open') {
    if (!OPENABLE.test(value)) return null
    return shell.openExternal(value).then(() => 'done' as const, () => null)
  }
  if (what === 'type') return (await sense.type(value)) ? 'done' : null
  return null
})

/** The display the overlay is drawing on, if it is showing. */
export function showing(): Display | null {
  if (!win || win.isDestroyed() || !win.isVisible()) return null
  const b = win.getBounds()
  return screen.getAllDisplays().find(d => d.bounds.x === b.x && d.bounds.y === b.y && d.bounds.width === b.width) ?? null
}

/** Puts the overlay over `display`, showing. */
function moveTo(w: BrowserWindow, display: Display): void {
  const b = display.bounds
  const cur = w.getBounds()
  if (cur.x !== b.x || cur.y !== b.y || cur.width !== b.width || cur.height !== b.height) {
    // A drawing on another display can't carry over: start fresh there.
    if (w.isVisible()) w.webContents.send('ink:clear', { instant: true })
    w.setBounds(b)
  }
  w.showInactive()
}

/** Moves the overlay over `display` and draws. */
export async function draw(display: Display, payload: DrawPayload): Promise<void> {
  const w = overlayWindow()
  lessons.track(display, payload)
  if (!payload.append) {
    voice.stop()
    voice.forget()
  }
  // Render the words ahead, and start once the first are ready.
  const lines = [...payload.marks.flatMap(words), ...(speaksCaption(payload) ? [payload.caption!] : [])]
  const first = voice.prepare(lines)
  await Promise.all([loaded, Promise.race([first, new Promise(r => setTimeout(r, FIRST_WORDS_WAIT_MS))])])
  const b = display.bounds
  moveTo(w, display)
  // screen-ink's pointer starts from the user's mouse, when it is on this display.
  const m = screen.getCursorScreenPoint()
  const inside = m.x >= b.x && m.x < b.x + b.width && m.y >= b.y && m.y < b.y + b.height
  const mouse = !payload.append && inside ? ([m.x - b.x, m.y - b.y] as [number, number]) : undefined
  w.webContents.send('ink:draw', { sounds: soundsOn(), cursor: settings.get().cursor, mouse, ...payload })
}

// screen-ink's pointer moving to a spot, or pressing there, and the page saying it has.
let lastPoint = 0
const pointed = new Map<number, () => void>()
ipcMain.on('ink:pointed', (e, id: unknown) => {
  if (e.sender !== page() || typeof id !== 'number') return
  pointed.get(id)?.()
  pointed.delete(id)
})

/**
 * Moves screen-ink's pointer to `at` (points on the display the overlay is on), and shows a press there named
 * `label`, or a scroll. Resolves once it has, or straight away when the pointer is off or nothing is showing.
 */
export function point(at: [number, number], show: { press?: boolean; label?: string; scroll?: string } = {}): Promise<void> {
  const p = page()
  if (!p || !win?.isVisible() || !settings.get().cursor) return Promise.resolve()
  const id = ++lastPoint
  return new Promise(resolve => {
    const done = () => {
      clearTimeout(timer)
      pointed.delete(id)
      resolve()
    }
    const timer = setTimeout(done, 2500)
    pointed.set(id, done)
    p.send('ink:point', { id, at, ...show })
  })
}

export function clear(instant = false): void {
  voice.stop()
  voice.forget()
  if (win && !win.isDestroyed()) win.webContents.send('ink:clear', { instant })
}

// What the overlay shows, as the page keeps it to draw again after a reload (renderer.ts), so development reloads
// and restarts (dev.ts) leave the drawing in place.
const SHOWN = 'ink:shown'

/** The drawing on screen and its display, or null when there is none. */
export async function shown(): Promise<{ displayId: number; drawing: string } | null> {
  const d = showing()
  if (!d || !win) return null
  const drawing: unknown = await win.webContents.executeJavaScript(`sessionStorage.getItem(${JSON.stringify(SHOWN)})`).catch(() => null)
  return typeof drawing === 'string' ? { displayId: d.id, drawing } : null
}

/** Draws again what `shown` gave, after a restart, without its words or animation. */
export async function reshow(s: { displayId: number; drawing: string }): Promise<void> {
  const display = screen.getAllDisplays().find(d => d.id === s.displayId)
  if (!display) return
  const w = overlayWindow()
  await loaded
  for (const p of JSON.parse(s.drawing).payloads as DrawPayload[]) lessons.track(display, p)
  const reloaded = new Promise<void>(r => w.webContents.once('did-finish-load', () => r()))
  await w.webContents.executeJavaScript(`sessionStorage.setItem(${JSON.stringify(SHOWN)}, ${JSON.stringify(s.drawing)}); location.reload()`)
  await reloaded
  moveTo(w, display)
}

/** Whether the page is still drawing. */
export async function drawing(): Promise<boolean> {
  if (!win || win.isDestroyed() || !win.isVisible()) return false
  return win.webContents.executeJavaScript('window.inkBusy?.() ?? false').catch(() => false)
}

/** Runs `fn` with the overlay invisible, so a screenshot shows the screen and not our marks. */
export async function hiddenWhile<T>(fn: () => Promise<T>): Promise<T> {
  if (!win || win.isDestroyed() || !win.isVisible()) return fn()
  win.setOpacity(0)
  await new Promise(r => setTimeout(r, 60))
  try {
    return await fn()
  } finally {
    win.setOpacity(1)
  }
}
