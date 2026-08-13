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

// Each character cell is sampled as a 6×12 pixel block. The 1:2 ratio matches how a
// monospace cell is shaped, so text rasterised through it keeps the proportions of the font.
const CELL_PX_W = 6
const CELL_PX_H = 12

const HALF_BLOCKS = [EMPTY, '▀', '▄', '█'] // indexed by (top ? 1 : 0) | (bottom ? 2 : 0)

const fontLoads = new Map() // family -> Promise<boolean>

const cssUrl = (family) =>
  `https://fonts.googleapis.com/css2?family=${family.replace(/ /g, '+')}&display=swap`

/**
 * Load a Google font so canvas can draw with it, resolving to whether it's actually usable.
 *
 * A `<link>` plus `document.fonts.load()` is not enough: that call resolves as a no-op while
 * the stylesheet is still in flight, so the first render silently falls back to a system font
 * and nothing ever triggers a redraw. Instead the CSS is fetched, every `@font-face` in it is
 * registered as a `FontFace` (Google splits families across unicode-range subsets, and the
 * Latin one is usually last), and the actual font files are awaited.
 */
export function loadFont(family) {
  const cached = fontLoads.get(family)
  if (cached) return cached

  const load = (async () => {
    let css
    try {
      const response = await fetch(cssUrl(family))
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      css = await response.text()
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
    for (const face of settled) if (face) document.fonts.add(face)
    return document.fonts.check(`64px "${family}"`)
  })()

  fontLoads.set(family, load)
  return load
}

/**
 * Rasterise text through a font and reduce it to character cells.
 *
 * Returns `{ cells, width, height }` where `cells` is a [x, y, char] list positioned from the
 * top-left of the *inked* bounds — the raster is cropped to the glyphs, so the anchor doesn't
 * drift when the font's internal padding changes.
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
}) {
  const lines = content.split('\n')
  if (!lines.some((l) => l.trim())) return { cells: [], width: 0, height: 0 }

  const fontPx = Math.max(4, Math.round(size * CELL_PX_H))
  const font = `${bold ? 'bold ' : ''}${fontPx}px "${family}", sans-serif`

  const measurer = document.createElement('canvas').getContext('2d')
  measurer.font = font
  const trackingPx = letterSpacing * CELL_PX_W
  const lineWidth = (line) => measurer.measureText(line).width + trackingPx * Math.max(0, line.length - 1)

  const stepPx = Math.round(fontPx * lineSpacing)
  const widthPx = Math.ceil(Math.max(1, ...lines.map(lineWidth))) + CELL_PX_W * 2
  const heightPx = stepPx * lines.length + fontPx

  const canvas = document.createElement('canvas')
  canvas.width = Math.ceil(widthPx / CELL_PX_W) * CELL_PX_W
  canvas.height = Math.ceil(heightPx / CELL_PX_H) * CELL_PX_H
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  ctx.font = font
  ctx.textBaseline = 'top'
  ctx.fillStyle = '#fff'

  lines.forEach((line, i) => {
    const y = i * stepPx
    if (!trackingPx) {
      ctx.fillText(line, 0, y)
      return
    }
    // Manual tracking: canvas has no letterSpacing in every browser we care about.
    let x = 0
    for (const ch of line) {
      ctx.fillText(ch, x, y)
      x += ctx.measureText(ch).width + trackingPx
    }
  })

  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height)
  const cellCols = canvas.width / CELL_PX_W
  const cellRows = canvas.height / CELL_PX_H

  /** Mean alpha over a pixel block, 0…1. */
  const coverage = (cx, cy, fromRow, toRow) => {
    let sum = 0
    let count = 0
    for (let py = cy * CELL_PX_H + fromRow; py < cy * CELL_PX_H + toRow; py++) {
      for (let px = cx * CELL_PX_W; px < (cx + 1) * CELL_PX_W; px++) {
        sum += data[(py * canvas.width + px) * 4 + 3]
        count++
      }
    }
    return count ? sum / count / 255 : 0
  }

  const raw = []
  for (let cy = 0; cy < cellRows; cy++) {
    for (let cx = 0; cx < cellCols; cx++) {
      let ch = EMPTY
      if (mode === 'half') {
        const top = coverage(cx, cy, 0, CELL_PX_H / 2) >= threshold
        const bottom = coverage(cx, cy, CELL_PX_H / 2, CELL_PX_H) >= threshold
        ch = HALF_BLOCKS[(top ? 1 : 0) | (bottom ? 2 : 0)]
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
  if (!raw.length) return { cells: [], width: 0, height: 0 }

  // Crop to the inked bounds so (x, y) anchors the visible glyphs, not the font's padding.
  const minX = Math.min(...raw.map((c) => c[0]))
  const minY = Math.min(...raw.map((c) => c[1]))
  const maxX = Math.max(...raw.map((c) => c[0]))
  const maxY = Math.max(...raw.map((c) => c[1]))
  return {
    cells: raw.map(([x, y, ch]) => [x - minX, y - minY, ch]),
    width: maxX - minX + 1,
    height: maxY - minY + 1,
  }
}

/** Render text straight into a full-canvas grid at (x, y). */
export function renderTextGrid(options, cols, rows, x, y) {
  const grid = makeGrid(cols, rows)
  const { cells, width, height } = renderText(options)
  for (const [cx, cy, ch] of cells) {
    const gx = x + cx
    const gy = y + cy
    if (gx >= 0 && gx < cols && gy >= 0 && gy < rows) grid[gy][gx] = ch
  }
  return { grid, width, height }
}
