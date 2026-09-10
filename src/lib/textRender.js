import { EMPTY, makeGrid } from './ascii.js'

/**
 * A curated slice of Google Fonts. Loaded through the CSS2 endpoint, which needs no API key.
 * Heavy display faces and pixel fonts read best once they're reduced to character cells;
 * hairline scripts tend to disappear, so the list leans towards weight.
 */
export const FONTS = [
  { family: 'Press Start 2P', note: 'pixel' },
  { family: 'Silkscreen', note: 'pixel' },
  { family: 'VT323', note: 'terminal' },
  { family: 'Major Mono Display', note: 'mono' },
  { family: 'JetBrains Mono', note: 'mono' },
  { family: 'Source Code Pro', note: 'mono' },
  { family: 'Anton', note: 'display' },
  { family: 'Bebas Neue', note: 'display' },
  { family: 'Archivo Black', note: 'display' },
  { family: 'Bungee', note: 'display' },
  { family: 'Titan One', note: 'display' },
  { family: 'Alfa Slab One', note: 'display' },
  { family: 'Righteous', note: 'display' },
  { family: 'Rubik Mono One', note: 'display' },
  { family: 'Montserrat', note: 'sans' },
  { family: 'Poppins', note: 'sans' },
  { family: 'Roboto', note: 'sans' },
  { family: 'Oswald', note: 'sans' },
  { family: 'Playfair Display', note: 'serif' },
  { family: 'Merriweather', note: 'serif' },
  { family: 'Lobster', note: 'script' },
  { family: 'Pacifico', note: 'script' },
]

/**
 * What a new text layer starts with. Small sizes blob together as counters close up; 7 cells
 * reads cleanly in every font. Shared with the session store, which fills in anything a saved
 * layer is missing from here.
 */
export const TEXT_DEFAULTS = {
  content: 'HELLO',
  family: 'Anton',
  bold: false,
  size: 7,
  mode: 'quad',
  solidChar: '#',
  threshold: 0.5,
  letterSpacing: 0,
  lineSpacing: 1.25,
  align: 'left',
  x: 2,
  y: 2,
}

// Each character cell is sampled as a 6×12 pixel block. The 1:2 ratio matches how a
// monospace cell is shaped, so text rasterised through it keeps the proportions of the font.
const CELL_PX_W = 6
const CELL_PX_H = 12

const HALF_BLOCKS = [EMPTY, '▀', '▄', '█'] // indexed by (top ? 1 : 0) | (bottom ? 2 : 0)
// Indexed by a bitmask of inked quarters: top-left 1, top-right 2, bottom-left 4, bottom-right 8.
const QUADRANTS = [EMPTY, '▘', '▝', '▀', '▖', '▌', '▞', '▛', '▗', '▚', '▐', '▜', '▄', '▙', '▟', '█']

// Cap height as a fraction of the em, used when the browser can't measure the real thing.
const FALLBACK_CAP_RATIO = 0.7

/**
 * Pixels of em needed for the font's capitals to stand `capPx` tall. Fonts put their caps
 * anywhere from 60% to 90% of the em, so sizing by em would make "7 rows" mean something
 * different in each face.
 */
function emForCapHeight(font, capPx) {
  const probe = 100
  const ctx = document.createElement('canvas').getContext('2d')
  ctx.font = font(probe)
  ctx.textBaseline = 'alphabetic'
  const ascent = ctx.measureText('H').actualBoundingBoxAscent
  const ratio = ascent > 0 ? ascent / probe : FALLBACK_CAP_RATIO
  return capPx / ratio
}

const fontLoads = new Map() // family -> Promise<boolean>

const cssUrl = (family, axis = '') =>
  `https://fonts.googleapis.com/css2?family=${family.replace(/ /g, '+')}${axis}&display=swap`

async function fetchCss(url) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.text()
}

/**
 * Load a Google font so canvas can draw with it, resolving to whether it's actually usable.
 *
 * A `<link>` plus `document.fonts.load()` is not enough: that call resolves as a no-op while
 * the stylesheet is still in flight, so the first render silently falls back to a system font
 * and nothing ever triggers a redraw. Instead the CSS is fetched, every `@font-face` in it is
 * registered as a `FontFace` (Google splits families across unicode-range subsets, and the
 * Latin one is usually last), and the actual font files are awaited.
 *
 * The regular and bold weights are asked for together so Bold uses the real cut. Families
 * without a 700 make the endpoint reject the request, in which case just the regular is
 * fetched and the browser emboldens it itself.
 */
