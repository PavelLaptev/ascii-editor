<script>
  import {
    EMPTY,
    BOX_STYLES,
    boxCells,
    brushPoints,
    cloneGrid,
    contentBounds,
    flipGrid,
    floodPoints,
    gridToText,
    linePoints,
    makeGrid,
    objectPoints,
    rectPoints,
    resizeGrid,
    shiftGrid,
    transformGrid,
    strokePoints,
    textToGrid,
  } from './ascii.js'
  import { FONTS, loadFont, renderTextGrid } from './textRender.js'

  // Grouped so the palette can be scanned by intent rather than by codepoint.
  // Both ramps run light → dark, which is the order you want for gradients.
  const PALETTE_GROUPS = [
    {
      name: 'Blocks & shades',
      chars: [
        ' ', '░', '▒', '▓', '█', // density ramp
        '▀', '▄', '▌', '▐', // halves
        '▘', '▝', '▖', '▗', '▚', '▞', '▛', '▜', '▙', '▟', // quadrants
        '▁', '▂', '▃', '▅', '▆', '▇', // eighths, for bars and soft edges
      ],
    },
    { name: 'ASCII ramp', chars: [' ', '.', ':', '-', '=', '+', '*', '%', '#', '@'] },
    { name: 'Punctuation', chars: ['.', ',', ':', ';', "'", '"', '`', '^', '~', '!', '?'] },
    { name: 'Math & signs', chars: ['+', '-', '_', '=', '*', '/', '\\', '|', '<', '>', '&', '$'] },
    { name: 'Brackets', chars: ['(', ')', '[', ']', '{', '}', '⟨', '⟩'] },
    { name: 'Letters & digits', chars: ['o', 'O', 'x', 'X', 'v', 'V', '0', '8', '1', '7'] },
    { name: 'Shapes', chars: ['■', '□', '▪', '▫', '●', '○', '◆', '◇', '★', '☆', '▲', '▼', '◀', '▶'] },
    { name: 'Arrows', chars: ['←', '→', '↑', '↓', '↔', '↕', '↖', '↗', '↘', '↙'] },
    { name: 'Box — single', chars: ['─', '│', '┌', '┐', '└', '┘', '├', '┤', '┬', '┴', '┼'] },
    { name: 'Box — double', chars: ['═', '║', '╔', '╗', '╚', '╝', '╠', '╣', '╦', '╩', '╬'] },
    { name: 'Box — rounded', chars: ['╭', '╮', '╰', '╯'] },
  ]

  // Pressure ramps, light → dark. No blank at the light end: a feather-light touch should
  // still mark the canvas rather than erase what's under it.
  const RAMPS = {
    ASCII: ['.', ':', '-', '=', '+', '*', '#', '%', '@'],
    Blocks: ['░', '▒', '▓', '█'],
    Dots: ['·', '∙', '•', '●'],
  }

  const TOOLS = [
    { id: 'pencil', label: 'Pencil', hint: 'Draw with the current character (P)' },
    { id: 'brush', label: 'Brush', hint: 'Pressure-sensitive brush for pen tablets (B)' },
    { id: 'eraser', label: 'Eraser', hint: 'Erase to blank (E)' },
    { id: 'line', label: 'Line', hint: 'Drag a straight line (L)' },
    { id: 'rect', label: 'Rect', hint: 'Drag a rectangle of the current character (R)' },
    { id: 'box', label: 'Box', hint: 'Drag a box-drawing frame (O)' },
    { id: 'fill', label: 'Fill', hint: 'Flood fill a region (F)' },
    { id: 'text', label: 'Text', hint: 'Click, then type (T)' },
    { id: 'select', label: 'Select', hint: 'Click an object or drag a box, then drag to move (S)' },
    { id: 'move', label: 'Move', hint: 'Drag anywhere to move the whole layer (V)' },
  ]

  let cols = $state(80)
  let rows = $state(24)

  // Layer stack, bottom-first: index 0 paints first, later layers cover it.
  let layers = $state([{ id: 1, name: 'Layer 1', visible: true, grid: makeGrid(80, 24) }])
  let activeIndex = $state(0)
  let nextLayerId = 2
  let renamingId = $state(null)

  /**
   * The active layer's cells. This is a proxied reference, so every existing
   * `grid[y][x] = ch` write lands on the active layer and re-renders.
   * Whole-grid replacements must assign to `layers[activeIndex].grid` instead.
   */
  const grid = $derived(layers[activeIndex].grid)

  /**
   * Flatten the visible layers, optionally substituting one layer's cells. The override is how
   * in-progress edits preview: they are applied to the active layer and the stack is re-flattened,
   * so lifting content reveals whatever sits underneath it and upper layers still occlude it.
   */
  function flatten(overrideGrid = null) {
    const out = makeGrid(cols, rows)
    layers.forEach((layer, i) => {
      if (!layer.visible) return
      const source = overrideGrid && i === activeIndex ? overrideGrid : layer.grid
      for (let y = 0; y < Math.min(rows, source.length); y++) {
        for (let x = 0; x < Math.min(cols, source[y].length); x++) {
          const ch = source[y][x]
          if (ch !== EMPTY) out[y][x] = ch
        }
      }
    })
    return out
  }

  /** All visible layers flattened top-down — what you see, export, and copy. */
  const composite = $derived.by(() => flatten())

  const activeLayer = $derived(layers[activeIndex])
  const activeText = $derived(activeLayer.text ?? null)

  let fontVersion = $state(0) // bumped when a webfont finishes loading, to force a re-render

  const TRANSFORMS = [
    { key: 'skewX', label: 'Skew X', min: -1.5, max: 1.5, step: 0.05, hint: 'Cells each row slides sideways, per row from the centre' },
    { key: 'skewY', label: 'Skew Y', min: -1.5, max: 1.5, step: 0.05, hint: 'Cells each column slides vertically, per column from the centre' },
    { key: 'rotate', label: 'Rotate', min: -180, max: 180, step: 1, hint: 'Degrees clockwise; 90° steps are exact' },
    { key: 'perspX', label: 'Persp X', min: -0.9, max: 0.9, step: 0.05, hint: 'Keystone: narrows the top, widens the bottom' },
    { key: 'perspY', label: 'Persp Y', min: -0.9, max: 0.9, step: 0.05, hint: 'Keystone: narrows the left, widens the right' },
  ]
  const NO_TRANSFORM = { skewX: 0, skewY: 0, rotate: 0, perspX: 0, perspY: 0 }

  // Transform being previewed on a painted layer. Text layers keep theirs as parameters
  // instead, since they regenerate from scratch and would wipe a baked transform.
  let pendingTransform = $state({ ...NO_TRANSFORM })
  const hasPendingTransform = $derived(
    !activeText && TRANSFORMS.some(({ key }) => pendingTransform[key]),
  )

  // A different layer means a different pending transform; don't carry it across.
  $effect(() => {
    activeIndex
    pendingTransform = { ...NO_TRANSFORM }
  })

  /** Read/write a transform value on whichever store the active layer uses. */
  const transformValue = (key) =>
    (activeText ? (activeText[key] ?? 0) : pendingTransform[key])

  function setTransform(key, value) {
    if (activeText) layers[activeIndex].text[key] = value
    else pendingTransform[key] = value
  }

  function resetTransform() {
    if (activeText) Object.assign(layers[activeIndex].text, NO_TRANSFORM)
    else pendingTransform = { ...NO_TRANSFORM }
  }

  function applyTransform() {
    if (!hasPendingTransform) return
    snapshot()
    layers[activeIndex].grid = transformGrid(grid, pendingTransform)
    pendingTransform = { ...NO_TRANSFORM }
  }

  /**
   * Bake an in-progress transform before doing anything that would otherwise throw it away —
   * adding or switching layers, drawing, resizing, exporting. A preview you can see should
   * never silently vanish; it either gets applied or you reset it yourself.
   */
  function commitPendingTransform() {
    if (hasPendingTransform) applyTransform()
  }

  function flipLayer(axis) {
    snapshot()
    if (activeText) {
      const t = layers[activeIndex].text
      if (axis === 'h') t.flipH = !t.flipH
      else t.flipV = !t.flipV
      return
    }
    layers[activeIndex].grid = flipGrid(grid, axis)
  }
  let fontReady = $state(true) // false once a font is known to be unavailable (offline)

  function addTextLayer() {
    commitPendingTransform()
    snapshot()
    const layer = {
      id: nextLayerId++,
      name: 'Text',
      visible: true,
      grid: makeGrid(cols, rows),
      text: {
        content: 'HELLO',
        family: 'Anton',
        bold: false,
        // Small sizes blob together as counters close up; 7 cells reads cleanly in every font.
        size: 7,
        mode: 'half',
        threshold: 0.5,
        letterSpacing: 0,
        lineSpacing: 1.25,
        x: 2,
        y: 2,
      },
    }
    layers = [...layers.slice(0, activeIndex + 1), layer, ...layers.slice(activeIndex + 1)]
    activeIndex += 1
    selection = null
  }

  /** How far the active text layer spills past each canvas edge, if at all. */
  const textOverflow = $derived.by(() => {
    if (!activeText || !activeLayer.textBox) return null
    const { width, height } = activeLayer.textBox
    const left = Math.max(0, -activeText.x)
    const top = Math.max(0, -activeText.y)
    const right = Math.max(0, activeText.x + width - cols)
    const bottom = Math.max(0, activeText.y + height - rows)
    return left || top || right || bottom ? { left, top, right, bottom } : null
  })

  /** Grow the canvas so the active text layer fits, shifting everything to keep it aligned. */
  function fitCanvasToText() {
    if (!textOverflow) return
    const { left, top, right, bottom } = textOverflow
    snapshot()
    const newCols = Math.min(400, cols + left + right)
    const newRows = Math.min(200, rows + top + bottom)
    for (const layer of layers) {
      const grown = resizeGrid(layer.grid, newCols, newRows)
      layer.grid = left || top ? shiftGrid(grown, left, top) : grown
      if (layer.text) {
        layer.text.x += left
        layer.text.y += top
      }
    }
    cols = newCols
    rows = newRows
    selection = null
  }

  /** Bake a text layer into ordinary cells so the drawing tools can touch it. */
  function rasterizeLayer() {
    commitPendingTransform()
    if (!activeText) return
    snapshot()
    delete layers[activeIndex].text
    flash('Text layer rasterized')
  }

  /**
   * Re-render every text layer whenever its parameters (or a newly loaded font) change.
   * This reads only `text` and never `grid`, so writing the grid can't retrigger it.
   */
  $effect(() => {
    fontVersion
    cols
    rows
    for (const layer of layers) {
      if (!layer.text) continue
      const { x, y, skewX = 0, skewY = 0, rotate = 0, perspX = 0, perspY = 0, flipH, flipV, ...options } =
        $state.snapshot(layer.text)
      const { grid: rendered, width, height } = renderTextGrid(
        { ...options, ramp: RAMPS.Blocks, solidChar: char },
        cols,
        rows,
        x,
        y,
      )
      // Transforms are parameters, re-applied on every render rather than baked once.
      let out = rendered
      if (flipH) out = flipGrid(out, 'h')
      if (flipV) out = flipGrid(out, 'v')
      if (skewX || skewY || rotate || perspX || perspY) {
        out = transformGrid(out, { skewX, skewY, rotate, perspX, perspY })
      }
      layer.grid = out
      layer.textBox = { width, height }
    }
  })

  /** Ask the browser for a webfont, then bump the version so text layers re-render with it. */
  function useFont(family) {
    if (!activeText) return
    layers[activeIndex].text.family = family
  }

  $effect(() => {
    // Fetch whatever font the active text layer wants (including after undo swaps it back),
    // then re-render once it's genuinely usable.
    if (!activeText) return
    const family = activeText.family
    fontReady = document.fonts.check(`64px "${family}"`)
    loadFont(family).then((ok) => {
      fontReady = ok
      fontVersion += 1
    })
  })

  let tool = $state('pencil')
  // Primary / secondary characters, à la Photoshop's foreground / background swatches.
  let char = $state('#')
  let altChar = $state(' ')
  let activeSlot = $state('primary')
  let boxStyle = $state('single')
  let filled = $state(false)
  let sameCharOnly = $state(false) // magic wand: stop at a different character, not just at blanks
  let pressureSize = $state(true)
  let pressureDensity = $state(true)
  let rampName = $state('ASCII')
  let dynamics = $state('pressure') // what drives the brush: 'pressure' | 'speed' | 'off'

  // Diagnostics for the last stroke, so it's obvious what the tablet is actually reporting.
  let pointerKind = $state(null)
  let lastForce = $state(null)
  let strokeMin = $state(null)
  let strokeMax = $state(null)
  let lastSample = null // {x, y, t} — plain let: needed between events, never rendered
  let speedForceValue = 1
  let fontSize = $state(16)
  // Display-only cell metrics: extra px between columns, and the row height multiplier.
  let letterSpacing = $state(0)
  let lineHeight = $state(1.2)
  let showGrid = $state(true)
  let brushSize = $state(1)
  // Which palette groups are expanded; the rest stay collapsed to keep the sidebar short.
  let openGroups = $state({ 'Blocks & shades': true, 'Box — single': true })

  let undoStack = $state([])
  let redoStack = $state([])

  // Drag / preview state
  let dragging = $state(false)
  let strokeChar = $state(null) // character the in-progress stroke commits (right-drag uses the secondary)

  // Selection state. `selection` is the set of selected cells; `moving` holds the lifted
  // characters while a move drag is in flight; `marquee` is the rubber-band box being dragged.
  let selection = $state(null) // [[x, y], ...]
  let marquee = $state(null) // [x0, y0, x1, y1]
  let moving = $state(null) // { cells: [[x, y, ch]], dx, dy, copy }
  let layerShift = $state(null) // { dx, dy } while the Move tool drags a whole layer
  let straightMode = $state(false) // Shift held at press: freehand tools draw a straight line
  let strokeForce = $state(1) // force sampled at press, so a straight stroke is uniform
  let start = $state(null) // [x, y]
  let end = $state(null) // [x, y]
  let hover = $state(null) // [x, y]
  let caret = $state(null) // [x, y] for the text tool

  let gridEl = $state(null)
  let measureEl = $state(null)
  let cellW = $state(9.6)

  const cellH = $derived(Math.max(1, Math.round(fontSize * lineHeight)))
  const isShape = $derived(tool === 'line' || tool === 'rect' || tool === 'box')
  const isBrush = $derived(tool === 'pencil' || tool === 'eraser' || tool === 'brush')
  // Line strokes are stamped with the same brush, so it takes a size too.
  const usesSize = $derived(isBrush || tool === 'line')
  // The hover outline traces the brush footprint, so only sized tools widen it.
  const brushSpan = $derived(usesSize ? brushSize : 1)
  const brushOffset = $derived(Math.floor((brushSpan - 1) / 2))
  const activeChar = $derived(activeSlot === 'primary' ? char : altChar)
  const selKeys = $derived(new Set((selection ?? []).map(([x, y]) => `${x},${y}`)))

  /**
   * Selected cells tagged with which of their four sides sit on the selection boundary,
   * so the overlay draws one outline around the whole shape instead of a grid of boxes.
   */
  const selEdges = $derived.by(() =>
    (selection ?? []).map(([x, y]) => ({
      x,
      y,
      top: !selKeys.has(`${x},${y - 1}`),
      right: !selKeys.has(`${x + 1},${y}`),
      bottom: !selKeys.has(`${x},${y + 1}`),
      left: !selKeys.has(`${x - 1},${y}`),
    })),
  )
  const hoverInSelection = $derived(!!hover && selKeys.has(`${hover[0]},${hover[1]}`))

  // Leaving the Select tool drops the selection, so a stale marquee can't linger over drawing.
  $effect(() => {
    if (tool !== 'select') {
      selection = null
      marquee = null
      moving = null
    }
  })

  function setActiveChar(value) {
    // Keep the last typed character so the single-cell input behaves like a replace.
    const next = [...value].pop() ?? ' '
    if (activeSlot === 'primary') char = next
    else altChar = next
  }

  function resetSpacing() {
    letterSpacing = 0
    lineHeight = 1.2
  }

  function swapChars() {
    const previous = char
    char = altChar
    altChar = previous
  }

  $effect(() => {
    // Re-measure whenever the font size or tracking changes. CSS letter-spacing adds a gap
    // after every character including the last, so width / 50 is exactly the cell pitch.
    fontSize
    letterSpacing
    if (!measureEl) return
    cellW = measureEl.getBoundingClientRect().width / 50
  })

  /** Cells the in-progress drag would paint, as [x, y, char]. */
  const preview = $derived.by(() => {
    if (!dragging || !start || !end) return []
    const [x0, y0] = start
    const [x1, y1] = end
    const ch = strokeChar ?? char

    // Shift-constrained freehand: one straight line from the press to the pointer.
    if (straightMode && isBrush) {
      const lineChar =
        tool === 'eraser' ? EMPTY : tool === 'brush' ? charFor(strokeForce) : ch
      const size = tool === 'brush' ? sizeFor(strokeForce) : brushSize
      return strokePoints(linePoints(x0, y0, x1, y1), size).map(([x, y]) => [x, y, lineChar])
    }
    if (!isShape) return []
    if (tool === 'line') {
      return strokePoints(linePoints(x0, y0, x1, y1), brushSize).map(([x, y]) => [x, y, ch])
    }
    if (tool === 'rect') return rectPoints(x0, y0, x1, y1, filled).map(([x, y]) => [x, y, ch])
    return boxCells(x0, y0, x1, y1, boxStyle)
  })

  /** The active layer with any in-flight edit applied, or null when nothing is in progress. */
  const previewLayer = $derived.by(() => {
    const isMoving = moving && (moving.dx || moving.dy)
    const isShifting = layerShift && (layerShift.dx || layerShift.dy)
    if (!isMoving && !isShifting && !preview.length && !hasPendingTransform) return null

    const out = isShifting
      ? shiftGrid(grid, layerShift.dx, layerShift.dy)
      : hasPendingTransform
        ? transformGrid(grid, pendingTransform)
        : cloneGrid(grid)
    const put = (x, y, ch) => {
      if (y >= 0 && y < out.length && x >= 0 && x < cols) out[y][x] = ch
    }
    if (isMoving) {
      // Lift first, then stamp, so the source only clears where the copy isn't landing.
      if (!moving.copy) for (const [x, y] of moving.cells) put(x, y, EMPTY)
      for (const [x, y, ch] of moving.cells) put(x + moving.dx, y + moving.dy, ch)
    }
    for (const [x, y, ch] of preview) put(x, y, ch)
    return out
  })

  /** The flattened stack as display strings, previewing edits on the active layer. */
  const displayRows = $derived.by(() =>
    (previewLayer ? flatten(previewLayer) : composite).map((row) => row.join('')),
  )

  /**
   * What Copy, Download and the size readout use. An unapplied transform is included, so
   * exporting can't quietly hand back art that looks nothing like what's on screen.
   */
  const text = $derived(
    gridToText(
      hasPendingTransform ? flatten(transformGrid(grid, pendingTransform)) : composite,
    ),
  )

  /** Undo entries capture the whole stack, so layer adds/deletes/reorders are undoable too. */
  function captureState() {
    return {
      layers: layers.map((l) => ({ ...l, grid: cloneGrid(l.grid) })),
      activeIndex,
    }
  }

  function restoreState(state) {
    // Clone on the way out too: the stack entry must not become live, mutable state.
    layers = state.layers.map((l) => ({ ...l, grid: cloneGrid(l.grid) }))
    activeIndex = Math.min(state.activeIndex, state.layers.length - 1)
    rows = layers[0].grid.length
    cols = layers[0].grid[0].length
  }

  function snapshot() {
    undoStack = [...undoStack.slice(-99), captureState()]
    redoStack = []
  }

  function undo() {
    if (!undoStack.length) return
    const prev = undoStack[undoStack.length - 1]
    undoStack = undoStack.slice(0, -1)
    redoStack = [...redoStack, captureState()]
    restoreState(prev)
  }

  function redo() {
    if (!redoStack.length) return
    const next = redoStack[redoStack.length - 1]
    redoStack = redoStack.slice(0, -1)
    undoStack = [...undoStack, captureState()]
    restoreState(next)
  }

  function paint(cells) {
    for (const [x, y, ch] of cells) {
      if (y < 0 || y >= grid.length || x < 0 || x >= cols) continue
      grid[y][x] = ch
    }
  }

  /**
   * How hard the brush is pressing, 0…1.
   *
   * `pressure` mode uses the tablet's own reading. Mice and trackpads report a flat 0.5 while
   * held, so anything that isn't a pen draws at full force rather than a permanent mid-tone.
   * Some pen drivers only report 1-while-down / 0-on-lift — `speed` mode covers those, and any
   * mouse, by deriving force from how fast the pointer is travelling.
   */
  function forceOf(event) {
    pointerKind = event.pointerType
    let f
    if (dynamics === 'off') f = 1
    else if (dynamics === 'speed') f = speedForce(event)
    else f = event.pointerType === 'pen' ? Math.max(event.pressure, 0.01) : 1

    lastForce = f
    strokeMin = strokeMin === null ? f : Math.min(strokeMin, f)
    strokeMax = strokeMax === null ? f : Math.max(strokeMax, f)
    return f
  }

  /** Slow strokes press hard, fast strokes press light — smoothed so it doesn't jitter. */
  function speedForce(event) {
    const t = event.timeStamp
    const { clientX: x, clientY: y } = event
    if (!lastSample) {
      lastSample = { x, y, t }
      return speedForceValue
    }
    const dt = Math.max(1, t - lastSample.t)
    const distance = Math.hypot(x - lastSample.x, y - lastSample.y)
    lastSample = { x, y, t }
    const target = Math.min(1, Math.max(0.05, 1 - distance / dt / 1.5))
    speedForceValue = speedForceValue * 0.6 + target * 0.4
    return speedForceValue
  }

  function beginStroke(event) {
    pointerKind = event.pointerType
    strokeMin = null
    strokeMax = null
    lastSample = null
    speedForceValue = 1
  }

  const dynamicsNote = $derived.by(() => {
    if (dynamics === 'off') return 'Every dab draws at full force.'
    if (!pointerKind) return 'Draw a stroke to see what your device reports.'
    const range =
      strokeMin === null ? '' : ` · stroke ${strokeMin.toFixed(2)}–${strokeMax.toFixed(2)}`
    const head = `${pointerKind} · now ${lastForce?.toFixed(2) ?? '–'}${range}`
    if (dynamics === 'pressure' && pointerKind !== 'pen') {
      return `${head}\nNot a pen — no pressure available. Switch Dynamics to Speed.`
    }
    if (dynamics === 'pressure' && strokeMin !== null && strokeMax - strokeMin < 0.02) {
      return `${head}\nConstant pressure: your driver isn't sending analog values. Try Speed.`
    }
    return head
  })

  const sizeFor = (p) =>
    pressureSize ? Math.max(1, Math.round(p * brushSize)) : brushSize

  function charFor(p) {
    if (!pressureDensity) return strokeChar ?? char
    const ramp = RAMPS[rampName]
    const i = Math.min(ramp.length - 1, Math.max(0, Math.round(p * (ramp.length - 1))))
    return ramp[i]
  }

  /** One pressure-weighted dab from `from` to `to`. */
  function brushSegment(from, to, p) {
    const path = linePoints(from[0], from[1], to[0], to[1])
    const ch = charFor(p)
    paint(strokePoints(path, sizeFor(p)).map(([x, y]) => [x, y, ch]))
  }

  function cellFromEvent(event) {
    if (!gridEl) return null
    const rect = gridEl.getBoundingClientRect()
    const x = Math.floor((event.clientX - rect.left) / cellW)
    const y = Math.floor((event.clientY - rect.top) / cellH)
    if (x < 0 || x >= cols || y < 0 || y >= rows) return null
    return [x, y]
  }

  function onPointerDown(event) {
    const cell = cellFromEvent(event)
    if (!cell) return
    event.target.setPointerCapture?.(event.pointerId)
    dragging = true
    start = cell
    end = cell

    if (tool === 'text') {
      caret = cell
      gridEl?.focus()
      return
    }
    if (tool === 'move') {
      gridEl?.focus()
      layerShift = { dx: 0, dy: 0 }
      return
    }
    // A text layer is regenerated from its parameters, so painting on it would be erased.
    if (activeText) {
      dragging = false
      flash('Text layer — edit it in the sidebar, or Rasterize to draw on it')
      return
    }
    if (tool === 'select') {
      gridEl?.focus()
      if (selKeys.has(`${cell[0]},${cell[1]}`)) {
        // Grab the current selection's characters; Alt drags out a copy instead of moving.
        moving = {
          cells: selection.map(([x, y]) => [x, y, grid[y][x]]),
          dx: 0,
          dy: 0,
          copy: event.altKey,
        }
      } else {
        marquee = [cell[0], cell[1], cell[0], cell[1]]
        selection = null
      }
      return
    }
    commitPendingTransform()
    // Right button draws with the secondary character, mirroring Photoshop's background colour.
    strokeChar = event.button === 2 ? altChar : char
    snapshot()

    // Shift at press turns a freehand tool into a line: preview only, commit on release.
    straightMode = event.shiftKey && isBrush
    if (straightMode) {
      if (tool === 'brush') {
        beginStroke(event)
        strokeForce = forceOf(event)
      }
      return
    }

    if (tool === 'brush') {
      beginStroke(event)
      brushSegment(cell, cell, forceOf(event))
    } else if (isBrush) {
      const ch = tool === 'eraser' ? EMPTY : strokeChar
      paint(brushPoints(cell[0], cell[1], brushSize).map(([x, y]) => [x, y, ch]))
    } else if (tool === 'fill') {
      paint(floodPoints(grid, cell[0], cell[1]).map(([x, y]) => [x, y, strokeChar]))
    }
  }

  function onPointerMove(event) {
    const cell = cellFromEvent(event)
    hover = cell
    if (!dragging || !cell) return
    if (tool === 'move') {
      // Clamp the preview too, so what you drag is what you get.
      layerShift = clampShift(cell[0] - start[0], cell[1] - start[1])
      end = cell
      return
    }
    if (tool === 'select') {
      if (moving) {
        moving.dx = cell[0] - start[0]
        moving.dy = cell[1] - start[1]
      } else if (marquee) {
        marquee = [marquee[0], marquee[1], cell[0], cell[1]]
      }
      end = cell
      return
    }
    if (straightMode) {
      end = cell // the line redraws from the anchor; nothing is committed until release
      return
    }
    if (tool === 'brush') {
      // Coalesced events carry the sub-frame samples a tablet reports between animation
      // frames — using them keeps pressure and curvature that a single event would drop.
      const samples = event.getCoalescedEvents?.() ?? []
      let prev = end ?? cell
      for (const sample of samples.length ? samples : [event]) {
        const c = cellFromEvent(sample)
        if (!c) continue
        brushSegment(prev, c, forceOf(sample))
        prev = c
      }
      end = prev
      return
    }
    if (isBrush) {
      const ch = tool === 'eraser' ? EMPTY : (strokeChar ?? char)
      // Interpolate so fast drags don't leave gaps.
      const [px, py] = end ?? cell
      const path = linePoints(px, py, cell[0], cell[1])
      paint(strokePoints(path, brushSize).map(([x, y]) => [x, y, ch]))
    }
    end = cell
  }

  function onPointerUp() {
    if (dragging && (isShape || straightMode) && preview.length) paint(preview)
    if (dragging && tool === 'select') finishSelectDrag()
    if (dragging && tool === 'move') commitLayerShift()
    straightMode = false
    dragging = false
    start = null
    end = null
    strokeChar = null
  }

  /** Bake the Move tool's drag into the active layer. */
  function commitLayerShift() {
    if (!layerShift) return
    const { dx, dy } = layerShift
    layerShift = null
    if (!dx && !dy) return
    nudgeLayer(dx, dy)
  }

  /**
   * Limit a move so a painted layer can't be pushed past the canvas edge. Cells shifted out
   * would be gone for good, and "move it off and back" is a normal thing to try. Text layers
   * aren't clamped: they re-render from their parameters, so nothing is lost off-canvas.
   */
  function clampShift(dx, dy) {
    if (activeText) return { dx, dy }
    const b = contentBounds(grid)
    if (!b) return { dx, dy }
    return {
      dx: Math.max(-b.minX, Math.min(dx, cols - 1 - b.maxX)),
      dy: Math.max(-b.minY, Math.min(dy, rows - 1 - b.maxY)),
    }
  }

  /**
   * Shift the whole active layer by whole cells. A text layer moves by its anchor rather than
   * its pixels — shifting the baked grid would be undone by the next re-render.
   */
  function nudgeLayer(rawDx, rawDy) {
    const { dx, dy } = clampShift(rawDx, rawDy)
    if (!dx && !dy) return
    snapshot()
    if (activeText) {
      layers[activeIndex].text.x += dx
      layers[activeIndex].text.y += dy
      return
    }
    layers[activeIndex].grid = shiftGrid(grid, dx, dy)
  }

  function selectAll() {
    tool = 'select'
    selection = rectPoints(0, 0, cols - 1, rows - 1, true)
    gridEl?.focus()
  }

  function finishSelectDrag() {
    if (moving) {
      commitMove()
      moving = null
      return
    }
    if (!marquee) return
    const [x0, y0, x1, y1] = marquee
    marquee = null
    if (x0 === x1 && y0 === y1) {
      // A click with no drag acts as a magic wand; on blank canvas it just clears.
      const object = objectPoints(grid, x0, y0, { sameChar: sameCharOnly })
      selection = object.length ? object : null
      return
    }
    const cells = rectPoints(x0, y0, x1, y1, true)
    selection = cells.length ? cells : null
  }

  /** Write the lifted characters at their new home and follow them with the selection. */
  function commitMove() {
    const { cells, dx, dy, copy } = moving
    if (!dx && !dy) return
    snapshot()
    if (!copy) paint(cells.map(([x, y]) => [x, y, EMPTY]))
    paint(cells.map(([x, y, ch]) => [x + dx, y + dy, ch]))
    selection = cells
      .map(([x, y]) => [x + dx, y + dy])
      .filter(([x, y]) => x >= 0 && x < cols && y >= 0 && y < rows)
    if (!selection.length) selection = null
  }

  /** Shift the selection by whole cells — used by the arrow keys. */
  function nudge(dx, dy) {
    if (!selection) return
    moving = { cells: selection.map(([x, y]) => [x, y, grid[y][x]]), dx, dy, copy: false }
    commitMove()
    moving = null
  }

  function deleteSelection() {
    if (!selection) return
    snapshot()
    paint(selection.map(([x, y]) => [x, y, EMPTY]))
  }

  function onKeyDown(event) {
    // Bound to the window so shortcuts work after clicking a sidebar control, but form
    // fields (the layer rename box, size inputs, the character slot) keep their own keys.
    const target = event.target
    if (
      target instanceof HTMLInputElement ||
      target instanceof HTMLSelectElement ||
      target instanceof HTMLTextAreaElement
    ) {
      return
    }
    const meta = event.metaKey || event.ctrlKey
    if (meta && event.key.toLowerCase() === 'z') {
      event.preventDefault()
      event.shiftKey ? redo() : undo()
      return
    }
    if (meta && event.key.toLowerCase() === 'y') {
      event.preventDefault()
      redo()
      return
    }
    if (meta && event.key.toLowerCase() === 'a') {
      event.preventDefault()
      selectAll()
      return
    }
    if (meta && event.key.toLowerCase() === 'd') {
      event.preventDefault()
      selection = null
      return
    }
    if (meta) return

    if (tool === 'move' && event.key.startsWith('Arrow')) {
      event.preventDefault()
      const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key]
      nudgeLayer(d[0], d[1])
      return
    }

    if (tool === 'select' && selection) {
      if (event.key === 'Escape') {
        selection = null
        return
      }
      if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault()
        deleteSelection()
        return
      }
      if (event.key.startsWith('Arrow')) {
        event.preventDefault()
        const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key]
        nudge(d[0], d[1])
        return
      }
    }

    if (tool === 'text' && caret) {
      const [x, y] = caret
      if (event.key === 'Backspace') {
        event.preventDefault()
        snapshot()
        const nx = Math.max(0, x - 1)
        grid[y][nx] = EMPTY
        caret = [nx, y]
        return
      }
      if (event.key === 'Enter') {
        event.preventDefault()
        caret = [start?.[0] ?? 0, Math.min(rows - 1, y + 1)]
        return
      }
      if (event.key.startsWith('Arrow')) {
        event.preventDefault()
        const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key]
        caret = [
          Math.min(cols - 1, Math.max(0, x + d[0])),
          Math.min(rows - 1, Math.max(0, y + d[1])),
        ]
        return
      }
      if ([...event.key].length === 1) {
        event.preventDefault()
        snapshot()
        grid[y][x] = event.key
        caret = x + 1 < cols ? [x + 1, y] : [0, Math.min(rows - 1, y + 1)]
        return
      }
      return
    }

    const key = event.key.toLowerCase()
    if (key === 'x') {
      swapChars()
      return
    }
    if (key === '[' || key === ']') {
      brushSize = Math.min(9, Math.max(1, brushSize + (key === ']' ? 1 : -1)))
      return
    }
    if (key === 'g') {
      showGrid = !showGrid
      return
    }
    const shortcut = {
      p: 'pencil', b: 'brush', e: 'eraser', l: 'line',
      r: 'rect', o: 'box', f: 'fill', t: 'text', s: 'select', v: 'move',
    }[key]
    if (shortcut) tool = shortcut
  }

  function addLayer() {
    commitPendingTransform()
    snapshot()
    const layer = {
      id: nextLayerId++,
      name: `Layer ${nextLayerId - 1}`,
      visible: true,
      grid: makeGrid(cols, rows),
    }
    layers = [...layers.slice(0, activeIndex + 1), layer, ...layers.slice(activeIndex + 1)]
    activeIndex += 1
    selection = null
  }

  function duplicateLayer() {
    commitPendingTransform()
    snapshot()
    const source = layers[activeIndex]
    const copy = {
      id: nextLayerId++,
      name: `${source.name} copy`,
      visible: source.visible,
      grid: cloneGrid(source.grid),
    }
    layers = [...layers.slice(0, activeIndex + 1), copy, ...layers.slice(activeIndex + 1)]
    activeIndex += 1
    selection = null
  }

  function deleteLayer() {
    commitPendingTransform()
    if (layers.length === 1) return
    snapshot()
    layers = layers.filter((_, i) => i !== activeIndex)
    activeIndex = Math.max(0, activeIndex - 1)
    selection = null
  }

  /** Move the active layer one step up (+1) or down (-1) the stack. */
  function moveLayer(direction) {
    commitPendingTransform()
    const target = activeIndex + direction
    if (target < 0 || target >= layers.length) return
    snapshot()
    const next = layers.slice()
    ;[next[activeIndex], next[target]] = [next[target], next[activeIndex]]
    layers = next
    activeIndex = target
  }

  /** Flatten the active layer onto the one below it, keeping the lower layer's name. */
  function mergeDown() {
    commitPendingTransform()
    if (activeIndex === 0) return
    snapshot()
    const upper = layers[activeIndex]
    const lower = layers[activeIndex - 1]
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        if (upper.grid[y][x] !== EMPTY) lower.grid[y][x] = upper.grid[y][x]
      }
    }
    layers = layers.filter((_, i) => i !== activeIndex)
    activeIndex -= 1
    selection = null
  }

  function toggleVisible(index) {
    layers[index].visible = !layers[index].visible
  }

  function selectLayer(index) {
    if (index === activeIndex) return
    commitPendingTransform()
    activeIndex = index
    selection = null
    caret = null
  }

  function applySize() {
    commitPendingTransform()
    const c = Math.max(1, Math.min(400, Math.round(cols)))
    const r = Math.max(1, Math.min(200, Math.round(rows)))
    if (c === grid[0].length && r === grid.length) return
    snapshot()
    // Every layer has to stay the same size, or compositing would go ragged.
    for (const layer of layers) layer.grid = resizeGrid(layer.grid, c, r)
    cols = c
    rows = r
    caret = null
    selection = null
  }

  /** Clears the active layer only; the rest of the stack is untouched. */
  function clearAll() {
    commitPendingTransform()
    snapshot()
    layers[activeIndex].grid = makeGrid(cols, rows)
    caret = null
    selection = null
  }

  async function copyText() {
    try {
      await navigator.clipboard.writeText(text)
      flash('Copied to clipboard')
    } catch {
      flash('Clipboard blocked — select the text below instead')
    }
  }

  function download() {
    const blob = new Blob([text], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'ascii-art.txt'
    a.click()
    URL.revokeObjectURL(url)
  }

  async function importFile(event) {
    const file = event.target.files?.[0]
    if (!file) return
    const content = await file.text()
    const lines = content.replace(/\r\n?/g, '\n').split('\n')
    const c = Math.max(cols, ...lines.map((l) => [...l].length))
    const r = Math.max(rows, lines.length)
    snapshot()
    for (const layer of layers) layer.grid = resizeGrid(layer.grid, c, r)
    layers[activeIndex].grid = textToGrid(content, c, r)
    cols = c
    rows = r
    event.target.value = ''
  }

  let toast = $state('')
  let toastTimer
  function flash(message) {
    toast = message
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => (toast = ''), 2000)
  }
