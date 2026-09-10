// Pure grid helpers — no Svelte state in here, just data in / data out.

export const EMPTY = ' '

export function makeGrid(cols, rows, fill = EMPTY) {
  return Array.from({ length: rows }, () => Array.from({ length: cols }, () => fill))
}

export function cloneGrid(grid) {
  return grid.map((row) => row.slice())
}

/** Bounding box of the non-blank cells, or null when the grid is empty. */
export function contentBounds(grid) {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (let y = 0; y < grid.length; y++) {
    for (let x = 0; x < grid[y].length; x++) {
      if (grid[y][x] === EMPTY) continue
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }
  return maxX === -Infinity ? null : { minX, minY, maxX, maxY }
}

// A character cell is about twice as tall as it is wide, so rotation has to happen in
// "visual" space or a quarter turn would squash the art instead of turning it.
const CELL_ASPECT = 2

// Glyphs that point somewhere, and what they become after a 90° clockwise turn.
const ROT_90 = { '─': '│', '│': '─', '-': '|', '|': '-', '┌': '┐', '┐': '┘', '┘': '└', '└': '┌', '├': '┬', '┬': '┤', '┤': '┴', '┴': '├', '═': '║', '║': '═', '╔': '╗', '╗': '╝', '╝': '╚', '╚': '╔', '╠': '╦', '╦': '╣', '╣': '╩', '╩': '╠', '╭': '╮', '╮': '╯', '╯': '╰', '╰': '╭', '▀': '▐', '▐': '▄', '▄': '▌', '▌': '▀', '▘': '▝', '▝': '▗', '▗': '▖', '▖': '▘', '▛': '▜', '▜': '▟', '▟': '▙', '▙': '▛', '▚': '▞', '▞': '▚', '/': '\\', '\\': '/', '←': '↑', '↑': '→', '→': '↓', '↓': '←', '↖': '↗', '↗': '↘', '↘': '↙', '↙': '↖', '◀': '▲', '▲': '▶', '▶': '▼', '▼': '◀' }

/** Turn a glyph `n` quarter-turns clockwise. */
function rotateGlyph(ch, n) {
  let out = ch
  for (let i = 0; i < n; i++) out = ROT_90[out] ?? out
  return out
}

/**
 * Exact 90° clockwise turn, done by index rather than trigonometry.
 *
 * Because a cell is 2:1, a quarter turn is not symmetric: every source row becomes two
 * destination columns, and every two source columns collapse into one destination row. Running
 * this through the general resampler instead leaves the compressed edge dotted, which is very
 * visible on something as ordinary as rotating a box.
 */
function rotateQuarter(grid, direction) {
  const rows = grid.length
  const cols = grid[0]?.length ?? 0
  const bounds = contentBounds(grid)
  if (!bounds) return cloneGrid(grid)

  const width = bounds.maxX - bounds.minX + 1
  const height = bounds.maxY - bounds.minY + 1
  const newWidth = height * 2
  const newHeight = Math.ceil(width / 2)
  const originX = Math.round((bounds.minX + bounds.maxX) / 2 - newWidth / 2)
  const originY = Math.round((bounds.minY + bounds.maxY) / 2 - newHeight / 2)
  const turned = direction > 0 ? 1 : 3

  const out = makeGrid(cols, rows)
  // Two source cells can compress onto one destination cell. The one whose exact position is
  // nearest that cell wins, which keeps corners: a corner sits exactly on its target, while
  // the edge cell beside it only rounds there.
  const error = Array.from({ length: rows }, () => new Float64Array(cols).fill(Infinity))

  for (let sy = bounds.minY; sy <= bounds.maxY; sy++) {
    for (let sx = bounds.minX; sx <= bounds.maxX; sx++) {
      const ch = grid[sy][sx]
      if (ch === EMPTY) continue
      const row = sy - bounds.minY
      const col = sx - bounds.minX
      // Distribute the compressed axis proportionally rather than by integer division, so the
      // first and last source cells land on the first and last destination ones.
      const along = direction > 0 ? col : width - 1 - col
      const exact = width === 1 ? 0 : (along / (width - 1)) * (newHeight - 1)
      const dy = originY + Math.round(exact)
      const distance = Math.abs(exact - Math.round(exact))
      const base = originX + (direction > 0 ? height - 1 - row : row) * 2
      for (const step of [0, 1]) {
        const dx = base + step
        if (dx < 0 || dx >= cols || dy < 0 || dy >= rows) continue
        if (distance >= error[dy][dx]) continue
        error[dy][dx] = distance
        out[dy][dx] = rotateGlyph(ch, turned)
      }
    }
  }
  return out
}

/** Exact half turn. No aspect correction needed, since both axes simply reverse. */
function rotateHalf(grid) {
  const rows = grid.length
  const cols = grid[0]?.length ?? 0
  const bounds = contentBounds(grid)
  if (!bounds) return cloneGrid(grid)
  const out = makeGrid(cols, rows)
  for (let y = bounds.minY; y <= bounds.maxY; y++) {
    for (let x = bounds.minX; x <= bounds.maxX; x++) {
      const ch = grid[y][x]
      if (ch === EMPTY) continue
      out[bounds.minY + bounds.maxY - y][bounds.minX + bounds.maxX - x] = rotateGlyph(ch, 2)
    }
  }
  return out
}

/**
 * Skew, rotate and add perspective to a grid, in one resampling pass.
 *
 * Every destination cell is mapped *back* to a source cell rather than pushing sources
 * forward — forward mapping tears holes through the result as soon as a transform stretches
 * anything. Doing all three at once also avoids the quality loss of resampling three times.
 *
 * - `skewX` / `skewY`: cells of shear per row (or column) away from the centre.
 * - `rotate`: degrees clockwise, corrected for the 1:2 cell aspect so it looks like a real turn.
 * - `perspX` / `perspY`: keystone taper, −1…1. Positive `perspX` widens the bottom and narrows
 *   the top, as though the art were leaning away from you.
 *
 * The pivot is the centre of the inked content, so art doesn't wander as you adjust.
 */
export function transformGrid(source, { skewX = 0, skewY = 0, rotate = 0, perspX = 0, perspY = 0 } = {}) {
  const rows = source.length
  const cols = source[0]?.length ?? 0
  if (!skewX && !skewY && !rotate && !perspX && !perspY) return cloneGrid(source)

  // Take whole quarter turns out of the angle first and do them exactly; the resampler below
  // then only ever handles the leftover tilt.
  const quarter = Math.round(rotate / 90)
  const turns = Math.abs(rotate - quarter * 90) < 4 ? ((quarter % 4) + 4) % 4 : 0
  // Each case is done in one exact step; chaining quarter turns would compound their rounding.
  let grid = source
  if (turns === 1) grid = rotateQuarter(source, 1)
  else if (turns === 2) grid = rotateHalf(source)
  else if (turns === 3) grid = rotateQuarter(source, -1)
  rotate -= turns * 90
  if (!skewX && !skewY && !rotate && !perspX && !perspY) return grid === source ? cloneGrid(source) : grid

  const bounds = contentBounds(grid)
  if (!bounds) return cloneGrid(grid)

  const pivotX = (bounds.minX + bounds.maxX) / 2
  const pivotY = (bounds.minY + bounds.maxY) / 2
  const halfW = Math.max(1, (bounds.maxX - bounds.minX) / 2)
  const halfH = Math.max(1, (bounds.maxY - bounds.minY) / 2)

  const radians = (rotate * Math.PI) / 180
  const cos = Math.cos(radians)
  const sin = Math.sin(radians)
  const determinant = 1 - skewX * skewY

  /** Map a destination point back to the glyph under it, or EMPTY. */
  function sample(dx, dy) {
    let x = dx - pivotX
    let y = dy - pivotY

    if (rotate) {
      const vx = x
      const vy = y * CELL_ASPECT
      x = vx * cos + vy * sin
      y = (-vx * sin + vy * cos) / CELL_ASPECT
    }
    if (perspX) {
      const scale = 1 + perspX * (y / halfH)
      if (Math.abs(scale) < 0.05) return EMPTY
      x /= scale
    }
    if (perspY) {
      const scale = 1 + perspY * (x / halfW)
      if (Math.abs(scale) < 0.05) return EMPTY
      y /= scale
    }
    if (skewX || skewY) {
      if (Math.abs(determinant) < 1e-6) return EMPTY
      const ux = (x - skewX * y) / determinant
      const uy = (y - skewY * x) / determinant
      x = ux
      y = uy
    }

    const sx = Math.round(pivotX + x)
    const sy = Math.round(pivotY + y)
    if (sx < 0 || sx >= cols || sy < 0 || sy >= rows) return EMPTY
    return grid[sy][sx]
  }

  /** Where a source cell lands. Mirrors `sample` exactly, in the opposite direction. */
  function project(sx, sy) {
    let x = sx - pivotX
    let y = sy - pivotY

    if (skewX || skewY) {
      const nx = x + skewX * y
      const ny = y + skewY * x
      x = nx
      y = ny
    }
    if (perspY) y *= 1 + perspY * (x / halfW)
    if (perspX) x *= 1 + perspX * (y / halfH)
    if (rotate) {
      const vx = x
      const vy = y * CELL_ASPECT
      x = vx * cos - vy * sin
      y = (vx * sin + vy * cos) / CELL_ASPECT
    }
    return [Math.round(pivotX + x), Math.round(pivotY + y)]
  }

  const out = makeGrid(cols, rows)

  // Pass 1 — inverse: every destination cell asks what's under it. Gives clean, single-width
  // edges, but silently drops strokes wherever the transform compresses an axis (rotation
  // always does, since cells are 2:1).
  for (let dy = 0; dy < rows; dy++) {
    for (let dx = 0; dx < cols; dx++) {
      const ch = sample(dx, dy)
      if (ch !== EMPTY) out[dy][dx] = ch
    }
  }

  // Pass 2 — forward: every source cell claims its destination, but only if pass 1 left it
  // blank. That guarantees nothing is lost without thickening what pass 1 already drew.
  for (let sy = 0; sy < rows; sy++) {
    for (let sx = 0; sx < cols; sx++) {
      const ch = grid[sy][sx]
      if (ch === EMPTY) continue
      const [dx, dy] = project(sx, sy)
      if (dx < 0 || dx >= cols || dy < 0 || dy >= rows) continue
      if (out[dy][dx] !== EMPTY) continue
      out[dy][dx] = ch
    }
  }
  return out
}

// Glyphs that point somewhere, and what they become when mirrored.
const FLIP_H = { '/': '\\', '\\': '/', '<': '>', '>': '<', '(': ')', ')': '(', '[': ']', ']': '[', '{': '}', '}': '{', '┌': '┐', '┐': '┌', '└': '┘', '┘': '└', '├': '┤', '┤': '├', '╔': '╗', '╗': '╔', '╚': '╝', '╝': '╚', '╠': '╣', '╣': '╠', '╭': '╮', '╮': '╭', '╰': '╯', '╯': '╰', '▌': '▐', '▐': '▌', '▖': '▗', '▗': '▖', '▘': '▝', '▝': '▘', '▙': '▟', '▟': '▙', '▛': '▜', '▜': '▛', '▚': '▞', '▞': '▚', '◀': '▶', '▶': '◀', '←': '→', '→': '←', '↖': '↗', '↗': '↖', '↙': '↘', '↘': '↙' }
const FLIP_V = { '/': '\\', '\\': '/', '┌': '└', '└': '┌', '┐': '┘', '┘': '┐', '┬': '┴', '┴': '┬', '╔': '╚', '╚': '╔', '╗': '╝', '╝': '╗', '╦': '╩', '╩': '╦', '╭': '╰', '╰': '╭', '╮': '╯', '╯': '╮', '▀': '▄', '▄': '▀', '▖': '▘', '▘': '▖', '▗': '▝', '▝': '▗', '▙': '▛', '▛': '▙', '▟': '▜', '▜': '▟', '▚': '▞', '▞': '▚', '▲': '▼', '▼': '▲', '↑': '↓', '↓': '↑', '↖': '↙', '↙': '↖', '↗': '↘', '↘': '↗', "'": ',', ',': "'" }

/**
 * Mirror a grid across its content's centre. Directional glyphs are swapped for their
 * mirrored counterpart, so a mirrored box frame still has corners that point the right way.
 */
export function flipGrid(grid, axis) {
  const rows = grid.length
  const cols = grid[0]?.length ?? 0
  const bounds = contentBounds(grid)
  if (!bounds) return cloneGrid(grid)
  const map = axis === 'h' ? FLIP_H : FLIP_V
  const out = makeGrid(cols, rows)
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const ch = grid[y][x]
      if (ch === EMPTY) continue
      const nx = axis === 'h' ? bounds.minX + bounds.maxX - x : x
      const ny = axis === 'v' ? bounds.minY + bounds.maxY - y : y
      if (nx >= 0 && nx < cols && ny >= 0 && ny < rows) out[ny][nx] = map[ch] ?? ch
    }
  }
  return out
}