export function loadFont(family) {
  const cached = fontLoads.get(family)
  if (cached) return cached

  const load = (async () => {
    let css
    try {
      css = await fetchCss(cssUrl(family, ':wght@400;700')).catch(() => fetchCss(cssUrl(family)))
    } catch {
      return false // offline or blocked — the caller renders with a system fallback
    }

    const faces = []
    for (const block of css.split('@font-face').slice(1)) {
      const src = block.match(/url\((https:[^)]+)\)/)?.[1]
      if (!src) continue
      const descriptors = {}
      const range = block.match(/unicode-range:\s*([^;}]+)/)?.[1]
      const weight = block.match(/font-weight:\s*([^;}]+)/)?.[1]
      if (range) descriptors.unicodeRange = range.trim()
      if (weight) descriptors.weight = weight.trim()
      try {
        faces.push(new FontFace(family, `url(${src})`, descriptors))
      } catch {
        // A descriptor this browser dislikes; skip that subset rather than failing the family.
      }
    }

    const settled = await Promise.all(faces.map((f) => f.load().catch(() => null)))
    const loaded = settled.filter(Boolean)
    // `document.fonts.check()` answers true for a family it has never heard of, so an empty
    // result has to be treated as a failure explicitly rather than asked about.
    if (!loaded.length) return false
    for (const face of loaded) document.fonts.add(face)
    return document.fonts.check(`64px "${family}"`)
  })()

  fontLoads.set(family, load)
  return load
}

const NOTHING = { grid: [], left: 0, top: 0 }

/**
 * Rasterise text through a font and reduce it to character cells.
 *
 * Returns `{ grid, left, top }`: `grid` holds just the inked cells, cropped tight, and
 * `left`/`top` say where that crop sits relative to the text's anchor, in cells. The anchor is
 * the typographic one — the pen origin of the first line horizontally, and its cap line
 * vertically — so editing the words, or swapping a descender in or out, doesn't shift the
 * block around. Ascenders and accents can poke above the anchor, which is why `top` can be
 * negative.
 */
