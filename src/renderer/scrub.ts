// The scrub bar under an explanation: go back a line, pause, go on a line, or click or drag along the track (one
// segment per spoken line) to hear part of it again. Dragging shows the drawing as it stood at each line, silently,
// and lets go into playing from there. Once the drawing has faded, the bar shrinks to a Replay button for a while.

export interface ScrubHooks {
  /** Rebuilds the drawing as it stands at `line`, then plays it from there unless `play` is false. */
  seek(line: number, play: boolean): void
  /** Pauses, or plays on from the line it paused in. */
  toggle(): void
}

const REPLAY_FOR_MS = 20_000 // how long the Replay button stays once the drawing has gone
const WORDS_PER_SECOND = 2.9 // a guess at the line's length until the voice says how long it is

const ICONS = {
  prev: '<svg viewBox="0 0 16 16"><path d="M4 3v10M13 3.5v9L6 8z"/></svg>',
  next: '<svg viewBox="0 0 16 16"><path d="M12 3v10M3 3.5v9L10 8z"/></svg>',
  play: '<svg viewBox="0 0 16 16"><path d="M4.5 2.5v11L13.5 8z"/></svg>',
  pause: '<svg viewBox="0 0 16 16"><path d="M4.5 3v10M11.5 3v10"/></svg>',
  again: '<svg viewBox="0 0 16 16"><path d="M3.2 8.5a5 5 0 1 0 1.6-4.1M4.5 1.8v3h3" fill="none"/></svg>',
}

const bar = document.getElementById('scrub') as HTMLDivElement
const prev = button('prev', 'Previous line')
const play = button('play', 'Pause')
const next = button('next', 'Next line')
const track = document.createElement('div')
track.className = 'scrub-track'
const tip = document.createElement('div')
tip.className = 'scrub-tip'
bar.append(prev, play, next, track, tip)

let hooks: ScrubHooks | null = null
let lines: string[] = []
let current = -1
let segments: HTMLElement[] = []
let dragging = -1
let hovered = false
let goneTimer = 0

function button(act: keyof typeof ICONS, title: string): HTMLButtonElement {
  const b = document.createElement('button')
  b.className = `scrub-${act}`
  b.title = title
  b.innerHTML = ICONS[act]
  return b
}

export function init(h: ScrubHooks): void {
  hooks = h
}

/** Whether the mouse is on the bar or dragging it, so the window keeps taking clicks. */
export const holding = () => hovered || dragging >= 0

/** The lines of the drawing on screen. A drawing with nothing said hides the bar. */
export function setLines(texts: string[]): void {
  clearTimeout(goneTimer)
  bar.classList.remove('gone')
  const same = texts.length === lines.length && texts.every((t, i) => t === lines[i])
  lines = texts
  if (!same) {
    segments = texts.map((text, i) => {
      const s = document.createElement('i')
      s.style.flexGrow = String(Math.max(3, text.split(/\s+/).filter(Boolean).length))
      s.dataset.line = String(i)
      s.append(document.createElement('b'))
      return s
    })
    track.replaceChildren(...segments)
  }
  bar.classList.toggle('show', texts.some(Boolean))
  mark()
}

/** The line now being said. */
export function setLine(n: number): void {
  if (n === current) return
  current = n
  mark()
  const text = lines[n]
  if (text) fill(text.split(/\s+/).length / WORDS_PER_SECOND)
}

/** The voice has started the current line and will take `seconds`. */
export function saying(text: string, seconds: number): void {
  if (lines[current] === text) fill(seconds)
}

/** Whether the explanation is playing, paused, or done. */
export function setState(state: 'playing' | 'paused' | 'done'): void {
  bar.dataset.state = state
  const [icon, title] = state === 'playing' ? (['pause', 'Pause'] as const) : state === 'paused' ? (['play', 'Play'] as const) : (['again', 'Play again'] as const)
  play.innerHTML = ICONS[icon]
  play.title = title
  const now = segments[current]?.querySelector('b')
  if (now) now.style.animationPlayState = state === 'playing' ? 'running' : 'paused'
  if (state === 'done') segments.forEach(s => s.classList.add('past'))
}

/** The drawing has gone: keep a Replay button up for a while. */
export function gone(canReplay: boolean): void {
  clearTimeout(goneTimer)
  if (!canReplay || !bar.classList.contains('show')) return bar.classList.remove('show')
  bar.classList.add('gone')
  play.innerHTML = `${ICONS.again}<span>Replay</span>`
  play.title = 'Play it again'
  goneTimer = window.setTimeout(() => {
    if (hovered) return
    bar.classList.remove('show', 'gone')
  }, REPLAY_FOR_MS)
}

function mark(): void {
  segments.forEach((s, i) => {
    s.classList.toggle('past', i < current)
    s.classList.toggle('now', i === current)
  })
}

/** Fills the current line's segment over `seconds`. */
function fill(seconds: number): void {
  const b = segments[current]?.querySelector('b')
  if (!b) return
  b.style.animation = 'none'
  void b.offsetWidth // restart it
  b.style.animation = `scrub-fill ${seconds}s linear forwards`
}

function lineAt(x: number): number {
  for (const s of segments) {
    const r = s.getBoundingClientRect()
    if (x < r.right + 1) return Number(s.dataset.line)
  }
  return segments.length - 1
}

function showTip(n: number, x: number): void {
  const text = lines[n]
  if (!text) return tip.classList.remove('show')
  tip.textContent = text
  const r = bar.getBoundingClientRect()
  tip.style.left = `${Math.min(Math.max(x - r.left, 120), r.width - 120)}px`
  tip.classList.add('show')
}

prev.addEventListener('click', () => hooks?.seek(Math.max(0, current - 1), true))
next.addEventListener('click', () => current < lines.length - 1 && hooks?.seek(current + 1, true))
play.addEventListener('click', () => {
  if (bar.classList.contains('gone') || bar.dataset.state === 'done') hooks?.seek(0, true)
  else hooks?.toggle()
})

track.addEventListener('pointerdown', e => {
  track.setPointerCapture(e.pointerId)
  dragging = lineAt(e.clientX)
  bar.classList.add('dragging')
  hooks?.seek(dragging, false)
  showTip(dragging, e.clientX)
})
track.addEventListener('pointermove', e => {
  const n = lineAt(e.clientX)
  showTip(n, e.clientX)
  if (dragging < 0 || n === dragging) return
  dragging = n
  hooks?.seek(n, false)
})
const release = () => {
  if (dragging < 0) return
  const n = dragging
  dragging = -1
  bar.classList.remove('dragging')
  hooks?.seek(n, true)
}
track.addEventListener('pointerup', release)
track.addEventListener('pointercancel', release)
track.addEventListener('pointerleave', () => dragging < 0 && tip.classList.remove('show'))
bar.addEventListener('pointerenter', () => (hovered = true))
bar.addEventListener('pointerleave', () => {
  hovered = false
  if (bar.classList.contains('gone')) gone(true)
})