export function gridToText(grid, { trim = true } = {}) {
  const lines = grid.map((row) => (trim ? row.join('').replace(/\s+$/, '') : row.join('')))
  if (!trim) return lines.join('\n')
  while (lines.length && lines[lines.length - 1] === '') lines.pop()
  return lines.join('\n')
}

/** Bresenham line, returned as [x, y] cells. */
export function linePoints(x0, y0, x1, y1) {
  const points = []
  const dx = Math.abs(x1 - x0)
  const dy = Math.abs(y1 - y0)
  const sx = x0 < x1 ? 1 : -1
  const sy = y0 < y1 ? 1 : -1
  let err = dx - dy
  let x = x0
  let y = y0
  for (;;) {
    points.push([x, y])
    if (x === x1 && y === y1) break
    const e2 = 2 * err
    if (e2 > -dy) {
      err -= dy
      x += sx
    }
    if (e2 < dx) {
      err += dx
      y += sy
    }
  }
  return points
}

/**
 * Square brush of `size` cells centred on (x, y).
 * Even sizes can't be perfectly centred, so they extend right/down.
 */
export function brushPoints(x, y, size) {
  if (size <= 1) return [[x, y]]
  const offset = Math.floor((size - 1) / 2)
  const points = []
  for (let dy = 0; dy < size; dy++) {
    for (let dx = 0; dx < size; dx++) {
      points.push([x - offset + dx, y - offset + dy])
    }
  }
  return points
}

