<script>
  import {
    EMPTY,
    BOX_STYLES,
    boxCells,
    brushPoints,
    cloneGrid,
    flipGrid,
    floodPoints,
    gridToText,
    linePoints,
    makeGrid,
    objectPoints,
    polylineGlyphs,
    rectPoints,
    transformGrid,
    strokePoints
  } from "./ascii.js";
  import { FONTS, loadFont, renderTextGrid } from "./textRender.js";
  import Icon from "./Icon.svelte";

  // Grouped so the palette can be scanned by intent rather than by codepoint.
  // Both ramps run light → dark, which is the order you want for gradients.
  const PALETTE_GROUPS = [
    {
      name: "Blocks & shades",
      chars: [
        " ",
        "░",
        "▒",
        "▓",
        "█", // density ramp
        "▀",
        "▄",
        "▌",
        "▐", // halves
        "▘",
        "▝",
        "▖",
        "▗",
        "▚",
        "▞",
        "▛",
        "▜",
        "▙",
        "▟", // quadrants
        "▁",
        "▂",
        "▃",
        "▅",
        "▆",
        "▇" // eighths, for bars and soft edges
      ]
    },
    {
      name: "ASCII ramp",
      chars: [" ", ".", ":", "-", "=", "+", "*", "%", "#", "@"]
    },
    {
      name: "Punctuation",
      chars: [".", ",", ":", ";", "'", '"', "`", "^", "~", "!", "?"]
    },
    {
      name: "Math & signs",
      chars: ["+", "-", "_", "=", "*", "/", "\\", "|", "<", ">", "&", "$"]
    },
    { name: "Brackets", chars: ["(", ")", "[", "]", "{", "}", "⟨", "⟩"] },
    {
      name: "Letters & digits",
      chars: ["o", "O", "x", "X", "v", "V", "0", "8", "1", "7"]
    },
    {
      name: "Shapes",
      chars: [
        "■",
        "□",
        "▪",
        "▫",
        "●",
        "○",
        "◆",
        "◇",
        "★",
        "☆",
        "▲",
        "▼",
        "◀",
        "▶"
      ]
    },
    {
      name: "Arrows",
      chars: ["←", "→", "↑", "↓", "↔", "↕", "↖", "↗", "↘", "↙"]
    },
    {
      name: "Box — single",
      chars: ["─", "│", "┌", "┐", "└", "┘", "├", "┤", "┬", "┴", "┼"]
    },
    {
      name: "Box — double",
      chars: ["═", "║", "╔", "╗", "╚", "╝", "╠", "╣", "╦", "╩", "╬"]
    },
    { name: "Box — rounded", chars: ["╭", "╮", "╰", "╯"] }
  ];

  // Pressure ramps, light → dark. No blank at the light end: a feather-light touch should
  // still mark the canvas rather than erase what's under it.
  const RAMPS = {
    ASCII: [".", ":", "-", "=", "+", "*", "#", "%", "@"],
    Blocks: ["░", "▒", "▓", "█"],
    Dots: ["·", "∙", "•", "●"]
  };

  // Every layer draws in its own colour, picked from the chip in the layers panel.
  const DEFAULT_INK = "#ffffff";
  const LAYER_COLORS = [
    "#ffffff",
    "#9aa3ad",
    "#00eaff",
    "#6f9dff",
    "#c58cff",
    "#ff5470",
    "#ff9a3d",
    "#ffd644",
    "#5ce65c"
  ];

  let cols = $state(80);
  let rows = $state(24);
  // What the Canvas panel's number fields hold. They only reach `cols`/`rows` on change, so
  // there is still an old size to compare against and to put on the undo stack.
  let colsInput = $state(80);
  let rowsInput = $state(24);
  $effect(() => {
    colsInput = cols;
    rowsInput = rows;
  });

  // Layer stack, bottom-first: index 0 paints first, later layers cover it.
  let layers = $state([
    {
      id: 1,
      name: "Layer 1",
      visible: true,
      color: DEFAULT_INK,
      ox: 0,
      oy: 0,
      grid: makeGrid(80, 24)
    }
  ]);
  let activeIndex = $state(0);
  let nextLayerId = 2;
  let renamingId = $state(null);

  /**
   * The active layer's cells. This is a proxied reference, so every existing
   * `grid[y][x] = ch` write lands on the active layer and re-renders.
   * Whole-grid replacements must assign to `layers[activeIndex].grid` instead.
   */
  const grid = $derived(layers[activeIndex].grid);

  /**
   * Flatten the visible layers, optionally substituting one layer's cells. The override is how
   * in-progress edits preview: they are applied to the active layer and the stack is re-flattened,
   * so lifting content reveals whatever sits underneath it and upper layers still occlude it.
   */
  function flatten(overrideGrid = null, owners = null, overrideOrigin = null) {
    const out = makeGrid(cols, rows);
    layers.forEach((layer, i) => {
      if (!layer.visible) return;
      const active = i === activeIndex;
      const source = overrideGrid && active ? overrideGrid : layer.grid;
      const origin =
        (overrideOrigin && active ? overrideOrigin : layer) ?? layer;
      const ox = origin.ox ?? 0;
      const oy = origin.oy ?? 0;
      // Walk only the part of the layer that lands inside the canvas window.
      const y0 = Math.max(0, -oy);
      const y1 = Math.min(source.length, rows - oy);
      for (let y = y0; y < y1; y++) {
        const row = source[y];
        const x0 = Math.max(0, -ox);
        const x1 = Math.min(row.length, cols - ox);
        for (let x = x0; x < x1; x++) {
          const ch = row[x];
          if (ch !== EMPTY) {
            out[y + oy][x + ox] = ch;
            if (owners) owners[y + oy][x + ox] = i;
          }
        }
      }
    });
    return out;
  }

  const layerOx = $derived(activeLayer.ox ?? 0);
  const layerOy = $derived(activeLayer.oy ?? 0);

  /** One cell of the active layer, addressed in canvas coordinates. */
  const cellAt = (x, y) => grid[y - layerOy]?.[x - layerOx] ?? EMPTY;

  /**
   * The active layer cropped to the canvas. Flood fill and the magic wand both want to reason
   * about what's on screen, and both hand back the coordinates they were given.
   */
  function activeCanvasGrid() {
    const out = makeGrid(cols, rows);
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) out[y][x] = cellAt(x, y);
    }
    return out;
  }

  /**
   * Grow a layer's cells so they cover at least the canvas, keeping everything already
   * outside it. Editing works in canvas coordinates, so this is what lets you paint on the
   * part of a moved layer that has come back into view without cropping the part that hasn't.
   */
  function ensureCanvasCovered(index = activeIndex) {
    const layer = layers[index];
    growLayer(
      layer,
      Math.min(0, layer.ox ?? 0),
      Math.min(0, layer.oy ?? 0),
      Math.max(cols, (layer.ox ?? 0) + (layer.grid[0]?.length ?? 0)),
      Math.max(rows, (layer.oy ?? 0) + layer.grid.length)
    );
  }

  /** Re-lay a layer's cells over a bigger box, in canvas coordinates. A no-op if it fits. */
  function growLayer(layer, minX, minY, maxX, maxY) {
    const ox = layer.ox ?? 0;
    const oy = layer.oy ?? 0;
    const w = layer.grid[0]?.length ?? 0;
    const h = layer.grid.length;
    if (minX === ox && minY === oy && maxX === ox + w && maxY === oy + h)
      return;
    const next = makeGrid(maxX - minX, maxY - minY);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++)
        next[y + oy - minY][x + ox - minX] = layer.grid[y][x];
    }
    layer.grid = next;
    layer.ox = minX;
    layer.oy = minY;
  }

  const makeOwners = () =>
    Array.from({ length: rows }, () => new Array(cols).fill(-1));

  /**
   * All visible layers flattened top-down — what you see, export, and copy — alongside the
   * layer index behind each cell, which is what gives the view its per-layer colours.
   */
  const composite = $derived.by(() => {
    const owners = makeOwners();
    return { chars: flatten(null, owners), owners };
  });

  const activeLayer = $derived(layers[activeIndex]);
  const activeText = $derived(activeLayer.text ?? null);

  let fontVersion = $state(0); // bumped when a webfont finishes loading, to force a re-render

  const TRANSFORMS = [
    {
      key: "skewX",
      label: "Skew X",
      min: -1.5,
      max: 1.5,
      step: 0.05,
      hint: "Cells each row slides sideways, per row from the centre"
    },
    {
      key: "skewY",
      label: "Skew Y",
      min: -1.5,
      max: 1.5,
      step: 0.05,
      hint: "Cells each column slides vertically, per column from the centre"
    },
    {
      key: "rotate",
      label: "Rotate",
      min: -180,
      max: 180,
      step: 1,
      hint: "Degrees clockwise; 90° steps are exact"
    },
    {
      key: "perspX",
      label: "Persp X",
      min: -0.9,
      max: 0.9,
      step: 0.05,
      hint: "Keystone: narrows the top, widens the bottom"
    },
    {
      key: "perspY",
      label: "Persp Y",
      min: -0.9,
      max: 0.9,
      step: 0.05,
      hint: "Keystone: narrows the left, widens the right"
    }
  ];
  const NO_TRANSFORM = { skewX: 0, skewY: 0, rotate: 0, perspX: 0, perspY: 0 };

  // Transform being previewed on a painted layer. Text layers keep theirs as parameters
  // instead, since they regenerate from scratch and would wipe a baked transform.
  let pendingTransform = $state({ ...NO_TRANSFORM });
  const hasPendingTransform = $derived(
    !activeText && TRANSFORMS.some(({ key }) => pendingTransform[key])
  );

  // A different layer means a different pending transform; don't carry it across.
  $effect(() => {
    activeIndex;
    pendingTransform = { ...NO_TRANSFORM };
  });

  /** Read/write a transform value on whichever store the active layer uses. */
  const transformValue = (key) =>
    activeText ? (activeText[key] ?? 0) : pendingTransform[key];

  function setTransform(key, value) {
    if (activeText) layers[activeIndex].text[key] = value;
    else pendingTransform[key] = value;
  }

  function resetTransform() {
    if (activeText) Object.assign(layers[activeIndex].text, NO_TRANSFORM);
    else pendingTransform = { ...NO_TRANSFORM };
  }

  function applyTransform() {
    if (!hasPendingTransform) return;
    snapshot();
    layers[activeIndex].grid = transformGrid(grid, pendingTransform);
    pendingTransform = { ...NO_TRANSFORM };
  }

  /** Commit the polyline being clicked out, if it has at least one segment. */
  function finishPath() {
    const points = polyPoints;
    polyPoints = [];
    if (points.length < 2) return;
    snapshot();
    paint(polylineGlyphs(points, boxStyle));
  }

  /** Everything half-finished gets committed before the canvas changes under it. */
  function commitInProgress() {
    finishPath();
    commitPendingTransform();
  }

  /**
   * Bake an in-progress transform before doing anything that would otherwise throw it away —
   * adding or switching layers, drawing, resizing, exporting. A preview you can see should
   * never silently vanish; it either gets applied or you reset it yourself.
   */
  function commitPendingTransform() {
    if (hasPendingTransform) applyTransform();
  }

  function flipLayer(axis) {
    snapshot();
    if (activeText) {
      const t = layers[activeIndex].text;
      if (axis === "h") t.flipH = !t.flipH;
      else t.flipV = !t.flipV;
      return;
    }
    layers[activeIndex].grid = flipGrid(grid, axis);
  }
  let fontReady = $state(true); // false once a font is known to be unavailable (offline)

  function addTextLayer() {
    commitInProgress();
    snapshot();
    const layer = {
      id: nextLayerId++,
      name: "Text",
      visible: true,
      color: DEFAULT_INK,
      ox: 0,
      oy: 0,
      grid: makeGrid(cols, rows),
      text: {
        content: "HELLO",
        family: "Anton",
        bold: false,
        // Small sizes blob together as counters close up; 7 cells reads cleanly in every font.
        size: 7,
        mode: "half",
        threshold: 0.5,
        letterSpacing: 0,
        lineSpacing: 1.25,
        x: 2,
        y: 2
      }
    };
    layers = [
      ...layers.slice(0, activeIndex + 1),
      layer,
      ...layers.slice(activeIndex + 1)
    ];
    activeIndex += 1;
    selection = null;
  }

  /** How far the active text layer spills past each canvas edge, if at all. */
  const textOverflow = $derived.by(() => {
    if (!activeText || !activeLayer.textBox) return null;
    const { width, height } = activeLayer.textBox;
    const left = Math.max(0, -activeText.x);
    const top = Math.max(0, -activeText.y);
    const right = Math.max(0, activeText.x + width - cols);
    const bottom = Math.max(0, activeText.y + height - rows);
    return left || top || right || bottom ? { left, top, right, bottom } : null;
  });

  /** Grow the canvas so the active text layer fits, shifting everything to keep it aligned. */
  function fitCanvasToText() {
    if (!textOverflow) return;
    const { left, top, right, bottom } = textOverflow;
    snapshot();
    const newCols = Math.min(400, cols + left + right);
    const newRows = Math.min(200, rows + top + bottom);
    for (const layer of layers) {
      if (layer.text) {
        layer.text.x += left;
        layer.text.y += top;
      } else {
        layer.ox = (layer.ox ?? 0) + left;
        layer.oy = (layer.oy ?? 0) + top;
      }
    }
    cols = newCols;
    rows = newRows;
    selection = null;
  }

  /** Bake a text layer into ordinary cells so the drawing tools can touch it. */
  function rasterizeLayer() {
    commitInProgress();
    if (!activeText) return;
    snapshot();
    delete layers[activeIndex].text;
    flash("Text layer rasterized");
  }

  /**
   * Re-render every text layer whenever its parameters (or a newly loaded font) change.
   * This reads only `text` and never `grid`, so writing the grid can't retrigger it.
   */
  $effect(() => {
    fontVersion;
    cols;
    rows;
    for (const layer of layers) {
      if (!layer.text) continue;
      const {
        x,
        y,
        skewX = 0,
        skewY = 0,
        rotate = 0,
        perspX = 0,
        perspY = 0,
        flipH,
        flipV,
        ...options
      } = $state.snapshot(layer.text);
      const {
        grid: rendered,
        width,
        height
      } = renderTextGrid(
        { ...options, ramp: RAMPS.Blocks, solidChar: char },
        cols,
        rows,
        x,
        y
      );
      // Transforms are parameters, re-applied on every render rather than baked once.
      let out = rendered;
      if (flipH) out = flipGrid(out, "h");
      if (flipV) out = flipGrid(out, "v");
      if (skewX || skewY || rotate || perspX || perspY) {
        out = transformGrid(out, { skewX, skewY, rotate, perspX, perspY });
      }
      layer.grid = out;
      layer.ox = 0;
      layer.oy = 0;
      layer.textBox = { width, height };
    }
  });

  /** Ask the browser for a webfont, then bump the version so text layers re-render with it. */
  function useFont(family) {
    if (!activeText) return;
    layers[activeIndex].text.family = family;
  }

  $effect(() => {
    // Fetch whatever font the active text layer wants (including after undo swaps it back),
    // then re-render once it's genuinely usable.
    if (!activeText) return;
    const family = activeText.family;
    fontReady = document.fonts.check(`64px "${family}"`);
    loadFont(family).then((ok) => {
      fontReady = ok;
      fontVersion += 1;
    });
  });

  let tool = $state("pencil");
  // Primary / secondary characters, à la Photoshop's foreground / background swatches.
  let char = $state("#");
  let altChar = $state(" ");
  let activeSlot = $state("primary");
  let boxStyle = $state("single");
  let filled = $state(false);
  let sameCharOnly = $state(false); // magic wand: stop at a different character, not just at blanks
  let pressureSize = $state(true);
  let pressureDensity = $state(true);
  let rampName = $state("ASCII");
  let dynamics = $state("pressure"); // what drives the brush: 'pressure' | 'speed' | 'off'

  // Diagnostics for the last stroke, so it's obvious what the tablet is actually reporting.
  let pointerKind = $state(null);
  let lastForce = $state(null);
  let strokeMin = $state(null);
  let strokeMax = $state(null);
  let lastSample = null; // {x, y, t} — plain let: needed between events, never rendered
  let speedForceValue = 1;
  let fontSize = $state(16);
  // Display-only cell metrics: extra px between columns, and the row height multiplier.
  let letterSpacing = $state(0);
  let lineHeight = $state(1.2);
  let showGrid = $state(true);
  let brushSize = $state(1);
  // Which palette groups are expanded; the rest stay collapsed to keep the palette short.
  let openGroups = $state({ "Blocks & shades": true, "Box — single": true });

  let undoStack = $state([]);
  let redoStack = $state([]);

  // Drag / preview state
  let dragging = $state(false);
  let strokeChar = $state(null); // character the in-progress stroke commits (right-drag uses the secondary)

  // Selection state. `selection` is the set of selected cells; `moving` holds the lifted
  // characters while a move drag is in flight; `marquee` is the rubber-band box being dragged.
  let selection = $state(null); // [[x, y], ...]
  let marquee = $state(null); // [x0, y0, x1, y1]
  let moving = $state(null); // { cells: [[x, y, ch]], dx, dy, copy }
  let layerShift = $state(null); // { dx, dy } while the Move tool drags a whole layer
  let polyPoints = $state([]); // committed vertices of the Path tool's in-progress line
  let straightMode = $state(false); // Shift held at press: freehand tools draw a straight line
  let strokeForce = $state(1); // force sampled at press, so a straight stroke is uniform
  let start = $state(null); // [x, y]
  let end = $state(null); // [x, y]
  let hover = $state(null); // [x, y]
  let caret = $state(null); // [x, y] for the text tool

  let gridEl = $state(null);
  let measureEl = $state(null);
  let cellW = $state(9.6);

  const cellH = $derived(Math.max(1, Math.round(fontSize * lineHeight)));
  const isShape = $derived(
    tool === "line" || tool === "rect" || tool === "box"
  );
  const isPath = $derived(tool === "path");
  const isBrush = $derived(
    tool === "pencil" || tool === "eraser" || tool === "brush"
  );
  // Line strokes are stamped with the same brush, so it takes a size too.
  const usesSize = $derived(isBrush || tool === "line");
  // The hover outline traces the brush footprint, so only sized tools widen it.
  const brushSpan = $derived(usesSize ? brushSize : 1);
  const brushOffset = $derived(Math.floor((brushSpan - 1) / 2));
  const activeChar = $derived(activeSlot === "primary" ? char : altChar);
  const selKeys = $derived(
    new Set((selection ?? []).map(([x, y]) => `${x},${y}`))
  );

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
      left: !selKeys.has(`${x - 1},${y}`)
    }))
  );
  const hoverInSelection = $derived(
    !!hover && selKeys.has(`${hover[0]},${hover[1]}`)
  );

  // Switching away from Path commits the line rather than dropping the clicks.
  let previousTool = "pencil";
  $effect(() => {
    if (tool === previousTool) return;
    if (previousTool === "path") finishPath();
    previousTool = tool;
  });

  // Leaving the Select tool drops the selection, so a stale marquee can't linger over drawing.
  $effect(() => {
    if (tool !== "select") {
      selection = null;
      marquee = null;
      moving = null;
    }
  });

  function setActiveChar(value) {
    // Keep the last typed character so the single-cell input behaves like a replace.
    const next = [...value].pop() ?? " ";
    if (activeSlot === "primary") char = next;
    else altChar = next;
  }

  function resetSpacing() {
    letterSpacing = 0;
    lineHeight = 1.2;
  }

  function swapChars() {
    const previous = char;
    char = altChar;
    altChar = previous;
  }

  $effect(() => {
    // Re-measure whenever the font size or tracking changes. CSS letter-spacing adds a gap
    // after every character including the last, so width / 50 is exactly the cell pitch.
    fontSize;
    letterSpacing;
    if (!measureEl) return;
    cellW = measureEl.getBoundingClientRect().width / 50;
  });

  /** Cells the in-progress drag would paint, as [x, y, char]. */
  const preview = $derived.by(() => {
    if (isPath) {
      if (!polyPoints.length) return [];
      // The segment to the cursor rubber-bands until the next click pins it down.
      return polylineGlyphs(
        hover ? [...polyPoints, hover] : polyPoints,
        boxStyle
      );
    }
    if (!dragging || !start || !end) return [];
    const [x0, y0] = start;
    const [x1, y1] = end;
    const ch = strokeChar ?? char;

    // Shift-constrained freehand: one straight line from the press to the pointer.
    if (straightMode && isBrush) {
      const lineChar =
        tool === "eraser"
          ? EMPTY
          : tool === "brush"
            ? charFor(strokeForce)
            : ch;
      const size = tool === "brush" ? sizeFor(strokeForce) : brushSize;
      return strokePoints(linePoints(x0, y0, x1, y1), size).map(([x, y]) => [
        x,
        y,
        lineChar
      ]);
    }
    if (!isShape) return [];
    if (tool === "line") {
      return strokePoints(linePoints(x0, y0, x1, y1), brushSize).map(
        ([x, y]) => [x, y, ch]
      );
    }
    if (tool === "rect")
      return rectPoints(x0, y0, x1, y1, filled).map(([x, y]) => [x, y, ch]);
    return boxCells(x0, y0, x1, y1, boxStyle);
  });

  /** The active layer with any in-flight edit applied, or null when nothing is in progress. */
  const previewLayer = $derived.by(() => {
    const isMoving = moving && (moving.dx || moving.dy);
    if (!isMoving && !preview.length && !hasPendingTransform) return null;

    const out = hasPendingTransform
      ? transformGrid(grid, pendingTransform)
      : cloneGrid(grid);
    // The cells arrive in canvas coordinates; the layer keeps its own.
    const put = (x, y, ch) => {
      const gy = y - layerOy;
      const gx = x - layerOx;
      if (gy >= 0 && gy < out.length && gx >= 0 && gx < out[gy].length)
        out[gy][gx] = ch;
    };
    if (isMoving) {
      // Lift first, then stamp, so the source only clears where the copy isn't landing.
      if (!moving.copy) for (const [x, y] of moving.cells) put(x, y, EMPTY);
      for (const [x, y, ch] of moving.cells)
        put(x + moving.dx, y + moving.dy, ch);
    }
    for (const [x, y, ch] of preview) put(x, y, ch);
    return out;
  });

  /** A Move drag in flight: the layer stays put, its origin previews somewhere else. */
  const previewOrigin = $derived(
    layerShift && (layerShift.dx || layerShift.dy)
      ? { ox: layerOx + layerShift.dx, oy: layerOy + layerShift.dy }
      : null
  );

  /**
   * A row as the fewest coloured runs that cover it. A blank carries no colour of its own, so
   * it joins the run it follows rather than splitting one — most rows come out as a single
   * span, which keeps drawing as cheap as it was when everything was one colour.
   */
  function rowRuns(row, ownerRow) {
    const runs = [];
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const owner = ownerRow[x];
      const color =
        ch === EMPTY || owner < 0
          ? null
          : (layers[owner]?.color ?? DEFAULT_INK);
      const last = runs[runs.length - 1];
      if (last && (color === null || last.color === color)) last.text += ch;
      else runs.push({ color: color ?? DEFAULT_INK, text: ch });
    }
    return runs;
  }

  /** The flattened stack as coloured runs, previewing edits on the active layer. */
  const displayRows = $derived.by(() => {
    const live = previewLayer || previewOrigin;
    const owners = live ? makeOwners() : composite.owners;
    const chars = live
      ? flatten(previewLayer, owners, previewOrigin)
      : composite.chars;
    return chars.map((row, y) => rowRuns(row, owners[y]));
  });

  /**
   * What Copy, Export and the size readout use. An unapplied transform is included, so
   * exporting can't quietly hand back art that looks nothing like what's on screen.
   */
  const exportView = $derived.by(() => {
    if (!hasPendingTransform) return composite;
    const owners = makeOwners();
    return {
      chars: flatten(transformGrid(grid, pendingTransform), owners),
      owners
    };
  });

  const text = $derived(gridToText(exportView.chars));

  /** Undo entries capture the whole stack, so layer adds/deletes/reorders are undoable too. */
  function captureState() {
    return {
      layers: layers.map((l) => ({ ...l, grid: cloneGrid(l.grid) })),
      activeIndex,
      cols,
      rows
    };
  }

  function restoreState(state) {
    // Clone on the way out too: the stack entry must not become live, mutable state.
    layers = state.layers.map((l) => ({ ...l, grid: cloneGrid(l.grid) }));
    activeIndex = Math.min(state.activeIndex, state.layers.length - 1);
    cols = state.cols;
    rows = state.rows;
  }

  function snapshot() {
    undoStack = [...undoStack.slice(-99), captureState()];
    redoStack = [];
  }

  function undo() {
    if (!undoStack.length) return;
    const prev = undoStack[undoStack.length - 1];
    undoStack = undoStack.slice(0, -1);
    redoStack = [...redoStack, captureState()];
    restoreState(prev);
  }

  function redo() {
    if (!redoStack.length) return;
    const next = redoStack[redoStack.length - 1];
    redoStack = redoStack.slice(0, -1);
    undoStack = [...undoStack, captureState()];
    restoreState(next);
  }

  function paint(cells) {
    ensureCanvasCovered();
    const layer = layers[activeIndex];
    const g = layer.grid;
    const ox = layer.ox ?? 0;
    const oy = layer.oy ?? 0;
    for (const [x, y, ch] of cells) {
      const gy = y - oy;
      if (gy < 0 || gy >= g.length) continue;
      const gx = x - ox;
      if (gx < 0 || gx >= g[gy].length) continue;
      g[gy][gx] = ch;
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
    pointerKind = event.pointerType;
    let f;
    if (dynamics === "off") f = 1;
    else if (dynamics === "speed") f = speedForce(event);
    else f = event.pointerType === "pen" ? Math.max(event.pressure, 0.01) : 1;

    lastForce = f;
    strokeMin = strokeMin === null ? f : Math.min(strokeMin, f);
    strokeMax = strokeMax === null ? f : Math.max(strokeMax, f);
    return f;
  }

  /** Slow strokes press hard, fast strokes press light — smoothed so it doesn't jitter. */
  function speedForce(event) {
    const t = event.timeStamp;
    const { clientX: x, clientY: y } = event;
    if (!lastSample) {
      lastSample = { x, y, t };
      return speedForceValue;
    }
    const dt = Math.max(1, t - lastSample.t);
    const distance = Math.hypot(x - lastSample.x, y - lastSample.y);
    lastSample = { x, y, t };
    const target = Math.min(1, Math.max(0.05, 1 - distance / dt / 1.5));
    speedForceValue = speedForceValue * 0.6 + target * 0.4;
    return speedForceValue;
  }

  function beginStroke(event) {
    pointerKind = event.pointerType;
    strokeMin = null;
    strokeMax = null;
    lastSample = null;
    speedForceValue = 1;
  }

  const dynamicsNote = $derived.by(() => {
    if (dynamics === "off") return "Every dab draws at full force.";
    if (!pointerKind) return "Draw a stroke to see what your device reports.";
    const range =
      strokeMin === null
        ? ""
        : ` · stroke ${strokeMin.toFixed(2)}–${strokeMax.toFixed(2)}`;
    const head = `${pointerKind} · now ${lastForce?.toFixed(2) ?? "–"}${range}`;
    if (dynamics === "pressure" && pointerKind !== "pen") {
      return `${head}\nNot a pen — no pressure available. Switch Dynamics to Speed.`;
    }
    if (
      dynamics === "pressure" &&
      strokeMin !== null &&
      strokeMax - strokeMin < 0.02
    ) {
      return `${head}\nConstant pressure: your driver isn't sending analog values. Try Speed.`;
    }
    return head;
  });

  const sizeFor = (p) =>
    pressureSize ? Math.max(1, Math.round(p * brushSize)) : brushSize;

  function charFor(p) {
    if (!pressureDensity) return strokeChar ?? char;
    const ramp = RAMPS[rampName];
    const i = Math.min(
      ramp.length - 1,
      Math.max(0, Math.round(p * (ramp.length - 1)))
    );
    return ramp[i];
  }

  /** One pressure-weighted dab from `from` to `to`. */
  function brushSegment(from, to, p) {
    const path = linePoints(from[0], from[1], to[0], to[1]);
    const ch = charFor(p);
    paint(strokePoints(path, sizeFor(p)).map(([x, y]) => [x, y, ch]));
  }

  /**
   * The cell under a pointer event. Outside the canvas this returns null, except with
   * `clamp` — during a drag the pointer wandering off the edge should keep the stroke or
   * shape tracking along that edge rather than freezing at whatever cell it last touched.
   */
  function cellFromEvent(event, { clamp = false } = {}) {
    if (!gridEl) return null;
    const rect = gridEl.getBoundingClientRect();
    const x = Math.floor((event.clientX - rect.left) / cellW);
    const y = Math.floor((event.clientY - rect.top) / cellH);
    if (clamp) {
      return [
        Math.min(cols - 1, Math.max(0, x)),
        Math.min(rows - 1, Math.max(0, y))
      ];
    }
    if (x < 0 || x >= cols || y < 0 || y >= rows) return null;
    return [x, y];
  }

  function onPointerDown(event) {
    const cell = cellFromEvent(event);
    if (!cell) return;
    if (isPath) {
      gridEl?.focus();
      if (event.button === 2) finishPath();
      else polyPoints = [...polyPoints, cell];
      return;
    }
    // Capture on the canvas itself, not event.target: the target is a row <div> whose text is
    // rewritten as you draw, and capture is lost the moment that node is replaced.
    gridEl?.setPointerCapture?.(event.pointerId);
    dragging = true;
    start = cell;
    end = cell;

    if (tool === "text") {
      caret = cell;
      gridEl?.focus();
      return;
    }
    if (tool === "move") {
      gridEl?.focus();
      layerShift = { dx: 0, dy: 0 };
      return;
    }
    // A text layer is regenerated from its parameters, so painting on it would be erased.
    if (activeText) {
      dragging = false;
      flash(
        "Text layer — edit it with the Font tool, or Rasterize to draw on it"
      );
      return;
    }
    if (tool === "select") {
      gridEl?.focus();
      if (selKeys.has(`${cell[0]},${cell[1]}`)) {
        // Grab the current selection's characters; Alt drags out a copy instead of moving.
        moving = {
          cells: selection.map(([x, y]) => [x, y, cellAt(x, y)]),
          dx: 0,
          dy: 0,
          copy: event.altKey
        };
      } else {
        marquee = [cell[0], cell[1], cell[0], cell[1]];
        selection = null;
      }
      return;
    }
    commitInProgress();
    // Right button draws with the secondary character, mirroring Photoshop's background colour.
    strokeChar = event.button === 2 ? altChar : char;
    snapshot();

    // Shift at press turns a freehand tool into a line: preview only, commit on release.
    straightMode = event.shiftKey && isBrush;
    if (straightMode) {
      if (tool === "brush") {
        beginStroke(event);
        strokeForce = forceOf(event);
      }
      return;
    }

    if (tool === "brush") {
      beginStroke(event);
      brushSegment(cell, cell, forceOf(event));
    } else if (isBrush) {
      const ch = tool === "eraser" ? EMPTY : strokeChar;
      paint(
        brushPoints(cell[0], cell[1], brushSize).map(([x, y]) => [x, y, ch])
      );
    } else if (tool === "fill") {
      paint(
        floodPoints(activeCanvasGrid(), cell[0], cell[1]).map(([x, y]) => [
          x,
          y,
          strokeChar
        ])
      );
    }
  }

  function onPointerMove(event) {
    // The hover highlight only makes sense over the canvas, but a drag keeps tracking along
    // the edge when the pointer leaves it.
    hover = cellFromEvent(event);
    if (!dragging) return;
    const cell = hover ?? cellFromEvent(event, { clamp: true });
    if (!cell) return;
    if (tool === "move") {
      // Clamp the preview too, so what you drag is what you get.
      layerShift = { dx: cell[0] - start[0], dy: cell[1] - start[1] };
      end = cell;
      return;
    }
    if (tool === "select") {
      if (moving) {
        moving.dx = cell[0] - start[0];
        moving.dy = cell[1] - start[1];
      } else if (marquee) {
        marquee = [marquee[0], marquee[1], cell[0], cell[1]];
      }
      end = cell;
      return;
    }
    if (straightMode) {
      end = cell; // the line redraws from the anchor; nothing is committed until release
      return;
    }
    if (tool === "brush") {
      // Coalesced events carry the sub-frame samples a tablet reports between animation
      // frames — using them keeps pressure and curvature that a single event would drop.
      const samples = event.getCoalescedEvents?.() ?? [];
      let prev = end ?? cell;
      for (const sample of samples.length ? samples : [event]) {
        const c = cellFromEvent(sample);
        if (!c) continue;
        brushSegment(prev, c, forceOf(sample));
        prev = c;
      }
      end = prev;
      return;
    }
    if (isBrush) {
      const ch = tool === "eraser" ? EMPTY : (strokeChar ?? char);
      // Interpolate so fast drags don't leave gaps.
      const [px, py] = end ?? cell;
      const path = linePoints(px, py, cell[0], cell[1]);
      paint(strokePoints(path, brushSize).map(([x, y]) => [x, y, ch]));
    }
    end = cell;
  }

  function onPointerUp() {
    // Also fires from the window, so a release outside the canvas — or outside the browser —
    // still ends the drag. Without the guard the second delivery would re-commit the stroke.
    if (!dragging) return;
    if ((isShape || straightMode) && preview.length) paint(preview);
    if (tool === "select") finishSelectDrag();
    if (tool === "move") commitLayerShift();
    straightMode = false;
    dragging = false;
    start = null;
    end = null;
    strokeChar = null;
  }

  /** Bake the Move tool's drag into the active layer. */
  function commitLayerShift() {
    if (!layerShift) return;
    const { dx, dy } = layerShift;
    layerShift = null;
    if (!dx && !dy) return;
    nudgeLayer(dx, dy);
  }

  /**
   * Move the whole active layer by whole cells. Nothing is clamped to the canvas and nothing
   * is dropped at the edge: a painted layer moves by its origin and a text layer by its
   * anchor, so in both cases the cells themselves are left alone and only the view crops.
   */
  function nudgeLayer(dx, dy) {
    if (!dx && !dy) return;
    snapshot();
    if (activeText) {
      layers[activeIndex].text.x += dx;
      layers[activeIndex].text.y += dy;
      return;
    }
    layers[activeIndex].ox = layerOx + dx;
    layers[activeIndex].oy = layerOy + dy;
  }

  function selectAll() {
    tool = "select";
    selection = rectPoints(0, 0, cols - 1, rows - 1, true);
    gridEl?.focus();
  }

  function finishSelectDrag() {
    if (moving) {
      commitMove();
      moving = null;
      return;
    }
    if (!marquee) return;
    const [x0, y0, x1, y1] = marquee;
    marquee = null;
    if (x0 === x1 && y0 === y1) {
      // A click with no drag acts as a magic wand; on blank canvas it just clears.
      const object = objectPoints(activeCanvasGrid(), x0, y0, {
        sameChar: sameCharOnly
      });
      selection = object.length ? object : null;
      return;
    }
    const cells = rectPoints(x0, y0, x1, y1, true);
    selection = cells.length ? cells : null;
  }

  /** Write the lifted characters at their new home and follow them with the selection. */
  function commitMove() {
    const { cells, dx, dy, copy } = moving;
    if (!dx && !dy) return;
    snapshot();
    if (!copy) paint(cells.map(([x, y]) => [x, y, EMPTY]));
    paint(cells.map(([x, y, ch]) => [x + dx, y + dy, ch]));
    selection = cells
      .map(([x, y]) => [x + dx, y + dy])
      .filter(([x, y]) => x >= 0 && x < cols && y >= 0 && y < rows);
    if (!selection.length) selection = null;
  }

  /** Shift the selection by whole cells — used by the arrow keys. */
  function nudge(dx, dy) {
    if (!selection) return;
    moving = {
      cells: selection.map(([x, y]) => [x, y, cellAt(x, y)]),
      dx,
      dy,
      copy: false
    };
    commitMove();
    moving = null;
  }

  function deleteSelection() {
    if (!selection) return;
    snapshot();
    paint(selection.map(([x, y]) => [x, y, EMPTY]));
  }

  function onKeyDown(event) {
    // Bound to the window so shortcuts work after clicking a panel control, but form
    // fields (the layer rename box, size inputs, the character slot) keep their own keys.
    const target = event.target;
    if (
      target instanceof HTMLInputElement ||
      target instanceof HTMLSelectElement ||
      target instanceof HTMLTextAreaElement
    ) {
      return;
    }
    const meta = event.metaKey || event.ctrlKey;
    if (meta && event.key.toLowerCase() === "z") {
      event.preventDefault();
      event.shiftKey ? redo() : undo();
      return;
    }
    if (meta && event.key.toLowerCase() === "y") {
      event.preventDefault();
      redo();
      return;
    }
    if (meta && event.key.toLowerCase() === "c") {
      event.preventDefault();
      copyText();
      return;
    }
    if (meta && event.key.toLowerCase() === "x") {
      event.preventDefault();
      cutSelection();
      return;
    }
    if (meta && event.key.toLowerCase() === "a") {
      event.preventDefault();
      selectAll();
      return;
    }
    if (meta && event.key.toLowerCase() === "d") {
      event.preventDefault();
      selection = null;
      return;
    }
    if (meta) return;

    if (tool === "move" && event.key.startsWith("Arrow")) {
      event.preventDefault();
      const d = {
        ArrowLeft: [-1, 0],
        ArrowRight: [1, 0],
        ArrowUp: [0, -1],
        ArrowDown: [0, 1]
      }[event.key];
      nudgeLayer(d[0], d[1]);
      return;
    }

    if (isPath && polyPoints.length) {
      if (event.key === "Enter") {
        event.preventDefault();
        finishPath();
        return;
      }
      if (event.key === "Escape") {
        // Escape releases the line rather than discarding it: it's committed and the tool
        // stays put, ready for the next one. Undo is there if it wasn't wanted.
        finishPath();
        return;
      }
    }

    if (tool === "select" && selection) {
      if (event.key === "Escape") {
        selection = null;
        return;
      }
      if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        deleteSelection();
        return;
      }
      if (event.key.startsWith("Arrow")) {
        event.preventDefault();
        const d = {
          ArrowLeft: [-1, 0],
          ArrowRight: [1, 0],
          ArrowUp: [0, -1],
          ArrowDown: [0, 1]
        }[event.key];
        nudge(d[0], d[1]);
        return;
      }
    }

    if (tool === "text" && caret) {
      const [x, y] = caret;
      if (event.key === "Backspace") {
        event.preventDefault();
        snapshot();
        const nx = Math.max(0, x - 1);
        paint([[nx, y, EMPTY]]);
        caret = [nx, y];
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        caret = [start?.[0] ?? 0, Math.min(rows - 1, y + 1)];
        return;
      }
      if (event.key.startsWith("Arrow")) {
        event.preventDefault();
        const d = {
          ArrowLeft: [-1, 0],
          ArrowRight: [1, 0],
          ArrowUp: [0, -1],
          ArrowDown: [0, 1]
        }[event.key];
        caret = [
          Math.min(cols - 1, Math.max(0, x + d[0])),
          Math.min(rows - 1, Math.max(0, y + d[1]))
        ];
        return;
      }
      if ([...event.key].length === 1) {
        event.preventDefault();
        snapshot();
        paint([[x, y, event.key]]);
        caret = x + 1 < cols ? [x + 1, y] : [0, Math.min(rows - 1, y + 1)];
        return;
      }
      return;
    }

    const key = event.key.toLowerCase();
    if (key === "x") {
      swapChars();
      return;
    }
    if (key === "-" || key === "=" || key === "+") {
      fontSize = Math.min(56, Math.max(8, fontSize + (key === "-" ? -2 : 2)));
      return;
    }
    if (key === "[" || key === "]") {
      brushSize = Math.min(9, Math.max(1, brushSize + (key === "]" ? 1 : -1)));
      return;
    }
    if (key === "g") {
      showGrid = !showGrid;
      return;
    }
    const shortcut = {
      p: "pencil",
      b: "brush",
      e: "eraser",
      l: "line",
      r: "rect",
      o: "box",
      f: "fill",
      t: "text",
      s: "select",
      v: "move",
      d: "path"
    }[key];
    if (shortcut) tool = shortcut;
  }

  function addLayer() {
    commitInProgress();
    snapshot();
    const layer = {
      id: nextLayerId++,
      name: `Layer ${nextLayerId - 1}`,
      visible: true,
      color: DEFAULT_INK,
      ox: 0,
      oy: 0,
      grid: makeGrid(cols, rows)
    };
    layers = [
      ...layers.slice(0, activeIndex + 1),
      layer,
      ...layers.slice(activeIndex + 1)
    ];
    activeIndex += 1;
    selection = null;
  }

  function duplicateLayer() {
    commitInProgress();
    snapshot();
    const source = layers[activeIndex];
    const copy = {
      id: nextLayerId++,
      name: `${source.name} copy`,
      visible: source.visible,
      color: source.color,
      ox: source.ox ?? 0,
      oy: source.oy ?? 0,
      grid: cloneGrid(source.grid)
    };
    layers = [
      ...layers.slice(0, activeIndex + 1),
      copy,
      ...layers.slice(activeIndex + 1)
    ];
    activeIndex += 1;
    selection = null;
  }

  function deleteLayer() {
    commitInProgress();
    if (layers.length === 1) return;
    snapshot();
    layers = layers.filter((_, i) => i !== activeIndex);
    activeIndex = Math.max(0, activeIndex - 1);
    selection = null;
  }

  /** Move the active layer one step up (+1) or down (-1) the stack. */
  function moveLayer(direction) {
    commitInProgress();
    const target = activeIndex + direction;
    if (target < 0 || target >= layers.length) return;
    snapshot();
    const next = layers.slice();
    [next[activeIndex], next[target]] = [next[target], next[activeIndex]];
    layers = next;
    activeIndex = target;
  }

  /** Flatten the active layer onto the one below it, keeping the lower layer's name. */
  function mergeDown() {
    commitInProgress();
    if (activeIndex === 0) return;
    snapshot();
    const upper = layers[activeIndex];
    const lower = layers[activeIndex - 1];
    // The two layers can sit at different origins and be different sizes, so grow the lower
    // one to hold both before stamping — merging must not crop either of them.
    const ux = upper.ox ?? 0;
    const uy = upper.oy ?? 0;
    growLayer(
      lower,
      Math.min(lower.ox ?? 0, ux),
      Math.min(lower.oy ?? 0, uy),
      Math.max(
        (lower.ox ?? 0) + (lower.grid[0]?.length ?? 0),
        ux + (upper.grid[0]?.length ?? 0)
      ),
      Math.max((lower.oy ?? 0) + lower.grid.length, uy + upper.grid.length)
    );
    const lx = lower.ox ?? 0;
    const ly = lower.oy ?? 0;
    for (let y = 0; y < upper.grid.length; y++) {
      for (let x = 0; x < upper.grid[y].length; x++) {
        const ch = upper.grid[y][x];
        if (ch !== EMPTY) lower.grid[y + uy - ly][x + ux - lx] = ch;
      }
    }
    layers = layers.filter((_, i) => i !== activeIndex);
    activeIndex -= 1;
    selection = null;
  }

  function toggleVisible(index) {
    layers[index].visible = !layers[index].visible;
  }

  function selectLayer(index) {
    if (index === activeIndex) return;
    commitInProgress();
    activeIndex = index;
    selection = null;
    caret = null;
  }

  /**
   * The canvas is a window onto the layers rather than their extent, so resizing it crops the
   * view and nothing else — shrink it and grow it again and the art comes back.
   */
  function applySize() {
    commitInProgress();
    const c = Number.isFinite(colsInput)
      ? Math.max(1, Math.min(400, Math.round(colsInput)))
      : cols;
    const r = Number.isFinite(rowsInput)
      ? Math.max(1, Math.min(200, Math.round(rowsInput)))
      : rows;
    colsInput = c;
    rowsInput = r;
    if (c === cols && r === rows) return;
    snapshot();
    cols = c;
    rows = r;
    caret = null;
    selection = null;
  }

  /** Clears the active layer only; the rest of the stack is untouched. */
  function clearAll() {
    commitInProgress();
    snapshot();
    layers[activeIndex].grid = makeGrid(cols, rows);
    layers[activeIndex].ox = 0;
    layers[activeIndex].oy = 0;
    caret = null;
    selection = null;
  }

  /**
   * The selected cells as text, cropped to their bounding box. Cells inside the box that
   * aren't selected come out blank, so an irregular wand selection keeps its shape instead of
   * dragging its neighbours along. With nothing selected this is the whole canvas.
   */
  const selectionText = $derived.by(() => {
    if (!selection?.length) return text;
    const xs = selection.map(([x]) => x);
    const ys = selection.map(([, y]) => y);
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    const out = makeGrid(
      Math.max(...xs) - minX + 1,
      Math.max(...ys) - minY + 1
    );
    for (const [x, y] of selection) {
      if (y < composite.chars.length && x < cols)
        out[y - minY][x - minX] = composite.chars[y][x];
    }
    return gridToText(out);
  });

  async function copyText() {
    const content = selectionText;
    const what = selection?.length ? "selection" : "canvas";
    try {
      await navigator.clipboard.writeText(content);
      flash(`Copied ${what} to clipboard`);
    } catch {
      flash("Clipboard blocked — try ⌘C, or Export instead");
    }
  }

  /** Copy the selection, then clear the cells it covers on the active layer. */
  async function cutSelection() {
    if (!selection?.length) return;
    await copyText();
    deleteSelection();
  }

  function saveBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
    flash(`Saved ${filename}`);
  }

  function exportText() {
    saveBlob(new Blob([text], { type: "text/plain" }), "ascii-art.txt");
  }

  /**
   * Draw the flattened stack into a bitmap at the on-screen cell metrics, so an exported
   * image matches the canvas: same zoom, same spacing, same per-layer colours. `scale` only
   * multiplies the pixel density — the layout is identical at any value.
   */
  function renderBitmap(scale = 2) {
    const { chars, owners } = exportView;
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(cols * cellW * scale));
    canvas.height = Math.max(1, Math.round(rows * cellH * scale));
    const ctx = canvas.getContext("2d");

    // The canvas element's own background, so the image reads the way the editor does —
    // and so JPEG, which has no alpha, doesn't fall back to black.
    ctx.fillStyle = gridEl
      ? getComputedStyle(gridEl).backgroundColor
      : "#1d1d1d";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.scale(scale, scale);
    ctx.font = `${fontSize}px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;
    ctx.textBaseline = "middle";

    // Cell by cell rather than run by run: `ctx.letterSpacing` isn't supported everywhere,
    // and giving each glyph its own column keeps the bitmap on exactly the screen's grid.
    for (let y = 0; y < chars.length; y++) {
      for (let x = 0; x < chars[y].length; x++) {
        const ch = chars[y][x];
        if (ch === EMPTY) continue;
        ctx.fillStyle = layers[owners[y][x]]?.color ?? DEFAULT_INK;
        ctx.fillText(ch, x * cellW, y * cellH + cellH / 2);
      }
    }
    return canvas;
  }

  function exportImage(format) {
    renderBitmap().toBlob(
      (blob) => {
        if (!blob) return flash("Could not render the image");
        saveBlob(blob, `ascii-art.${format}`);
      },
      format === "jpg" ? "image/jpeg" : "image/png",
      0.92
    );
  }

  /**
   * Drop pasted text onto the canvas as a moveable selection.
   *
   * Blanks in the pasted block are treated as transparent, so pasting art over existing work
   * doesn't punch a rectangular hole through it — and the selection that comes back covers
   * exactly the cells that landed, ready to drag.
   */
  function placePaste(content) {
    const lines = content.replace(/\r\n?/g, "\n").split("\n");
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    if (!lines.length) {
      flash("Clipboard has no text");
      return;
    }

    // A text layer regenerates from its parameters, so give the paste a layer of its own.
    if (activeText) addLayer();
    commitPendingTransform();

    const [originX, originY] = selection?.length
      ? [
          Math.min(...selection.map(([x]) => x)),
          Math.min(...selection.map(([, y]) => y))
        ]
      : (caret ?? hover ?? [0, 0]);

    const cells = [];
    let clipped = false;
    lines.forEach((line, dy) => {
      [...line].forEach((ch, dx) => {
        if (ch === EMPTY) return;
        const x = originX + dx;
        const y = originY + dy;
        if (x < 0 || x >= cols || y < 0 || y >= rows) clipped = true;
        else cells.push([x, y, ch]);
      });
    });
    if (!cells.length) {
      flash("Nothing to paste here");
      return;
    }

    snapshot();
    paint(cells);
    tool = "select";
    selection = cells.map(([x, y]) => [x, y]);
    gridEl?.focus();
    const width = Math.max(...lines.map((l) => [...l].length));
    flash(
      `Pasted ${width}×${lines.length}${clipped ? " (clipped at the edge)" : ""} — drag to move`
    );
  }

  /** The paste event carries the clipboard directly, so it needs no permission prompt. */
  function onPaste(event) {
    const target = event.target;
    if (
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement
    ) {
      return;
    }
    const content = event.clipboardData?.getData("text/plain");
    if (!content) return;
    event.preventDefault();
    placePaste(content);
  }

  let toast = $state("");
  let toastTimer;
  function flash(message) {
    toast = message;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toast = ""), 2000);
  }

  // ── Chrome ─────────────────────────────────────────────────────────────────
  // Three toolbar groups, matching the Figma file: selection, drawing, and the two
  // buttons that open a panel rather than arm a tool.
  const SELECT_TOOLS = [
    {
      id: "move",
      label: "Move",
      key: "V",
      icon: "move",
      hint: "Drag anywhere to move the whole layer"
    },
    {
      id: "select",
      label: "Select",
      key: "S",
      icon: "select",
      hint: "Click an object or drag a box, then drag to move"
    }
  ];
  const DRAW_TOOLS = [
    {
      id: "pencil",
      label: "Pencil",
      key: "P",
      icon: "pencil",
      hint: "Draw with the current character"
    },
    {
      id: "brush",
      label: "Brush",
      key: "B",
      icon: "brush",
      hint: "Pressure-sensitive brush for pen tablets"
    },
    {
      id: "eraser",
      label: "Eraser",
      key: "E",
      icon: "eraser",
      hint: "Erase to blank"
    },
    {
      id: "fill",
      label: "Fill",
      key: "F",
      icon: "fill",
      hint: "Flood fill a region"
    },
    {
      id: "shape",
      label: "Path",
      key: "D",
      icon: "path",
      hint: "Path, line, rectangle and box"
    },
    {
      id: "text",
      label: "Font",
      key: "T",
      icon: "text",
      hint: "Type into cells, or build a text layer"
    }
  ];

  /**
   * The design has one button where there were four shape tools, so they share it as a tool
   * group: the button shows whichever member is live, and the settings panel switches between
   * them. Their old keyboard shortcuts still reach each one directly.
   */
  const SHAPES = [
    { id: "path", label: "Path", key: "D" },
    { id: "line", label: "Line", key: "L" },
    { id: "rect", label: "Rect", key: "R" },
    { id: "box", label: "Box", key: "O" }
  ];
  let lastShape = $state("path");
  const inShapeGroup = $derived(SHAPES.some((s) => s.id === tool));
  const shapeButton = $derived(
    SHAPES.find((s) => s.id === (inShapeGroup ? tool : lastShape))
  );
  $effect(() => {
    if (inShapeGroup) lastShape = tool;
  });

  /** What the floating panel above the toolbar shows. 'tool' follows the armed tool. */
  let panel = $state("tool");
  const hasToolSettings = $derived(tool !== "move" && tool !== "fill");
  const panelOpen = $derived(panel !== "tool" || hasToolSettings);

  function pickTool(id) {
    tool = id === "shape" ? lastShape : id;
    panel = "tool";
  }

  // Panels that can be torn out of the popover and docked under Layers. The tool settings
  // aren't here: they belong to whatever is armed, so they have nowhere fixed to live.
  const PINNABLE = { char: "Characters", effects: "Effects", canvas: "Canvas" };
  let pinned = $state([]); // panel names, in dock order under Layers

  function pinPanel(name) {
    if (!pinned.includes(name)) pinned = [...pinned, name];
    panel = "tool";
  }

  const unpinPanel = (name) => (pinned = pinned.filter((n) => n !== name));

  /**
   * The toolbar button is show/hide; pinning only decides where the panel lives. So pressing
   * it on a pinned panel closes that panel outright rather than reopening it in the popover.
   */
  function togglePanel(name) {
    if (pinned.includes(name)) unpinPanel(name);
    else panel = panel === name ? "tool" : name;
  }

  /** Clicking a character swatch arms that slot and shows the palette on it. */
  function pickSlot(slot) {
    const same = activeSlot === slot;
    activeSlot = slot;
    if (same) togglePanel("char");
    else if (!pinned.includes("char")) panel = "char";
  }

  /** Swatches show a visible stand-in for whitespace rather than an empty box. */
  const showChar = (ch) => (ch === " " ? "SP" : ch);

  // ── Layers panel ───────────────────────────────────────────────────────────
  const LAYERS_PANEL_WIDTH = 265;
  const LAYER_ROW_HEIGHT = 32;

  let collapsed = $state({ layers: false }); // panel name -> collapsed, across the dock
  let panelPos = $state(null); // {x, y}; null until it's parked in its designed spot
  let listEl = $state(null);
  let panelDrag = null;

  $effect(() => {
    if (!panelPos)
      panelPos = { x: window.innerWidth - LAYERS_PANEL_WIDTH - 23, y: 26 };
  });

  /** Keep a dragged panel on screen when the window shrinks under it. */
  function clampPanel() {
    if (!panelPos) return;
    panelPos = {
      x: Math.max(
        8,
        Math.min(window.innerWidth - LAYERS_PANEL_WIDTH - 8, panelPos.x)
      ),
      y: Math.max(8, Math.min(window.innerHeight - 60, panelPos.y))
    };
  }

  function startPanelDrag(event) {
    if (event.button !== 0 || event.target.closest("button")) return;
    panelDrag = {
      dx: event.clientX - panelPos.x,
      dy: event.clientY - panelPos.y
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function movePanelDrag(event) {
    if (!panelDrag) return;
    panelPos = {
      x: event.clientX - panelDrag.dx,
      y: event.clientY - panelDrag.dy
    };
    clampPanel();
  }

  const endPanelDrag = () => (panelDrag = null);

  // The dock — Layers plus whatever is pinned under it — moves as one column, so every
  // header in it drags the same position.
  const dockDrag = {
    onpointerdown: startPanelDrag,
    onpointermove: movePanelDrag,
    onpointerup: endPanelDrag
  };

  // Row reordering. The list paints top-down (last layer first), so a pointer position is
  // converted to a visual row and then flipped back into a stack index.
  let rowDrag = $state(null); // { from, to }

  function startRowDrag(event, index) {
    if (event.button !== 0) return;
    event.stopPropagation();
    rowDrag = { from: index, to: index };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function moveRowDrag(event) {
    if (!rowDrag || !listEl) return;
    const top = listEl.getBoundingClientRect().top;
    const visual = Math.floor((event.clientY - top) / LAYER_ROW_HEIGHT);
    const clamped = Math.max(0, Math.min(layers.length - 1, visual));
    rowDrag = { ...rowDrag, to: layers.length - 1 - clamped };
  }

  function endRowDrag() {
    if (rowDrag && rowDrag.to !== rowDrag.from)
      reorderLayer(rowDrag.from, rowDrag.to);
    rowDrag = null;
  }

  /** Pull a layer out of the stack and drop it back at `to`, keeping the selection on it. */
  function reorderLayer(from, to) {
    commitInProgress();
    snapshot();
    const activeId = layers[activeIndex].id;
    const next = layers.slice();
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    layers = next;
    activeIndex = next.findIndex((l) => l.id === activeId);
    selection = null;
  }

  // Right-clicking a row reaches the operations the design's three-button footer has no
  // room for: rename, merge down, rasterize.
  let menu = $state(null); // { x, y, index }

  function openMenu(event, index) {
    event.preventDefault();
    selectLayer(index);
    menu = { x: event.clientX, y: event.clientY, index };
  }

  function runMenu(action) {
    menu = null;
    action();
  }

  // Colour swatch popover, anchored under the chip it was opened from.
  let colorMenu = $state(null); // { x, y, index }

  function openColorMenu(event, index) {
    event.stopPropagation();
    selectLayer(index);
    const rect = event.currentTarget.getBoundingClientRect();
    colorMenu = { x: rect.left, y: rect.bottom + 6, index };
  }

  function setLayerColor(index, color) {
    if (layers[index].color === color) return;
    snapshot();
    layers[index].color = color;
  }

  const closeMenus = () => {
    menu = null;
    colorMenu = null;
  };
</script>

<svelte:window
  onkeydown={onKeyDown}
  onpaste={onPaste}
  onpointerup={onPointerUp}
  onpointercancel={onPointerUp}
  onresize={clampPanel}
  onclick={closeMenus}
/>

{#snippet charPanel()}
  <div class="settings-body">
    <div class="field">
      <span class="label"
        >{activeSlot === "primary" ? "Primary" : "Secondary"}</span
      >
      <input
        class="char-input"
        value={activeChar}
        oninput={(e) => setActiveChar(e.currentTarget.value)}
        spellcheck="false"
      />
      <span class="value"
        >U+{activeChar
          .codePointAt(0)
          .toString(16)
          .toUpperCase()
          .padStart(4, "0")}</span
      >
    </div>
    <div class="palette-scroll">
      {#each PALETTE_GROUPS as group}
        <details
          open={openGroups[group.name] ?? false}
          ontoggle={(e) => (openGroups[group.name] = e.currentTarget.open)}
        >
          <summary>{group.name}</summary>
          <div class="palette">
            {#each group.chars as p}
              <button
                class="swatch-btn"
                class:active={activeChar === p}
                onclick={() => setActiveChar(p)}
                title={p === " " ? "space" : p}>{p === " " ? "␠" : p}</button
              >
            {/each}
          </div>
        </details>
      {/each}
    </div>
  </div>
{/snippet}

{#snippet effectsPanel()}
  <div class="settings-body">
    {#each TRANSFORMS as t}
      <label class="field" title={t.hint}>
        <span class="label">{t.label}</span>
        <input
          type="range"
          min={t.min}
          max={t.max}
          step={t.step}
          value={transformValue(t.key)}
          oninput={(e) => setTransform(t.key, +e.currentTarget.value)}
        />
        <span class="value">{transformValue(t.key)}</span>
      </label>
    {/each}
    <div class="field">
      <span class="label">Flip</span>
      <div class="segmented">
        <button onclick={() => flipLayer("h")} title="Mirror left ↔ right"
          >Horizontal</button
        >
        <button onclick={() => flipLayer("v")} title="Mirror top ↔ bottom"
          >Vertical</button
        >
      </div>
      <button class="ghost value" onclick={resetTransform}>Reset</button>
    </div>
    {#if !activeText}
      <button
        class="wide"
        disabled={!hasPendingTransform}
        title="A transform is a preview until it's applied — drawing on the layer or switching away applies it for you"
        onclick={applyTransform}
      >
        Apply to layer
      </button>
    {/if}
  </div>
{/snippet}

{#snippet canvasPanel()}
  <div class="settings-body">
    <div class="field">
      <span class="label">Cols</span>
      <input
        type="number"
        min="1"
        max="400"
        bind:value={colsInput}
        onchange={applySize}
      />
      <span class="label">Rows</span>
      <input
        type="number"
        min="1"
        max="200"
        bind:value={rowsInput}
        onchange={applySize}
      />
    </div>
    <label class="field" title="Font size in pixels (− and + to step)">
      <span class="label">Zoom</span>
      <input type="range" min="8" max="56" bind:value={fontSize} />
      <span class="value">{fontSize}px</span>
    </label>
    <label class="field" title="Horizontal gap between columns (display only)">
      <span class="label">H space</span>
      <input
        type="range"
        min="-2"
        max="16"
        step="0.5"
        bind:value={letterSpacing}
      />
      <span class="value">{cellW.toFixed(1)}</span>
    </label>
    <label class="field" title="Vertical row pitch (display only)">
      <span class="label">V space</span>
      <input
        type="range"
        min="0.6"
        max="3"
        step="0.05"
        bind:value={lineHeight}
      />
      <span class="value">{cellH}</span>
    </label>
    <div class="field">
      <label class="check" title="Toggle cell guides (G)">
        <input type="checkbox" bind:checked={showGrid} /> Show grid
      </label>
      <button class="ghost value" onclick={resetSpacing}>Reset spacing</button>
    </div>
    <div class="field">
      <span class="label">Export</span>
      <div class="segmented">
        <button onclick={exportText} title="Plain text, characters only"
          >Txt</button
        >
        <button
          onclick={() => exportImage("png")}
          title="Image at twice the on-screen size">Png</button
        >
        <button
          onclick={() => exportImage("jpg")}
          title="Image at twice the on-screen size">Jpg</button
        >
      </div>
    </div>
    <div class="field">
      <div class="segmented">
        <button onclick={clearAll} title="Clear the active layer"
          >Clear layer</button
        >
      </div>
    </div>
  </div>
{/snippet}

<div class="app">
  <div class="viewport">
    <div class="stage">
      <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
      <pre
        bind:this={gridEl}
        class="grid"
        class:text-tool={tool === "text"}
        class:select-tool={tool === "select"}
        class:move-tool={tool === "move"}
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
        ondblclick={() => isPath && finishPath()}>{#each displayRows as row}<div
            class="line">{#each row as run}<span style="color:{run.color}"
                >{run.text}</span
              >{/each}</div>{/each}{#if showGrid}<span
            class="gridlines"
            style="background-size:{cellW}px {cellH}px;"
          ></span>{/if}{#if hover}<span
            class="hover-cell"
            style="left:{(hover[0] - brushOffset) * cellW}px; top:{(hover[1] -
              brushOffset) *
              cellH}px; width:{brushSpan * cellW}px; height:{brushSpan *
              cellH}px;"></span>{/if}{#each selEdges as s}<span
            class="sel-cell"
            style="left:{(s.x + (moving?.dx ?? 0)) * cellW}px; top:{(s.y +
              (moving?.dy ?? 0)) *
              cellH}px; width:{cellW}px; height:{cellH}px; border-width:{s.top
              ? 1
              : 0}px {s.right ? 1 : 0}px {s.bottom ? 1 : 0}px {s.left
              ? 1
              : 0}px;"></span>{/each}{#if marquee}<span
            class="marquee"
            style="left:{Math.min(marquee[0], marquee[2]) *
              cellW}px; top:{Math.min(marquee[1], marquee[3]) *
              cellH}px; width:{(Math.abs(marquee[2] - marquee[0]) + 1) *
              cellW}px; height:{(Math.abs(marquee[3] - marquee[1]) + 1) *
              cellH}px;"></span>{/if}{#if caret && tool === "text"}<span
            class="caret"
            style="left:{caret[0] * cellW}px; top:{caret[1] *
              cellH}px; width:{cellW}px; height:{cellH}px;"></span>{/if}</pre>
      <div class="measure-box" aria-hidden="true">
        <span
          bind:this={measureEl}
          class="measure"
          style="font-size:{fontSize}px; letter-spacing:{letterSpacing}px;"
          >00000000000000000000000000000000000000000000000000</span
        >
      </div>
    </div>
  </div>

  <div
    class="dock"
    style="left:{panelPos?.x ?? 0}px; top:{panelPos?.y ?? 26}px"
  >
    <div class="panel layers">
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div class="panel-head" {...dockDrag}>
        <button
          class="chevron"
          class:collapsed={collapsed.layers}
          title={collapsed.layers ? "Expand" : "Collapse"}
          onclick={() => (collapsed.layers = !collapsed.layers)}
        >
          <Icon name="chevron" size={24} />
        </button>
        <span class="panel-title">Layers</span>
        <span class="grip" aria-hidden="true">⠿</span>
      </div>

      {#if !collapsed.layers}
        <div class="layer-list" bind:this={listEl}>
          {#each [...layers].reverse() as layer, i (layer.id)}
            {@const index = layers.length - 1 - i}
            <!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
            <div
              class="layer-row"
              class:active={index === activeIndex}
              class:dragging={rowDrag?.from === index}
              class:drop={rowDrag &&
                rowDrag.from !== index &&
                rowDrag.to === index}
              onclick={() => selectLayer(index)}
              oncontextmenu={(e) => openMenu(e, index)}
            >
              <!-- svelte-ignore a11y_no_static_element_interactions -->
              <span
                class="grip drag"
                title="Drag to reorder"
                onpointerdown={(e) => startRowDrag(e, index)}
                onpointermove={moveRowDrag}
                onpointerup={endRowDrag}>⠿</span
              >
              <button
                class="layer-chip"
                class:text={!!layer.text}
                style="--chip:{layer.color}"
                title="Layer colour"
                onclick={(e) => openColorMenu(e, index)}
                aria-label="Layer colour"
              ></button>
              {#if renamingId === layer.id}
                <!-- svelte-ignore a11y_autofocus -->
                <input
                  class="layer-name-input"
                  value={layer.name}
                  autofocus
                  onblur={(e) => {
                    layer.name = e.currentTarget.value.trim() || layer.name;
                    renamingId = null;
                  }}
                  onkeydown={(e) => {
                    if (e.key === "Enter" || e.key === "Escape")
                      e.currentTarget.blur();
                    e.stopPropagation();
                  }}
                />
              {:else}
                <span
                  class="layer-name"
                  ondblclick={() => (renamingId = layer.id)}
                  title="Click to select, double-click to rename, right-click for more"
                  >{layer.name}</span
                >
              {/if}
              <button
                class="eye"
                title={layer.visible ? "Hide layer" : "Show layer"}
                onclick={(e) => {
                  e.stopPropagation();
                  toggleVisible(index);
                }}
              >
                <Icon
                  name={layer.visible ? "eye-open" : "eye-close"}
                  size={18}
                />
              </button>
            </div>
          {/each}
        </div>

        <div class="layer-actions">
          <button title="New layer" onclick={addLayer}
            ><Icon name="plus" size={24} /></button
          >
          <button title="Duplicate layer" onclick={duplicateLayer}
            ><Icon name="clone" size={24} /></button
          >
          <button
            title="Delete layer"
            disabled={layers.length === 1}
            onclick={deleteLayer}
          >
            <Icon name="trash" size={24} />
          </button>
        </div>
      {/if}
    </div>

    <!-- Panels pinned out of the popover stack under Layers and travel with it. -->
    {#each pinned as name (name)}
      <div class="panel">
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div class="panel-head" {...dockDrag}>
          <button
            class="chevron"
            class:collapsed={collapsed[name]}
            title={collapsed[name] ? "Expand" : "Collapse"}
            onclick={() => (collapsed[name] = !collapsed[name])}
          >
            <Icon name="chevron" size={24} />
          </button>
          <span class="panel-title">{PINNABLE[name]}</span>
          <button
            class="pin"
            title="Put this panel back above the toolbar"
            onclick={() => unpinPanel(name)}>Unpin</button
          >
        </div>
        {#if !collapsed[name]}
          {#if name === "char"}{@render charPanel()}
          {:else if name === "effects"}{@render effectsPanel()}
          {:else}{@render canvasPanel()}{/if}
        {/if}
      </div>
    {/each}
  </div>

  {#if menu}
    <div class="panel menu" style="left:{menu.x}px; top:{menu.y}px">
      <button
        onclick={() => runMenu(() => (renamingId = layers[menu.index].id))}
        >Rename</button
      >
      <button onclick={() => runMenu(duplicateLayer)}>Duplicate</button>
      <button
        disabled={menu.index === layers.length - 1}
        onclick={() => runMenu(() => moveLayer(1))}
      >
        Move up
      </button>
      <button
        disabled={menu.index === 0}
        onclick={() => runMenu(() => moveLayer(-1))}
      >
        Move down
      </button>
      <button disabled={menu.index === 0} onclick={() => runMenu(mergeDown)}
        >Merge down</button
      >
      {#if layers[menu.index].text}
        <button onclick={() => runMenu(rasterizeLayer)}>Rasterize</button>
      {/if}
      <button
        disabled={layers.length === 1}
        onclick={() => runMenu(deleteLayer)}>Delete</button
      >
    </div>
  {/if}

  {#if colorMenu}
    <!-- Clicks are stopped here so the native colour input can open without the window
         handler tearing the popover down under it. -->
    <!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
    <div
      class="panel color-menu"
      style="left:{colorMenu.x}px; top:{colorMenu.y}px"
      onclick={(e) => e.stopPropagation()}
    >
      <div class="color-grid">
        {#each LAYER_COLORS as c}
          <button
            class="color-swatch"
            class:active={layers[colorMenu.index]?.color === c}
            style="--chip:{c}"
            title={c}
            aria-label={c}
            onclick={() => {
              setLayerColor(colorMenu.index, c);
              colorMenu = null;
            }}
          ></button>
        {/each}
      </div>
      <label class="color-custom">
        <input
          type="color"
          value={layers[colorMenu.index]?.color ?? DEFAULT_INK}
          onchange={(e) =>
            setLayerColor(colorMenu.index, e.currentTarget.value)}
        />
        Custom
      </label>
    </div>
  {/if}

  {#if toast}<div class="toast">{toast}</div>{/if}

  {#if panelOpen}
    <div class="panel settings">
      {#if PINNABLE[panel]}
        <div class="settings-head">
          <span class="panel-title">{PINNABLE[panel]}</span>
          <button
            class="pin"
            title="Dock this panel under Layers"
            onclick={() => pinPanel(panel)}>Pin</button
          >
        </div>
      {/if}
      {#if panel === "char"}{@render charPanel()}
      {:else if panel === "effects"}{@render effectsPanel()}
      {:else if panel === "canvas"}{@render canvasPanel()}
      {:else}
        <div class="settings-body">
          {#if tool === "select"}
            <label
              class="check"
              title="Click-to-select stops at a different character instead of at blanks"
            >
              <input type="checkbox" bind:checked={sameCharOnly} /> Same character
              only
            </label>
          {:else if tool === "text"}
            {#if activeText}
              <textarea
                class="text-input"
                rows="2"
                bind:value={layers[activeIndex].text.content}
                placeholder="Type here"
              ></textarea>
              <div class="field">
                <span class="label">Font</span>
                <select
                  value={activeText.family}
                  onchange={(e) => useFont(e.currentTarget.value)}
                >
                  {#each FONTS as f}<option value={f.family}
                      >{f.family} · {f.note}</option
                    >{/each}
                </select>
                <label class="check"
                  ><input
                    type="checkbox"
                    bind:checked={layers[activeIndex].text.bold}
                  /> Bold</label
                >
              </div>
              <label class="field" title="Cap height in character cells">
                <span class="label">Size</span>
                <input
                  type="range"
                  min="1"
                  max="20"
                  step="0.5"
                  bind:value={layers[activeIndex].text.size}
                />
                <span class="value">{activeText.size}</span>
              </label>
              <div class="field">
                <span class="label">Style</span>
                <select bind:value={layers[activeIndex].text.mode}>
                  <option value="half">Half blocks</option>
                  <option value="shade">Shading</option>
                  <option value="solid">Solid</option>
                </select>
                <span class="value">
                  {activeLayer.textBox
                    ? `${activeLayer.textBox.width}×${activeLayer.textBox.height}`
                    : "—"}
                </span>
              </div>
              <label
                class="field"
                title="Coverage a cell needs before it's inked"
              >
                <span class="label">Weight</span>
                <input
                  type="range"
                  min="0.05"
                  max="0.9"
                  step="0.05"
                  bind:value={layers[activeIndex].text.threshold}
                />
                <span class="value">{activeText.threshold}</span>
              </label>
              <label class="field" title="Extra space between glyphs, in cells">
                <span class="label">Tracking</span>
                <input
                  type="range"
                  min="-1"
                  max="4"
                  step="0.25"
                  bind:value={layers[activeIndex].text.letterSpacing}
                />
                <span class="value">{activeText.letterSpacing}</span>
              </label>
              <label
                class="field"
                title="Line height as a multiple of the font size"
              >
                <span class="label">Leading</span>
                <input
                  type="range"
                  min="0.8"
                  max="2.5"
                  step="0.05"
                  bind:value={layers[activeIndex].text.lineSpacing}
                />
                <span class="value">{activeText.lineSpacing}</span>
              </label>
              <div class="field">
                <span class="label">Position</span>
                <input
                  type="number"
                  bind:value={layers[activeIndex].text.x}
                  title="Column"
                />
                <input
                  type="number"
                  bind:value={layers[activeIndex].text.y}
                  title="Row"
                />
              </div>
              {#if !fontReady}
                <p class="note">
                  Font unavailable offline — drawing with a system fallback.
                </p>
              {/if}
              {#if textOverflow}
                <p class="note warn">
                  Extends past the canvas — the text is kept in full, only the
                  view is cropped.
                </p>
                <button class="wide" onclick={fitCanvasToText}
                  >Fit canvas to text</button
                >
              {/if}
              <button class="wide" onclick={rasterizeLayer}
                >Rasterize to draw on it</button
              >
            {:else}
              <p class="note">
                Click the canvas and type to set characters directly.
              </p>
              <button class="wide" onclick={addTextLayer}>New text layer</button
              >
            {/if}
          {:else if inShapeGroup}
            <div class="field">
              <span class="label">Shape</span>
              <div class="segmented">
                {#each SHAPES as s}
                  <button
                    class:active={tool === s.id}
                    onclick={() => pickTool(s.id)}
                  >
                    {s.label} <em>{s.key}</em>
                  </button>
                {/each}
              </div>
            </div>
            {#if tool === "path" || tool === "box"}
              <div class="field">
                <span class="label">Style</span>
                <select bind:value={boxStyle}>
                  {#each BOX_STYLES as s}<option value={s}>{s}</option>{/each}
                </select>
              </div>
            {/if}
            {#if tool === "rect"}
              <label class="check"
                ><input type="checkbox" bind:checked={filled} /> Filled</label
              >
            {/if}
            {#if tool === "line"}
              <label class="field" title="Brush size ([ and ])">
                <span class="label">Size</span>
                <input type="range" min="1" max="9" bind:value={brushSize} />
                <span class="value">{brushSize}×{brushSize}</span>
              </label>
            {/if}
            {#if tool === "path"}
              <p class="note">
                Click each corner. Enter, Esc, double-click or right-click
                releases the line so you can start the next one.
              </p>
            {/if}
          {:else}
            <label class="field" title="Brush size ([ and ])">
              <span class="label"
                >{tool === "brush" && pressureSize ? "Max size" : "Size"}</span
              >
              <input type="range" min="1" max="9" bind:value={brushSize} />
              <span class="value">{brushSize}×{brushSize}</span>
            </label>
            {#if tool === "brush"}
              <div class="field" title="What varies the brush as you draw">
                <span class="label">Dynamics</span>
                <div class="segmented">
                  <button
                    class:active={dynamics === "pressure"}
                    onclick={() => (dynamics = "pressure")}>Pressure</button
                  >
                  <button
                    class:active={dynamics === "speed"}
                    onclick={() => (dynamics = "speed")}>Speed</button
                  >
                  <button
                    class:active={dynamics === "off"}
                    onclick={() => (dynamics = "off")}>Off</button
                  >
                </div>
              </div>
              <div class="field">
                <label class="check" title="Harder press paints a wider dab">
                  <input type="checkbox" bind:checked={pressureSize} /> Force → size
                </label>
                <label
                  class="check"
                  title="Harder press picks a denser character"
                >
                  <input type="checkbox" bind:checked={pressureDensity} /> Force
                  → density
                </label>
              </div>
              {#if pressureDensity}
                <div class="field">
                  <span class="label">Ramp</span>
                  <select bind:value={rampName}>
                    {#each Object.keys(RAMPS) as r}<option value={r}>{r}</option
                      >{/each}
                  </select>
                </div>
              {/if}
              <p class="note">{dynamicsNote}</p>
            {/if}
          {/if}
        </div>
      {/if}
    </div>
  {/if}

  <div class="toolbar">
    <div class="chars">
      <button
        class="swatch back"
        class:armed={activeSlot === "secondary"}
        title="Secondary character — drawn with the right button"
        onclick={() => pickSlot("secondary")}>{showChar(altChar)}</button
      >
      <button
        class="swatch front"
        class:armed={activeSlot === "primary"}
        title="Primary character — drawn with the left button"
        onclick={() => pickSlot("primary")}>{showChar(char)}</button
      >
    </div>

    <span class="divider"></span>

    <div class="tool-group">
      {#each SELECT_TOOLS as t}
        <button
          class="tool"
          class:active={tool === t.id}
          title={t.hint}
          onclick={() => pickTool(t.id)}
        >
          <Icon name={t.icon} size={34} />
          <span class="tool-label">{t.label} <em>{t.key}</em></span>
        </button>
      {/each}
    </div>

    <span class="divider"></span>

    <div class="tool-group">
      {#each DRAW_TOOLS as t}
        {@const isShapeButton = t.id === "shape"}
        <button
          class="tool"
          class:active={isShapeButton ? inShapeGroup : tool === t.id}
          title={t.hint}
          onclick={() => pickTool(t.id)}
        >
          <Icon name={t.icon} size={34} />
          <span class="tool-label">
            {isShapeButton ? shapeButton.label : t.label}
            <em>{isShapeButton ? shapeButton.key : t.key}</em>
          </span>
        </button>
      {/each}
    </div>

    <span class="divider"></span>

    <div class="tool-group">
      <button
        class="tool"
        class:active={panel === "effects" || pinned.includes("effects")}
        title="Skew, rotate, flip and keystone the active layer"
        onclick={() => togglePanel("effects")}
      >
        <Icon name="fx" size={34} />
        <span class="tool-label">Effects</span>
      </button>
      <button
        class="tool"
        class:active={panel === "canvas" || pinned.includes("canvas")}
        title="Canvas size, zoom and cell spacing"
        onclick={() => togglePanel("canvas")}
      >
        <Icon name="canvas" size={34} />
        <span class="tool-label">Canvas</span>
      </button>
    </div>
  </div>

  <div class="status">
    <span>{cols} × {rows}</span>
    <span>{hover ? `${hover[0]}, ${hover[1]}` : "–"}</span>
  </div>
</div>

<style>
  .app {
    position: relative;
    height: 100vh;
    overflow: hidden;
    background: var(--bg);
    color: var(--ink);
    font-family: var(--ui-font);
  }

  /* ── Canvas ──────────────────────────────────────────────────────────────── */

  .viewport {
    height: 100%;
    overflow: auto;
    display: flex;
    /* Asymmetric padding parks the canvas where the design has it — just above centre —
       and keeps the bottom clear of the toolbar when the canvas is tall enough to scroll. */
    padding: 96px 24px 136px;
  }
  .stage {
    margin: auto;
  }

  .grid {
    position: relative;
    display: inline-block;
    margin: 0;
    font-family: var(--art-font);
    background: var(--bg);
    color: var(--ink);
    border: 1px solid var(--accent);
    cursor: crosshair;
    outline: none;
    user-select: none;
    touch-action: none;
    white-space: pre;
  }
  .grid.text-tool {
    cursor: text;
  }
  .grid.select-tool {
    cursor: cell;
  }
  .grid.move-tool {
    cursor: move;
  }
  .grid.select-tool.grabbable {
    cursor: grab;
  }
  .grid.select-tool.grabbable:active {
    cursor: grabbing;
  }
  .line {
    height: inherit;
  }

  .caret {
    position: absolute;
    background: rgba(0, 234, 255, 0.45);
    pointer-events: none;
  }

  /* Cell guides, drawn from the measured cell size so they line up with glyphs. */
  .gridlines {
    position: absolute;
    inset: 0;
    pointer-events: none;
    background-image: linear-gradient(
        to right,
        rgba(255, 255, 255, 0.08) 1px,
        transparent 1px
      ),
      linear-gradient(to bottom, rgba(255, 255, 255, 0.08) 1px, transparent 1px);
  }

  /* Fill on every selected cell, but border only on the sides facing outwards —
     interior edges get 0px widths inline, leaving a single clean outline. */
  .sel-cell {
    position: absolute;
    pointer-events: none;
    background: rgba(0, 234, 255, 0.18);
    border-style: solid;
    border-color: var(--accent);
  }

  .marquee {
    position: absolute;
    pointer-events: none;
    background: rgba(0, 234, 255, 0.1);
    border: 1px dashed var(--accent);
  }

  .hover-cell {
    position: absolute;
    pointer-events: none;
    background: rgba(255, 255, 255, 0.1);
    outline: 1px solid rgba(255, 255, 255, 0.45);
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
    font-family: var(--art-font);
  }

  /* ── Floating panels ─────────────────────────────────────────────────────── */

  .panel {
    position: absolute;
    background: var(--panel);
    color: var(--ink);
    font-size: 12px;
    letter-spacing: -0.05em;
  }

  .divider {
    align-self: stretch;
    width: 1px;
    flex: none;
    background: rgba(255, 255, 255, 0.2);
  }

  .grip {
    font-size: 12px;
    line-height: 1;
    opacity: 0.5;
    user-select: none;
  }

  /* ── Layers ──────────────────────────────────────────────────────────────── */

  /* Layers, plus any pinned panel, in one draggable right-hand column. */
  .dock {
    position: absolute;
    width: 265px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    max-height: calc(100vh - 52px);
    overflow-y: auto;
  }
  .dock > .panel {
    position: static;
    flex: none;
  }

  .layers {
    display: flex;
    flex-direction: column;
  }
  .panel-head {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px;
    cursor: grab;
    touch-action: none;
  }
  .panel-head:active {
    cursor: grabbing;
  }
  .panel-title {
    flex: 1;
    font-size: 14px;
    letter-spacing: -0.05em;
    text-transform: uppercase;
  }
  .chevron {
    display: block;
    padding: 0;
    background: none;
    border: none;
    color: var(--ink);
    cursor: pointer;
    /* The asset points up; expanded turns it down. */
    transform: rotate(180deg);
  }
  .chevron.collapsed {
    transform: none;
  }

  .layer-list {
    display: flex;
    flex-direction: column;
    max-height: 320px;
    overflow-y: auto;
  }
  .layer-row {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 32px;
    flex: none;
    padding: 8px;
    cursor: pointer;
  }
  .layer-row:hover {
    background: rgba(255, 255, 255, 0.05);
  }
  .layer-row.active {
    background: var(--row-selected);
  }
  .layer-row.dragging {
    opacity: 0.4;
  }
  .layer-row.drop {
    box-shadow: inset 0 0 0 1px var(--accent);
  }
  .grip.drag {
    cursor: grab;
    touch-action: none;
  }
  .layer-chip {
    width: 13px;
    height: 13px;
    flex: none;
    padding: 0;
    border: none;
    background: var(--chip);
    cursor: pointer;
  }
  .layer-chip:hover {
    box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.35);
  }
  /* Text layers regenerate from parameters rather than cells; the hollow chip says so. */
  .layer-chip.text {
    background: none;
    box-shadow: inset 0 0 0 2px var(--chip);
  }
  .layer-chip.text:hover {
    box-shadow:
      inset 0 0 0 2px var(--chip),
      0 0 0 2px rgba(255, 255, 255, 0.35);
  }

  .color-menu {
    z-index: 5;
    padding: 8px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
  }
  .color-grid {
    display: grid;
    grid-template-columns: repeat(3, 22px);
    gap: 4px;
  }
  .color-swatch {
    width: 22px;
    height: 22px;
    padding: 0;
    border: none;
    background: var(--chip);
    cursor: pointer;
  }
  .color-swatch:hover {
    box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.35);
  }
  .color-swatch.active {
    box-shadow: 0 0 0 2px var(--ink);
  }
  .color-custom {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 8px;
    font-size: 11px;
    text-transform: uppercase;
    color: var(--ink-dim);
    cursor: pointer;
  }
  .color-custom input {
    width: 26px;
    height: 22px;
    padding: 0;
    background: none;
    border: 1px solid var(--hairline);
    cursor: pointer;
  }
  .layer-name,
  .layer-name-input {
    flex: 1;
    min-width: 0;
    font-size: 12px;
    letter-spacing: -0.05em;
    text-transform: uppercase;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .layer-name-input {
    font-family: inherit;
    color: var(--ink);
    background: var(--bg);
    border: 1px solid var(--accent);
    outline: none;
    padding: 2px 4px;
  }
  .eye {
    display: block;
    padding: 0;
    background: none;
    border: none;
    color: var(--ink);
    cursor: pointer;
  }
  .eye:hover {
    opacity: 0.6;
  }

  .layer-actions {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
    padding: 10px;
    background: var(--panel-alt);
  }
  .layer-actions button {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    padding: 0;
    background: none;
    border: none;
    color: var(--ink);
    opacity: 0.7;
    cursor: pointer;
  }
  .layer-actions button:hover:not(:disabled) {
    opacity: 1;
  }
  .layer-actions button:disabled {
    opacity: 0.25;
    cursor: default;
  }

  .menu {
    display: flex;
    flex-direction: column;
    min-width: 150px;
    padding: 4px 0;
    z-index: 5;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
  }
  .menu button {
    text-align: left;
    padding: 7px 12px;
    font: inherit;
    font-size: 11px;
    letter-spacing: -0.05em;
    text-transform: uppercase;
    color: var(--ink);
    background: none;
    border: none;
    cursor: pointer;
  }
  .menu button:hover:not(:disabled) {
    background: var(--row-selected);
  }
  .menu button:disabled {
    opacity: 0.25;
    cursor: default;
  }

  /* ── Tool settings ───────────────────────────────────────────────────────── */

  .settings {
    left: 50%;
    transform: translateX(-50%);
    bottom: 121px;
    display: flex;
    flex-direction: column;
  }
  .settings-head {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 16px 0;
  }
  .settings-body {
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-width: 261px;
    max-width: min(680px, calc(100vw - 48px));
    max-height: calc(100vh - 300px);
    overflow-y: auto;
    padding: 16px;
  }
  .settings-head + .settings-body {
    padding-top: 4px;
  }

  .pin {
    padding: 4px 8px;
    font: inherit;
    font-size: 11px;
    letter-spacing: -0.05em;
    text-transform: uppercase;
    color: var(--ink);
    background: rgba(255, 255, 255, 0.08);
    border: none;
    opacity: 0.7;
    cursor: pointer;
  }
  .pin:hover {
    opacity: 1;
  }

  /* Docked, a panel has 245px of usable width instead of ~640, so the roomy popover
     measurements have to give. The dock itself scrolls rather than each panel. */
  .dock .settings-body {
    min-width: 0;
    max-width: none;
    max-height: none;
    overflow: visible;
    gap: 6px;
    padding: 10px;
  }
  .dock .field {
    gap: 10px;
  }
  .dock .settings-body input[type="range"] {
    min-width: 70px;
  }
  .dock .settings-body input[type="number"] {
    width: 60px;
  }
  .dock .palette-scroll {
    width: 100%;
    columns: 1;
  }
  .dock .note {
    max-width: none;
  }

  .field {
    display: flex;
    align-items: center;
    gap: 17px;
    min-height: 30px;
  }
  .label {
    font-size: 13px;
    text-transform: uppercase;
    white-space: nowrap;
    flex: none;
  }
  .value {
    margin-left: auto;
    font-size: 13px;
    text-transform: uppercase;
    white-space: nowrap;
    flex: none;
    /* Tabular figures plus a floor, so a readout going 0 → 0.3 doesn't shove its row about. */
    min-width: 4ch;
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  .note {
    margin: 0;
    /* Definite width, so a long hint never widens the panel; min-width stretches it back out
       once the panel has been sized by the rows above it. */
    width: 0;
    min-width: 100%;
    font-size: 11px;
    line-height: 1.5;
    color: var(--ink-dim);
    white-space: pre-line;
  }
  .note.warn {
    color: #e0c169;
  }

  /* Slider, rebuilt from the design's 2px track and 12×28 handle. */
  .settings-body input[type="range"] {
    -webkit-appearance: none;
    appearance: none;
    flex: 1;
    min-width: 131px;
    height: 30px;
    background: none;
    outline: none;
    margin: 0;
  }
  .settings-body input[type="range"]::-webkit-slider-runnable-track {
    height: 2px;
    background: var(--hairline);
  }
  .settings-body input[type="range"]::-moz-range-track {
    height: 2px;
    background: var(--hairline);
  }
  .settings-body input[type="range"]::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 12px;
    height: 28px;
    margin-top: -13px;
    background: var(--panel);
    border: 2px solid var(--ink);
    border-radius: 0;
    cursor: ew-resize;
  }
  .settings-body input[type="range"]::-moz-range-thumb {
    width: 8px;
    height: 24px;
    background: var(--panel);
    border: 2px solid var(--ink);
    border-radius: 0;
    cursor: ew-resize;
  }

  .settings-body input[type="number"],
  .settings-body select,
  .text-input,
  .char-input {
    font: inherit;
    font-size: 12px;
    color: var(--ink);
    background: none;
    border: 1px solid var(--hairline);
    border-radius: 0;
    padding: 6px 8px;
    outline: none;
  }
  .settings-body input[type="number"] {
    width: 72px;
  }
  .settings-body select {
    flex: 1;
    min-width: 0;
    -webkit-appearance: none;
    appearance: none;
    padding-right: 26px;
    /* The layers panel's chevron, turned to point down. */
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'%3E%3Cpath transform='rotate(180 12 12)' d='M20.5303 15.4697L19.4697 16.5303L12 9.06055L4.53027 16.5303L3.46973 15.4697L12 6.93945L20.5303 15.4697Z' fill='white'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: right 6px center;
    background-size: 14px;
  }
  .settings-body select:focus,
  .settings-body input:focus,
  .text-input:focus {
    border-color: var(--accent);
  }

  .text-input {
    width: 100%;
    font-family: var(--art-font);
    resize: vertical;
  }
  .char-input {
    width: 56px;
    font-family: var(--art-font);
    font-size: 20px;
    text-align: center;
  }

  .check {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    text-transform: uppercase;
    white-space: nowrap;
    cursor: pointer;
  }
  .check input[type="checkbox"] {
    -webkit-appearance: none;
    appearance: none;
    width: 14px;
    height: 14px;
    margin: 0;
    background: none;
    border: 1px solid var(--hairline);
    cursor: pointer;
  }
  .check input[type="checkbox"]:checked {
    background: var(--accent);
    border-color: var(--accent);
  }

  .segmented {
    display: flex;
    gap: 2px;
  }
  .segmented button {
    padding: 7px 10px;
    font: inherit;
    font-size: 11px;
    letter-spacing: -0.05em;
    text-transform: uppercase;
    color: var(--ink);
    background: rgba(255, 255, 255, 0.08);
    border: none;
    opacity: 0.7;
    cursor: pointer;
  }
  .segmented button:hover {
    opacity: 1;
  }
  .segmented button.active {
    background: var(--accent);
    color: #000;
    opacity: 1;
  }
  .segmented em {
    font-style: normal;
    opacity: 0.3;
  }

  .wide,
  .ghost {
    padding: 8px 10px;
    font: inherit;
    font-size: 11px;
    letter-spacing: -0.05em;
    text-transform: uppercase;
    color: var(--ink);
    background: rgba(255, 255, 255, 0.08);
    border: none;
    cursor: pointer;
  }
  .wide {
    width: 100%;
    /* A full-width action reads as a separate step from the rows it follows, so it gets more
       air than the 4px that separates the rows themselves. */
    margin-top: 8px;
  }
  .wide:hover:not(:disabled),
  .ghost:hover {
    background: rgba(255, 255, 255, 0.16);
  }
  .wide:disabled {
    opacity: 0.3;
    cursor: default;
  }
  .ghost {
    background: none;
    text-decoration: underline;
    padding: 0;
  }

  /* ── Character palette ───────────────────────────────────────────────────── */

  .palette-scroll {
    /* Multi-column rather than grid: the groups are wildly different heights once a few
       are open, and columns pack them instead of leaving row-sized holes. The width is
       explicit because the panel sizes to its content. */
    width: min(600px, calc(100vw - 88px));
    columns: 3;
    column-gap: 24px;
  }
  .palette-scroll details {
    break-inside: avoid;
  }
  details {
    border-top: 1px solid rgba(255, 255, 255, 0.12);
  }
  summary {
    list-style: none;
    cursor: pointer;
    padding: 7px 0;
    font-size: 11px;
    text-transform: uppercase;
    color: var(--ink-dim);
    display: flex;
    align-items: center;
    gap: 6px;
    user-select: none;
  }
  summary::-webkit-details-marker {
    display: none;
  }
  summary::before {
    content: "▸";
    font-size: 9px;
    transition: transform 0.12s ease;
  }
  details[open] > summary::before {
    transform: rotate(90deg);
  }
  summary:hover {
    color: var(--ink);
  }

  .palette {
    display: grid;
    grid-template-columns: repeat(6, 26px);
    gap: 2px;
    padding: 0 0 10px;
  }
  .swatch-btn {
    aspect-ratio: 1;
    display: grid;
    place-items: center;
    padding: 0;
    font-family: var(--art-font);
    font-size: 13px;
    color: var(--ink);
    background: rgba(255, 255, 255, 0.08);
    border: none;
    cursor: pointer;
  }
  .swatch-btn:hover {
    background: rgba(255, 255, 255, 0.2);
  }
  .swatch-btn.active {
    background: var(--accent);
    color: #000;
  }

  /* ── Toolbar ─────────────────────────────────────────────────────────────── */

  .toolbar {
    position: absolute;
    left: 50%;
    transform: translateX(-50%);
    bottom: 19px;
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 6px;
    max-width: calc(100vw - 32px);
    overflow-x: auto;
    background: var(--panel);
  }

  .chars {
    position: relative;
    /* Just the two overlapping swatches: 56 wide, offset by 36. */
    width: 92px;
    height: 79px;
    flex: none;
  }
  .swatch {
    position: absolute;
    width: 56px;
    height: 50px;
    display: grid;
    place-items: center;
    padding: 0;
    font-family: var(--art-font);
    font-size: 26px;
    line-height: 1;
    color: var(--ink);
    background: var(--panel);
    border: 1px solid var(--ink);
    cursor: pointer;
  }
  /* The armed slot sits in front, top-left, the way a foreground swatch does. */
  .swatch.back {
    left: 36px;
    top: 27px;
    font-size: 16px;
    opacity: 0.3;
  }
  .swatch.front {
    left: 0;
    top: 0;
  }
  .swatch.armed {
    border-color: var(--accent);
  }
  .swatch.back.armed {
    opacity: 0.6;
  }

  .tool-group {
    display: flex;
    align-items: center;
    gap: 4px;
    flex: none;
  }
  .tool {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 10px;
    width: 72px;
    height: 80px;
    flex: none;
    padding: 10px;
    background: none;
    border: none;
    color: var(--ink);
    opacity: 0.7;
    cursor: pointer;
  }
  .tool:hover {
    opacity: 1;
  }
  .tool.active {
    background: var(--accent);
    color: #000;
    opacity: 1;
  }
  .tool-label {
    display: flex;
    align-items: center;
    justify-content: center;
    /* Wider than the design's 2px: the negative tracking pulls the shortcut into the label. */
    gap: 4px;
    height: 15px;
    width: 100%;
    font-size: 11px;
    letter-spacing: -0.05em;
    text-transform: uppercase;
    white-space: nowrap;
  }
  .tool-label em {
    font-style: normal;
    opacity: 0.3;
  }

  /* ── Status & toast ──────────────────────────────────────────────────────── */

  .status {
    position: absolute;
    left: 23px;
    bottom: 19px;
    display: flex;
    gap: 16px;
    font-size: 11px;
    text-transform: uppercase;
    color: var(--ink-faint);
    font-variant-numeric: tabular-nums;
    pointer-events: none;
  }

  .toast {
    position: absolute;
    left: 50%;
    transform: translateX(-50%);
    bottom: 121px;
    z-index: 6;
    padding: 10px 16px;
    font-size: 12px;
    text-transform: uppercase;
    color: #000;
    background: var(--accent);
    pointer-events: none;
  }
</style>
