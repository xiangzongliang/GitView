// Minimal ANSI escape-sequence parser for coloring terminal output.
// Handles SGR sequences (colors + text styles); every other CSI/escape
// sequence is stripped. Incomplete trailing escapes are kept as literal text.
// 256-color / truecolor values are mapped to the nearest of the 16 named
// colors so the renderer only needs named CSS classes.

export type AnsiColor =
  | 'black'
  | 'red'
  | 'green'
  | 'yellow'
  | 'blue'
  | 'magenta'
  | 'cyan'
  | 'white'
  | 'bright-black'
  | 'bright-red'
  | 'bright-green'
  | 'bright-yellow'
  | 'bright-blue'
  | 'bright-magenta'
  | 'bright-cyan'
  | 'bright-white'

export interface AnsiSeg {
  text: string
  fg?: AnsiColor
  bg?: AnsiColor
  bold?: boolean
  dim?: boolean
  italic?: boolean
  underline?: boolean
}

interface SgrState {
  fg?: AnsiColor
  bg?: AnsiColor
  bold?: boolean
  dim?: boolean
  italic?: boolean
  underline?: boolean
}

// xterm's default 16-color palette, used for nearest-color matching.
const PALETTE: Record<AnsiColor, [number, number, number]> = {
  black: [0, 0, 0],
  red: [205, 0, 0],
  green: [0, 205, 0],
  yellow: [205, 205, 0],
  blue: [0, 0, 238],
  magenta: [205, 0, 205],
  cyan: [0, 205, 205],
  white: [229, 229, 229],
  'bright-black': [127, 127, 127],
  'bright-red': [255, 0, 0],
  'bright-green': [0, 255, 0],
  'bright-yellow': [255, 255, 0],
  'bright-blue': [92, 92, 255],
  'bright-magenta': [255, 0, 255],
  'bright-cyan': [0, 255, 255],
  'bright-white': [255, 255, 255],
}

const NAMED: AnsiColor[] = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
]

const NAMED_BRIGHT: AnsiColor[] = NAMED.map((c) => ('bright-' + c) as AnsiColor)

const CUBE_LEVELS = [0, 95, 135, 175, 215, 255]

function nearestNamed(r: number, g: number, b: number): AnsiColor {
  let best: AnsiColor = 'white'
  let bestD = Infinity
  for (const name of Object.keys(PALETTE) as AnsiColor[]) {
    const p = PALETTE[name]
    const dr = r - p[0]
    const dg = g - p[1]
    const db = b - p[2]
    const d = dr * dr + dg * dg + db * db
    if (d < bestD) {
      bestD = d
      best = name
    }
  }
  return best
}

/** Map an xterm 256-color index to the nearest named color. */
function color256(n: number): AnsiColor {
  n = Math.max(0, Math.min(255, n))
  if (n < 8) return NAMED[n]
  if (n < 16) return NAMED_BRIGHT[n - 8]
  if (n < 232) {
    const i = n - 16
    return nearestNamed(
      CUBE_LEVELS[Math.floor(i / 36)],
      CUBE_LEVELS[Math.floor((i % 36) / 6)],
      CUBE_LEVELS[i % 6]
    )
  }
  const v = Math.round(((n - 232) / 23) * 255)
  return nearestNamed(v, v, v)
}

function applySgr(params: string, st: SgrState): void {
  if (params === '') params = '0'
  const codes: number[] = []
  for (const p of params.split(';')) {
    const n = parseInt(p, 10)
    codes.push(Number.isFinite(n) ? n : 0)
  }

  let k = 0
  while (k < codes.length) {
    const c = codes[k]
    if (c === 0) {
      st.fg = undefined
      st.bg = undefined
      st.bold = false
      st.dim = false
      st.italic = false
      st.underline = false
    } else if (c === 1) st.bold = true
    else if (c === 2) st.dim = true
    else if (c === 3) st.italic = true
    else if (c === 4) st.underline = true
    else if (c === 22) { st.bold = false; st.dim = false }
    else if (c === 23) st.italic = false
    else if (c === 24) st.underline = false
    else if (c >= 30 && c <= 37) st.fg = NAMED[c - 30]
    else if (c === 39) st.fg = undefined
    else if (c >= 40 && c <= 47) st.bg = NAMED[c - 40]
    else if (c === 49) st.bg = undefined
    else if (c >= 90 && c <= 97) st.fg = NAMED_BRIGHT[c - 90]
    else if (c >= 100 && c <= 107) st.bg = NAMED_BRIGHT[c - 100]
    else if (c === 38 || c === 48) {
      // extended color: 38;5;n (256) or 38;2;r;g;b (truecolor)
      const mode = codes[k + 1]
      if (mode === 5 && k + 2 < codes.length) {
        const col = color256(codes[k + 2])
        if (c === 38) st.fg = col
        else st.bg = col
        k += 2
      } else if (mode === 2 && k + 4 < codes.length) {
        const col = nearestNamed(codes[k + 2], codes[k + 3], codes[k + 4])
        if (c === 38) st.fg = col
        else st.bg = col
        k += 4
      } else {
        break // malformed; stop consuming
      }
    }
    k++
  }
}

/**
 * Parse text containing ANSI escape sequences into per-line segments.
 * SGR state carries across lines; unknown/incomplete escapes are either
 * dropped or (when truncated at the end) emitted as literal text.
 */
export function parseAnsi(text: string): AnsiSeg[][] {
  const rows: AnsiSeg[][] = []
  let cur: AnsiSeg[] = []
  let buf = ''
  const st: SgrState = {}

  const flush = () => {
    if (buf) {
      cur.push({ text: buf, ...st })
      buf = ''
    }
  }
  const newline = () => {
    flush()
    rows.push(cur)
    cur = []
  }

  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (ch === '\x1b') {
      if (text[i + 1] === '[') {
        // CSI: consume parameter/intermediate bytes, then a final byte
        let j = i + 2
        while (j < text.length && text.charCodeAt(j) >= 0x20 && text.charCodeAt(j) <= 0x3f) j++
        if (j >= text.length || text.charCodeAt(j) < 0x40 || text.charCodeAt(j) > 0x7e) {
          buf += text.slice(i) // incomplete escape → literal text
          i = text.length
          break
        }
        const params = text.slice(i + 2, j)
        if (text[j] === 'm') applySgr(params, st)
        i = j + 1
      } else if (text[i + 1] === ']') {
        // OSC: consume up to BEL or ST (ESC \)
        let end = -1
        for (let j = i + 2; j < text.length; j++) {
          if (text[j] === '\x07') {
            end = j
            break
          }
          if (text[j] === '\x1b' && text[j + 1] === '\\') {
            end = j + 1
            break
          }
        }
        if (end < 0) {
          buf += text.slice(i) // incomplete → literal text
          i = text.length
          break
        }
        i = end + 1
      } else if (text[i + 1] === '(' || text[i + 1] === ')' || text[i + 1] === '#') {
        i += 3 // charset designation, e.g. ESC ( B
      } else if (i + 1 >= text.length) {
        buf += ch // lone trailing ESC → literal text
        i++
      } else {
        i += 2 // two-char escape (e.g. ESC =), dropped
      }
    } else if (ch === '\n') {
      newline()
      i++
    } else {
      if (ch !== '\r') buf += ch
      i++
    }
  }
  flush()
  rows.push(cur)
  return rows
}