export function renderText({
  content = '',
  family = 'Anton',
  bold = false,
  size = 6,
  mode = 'half',
  ramp = ['░', '▒', '▓', '█'],
  solidChar = '#',
  threshold = 0.35,
  letterSpacing = 0,
  lineSpacing = 1.25,
  align = 'left',
}) {
  const lines = content.split('\n')
  if (!lines.some((l) => l.trim())) return NOTHING

  // `size` is the cap height in rows, so the same number reads the same in every font.
  const fontFor = (px) => `${bold ? 'bold ' : ''}${px}px "${family}", sans-serif`
  const fontPx = Math.max(4, Math.round(emForCapHeight(fontFor, size * CELL_PX_H)))
  const font = fontFor(fontPx)
  const trackingPx = letterSpacing * CELL_PX_W

  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  // Canvas grew a native letterSpacing; where it's missing, glyphs are placed one by one.
  const nativeTracking = 'letterSpacing' in ctx
  // Resizing a canvas resets its context, so this is applied again after the size is known.
  const setup = () => {
    ctx.font = font
    ctx.textBaseline = 'top'
    if (nativeTracking) ctx.letterSpacing = `${trackingPx}px`
  }
  setup()

  const glyphs = (line) => Array.from(line)
  const lineWidth = (line) => {
    if (nativeTracking || !trackingPx) return ctx.measureText(line).width
    // Placed glyph by glyph, so measured the same way — kerning doesn't apply.
    return glyphs(line).reduce((w, ch) => w + ctx.measureText(ch).width + trackingPx, -trackingPx)
  }
  const widths = lines.map(lineWidth)
  const blockW = Math.max(1, ...widths)

  // Room for glyphs that overhang their advance box (swashes, italics) so they aren't clipped.
  // The left pad is a whole number of cells so the anchor column stays exact.
  const padX = Math.ceil(fontPx / 3 / CELL_PX_W) * CELL_PX_W
  const padY = Math.ceil(fontPx / 4)
  const stepPx = Math.round(fontPx * lineSpacing)

  canvas.width = Math.ceil((blockW + padX * 2) / CELL_PX_W) * CELL_PX_W
  canvas.height =
    Math.ceil((padY * 2 + stepPx * (lines.length - 1) + fontPx * 1.5) / CELL_PX_H) * CELL_PX_H
  setup()
  ctx.fillStyle = '#fff'

  // With the baseline at 'top', the ascent of a capital comes back negative: it's how far the
  // cap line sits below the top of the em box.
  const capAscent = ctx.measureText('H').actualBoundingBoxAscent ?? 0
  const capTopPx = padY - capAscent

  const alignFactor = align === 'center' ? 0.5 : align === 'right' ? 1 : 0
  lines.forEach((line, i) => {
    const x0 = padX + (blockW - widths[i]) * alignFactor
    const y = padY + i * stepPx
    if (nativeTracking || !trackingPx) {
      ctx.fillText(line, x0, y)
      return
    }
    let x = x0
    for (const ch of glyphs(line)) {
      ctx.fillText(ch, x, y)
      x += ctx.measureText(ch).width + trackingPx
    }
  })

  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height)
  const cellCols = canvas.width / CELL_PX_W
  const cellRows = canvas.height / CELL_PX_H

  /** Mean alpha over part of a cell, 0…1. Rows and columns are in pixels within the cell. */
  const coverage = (cx, cy, fromRow, toRow, fromCol = 0, toCol = CELL_PX_W) => {
    let sum = 0
    let count = 0
    for (let py = cy * CELL_PX_H + fromRow; py < cy * CELL_PX_H + toRow; py++) {
      for (let px = cx * CELL_PX_W + fromCol; px < cx * CELL_PX_W + toCol; px++) {
        sum += data[(py * canvas.width + px) * 4 + 3]
        count++
      }
    }
    return count ? sum / count / 255 : 0
  }
  const inked = (...args) => coverage(...args) >= threshold

  const halfH = CELL_PX_H / 2
  const halfW = CELL_PX_W / 2
  const raw = []
  for (let cy = 0; cy < cellRows; cy++) {
    for (let cx = 0; cx < cellCols; cx++) {
      let ch = EMPTY
      if (mode === 'half') {
        const top = inked(cx, cy, 0, halfH)
        const bottom = inked(cx, cy, halfH, CELL_PX_H)
        ch = HALF_BLOCKS[(top ? 1 : 0) | (bottom ? 2 : 0)]
      } else if (mode === 'quad') {
        // Two samples across as well as down, so verticals land as precisely as horizontals.
        const mask =
          (inked(cx, cy, 0, halfH, 0, halfW) ? 1 : 0) |
          (inked(cx, cy, 0, halfH, halfW, CELL_PX_W) ? 2 : 0) |
          (inked(cx, cy, halfH, CELL_PX_H, 0, halfW) ? 4 : 0) |
          (inked(cx, cy, halfH, CELL_PX_H, halfW, CELL_PX_W) ? 8 : 0)
        ch = QUADRANTS[mask]
      } else {
        const c = coverage(cx, cy, 0, CELL_PX_H)
        if (c >= threshold) {
          if (mode === 'solid') ch = solidChar
          else {
            // Spread the remaining coverage across the ramp so faint edges stay light.
            const t = (c - threshold) / (1 - threshold)
            ch = ramp[Math.min(ramp.length - 1, Math.floor(t * ramp.length))]
          }
        }
      }
      if (ch !== EMPTY) raw.push([cx, cy, ch])
    }
  }
  if (!raw.length) return NOTHING

  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const [x, y] of raw) {
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  const grid = makeGrid(maxX - minX + 1, maxY - minY + 1)
  for (const [x, y, ch] of raw) grid[y - minY][x - minX] = ch

  const anchorCol = padX / CELL_PX_W
  const anchorRow = Math.round(capTopPx / CELL_PX_H)
  return { grid, left: minX - anchorCol, top: minY - anchorRow }
}