</script>

<svelte:window onkeydown={onKeyDown} />

<div class="app">
  <header>
    <h1>ASCII Editor</h1>
    <div class="spacer"></div>
    <button onclick={undo} disabled={!undoStack.length} title="Undo (⌘Z)">Undo</button>
    <button onclick={redo} disabled={!redoStack.length} title="Redo (⇧⌘Z)">Redo</button>
    <button onclick={clearAll}>Clear</button>
    <button onclick={copyText}>Copy</button>
    <button onclick={download}>Download</button>
    <label class="file">
      Import
      <input type="file" accept=".txt,text/plain" onchange={importFile} />
    </label>
  </header>

  <div class="body">
    <aside>
      <section>
        <h2>Tool</h2>
        <div class="tools">
          {#each TOOLS as t}
            <button class="tool" class:active={tool === t.id} title={t.hint} onclick={() => (tool = t.id)}>
              {t.label}
            </button>
          {/each}
        </div>
        {#if usesSize}
          <label class="row" title="Brush size ([ and ])">
            {tool === 'brush' && pressureSize ? 'Max size' : 'Size'}
            <input type="range" min="1" max="9" bind:value={brushSize} />
          </label>
          <div class="size-readout">{brushSize} × {brushSize}</div>
        {/if}
        {#if tool === 'brush'}
          <label class="row" title="What varies the brush as you draw">
            Dynamics
            <select bind:value={dynamics}>
              <option value="pressure">Pen pressure</option>
              <option value="speed">Speed</option>
              <option value="off">Off</option>
            </select>
          </label>
          <label class="check" title="Harder press paints a wider dab">
            <input type="checkbox" bind:checked={pressureSize} /> Force → size
          </label>
          <label class="check" title="Harder press picks a denser character">
            <input type="checkbox" bind:checked={pressureDensity} /> Force → density
          </label>
          {#if pressureDensity}
            <label class="row">
              Ramp
              <select bind:value={rampName}>
                {#each Object.keys(RAMPS) as r}<option value={r}>{r}</option>{/each}
              </select>
            </label>
            <div class="ramp-preview">{RAMPS[rampName].join(' ')}</div>
          {/if}
          <p class="note">{dynamicsNote}</p>
        {/if}
        {#if tool === 'rect'}
          <label class="check"><input type="checkbox" bind:checked={filled} /> Filled</label>
        {/if}
        {#if tool === 'select'}
          <label class="check" title="Click-to-select stops at a different character instead of at blanks">
            <input type="checkbox" bind:checked={sameCharOnly} /> Same character only
          </label>
        {/if}
        {#if tool === 'box'}
          <label class="row">
            Style
            <select bind:value={boxStyle}>
              {#each BOX_STYLES as s}<option value={s}>{s}</option>{/each}
            </select>
          </label>
        {/if}
      </section>

      <section>
        <h2>Layers</h2>
        <div class="layers">
          {#each [...layers].reverse() as layer, i (layer.id)}
            {@const index = layers.length - 1 - i}
            <div class="layer" class:active={index === activeIndex}>
              <button
                class="eye"
                class:hidden={!layer.visible}
                title={layer.visible ? 'Hide layer' : 'Show layer'}
                onclick={() => toggleVisible(index)}
              >{layer.visible ? '◉' : '○'}</button>
              {#if renamingId === layer.id}
                <!-- svelte-ignore a11y_autofocus -->
                <input
                  class="layer-name-input"
                  value={layer.name}
                  autofocus
                  onblur={(e) => {
                    layer.name = e.currentTarget.value.trim() || layer.name
                    renamingId = null
                  }}
                  onkeydown={(e) => {
                    if (e.key === 'Enter' || e.key === 'Escape') e.currentTarget.blur()
                    e.stopPropagation()
                  }}
                />
              {:else}
                <button
                  class="layer-name"
                  onclick={() => selectLayer(index)}
                  ondblclick={() => (renamingId = layer.id)}
                  title="Click to select, double-click to rename"
                >{layer.name}</button>
              {/if}
            </div>
          {/each}
        </div>
        <div class="layer-actions">
          <button onclick={addLayer} title="New layer above the active one">+</button>
          <button onclick={addTextLayer} title="New text layer">T+</button>
          <button onclick={duplicateLayer} title="Duplicate layer">⧉</button>
          <button onclick={() => moveLayer(1)} disabled={activeIndex === layers.length - 1} title="Move up">↑</button>
          <button onclick={() => moveLayer(-1)} disabled={activeIndex === 0} title="Move down">↓</button>
          <button onclick={mergeDown} disabled={activeIndex === 0} title="Merge down">⌄⌃</button>
          <button onclick={deleteLayer} disabled={layers.length === 1} title="Delete layer">✕</button>
        </div>
      </section>

      <section>
        <h2>Transform</h2>
        {#each TRANSFORMS as t}
          <label class="row" title={t.hint}>
            {t.label}
            <input
              type="range"
              min={t.min}
              max={t.max}
              step={t.step}
              value={transformValue(t.key)}
              oninput={(e) => setTransform(t.key, +e.currentTarget.value)}
            />
          </label>
        {/each}
        <div class="size-readout">
          {TRANSFORMS.filter((t) => transformValue(t.key))
            .map((t) => `${t.label} ${transformValue(t.key)}`)
            .join(' · ') || 'none'}
          <button class="link" onclick={resetTransform}>reset</button>
        </div>
        {#if !activeText}
          <button class="wide" disabled={!hasPendingTransform} onclick={applyTransform}>
            Apply to layer
          </button>
          {#if hasPendingTransform}
            <p class="note">Preview — applied automatically if you draw or switch layers.</p>
          {/if}
        {/if}
        <div class="flip-row">
          <button onclick={() => flipLayer('h')} title="Mirror left ↔ right">Flip H</button>
          <button onclick={() => flipLayer('v')} title="Mirror top ↔ bottom">Flip V</button>
        </div>
      </section>

      {#if activeText}
        <section>
          <h2>Text layer</h2>
          <textarea
            class="text-input"
            rows="2"
            bind:value={layers[activeIndex].text.content}
            placeholder="Type here"
          ></textarea>
          <label class="row">
            Font
            <select value={activeText.family} onchange={(e) => useFont(e.currentTarget.value)}>
              {#each FONTS as f}<option value={f.family}>{f.family} · {f.note}</option>{/each}
            </select>
          </label>
          <label class="check">
            <input type="checkbox" bind:checked={layers[activeIndex].text.bold} /> Bold
          </label>
          <label class="row" title="Cap height in character cells">
            Size <input type="range" min="1" max="20" step="0.5" bind:value={layers[activeIndex].text.size} />
          </label>
          <label class="row">
            Style
            <select bind:value={layers[activeIndex].text.mode}>
              <option value="half">Half blocks</option>
              <option value="shade">Shading</option>
              <option value="solid">Solid</option>
            </select>
          </label>
          <label class="row" title="Coverage a cell needs before it's inked">
            Weight <input type="range" min="0.05" max="0.9" step="0.05" bind:value={layers[activeIndex].text.threshold} />
          </label>
          <label class="row" title="Extra space between glyphs, in cells">
            Tracking <input type="range" min="-1" max="4" step="0.25" bind:value={layers[activeIndex].text.letterSpacing} />
          </label>
          <label class="row" title="Line height as a multiple of the font size">
            Leading <input type="range" min="0.8" max="2.5" step="0.05" bind:value={layers[activeIndex].text.lineSpacing} />
          </label>
          <div class="row">
            <span>Position</span>
            <span class="pos">
              <input type="number" bind:value={layers[activeIndex].text.x} title="Column" />
              <input type="number" bind:value={layers[activeIndex].text.y} title="Row" />
            </span>
          </div>
          <p class="note">
            {activeLayer.textBox
              ? `${activeLayer.textBox.width}×${activeLayer.textBox.height}`
              : '—'} cells · Move tool (V) or arrow keys to reposition
            {#if !fontReady}
              {'\n'}Font unavailable offline — drawing with a system fallback.
            {/if}
          </p>
          {#if textOverflow}
            <p class="note warn">
              Extends past the canvas — the text is kept in full, only the view is cropped.
            </p>
            <button class="wide" onclick={fitCanvasToText}>Fit canvas to text</button>
          {/if}
          <button class="wide" onclick={rasterizeLayer}>Rasterize to draw on it</button>
        </section>
      {/if}

      <section>
        <h2>Canvas</h2>
        <label class="row">Cols <input type="number" min="1" max="400" bind:value={cols} onchange={applySize} /></label>
        <label class="row">Rows <input type="number" min="1" max="200" bind:value={rows} onchange={applySize} /></label>
        <label class="row">Zoom <input type="range" min="8" max="32" bind:value={fontSize} /></label>
        <label class="row" title="Horizontal gap between columns (display only)">
          H space <input type="range" min="-2" max="16" step="0.5" bind:value={letterSpacing} />
        </label>
        <label class="row" title="Vertical row pitch (display only)">
          V space <input type="range" min="0.6" max="3" step="0.05" bind:value={lineHeight} />
        </label>
        <div class="size-readout">
          cell {cellW.toFixed(1)} × {cellH}px
          <button class="link" onclick={resetSpacing}>reset</button>
        </div>
        <label class="check" title="Toggle cell guides (G)">
          <input type="checkbox" bind:checked={showGrid} /> Show grid
        </label>
      </section>

      <section>
        <h2>Character</h2>
        <div class="slots">
          <button
            class="slot"
            class:active={activeSlot === 'primary'}
            onclick={() => (activeSlot = 'primary')}
            title="Primary — drawn with the left button"
          >{char === ' ' ? '␠' : char}</button>
          <button
            class="slot"
            class:active={activeSlot === 'secondary'}
            onclick={() => (activeSlot = 'secondary')}
            title="Secondary — drawn with the right button"
          >{altChar === ' ' ? '␠' : altChar}</button>
          <button class="swap" onclick={swapChars} title="Swap primary and secondary (X)">⇄</button>
        </div>
        <input
          class="char-input"
          value={activeChar}
          oninput={(e) => setActiveChar(e.currentTarget.value)}
          spellcheck="false"
        />
        {#each PALETTE_GROUPS as group}
          <details
            open={openGroups[group.name] ?? false}
            ontoggle={(e) => (openGroups[group.name] = e.currentTarget.open)}
          >
            <summary>{group.name}</summary>
            <div class="palette">
              {#each group.chars as p}
                <button
                  class="swatch"
                  class:active={activeChar === p}
                  onclick={() => setActiveChar(p)}
                  title={p === ' ' ? 'space' : p}
                >{p === ' ' ? '␠' : p}</button>
              {/each}
            </div>
          </details>
        {/each}
      </section>
    </aside>

    <main>
      <div class="canvas-wrap">
        <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
        <pre
          bind:this={gridEl}
          class="grid"
          class:text-tool={tool === 'text'}
          class:select-tool={tool === 'select'}
          class:move-tool={tool === 'move'}
          class:grabbable={hoverInSelection}
          role="application"
          aria-label="ASCII canvas"
          tabindex="0"
          style="font-size:{fontSize}px; line-height:{cellH}px; letter-spacing:{letterSpacing}px;"
          onpointerdown={onPointerDown}
          onpointermove={onPointerMove}
          onpointerup={onPointerUp}
          onpointerleave={() => (hover = null)}
          oncontextmenu={(e) => e.preventDefault()}
        >{#each displayRows as row}<div class="line">{row}</div>{/each}{#if showGrid}<span
            class="gridlines"
            style="background-size:{cellW}px {cellH}px;"
          ></span>{/if}{#if hover}<span
            class="hover-cell"
            style="left:{(hover[0] - brushOffset) * cellW}px; top:{(hover[1] - brushOffset) *
              cellH}px; width:{brushSpan * cellW}px; height:{brushSpan * cellH}px;"
          ></span>{/if}{#each selEdges as s}<span
            class="sel-cell"
            style="left:{(s.x + (moving?.dx ?? 0)) * cellW}px; top:{(s.y + (moving?.dy ?? 0)) *
              cellH}px; width:{cellW}px; height:{cellH}px; border-width:{s.top ? 1 : 0}px {s.right
              ? 1
              : 0}px {s.bottom ? 1 : 0}px {s.left ? 1 : 0}px;"
          ></span>{/each}{#if marquee}<span
            class="marquee"
            style="left:{Math.min(marquee[0], marquee[2]) * cellW}px; top:{Math.min(
              marquee[1],
              marquee[3],
            ) * cellH}px; width:{(Math.abs(marquee[2] - marquee[0]) + 1) *
              cellW}px; height:{(Math.abs(marquee[3] - marquee[1]) + 1) * cellH}px;"
          ></span>{/if}{#if caret && tool === 'text'}<span
            class="caret"
            style="left:{caret[0] * cellW}px; top:{caret[1] * cellH}px; width:{cellW}px; height:{cellH}px;"
          ></span>{/if}</pre>
        <div class="measure-box" aria-hidden="true"><span
            bind:this={measureEl}
            class="measure"
            style="font-size:{fontSize}px; letter-spacing:{letterSpacing}px;"
          >00000000000000000000000000000000000000000000000000</span></div>
      </div>

      <footer>
        <span>{cols} × {rows}</span>
        <span>{hover ? `${hover[0]}, ${hover[1]}` : '–'}</span>
        <span class="toast">{toast}</span>
      </footer>
    </main>
  </div>
</div>

<style>
  .app {
    display: flex;
    flex-direction: column;
    height: 100vh;
    background: #12141a;
    color: #d7dae0;
    font-family: system-ui, sans-serif;
  }

  header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 14px;
    border-bottom: 1px solid #262a33;
  }
  h1 {
    font-size: 15px;
    font-weight: 600;
    margin: 0;
    letter-spacing: 0.04em;
  }
  .spacer { flex: 1; }

  .body {
    display: flex;
    flex: 1;
    min-height: 0;
  }

  aside {
    width: 232px;
    flex: none;
    padding: 14px;
    border-right: 1px solid #262a33;
    overflow-y: auto;
  }
  section + section { margin-top: 20px; }
  h2 {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: #7c8496;
    margin: 0 0 8px;
  }

  .tools {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 4px;
  }

  button {
    font: inherit;
    font-size: 13px;
    color: #d7dae0;
    background: #1c2029;
    border: 1px solid #2c313d;
    border-radius: 6px;
    padding: 6px 10px;
    cursor: pointer;
  }
  button:hover:not(:disabled) { background: #252a35; }
  button:disabled { opacity: 0.4; cursor: default; }
  .tool.active {
    background: #3b6ef5;
    border-color: #3b6ef5;
    color: #fff;
  }

  .file {
    font-size: 13px;
    background: #1c2029;
    border: 1px solid #2c313d;
    border-radius: 6px;
    padding: 6px 10px;
    cursor: pointer;
  }
  .file input { display: none; }

  .row, .check {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
    margin-top: 8px;
  }
  .row input, .row select {
    margin-left: auto;
    width: 110px;
    font: inherit;
    font-size: 13px;
    background: #1c2029;
    color: inherit;
    border: 1px solid #2c313d;
    border-radius: 5px;
    padding: 4px 6px;
  }

  .size-readout {
    font-size: 12px;
    color: #7c8496;
    text-align: right;
    margin-top: 2px;
    font-variant-numeric: tabular-nums;
  }

  .slots {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 8px;
  }
  .slot {
    flex: 1;
    font-family: ui-monospace, monospace;
    font-size: 20px;
    padding: 8px 0;
    color: #fff;
  }
  .slot.active {
    border-color: #3b6ef5;
    box-shadow: inset 0 0 0 1px #3b6ef5;
  }
  .swap {
    flex: none;
    padding: 8px 9px;
    font-size: 14px;
    line-height: 1;
  }

  .layers {
    display: flex;
    flex-direction: column;
    gap: 2px;
    max-height: 190px;
    overflow-y: auto;
  }
  .layer {
    display: flex;
    align-items: center;
    gap: 2px;
    border: 1px solid transparent;
    border-radius: 6px;
  }
  .layer.active {
    background: rgba(59, 110, 245, 0.16);
    border-color: #3b6ef5;
  }
  .eye {
    flex: none;
    width: 24px;
    padding: 5px 0;
    font-size: 12px;
    background: none;
    border: none;
    color: #9be59b;
  }
  .eye.hidden { color: #5a6273; }
  .eye:hover:not(:disabled) { background: none; }
  .layer-name,
  .layer-name-input {
    flex: 1;
    min-width: 0;
    text-align: left;
    font-size: 13px;
    padding: 5px 6px;
    background: none;
    border: none;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: inherit;
  }
  .layer-name:hover:not(:disabled) { background: rgba(255, 255, 255, 0.05); }
  .layer-name-input {
    font-family: inherit;
    background: #0b0d11;
    border: 1px solid #3b6ef5;
    border-radius: 4px;
    outline: none;
  }

  .text-input {
    width: 100%;
    font-family: ui-monospace, monospace;
    font-size: 13px;
    background: #0b0d11;
    color: #d7dae0;
    border: 1px solid #2c313d;
    border-radius: 6px;
    padding: 6px 8px;
    resize: vertical;
  }
  .pos {
    margin-left: auto;
    display: flex;
    gap: 4px;
  }
  .pos input {
    width: 53px;
    font: inherit;
    font-size: 13px;
    background: #1c2029;
    color: inherit;
    border: 1px solid #2c313d;
    border-radius: 5px;
    padding: 4px 6px;
  }
  .wide {
    width: 100%;
    margin-top: 8px;
  }
  .flip-row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 4px;
    margin-top: 8px;
  }

  .layer-actions {
    display: grid;
    grid-template-columns: repeat(7, 1fr);
    gap: 3px;
    margin-top: 6px;
  }
  .layer-actions button {
    padding: 5px 0;
    font-size: 12px;
    line-height: 1;
  }

  .ramp-preview {
    font-family: ui-monospace, monospace;
    font-size: 14px;
    color: #9be59b;
    background: #0b0d11;
    border: 1px solid #2c313d;
    border-radius: 5px;
    padding: 5px 7px;
    margin-top: 6px;
    text-align: center;
    letter-spacing: 1px;
  }

  .note {
    font-size: 11px;
    line-height: 1.45;
    color: #7c8496;
    margin: 8px 0 0;
    white-space: pre-line;
    font-variant-numeric: tabular-nums;
  }

  .note.warn { color: #e0c169; }

  .link {
    background: none;
    border: none;
    padding: 0 0 0 8px;
    font-size: 12px;
    color: #6d86c8;
    text-decoration: underline;
    cursor: pointer;
  }
  .link:hover:not(:disabled) { background: none; color: #9db4ec; }

  .char-input {
    width: 100%;
    margin-bottom: 6px;
    font-family: ui-monospace, monospace;
    font-size: 22px;
    text-align: center;
    background: #1c2029;
    color: #fff;
    border: 1px solid #2c313d;
    border-radius: 6px;
    padding: 6px;
  }

  details {
    border-top: 1px solid #22262f;
  }
  details:first-of-type { border-top: none; }

  summary {
    list-style: none;
    cursor: pointer;
    padding: 7px 2px;
    font-size: 12px;
    color: #a7aebd;
    display: flex;
    align-items: center;
    gap: 6px;
    user-select: none;
  }
  summary::-webkit-details-marker { display: none; }
  summary::before {
    content: '▸';
    font-size: 9px;
    color: #7c8496;
    transition: transform 0.12s ease;
  }
  details[open] > summary::before { transform: rotate(90deg); }
  summary:hover { color: #fff; }

  .palette {
    display: grid;
    grid-template-columns: repeat(6, 1fr);
    gap: 3px;
    padding: 0 0 10px 14px;
  }
  .swatch {
    font-family: ui-monospace, monospace;
    font-size: 13px;
    padding: 0;
    aspect-ratio: 1;
    display: grid;
    place-items: center;
  }
  .swatch.active {
    background: #3b6ef5;
    border-color: #3b6ef5;
    color: #fff;
  }

  main {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .canvas-wrap {
    flex: 1;
    overflow: auto;
    padding: 20px;
  }

  .grid {
    position: relative;
    display: inline-block;
    margin: 0;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    background: #0b0d11;
    color: #9be59b;
    border: 1px solid #2c313d;
    cursor: crosshair;
    outline: none;
    user-select: none;
    touch-action: none;
    white-space: pre;
  }
  .grid:focus { border-color: #3b6ef5; }
  .grid.text-tool { cursor: text; }
  .grid.select-tool { cursor: cell; }
  .grid.move-tool { cursor: move; }
  .grid.select-tool.grabbable { cursor: grab; }
  .grid.select-tool.grabbable:active { cursor: grabbing; }
  .line { height: inherit; }

  .caret {
    position: absolute;
    background: rgba(59, 110, 245, 0.45);
    pointer-events: none;
  }

  /* Cell guides, drawn from the measured cell size so they line up with glyphs. */
  .gridlines {
    position: absolute;
    inset: 0;
    pointer-events: none;
    background-image:
      linear-gradient(to right, rgba(122, 138, 168, 0.17) 1px, transparent 1px),
      linear-gradient(to bottom, rgba(122, 138, 168, 0.17) 1px, transparent 1px);
  }

  /* Fill on every selected cell, but border only on the sides facing outwards —
     interior edges get 0px widths inline, leaving a single clean outline. */
  .sel-cell {
    position: absolute;
    pointer-events: none;
    background: rgba(59, 110, 245, 0.22);
    border-style: solid;
    border-color: rgba(140, 175, 255, 0.9);
  }

  .marquee {
    position: absolute;
    pointer-events: none;
    background: rgba(59, 110, 245, 0.12);
    border: 1px dashed rgba(140, 175, 255, 0.85);
  }

  .hover-cell {
    position: absolute;
    pointer-events: none;
    background: rgba(155, 229, 155, 0.13);
    outline: 1px solid rgba(155, 229, 155, 0.55);
    outline-offset: -1px;
  }

  /* Zero-sized clip: the span inside still lays out at its true width (so it can be
     measured), but contributes nothing to the scrollable area. */
  .measure-box {
    width: 0;
    height: 0;
    overflow: hidden;
  }
  .measure {
    display: inline-block;
    visibility: hidden;
    white-space: pre;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }

  footer {
    display: flex;
    gap: 16px;
    padding: 8px 14px;
    border-top: 1px solid #262a33;
    font-size: 12px;
    color: #7c8496;
    font-variant-numeric: tabular-nums;
  }
  .toast { margin-left: auto; color: #9be59b; }
</style>