/** Stamp a brush along every cell of a stroke path, without repeating cells. */
export function strokePoints(path, size) {
  if (size <= 1) return path
  const seen = new Set()
  const out = []
  for (const [px, py] of path) {
    for (const [x, y] of brushPoints(px, py, size)) {
      const key = `${x},${y}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push([x, y])
    }
  }
  return out
}

export function rectPoints(x0, y0, x1, y1, filled) {
  const points = []
  const left = Math.min(x0, x1)
  const right = Math.max(x0, x1)
  const top = Math.min(y0, y1)
  const bottom = Math.max(y0, y1)
  for (let y = top; y <= bottom; y++) {
    for (let x = left; x <= right; x++) {
      const edge = x === left || x === right || y === top || y === bottom
      if (filled || edge) points.push([x, y])
    }
  }
  return points
}

/**
 * Cells of the ellipse inscribed in the box (x0, y0)–(x1, y1), inclusive. Outline cells are
 * the inside cells with an outside neighbour, which keeps the ring one cell thick on the flat
 * runs and 8-connected on the curves, like any rasterised circle.
 */
export function ellipsePoints(x0, y0, x1, y1, filled) {
  const left = Math.min(x0, x1)
  const right = Math.max(x0, x1)
  const top = Math.min(y0, y1)
  const bottom = Math.max(y0, y1)
  const cx = (left + right) / 2
  const cy = (top + bottom) / 2
  // Half a cell of slack so the edge cells count as inside and a 1×1 drag still draws.
  const rx = (right - left) / 2 + 0.5
  const ry = (bottom - top) / 2 + 0.5
  const inside = (x, y) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1
  const points = []
  for (let y = top; y <= bottom; y++) {
    for (let x = left; x <= right; x++) {
      if (!inside(x, y)) continue
      const edge =
        !inside(x - 1, y) || !inside(x + 1, y) || !inside(x, y - 1) || !inside(x, y + 1)
      if (filled || edge) points.push([x, y])
    }
  }
  return points
}

/**
 * Cells of a closed polygon through integer `vertices`: the outline is one line per edge,
 * and filling adds every cell whose centre a scanline finds inside (even-odd rule).
 */
export function polygonPoints(vertices, filled) {
  const cells = new Map()
  const add = ([x, y]) => cells.set(`${x},${y}`, [x, y])
  const n = vertices.length
  for (let i = 0; i < n; i++) {
    const [ax, ay] = vertices[i]
    const [bx, by] = vertices[(i + 1) % n]
    linePoints(ax, ay, bx, by).forEach(add)
  }
  if (filled) {
    const ys = vertices.map(([, y]) => y)
    for (let y = Math.min(...ys); y <= Math.max(...ys); y++) {
      const xs = []
      for (let i = 0; i < n; i++) {
        const [ax, ay] = vertices[i]
        const [bx, by] = vertices[(i + 1) % n]
        // Half-open in y, so a vertex shared by two edges is crossed exactly once.
        if ((ay <= y && by > y) || (by <= y && ay > y)) {
          xs.push(ax + ((y - ay) / (by - ay)) * (bx - ax))
        }
      }
      xs.sort((a, b) => a - b)
      for (let i = 0; i + 1 < xs.length; i += 2) {
        for (let x = Math.ceil(xs[i]); x <= Math.floor(xs[i + 1]); x++) add([x, y])
      }
    }
  }
  return [...cells.values()]
}

/** Corners of an isosceles triangle filling the box, pointing `direction`: up, down, left or right. */
export function triangleVertices(x0, y0, x1, y1, direction = 'up') {
  const left = Math.min(x0, x1)
  const right = Math.max(x0, x1)
  const top = Math.min(y0, y1)
  const bottom = Math.max(y0, y1)
  const cx = Math.round((left + right) / 2)
  const cy = Math.round((top + bottom) / 2)
  switch (direction) {
    case 'down':
      return [[left, top], [right, top], [cx, bottom]]
    case 'left':
      return [[left, cy], [right, top], [right, bottom]]
    case 'right':
      return [[left, top], [right, cy], [left, bottom]]
    default:
      return [[cx, top], [right, bottom], [left, bottom]]
  }
}

/** Corners of a diamond filling the box: one vertex on the middle of each side. */
export function diamondVertices(x0, y0, x1, y1) {
  const left = Math.min(x0, x1)
  const right = Math.max(x0, x1)
  const top = Math.min(y0, y1)
  const bottom = Math.max(y0, y1)
  const cx = Math.round((left + right) / 2)
  const cy = Math.round((top + bottom) / 2)
  return [[cx, top], [right, cy], [cx, bottom], [left, cy]]
}

const BOX = {
  ascii: { h: '-', v: '|', tl: '+', tr: '+', bl: '+', br: '+' },
  single: { h: '─', v: '│', tl: '┌', tr: '┐', bl: '└', br: '┘' },
  double: { h: '═', v: '║', tl: '╔', tr: '╗', bl: '╚', br: '╝' },
  round: { h: '─', v: '│', tl: '╭', tr: '╮', bl: '╰', br: '╯' },
}

export const BOX_STYLES = Object.keys(BOX)

/**
 * Turn a click-to-click polyline into connected line glyphs.
 *
 * Each segment is rasterised on its own, so its direction is known exactly rather than inferred
 * from a wobbling pointer: `─` along a horizontal run, `│` down a vertical one, `/` and `\` on
 * slopes. Bresenham only ever steps sideways, down, or diagonally, so a shallow slope comes out
 * as a run of `─` with `/` at each step — the way ASCII slopes are drawn by hand.
 *
 * Vertices are then resolved against the segments either side of them, which is where the
 * corner glyphs come from.
 */
export function polylineGlyphs(vertices, style = 'single') {
  const box = BOX[style] ?? BOX.single
  const diagonal = (dx, dy) => (dx * dy < 0 ? '/' : '\\')
  const points = vertices.filter(
    (point, i) => i === 0 || point[0] !== vertices[i - 1][0] || point[1] !== vertices[i - 1][1],
  )
  if (!points.length) return []
  if (points.length === 1) return [[points[0][0], points[0][1], box.h]]

  const glyphFor = (dx, dy) => (dx && dy ? diagonal(dx, dy) : dx ? box.h : box.v)
  const side = (dx, dy) => (dx ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'down' : 'up')
  const corners = {
    'right,down': box.tl, 'down,right': box.tl,
    'left,down': box.tr, 'down,left': box.tr,
    'right,up': box.bl, 'up,right': box.bl,
    'left,up': box.br, 'up,left': box.br,
  }

  const cells = new Map() // "x,y" -> [x, y, char]; later segments win where they overlap
  const put = (x, y, ch) => cells.set(`${x},${y}`, [x, y, ch])

  // Each cell takes the glyph of the step that arrives at it; the first takes the step leaving.
  const segments = []
  for (let i = 0; i < points.length - 1; i++) {
    const [x0, y0] = points[i]
    const [x1, y1] = points[i + 1]
    const run = linePoints(x0, y0, x1, y1)
    segments.push(run)

    // A segment near 45° is drawn entirely with one diagonal. Bresenham gives such a line the
    // odd axis-aligned step, and a lone `─` sitting in a slope reads as a mistake rather than
    // as the shallower gradient it technically is.
    const dx = Math.abs(x1 - x0)
    const dy = Math.abs(y1 - y0)
    const uniform =
      dx && dy && Math.min(dx, dy) / Math.max(dx, dy) >= 0.5
        ? diagonal(Math.sign(x1 - x0), Math.sign(y1 - y0))
        : null

    run.forEach(([x, y], j) => {
      if (uniform) return put(x, y, uniform)
      const [fx, fy] = j === 0 ? run[0] : run[j - 1]
      const [tx, ty] = j === 0 ? run[Math.min(1, run.length - 1)] : run[j]
      put(x, y, glyphFor(Math.sign(tx - fx), Math.sign(ty - fy)))
    })
  }

  // Interior vertices: join the direction arriving with the direction leaving.
  for (let i = 1; i < points.length - 1; i++) {
    const before = segments[i - 1]
    const after = segments[i]
    if (before.length < 2 || after.length < 2) continue
    const [px, py] = before[before.length - 2]
    const [vx, vy] = points[i]
    const [nx, ny] = after[1]
    const into = [Math.sign(vx - px), Math.sign(vy - py)]
    const outOf = [Math.sign(nx - vx), Math.sign(ny - vy)]

    if (into[0] === outOf[0] && into[1] === outOf[1]) continue // straight through
    const intoDiagonal = into[0] && into[1]
    const outDiagonal = outOf[0] && outOf[1]
    if (intoDiagonal && outDiagonal) {
      put(vx, vy, into[0] * into[1] === outOf[0] * outOf[1] ? diagonal(...into) : box.h)
    } else if (intoDiagonal || outDiagonal) {
      // A slope meeting a flat run: the flat glyph carries the join more cleanly.
      const straight = intoDiagonal ? outOf : into
      put(vx, vy, glyphFor(straight[0], straight[1]))
    } else {
      const back = side(-into[0], -into[1])
      put(vx, vy, corners[`${back},${side(outOf[0], outOf[1])}`] ?? box.h)
    }
  }

  return [...cells.values()]
}

/** Box outline as [x, y, char] triples, picking the right corner/edge glyph. */
export function boxCells(x0, y0, x1, y1, style) {
  const b = BOX[style] ?? BOX.single
  const left = Math.min(x0, x1)
  const right = Math.max(x0, x1)
  const top = Math.min(y0, y1)
  const bottom = Math.max(y0, y1)
  const cells = []
  for (let y = top; y <= bottom; y++) {
    for (let x = left; x <= right; x++) {
      let ch = null
      if (x === left && y === top) ch = b.tl
      else if (x === right && y === top) ch = b.tr
      else if (x === left && y === bottom) ch = b.bl
      else if (x === right && y === bottom) ch = b.br
      else if (y === top || y === bottom) ch = b.h
      else if (x === left || x === right) ch = b.v
      if (ch) cells.push([x, y, ch])
    }
  }
  // A 1-wide or 1-tall box degenerates to a line; corners above already cover it.
  return cells
}

/**
 * The connected run of cells containing (x, y), for magic-wand selection.
 * Uses 8-way connectivity so diagonal strokes — common in ASCII art — count as one object.
 * By default any non-blank cell continues the run; with `sameChar`, only cells holding the
 * same character as the starting cell do. Returns [] when the starting cell is blank.
 */
export function objectPoints(grid, x, y, { sameChar = false } = {}) {
  const rows = grid.length
  const cols = grid[0]?.length ?? 0
  if (y < 0 || y >= rows || x < 0 || x >= cols) return []
  const target = grid[y][x]
  if (target === EMPTY) return []
  const matches = (ch) => (sameChar ? ch === target : ch !== EMPTY)
  const seen = new Set()
  const out = []
  const stack = [[x, y]]
  while (stack.length) {
    const [cx, cy] = stack.pop()
    if (cx < 0 || cx >= cols || cy < 0 || cy >= rows) continue
    const key = cy * cols + cx
    if (seen.has(key)) continue
    if (!matches(grid[cy][cx])) continue
    seen.add(key)
    out.push([cx, cy])
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx || dy) stack.push([cx + dx, cy + dy])
      }
    }
  }
  return out
}

/** 4-way flood fill from (x, y), returning the cells to repaint. */
export function floodPoints(grid, x, y) {
  const rows = grid.length
  const cols = grid[0]?.length ?? 0
  if (y < 0 || y >= rows || x < 0 || x >= cols) return []
  const target = grid[y][x]
  const seen = new Set()
  const out = []
  const stack = [[x, y]]
  while (stack.length) {
    const [cx, cy] = stack.pop()
    if (cx < 0 || cx >= cols || cy < 0 || cy >= rows) continue
    const key = cy * cols + cx
    if (seen.has(key)) continue
    if (grid[cy][cx] !== target) continue
    seen.add(key)
    out.push([cx, cy])
    stack.push([cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1])
  }
  return out
}
