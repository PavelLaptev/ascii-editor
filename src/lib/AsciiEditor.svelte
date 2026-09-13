<script>
  import {
    EMPTY,
    BOX_STYLES,
    boxCells,
    brushPoints,
    diamondVertices,
    ellipsePoints,
    cloneGrid,
    contentBounds,
    flipGrid,
    floodPoints,
    gridToText,
    linePoints,
    makeGrid,
    objectPoints,
    polygonPoints,
    polylineGlyphs,
    rectPoints,
    transformGrid,
    strokePoints,
    triangleVertices
  } from "./ascii.js";
  import { FONTS, TEXT_DEFAULTS, loadFont, renderText } from "./textRender.js";
  import { loadSession, saveSession } from "./storage.js";
  import Icon from "./Icon.svelte";
  import { glitch } from "./glitch.js";

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

  // Every layer draws in its own colour, picked from the chip in the layers panel. Each
  // theme has its own set, position for position: the first entry is the default ink, and
  // the rest are the same hues pulled bright for the dark ground or deep for the light one.
  const THEME_PALETTES = {
    dark: [
      "#ffffff",
      "#9aa3ad",
      "#00eaff",
      "#6f9dff",
      "#c58cff",
      "#ff5470",
      "#ff9a3d",
      "#ffd644",
      "#5ce65c"
    ],
    light: [
      "#000000",
      "#5b636b",
      "#0086a5",
      "#2c5fd6",
      "#7a3fd6",
      "#d1173a",
      "#d66a00",
      "#a88500",
      "#1f8f1f"
    ]
  };

  // Whatever the last session left in localStorage, or null on a first visit.
  const saved = loadSession();
  const prefs = saved?.prefs ?? {};

  // "dark" is the design; "light" is its opposite. Stamped on <html> so the tokens in
  // app.css swap, and applied right away so the first paint is already the saved theme.
  // The favicon follows: one file per theme, so the tab matches the page.
  let theme = $state(prefs.theme === "light" ? "light" : "dark");
  function applyTheme(t) {
    document.documentElement.dataset.theme = t;
    const icon = document.querySelector("link[rel='icon']");
    if (icon) icon.href = t === "light" ? "/favicon-light.svg" : "/favicon.svg";
  }
  applyTheme(theme);
  $effect(() => applyTheme(theme));

  const LAYER_COLORS = $derived(THEME_PALETTES[theme]);
  const DEFAULT_INK = $derived(LAYER_COLORS[0]);

  let cols = $state(saved?.cols ?? 80);
  let rows = $state(saved?.rows ?? 24);
  // What the Canvas panel's number fields hold. They only reach `cols`/`rows` on change, so
  // there is still an old size to compare against and to put on the undo stack.
  let colsInput = $state(80);
  let rowsInput = $state(24);
  $effect(() => {
    colsInput = cols;
    rowsInput = rows;
  });

  // Layer stack, bottom-first: index 0 paints first, later layers cover it.
  const initialLayers = saved?.layers ?? [
    {
      id: 1,
      name: "Layer 1",
      visible: true,
      color: DEFAULT_INK,
      ox: 0,
      oy: 0,
      grid: makeGrid(80, 24)
    }
  ];
  let layers = $state(initialLayers);
  let activeIndex = $state(saved?.activeIndex ?? 0);
  // Ids only ever grow, so a restored stack carries on after its highest.
  let nextLayerId = Math.max(0, ...initialLayers.map((l) => l.id)) + 1;
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

  const activeLayer = $derived(layers[activeIndex]);
  const activeText = $derived(activeLayer.text ?? null);
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

  let fontVersion = $state(0); // bumped when a webfont finishes loading, to force a re-render
  const loadedFamilies = new Set(); // webfonts confirmed usable by canvas
  let fontFailures = $state({}); // family -> true once it's known to be unavailable (offline)
  const fontReady = $derived(!activeText || !fontFailures[activeText.family]);

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
  // Resampled once here; the on-screen preview, Apply and export all read this one result.
  const transformedGrid = $derived(
    hasPendingTransform ? transformGrid(grid, pendingTransform) : null
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
    if (activeText) editText(key, value);
    else pendingTransform[key] = value;
  }

  function resetTransform() {
    if (activeText) {
      snapshot();
      Object.assign(layers[activeIndex].text, NO_TRANSFORM);
    } else pendingTransform = { ...NO_TRANSFORM };
  }

  function applyTransform() {
    if (!hasPendingTransform) return;
    snapshot();
    layers[activeIndex].grid = transformedGrid;
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
      grid: [],
      text: {
        ...TEXT_DEFAULTS,
        // Solid style draws with whatever the brush held when the layer was made; from then on
        // it's the layer's own, so changing the brush can't restyle text behind your back.
        solidChar: char.trim() ? char : "#"
      }
    };
    insertLayer(layer);
  }

  /** The active text layer's rendered size, transforms included. */
  const textSize = $derived(
    activeText
      ? { width: activeLayer.grid[0]?.length ?? 0, height: activeLayer.grid.length }
      : null
  );

  /**
   * How far the active text layer spills past each canvas edge, if at all. Measured on the
   * finished cells, so a rotated or skewed layer is judged by where it actually lands.
   */
  const textOverflow = $derived.by(() => {
    if (!textSize) return null;
    const { width, height } = textSize;
    if (!width || !height) return null;
    const left = Math.max(0, -layerOx);
    const top = Math.max(0, -layerOy);
    const right = Math.max(0, layerOx + width - cols);
    const bottom = Math.max(0, layerOy + height - rows);
    return left || top || right || bottom ? { left, top, right, bottom } : null;
  });

  /** Grow the canvas so the active text layer fits, shifting everything to keep it aligned. */
  function fitCanvasToText() {
    if (!textOverflow) return;
    const { left, top, right, bottom } = textOverflow;
    snapshot();
    const newCols = Math.min(400, cols + left + right);
    const newRows = Math.min(200, rows + top + bottom);
    // The canvas has a ceiling; if it's hit, shift only by what was actually gained.
    const dx = Math.min(left, newCols - cols);
    const dy = Math.min(top, newRows - rows);
    for (const layer of layers) {
      if (layer.text) {
        layer.text.x += dx;
        layer.text.y += dy;
      } else {
        layer.ox = (layer.ox ?? 0) + dx;
        layer.oy = (layer.oy ?? 0) + dy;
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

  const round2 = (n) => Math.round(n * 100) / 100;
  // The slider reads as weight, so it's the inverse of the stored coverage threshold.
  const textWeight = $derived(activeText ? round2(1 - activeText.threshold) : 0);

  /** Change one parameter of the active text layer, as an undoable step. */
  function editText(key, value) {
    if (!activeText) return;
    // A slider drag or a typing burst is one step, not one per event.
    snapshot(`text:${activeLayer.id}:${key}`);
    layers[activeIndex].text[key] = value;
  }

  /**
   * Build a text layer's cells from its parameters: rasterise, mirror, then transform.
   *
   * The result is the layer's own tightly cropped grid with an origin, exactly like a painted
   * layer that has been moved. Nothing is clipped to the canvas here, so a layer hanging off
   * the edge keeps every cell, and flips and rotations work on the whole text rather than on
   * whatever happened to be in view.
   */
  function buildTextLayer(text) {
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
    } = text;
    let { grid: out, left, top } = renderText({ ...options, ramp: RAMPS.Blocks });
    let ox = x + left;
    let oy = y + top;
    if (flipH) out = flipGrid(out, "h");
    if (flipV) out = flipGrid(out, "v");
    if (out.length && (skewX || skewY || rotate || perspX || perspY)) {
      // The resampler keeps its grid's size, so give it a margin that any of the transforms
      // can spill into, then crop back down to whatever came out.
      const w = out[0].length;
      const h = out.length;
      const radius = Math.sqrt(w * w + 4 * h * h) / 2; // cells are 1:2, so height counts double
      const turning = rotate % 90 !== 0;
      const padX =
        Math.ceil(
          (turning ? radius - w / 2 : 0) +
            (Math.abs(skewX) * h) / 2 +
            (Math.abs(perspX) * w) / 2
        ) + 2;
      const padY =
        Math.ceil(
          (turning ? radius / 2 - h / 2 : 0) +
            (Math.abs(skewY) * w) / 2 +
            (Math.abs(perspY) * h) / 2
        ) + 2;
      const padded = makeGrid(w + padX * 2, h + padY * 2);
      for (let r = 0; r < h; r++) {
        for (let c = 0; c < w; c++) padded[r + padY][c + padX] = out[r][c];
      }
      const turned = transformGrid(padded, { skewX, skewY, rotate, perspX, perspY });
      const bounds = contentBounds(turned);
      if (!bounds) return { grid: [], ox, oy };
      out = turned
        .slice(bounds.minY, bounds.maxY + 1)
        .map((row) => row.slice(bounds.minX, bounds.maxX + 1));
      ox += bounds.minX - padX;
      oy += bounds.minY - padY;
    }
    return { grid: out, ox, oy };
  }

  // What each text layer was last built from, by layer id. Rasterising goes through a canvas
  // and back, so a layer is only rebuilt when its own parameters (or its font) change — not
  // because a sibling was edited or the stack was reordered.
  let textBuilds = new Map();

  /**
   * Re-render text layers whose parameters (or a newly loaded font) changed.
   * This reads only `text` and never `grid`, so writing the grid can't retrigger it.
   */
  $effect(() => {
    fontVersion;
    const next = new Map();
    for (const layer of layers) {
      if (!layer.text) continue;
      const text = $state.snapshot(layer.text);
      const key = JSON.stringify(text) + (loadedFamilies.has(text.family) ? "+" : "-");
      const previous = textBuilds.get(layer.id);
      if (previous !== key) {
        const { grid, ox, oy } = buildTextLayer(text);
        layer.grid = grid;
        layer.ox = ox;
        layer.oy = oy;
      }
      next.set(layer.id, key);
    }
    textBuilds = next;
  });

  function useFont(family) {
    editText("family", family);
  }

  $effect(() => {
    // Fetch whatever font any text layer wants — not just the active one, so a layer brought
    // back by undo or a duplicate renders properly too — and bump the version once a font is
    // genuinely usable so the layers using it are rebuilt.
    for (const layer of layers) {
      const family = layer.text?.family;
      if (!family || loadedFamilies.has(family) || fontFailures[family]) continue;
      loadFont(family).then((ok) => {
        if (!ok) fontFailures[family] = true;
        else if (!loadedFamilies.has(family)) {
          loadedFamilies.add(family);
          fontVersion += 1;
        }
      });
    }
  });

  let tool = $state("pencil");
  // Primary / secondary characters, à la Photoshop's foreground / background swatches. The
  // primary draws with the left button, the secondary with the right; X swaps them. Only the
  // primary is editable directly: swap to reach the secondary.
  let char = $state(prefs.char ?? "#");
  let altChar = $state(prefs.altChar ?? " ");
  let boxStyle = $state(
    BOX_STYLES.includes(prefs.boxStyle) ? prefs.boxStyle : "double"
  );
  let filled = $state(false); // rect, ellipse, triangle and diamond: solid rather than outline
  let triangleDir = $state("up");
  let constrain = $state(false); // Shift during a shape drag: square, circle, equilateral, 45°
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
  let fontSize = $state(prefs.fontSize ?? 16);
  // Display-only cell metrics: extra px between columns, and the row height multiplier.
  let letterSpacing = $state(prefs.letterSpacing ?? 0);
  let lineHeight = $state(prefs.lineHeight ?? 1.2);
  let showGrid = $state(prefs.showGrid ?? true);
  let showGuides = $state(prefs.showGuides ?? false); // row and column bands under the cursor
  let brushSize = $state(prefs.brushSize ?? 1);
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
  let addingToSelection = false; // Shift was down when the select drag started
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
    ["line", "rect", "box", "ellipse", "triangle", "diamond"].includes(tool)
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

  function setChar(value) {
    // Keep the last typed character so the single-cell input behaves like a replace.
    char = [...value].pop() ?? " ";
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
    const [x1, y1] = constrain && isShape ? constrainEnd(x0, y0, ...end) : end;
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
    if (tool === "ellipse")
      return ellipsePoints(x0, y0, x1, y1, filled).map(([x, y]) => [x, y, ch]);
    if (tool === "triangle")
      return polygonPoints(
        triangleVertices(x0, y0, x1, y1, triangleDir),
        filled
      ).map(([x, y]) => [x, y, ch]);
    if (tool === "diamond")
      return polygonPoints(diamondVertices(x0, y0, x1, y1), filled).map(
        ([x, y]) => [x, y, ch]
      );
    return boxCells(x0, y0, x1, y1, boxStyle);
  });

  /**
   * Where the drag end lands with Shift held. Cells aren't square, so "square" and "circle"
   * mean equal on screen, measured with the current cell pitch: a rect, box, ellipse or
   * diamond gets equal sides, a triangle becomes equilateral, and a line snaps to
   * horizontal, vertical or the screen diagonal.
   */
  function constrainEnd(x0, y0, x1, y1) {
    const sx = x1 >= x0 ? 1 : -1;
    const sy = y1 >= y0 ? 1 : -1;
    const wx = (Math.abs(x1 - x0) + 1) * cellW; // on-screen extent of the box, in px
    const wy = (Math.abs(y1 - y0) + 1) * cellH;
    if (tool === "line") {
      const angle = Math.atan2(wy, wx);
      if (angle < Math.PI / 8) return [x1, y0];
      if (angle > (3 * Math.PI) / 8) return [x0, y1];
    }
    // Height over width the shape wants on screen: 1 for square, √3/2 for an equilateral
    // triangle standing on its base, and the inverse when it lies on its side.
    const ratio =
      tool !== "triangle"
        ? 1
        : triangleDir === "up" || triangleDir === "down"
          ? Math.sqrt(3) / 2
          : 2 / Math.sqrt(3);
    const size = Math.max(wx, wy / ratio);
    const dx = Math.max(0, Math.round(size / cellW) - 1);
    const dy = Math.max(0, Math.round((size * ratio) / cellH) - 1);
    return [x0 + sx * dx, y0 + sy * dy];
  }

  /** The active layer with any in-flight edit applied, or null when nothing is in progress. */
  const previewLayer = $derived.by(() => {
    const isMoving = moving && (moving.dx || moving.dy);
    if (!isMoving && !preview.length && !hasPendingTransform) return null;

    const out = cloneGrid(transformedGrid ?? grid);
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
      chars: flatten(transformedGrid, owners),
      owners
    };
  });

  const text = $derived(gridToText(exportView.chars));

  /**
   * A layer as plain, unshared data. The grid and the text parameters are both copied: a
   * history entry that still pointed at the live `text` object would change along with it,
   * and undoing an edit would restore the edit.
   */
  function cloneLayer(layer) {
    const copy = { ...layer, grid: cloneGrid(layer.grid) };
    if (layer.text) copy.text = structuredClone($state.snapshot(layer.text));
    return copy;
  }

  /** Undo entries capture the whole stack, so layer adds/deletes/reorders are undoable too. */
  function captureState() {
    return { layers: layers.map(cloneLayer), activeIndex, cols, rows };
  }

  function restoreState(state) {
    // Clone on the way out too: the stack entry must not become live, mutable state.
    layers = state.layers.map(cloneLayer);
    activeIndex = Math.min(state.activeIndex, state.layers.length - 1);
    cols = state.cols;
    rows = state.rows;
  }

  // The last coalescing snapshot, so a run of edits to one control folds into a single step.
  let coalescing = null; // { key, at }
  const COALESCE_MS = 1000;

  /**
   * Push the current state onto the undo stack. With a `coalesceKey`, repeated calls in quick
   * succession — a slider being dragged, a word being typed — extend the previous entry
   * instead of adding one apiece, so one Cmd+Z takes back the whole gesture.
   */
  function snapshot(coalesceKey = null) {
    const now = Date.now();
    if (
      coalesceKey &&
      coalescing?.key === coalesceKey &&
      now - coalescing.at < COALESCE_MS
    ) {
      coalescing.at = now;
      return;
    }
    coalescing = coalesceKey ? { key: coalesceKey, at: now } : null;
    undoStack = [...undoStack.slice(-99), captureState()];
    redoStack = [];
  }

  function undo() {
    if (!undoStack.length) return;
    coalescing = null;
    const prev = undoStack[undoStack.length - 1];
    undoStack = undoStack.slice(0, -1);
    redoStack = [...redoStack, captureState()];
    restoreState(prev);
  }

  function redo() {
    if (!redoStack.length) return;
    coalescing = null;
    const next = redoStack[redoStack.length - 1];
    redoStack = redoStack.slice(0, -1);
    undoStack = [...undoStack, captureState()];
    restoreState(next);
  }

  function paint(cells) {
    // A text layer's cells are rebuilt from its parameters; anything painted would be lost.
    if (activeText) return;
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

  // ── View transform ─────────────────────────────────────────────────────────
  // Panning and zooming move the whole stage on screen and leave the artwork untouched —
  // unlike the Canvas panel's zoom, which resizes the cells and so changes what is drawn.
  const MIN_ZOOM = 0.1;
  const MAX_ZOOM = 8;
  let view = $state({ x: 0, y: 0, z: 1 });
  let stageEl = $state(null);
  let viewportEl = $state(null);
  let spaceHeld = $state(false);
  let panning = $state(null); // last pointer position while dragging the view, else null

  /** Zoom by `factor`, keeping whatever sits under (clientX, clientY) pinned there. */
  function zoomAt(clientX, clientY, factor) {
    const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, view.z * factor));
    viewTouched = true;
    if (z === view.z || !stageEl) return;
    // The stage's own rect already carries the current pan and zoom, so the offset from its
    // corner is the scaled distance to the cursor — no need to know the untransformed spot.
    const rect = stageEl.getBoundingClientRect();
    view = {
      z,
      x: view.x + (clientX - rect.left) * (1 - z / view.z),
      y: view.y + (clientY - rect.top) * (1 - z / view.z)
    };
  }

  const zoomCentre = (factor) =>
    viewportEl
      ? (() => {
          const r = viewportEl.getBoundingClientRect();
          zoomAt(r.left + r.width / 2, r.top + r.height / 2, factor);
        })()
      : undefined;

  // Set by any pan or zoom the user makes; until then the view follows the window, so
  // a canvas that opens wider than a tablet's screen is fitted, and refitted on rotation.
  let viewTouched = false;

  /**
   * Zoom out until the whole canvas is on screen, or back to 100% when it already fits. The
   * untransformed stage is centred by the layout, so the offset only has to undo what the
   * scale pulls toward the stage's corner — unless the stage overflows, in which case the
   * layout leaves it at the top-left edge and the offset centres it outright.
   */
  function fitView() {
    if (!stageEl || !viewportEl) return;
    const pad = getComputedStyle(viewportEl);
    const availW =
      viewportEl.clientWidth - parseFloat(pad.paddingLeft) - parseFloat(pad.paddingRight);
    const availH =
      viewportEl.clientHeight - parseFloat(pad.paddingTop) - parseFloat(pad.paddingBottom);
    const w = stageEl.offsetWidth;
    const h = stageEl.offsetHeight;
    const z = Math.max(MIN_ZOOM, Math.min(1, availW / w, availH / h));
    view = {
      z,
      x: w <= availW ? (w * (1 - z)) / 2 : (availW - w * z) / 2,
      y: h <= availH ? (h * (1 - z)) / 2 : (availH - h * z) / 2
    };
    viewTouched = false;
  }
  const resetView = fitView;

  $effect(() => {
    if (stageEl && viewportEl) fitView();
  });

  // Svelte registers wheel handlers as passive, where preventDefault is a no-op, so this
  // one is attached by hand to stop the browser page-zooming on a pinch.
  $effect(() => {
    const el = viewportEl;
    if (!el) return;
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  });

  /** Trackpad and wheel: pinch (or ctrl/⌘ held) zooms, everything else pans. */
  function onWheel(event) {
    event.preventDefault();
    viewTouched = true;
    if (event.ctrlKey || event.metaKey) {
      zoomAt(event.clientX, event.clientY, Math.exp(-event.deltaY / 240));
    } else {
      view = { ...view, x: view.x - event.deltaX, y: view.y - event.deltaY };
    }
  }

  // Middle-drag, or space held with the left button, pans regardless of the armed tool.
  const wantsPan = (event) =>
    event.button === 1 || (spaceHeld && event.button === 0);

  function onViewPointerDown(event) {
    if (!wantsPan(event)) return;
    event.preventDefault();
    viewTouched = true;
    panning = { x: event.clientX, y: event.clientY };
    viewportEl?.setPointerCapture?.(event.pointerId);
  }

  function onViewPointerMove(event) {
    if (onTouchMove(event) || !panning) return;
    view = {
      ...view,
      x: view.x + event.clientX - panning.x,
      y: view.y + event.clientY - panning.y
    };
    panning = { x: event.clientX, y: event.clientY };
  }

  const endPan = () => (panning = null);
  function onViewPointerUp(event) {
    endPan();
    onTouchUp(event);
  }

  // ── Touch ──────────────────────────────────────────────────────────────────
  // One finger works the armed tool; two pan and pinch-zoom the view. The second finger is
  // caught on the way down, in the capture phase, so the canvas never sees it, and whatever
  // the first finger had started is thrown away: it was the start of a pan, not a mark. Pens
  // aren't tracked here, so a resting finger never interrupts a stylus stroke.
  const touches = new Map(); // pointerId -> { x, y } for the fingers currently down
  let gesturing = false; // from the second finger's touch until every finger lifts

  function onTouchDownCapture(event) {
    if (event.pointerType !== "touch") return;
    touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (touches.size < 2 && !gesturing) return;
    event.stopPropagation();
    if (!gesturing) {
      gesturing = true;
      cancelStroke();
    }
  }

  /** Centre and spread of the first two fingers. */
  function pinchOf() {
    const [a, b] = touches.values();
    return {
      cx: (a.x + b.x) / 2,
      cy: (a.y + b.y) / 2,
      d: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y))
    };
  }

  /** Returns true when the move belonged to a finger, whether or not it moved the view. */
  function onTouchMove(event) {
    const finger = touches.get(event.pointerId);
    if (!finger) return false;
    if (!gesturing || touches.size < 2) {
      finger.x = event.clientX;
      finger.y = event.clientY;
      return true;
    }
    const before = pinchOf();
    finger.x = event.clientX;
    finger.y = event.clientY;
    const after = pinchOf();
    // Scale about where the fingers were, then carry the view along with them.
    zoomAt(before.cx, before.cy, after.d / before.d);
    view = { ...view, x: view.x + after.cx - before.cx, y: view.y + after.cy - before.cy };
    return true;
  }

  function onTouchUp(event) {
    if (!touches.delete(event.pointerId)) return;
    if (!touches.size) gesturing = false;
  }

  /**
   * The cell under a pointer event. Outside the canvas this returns null, except with
   * `clamp` — during a drag the pointer wandering off the edge should keep the stroke or
   * shape tracking along that edge rather than freezing at whatever cell it last touched.
   */
  function cellFromEvent(event, { clamp = false } = {}) {
    if (!gridEl) return null;
    // The rect is post-transform, so the on-screen cell size is the zoomed one.
    const rect = gridEl.getBoundingClientRect();
    const x = Math.floor((event.clientX - rect.left) / (cellW * view.z));
    const y = Math.floor((event.clientY - rect.top) / (cellH * view.z));
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
    if (wantsPan(event)) return; // the viewport handles it as a pan instead
    const cell = cellFromEvent(event);
    if (!cell) return;
    if (isPath) {
      gridEl?.focus();
      if (event.button === 2) finishPath();
      else polyPoints = [...polyPoints, cell];
      pathPointByTouch = event.pointerType === "touch";
      return;
    }
    // Capture on the canvas itself, not event.target: the target is a row <div> whose text is
    // rewritten as you draw, and capture is lost the moment that node is replaced.
    gridEl?.setPointerCapture?.(event.pointerId);
    dragging = true;
    start = cell;
    end = cell;

    if (tool === "move") {
      gridEl?.focus();
      layerShift = { dx: 0, dy: 0 };
      return;
    }
    // A text layer is regenerated from its parameters, so anything typed or painted onto it
    // would be erased. Moving it is fine, which is why Move is handled above.
    if (activeText) {
      dragging = false;
      flash(
        "Text layer — edit it in the Font panel, or Rasterize to draw on it"
      );
      return;
    }
    if (tool === "text") {
      caret = cell;
      gridEl?.focus();
      return;
    }
    if (tool === "select") {
      gridEl?.focus();
      // Shift joins the new marquee or wand pick onto the current selection instead of
      // replacing it, and never starts a move even when the press lands inside it.
      addingToSelection = event.shiftKey;
      if (!addingToSelection && selKeys.has(`${cell[0]},${cell[1]}`)) {
        // Grab the current selection's characters; Alt drags out a copy instead of moving.
        moving = {
          cells: selection.map(([x, y]) => [x, y, cellAt(x, y)]),
          dx: 0,
          dy: 0,
          copy: event.altKey
        };
      } else {
        marquee = [cell[0], cell[1], cell[0], cell[1]];
        if (!addingToSelection) selection = null;
      }
      return;
    }
    commitInProgress();
    // Right button draws with the secondary character, mirroring Photoshop's background colour.
    strokeChar = event.button === 2 ? altChar : char;
    snapshot();
    strokeUndoable = true;

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
    constrain = event.shiftKey;
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

  // Whether the in-progress stroke pushed an undo entry, so cancelling it can pop that back.
  let strokeUndoable = false;
  let pathPointByTouch = false;

  /**
   * Abandon whatever the pointer is in the middle of without committing it: a stroke goes
   * back to the state it snapshotted, a marquee, move or shape preview simply drops, and a
   * path vertex that a finger just planted is pulled out again.
   */
  function cancelStroke() {
    if (isPath && pathPointByTouch) {
      polyPoints = polyPoints.slice(0, -1);
      pathPointByTouch = false;
    }
    if (!dragging) return;
    if (strokeUndoable && undoStack.length) {
      restoreState(undoStack[undoStack.length - 1]);
      undoStack = undoStack.slice(0, -1);
      coalescing = null;
    }
    strokeUndoable = false;
    straightMode = false;
    constrain = false;
    dragging = false;
    start = null;
    end = null;
    strokeChar = null;
    marquee = null;
    moving = null;
    layerShift = null;
  }

  function onPointerUp() {
    endPan();
    // Also fires from the window, so a release outside the canvas — or outside the browser —
    // still ends the drag. Without the guard the second delivery would re-commit the stroke.
    strokeUndoable = false;
    if (!dragging) return;
    if ((isShape || straightMode) && preview.length) paint(preview);
    if (tool === "select") finishSelectDrag();
    if (tool === "move") commitLayerShift();
    straightMode = false;
    constrain = false;
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
    const cells =
      x0 === x1 && y0 === y1
        ? // A click with no drag acts as a magic wand; on blank canvas it just clears.
          objectPoints(activeCanvasGrid(), x0, y0, { sameChar: sameCharOnly })
        : rectPoints(x0, y0, x1, y1, true);
    if (addingToSelection && selection) {
      const fresh = cells.filter(([x, y]) => !selKeys.has(`${x},${y}`));
      selection = [...selection, ...fresh];
      return;
    }
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

  const ARROWS = {
    ArrowLeft: [-1, 0],
    ArrowRight: [1, 0],
    ArrowUp: [0, -1],
    ArrowDown: [0, 1]
  };

  function onKeyDown(event) {
    if (event.key === "Shift" && dragging) constrain = true;
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
    if (meta && ["=", "+", "-", "_", "0"].includes(event.key)) {
      event.preventDefault();
      if (event.key === "0") resetView();
      else zoomCentre(event.key === "-" || event.key === "_" ? 1 / 1.25 : 1.25);
      return;
    }
    if (meta) return;

    // Space arms panning, except while typing, where it is a character like any other.
    if (event.code === "Space" && !(tool === "text" && caret)) {
      event.preventDefault();
      spaceHeld = true;
      return;
    }

    if (tool === "move" && event.key.startsWith("Arrow")) {
      event.preventDefault();
      const d = ARROWS[event.key];
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
        const d = ARROWS[event.key];
        nudge(d[0], d[1]);
        return;
      }
    }

    // The caret may be left over from a painted layer; typing must not land on a text layer.
    if (tool === "text" && caret && !activeText) {
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
        const d = ARROWS[event.key];
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
      c: "ellipse",
      f: "fill",
      t: "text",
      s: "select",
      v: "move",
      d: "path"
    }[key];
    if (shortcut) tool = shortcut;
  }

  /** A blank painted layer the size of the canvas, named after its id. */
  function newLayer() {
    const id = nextLayerId++;
    return {
      id,
      name: `Layer ${id}`,
      visible: true,
      color: DEFAULT_INK,
      ox: 0,
      oy: 0,
      grid: makeGrid(cols, rows)
    };
  }

  /**
   * Drop a layer into the stack just above the active one and make it active. Not an undo
   * step on its own: callers snapshot first, so a gesture that also adds a layer — paste onto
   * a text layer, say — is still one step.
   */
  function insertLayer(layer) {
    layers = [
      ...layers.slice(0, activeIndex + 1),
      layer,
      ...layers.slice(activeIndex + 1)
    ];
    activeIndex += 1;
    selection = null;
  }

  function addLayer() {
    commitInProgress();
    snapshot();
    insertLayer(newLayer());
  }

  function duplicateLayer() {
    commitInProgress();
    snapshot();
    // cloneLayer copies the text parameters too, so a copy of a text layer stays editable text.
    const copy = cloneLayer(layers[activeIndex]);
    copy.id = nextLayerId++;
    copy.name = `${copy.name} copy`;
    insertLayer(copy);
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
    // Merging onto a text layer bakes it first: otherwise its next rebuild would regenerate
    // its cells from the parameters and quietly drop everything just merged in.
    if (lower.text) delete lower.text;
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
    // Read through the export view, so a selection copies what's on screen — pending
    // transform included — exactly as copying the whole canvas does.
    const { chars } = exportView;
    for (const [x, y] of selection) {
      if (y < chars.length && x < cols) out[y - minY][x - minX] = chars[y][x];
    }
    return gridToText(out);
  });

  async function copyText() {
    const content = selectionText;
    const what = selection?.length ? "selection" : "canvas";
    try {
      await navigator.clipboard.writeText(content);
      flash(`Copied ${what} to clipboard`);
      return true;
    } catch {
      flash("Clipboard blocked — use Export to save the text instead");
      return false;
    }
  }

  /** Copy the selection, then clear the cells it covers on the active layer. */
  async function cutSelection() {
    if (!selection?.length) return;
    // Nothing is removed unless the copy actually reached the clipboard.
    if (await copyText()) deleteSelection();
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
    ctx.fillStyle = getComputedStyle(gridEl ?? document.documentElement)
      .getPropertyValue("--bg")
      .trim();
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

    commitInProgress();
    snapshot();
    // A text layer regenerates from its parameters, so give the paste a layer of its own.
    if (activeText) insertLayer(newLayer());
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
  // Three toolbar groups, matching the Figma file: selection, drawing, and the three
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
      hint: "Path, line, rectangle, box, ellipse, triangle and diamond"
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
    { id: "path", label: "Path", key: "D", icon: "shape-path" },
    { id: "line", label: "Line", key: "L", icon: "shape-line" },
    { id: "rect", label: "Rect", key: "R", icon: "shape-rect" },
    { id: "box", label: "Box", key: "O", icon: "shape-box" },
    { id: "ellipse", label: "Ellipse", key: "C", icon: "shape-ellipse" },
    { id: "triangle", label: "Triangle", key: "", icon: "shape-triangle" },
    { id: "diamond", label: "Diamond", key: "", icon: "shape-diamond" }
  ];
  let lastShape = $state("path");
  const inShapeGroup = $derived(SHAPES.some((s) => s.id === tool));
  const shapeButton = $derived(
    SHAPES.find((s) => s.id === (inShapeGroup ? tool : lastShape))
  );
  $effect(() => {
    if (inShapeGroup) lastShape = tool;
  });

  // Panels that can be torn out of the popover and docked on the right. Tool settings are
  // pinned per tool under a "tool:" key — a docked Pencil panel stays a Pencil panel when the
  // brush is armed — with the shape group sharing one key, as it shares one button.
  const PINNABLE = {
    layers: "Layers",
    char: "Characters",
    effects: "Effects",
    canvas: "Canvas"
  };
  const TOOL_PREFIX = "tool:";
  const TOOL_IDS = new Set([...SELECT_TOOLS, ...DRAW_TOOLS].map((t) => t.id));
  const pinnableName = (name) =>
    name.startsWith(TOOL_PREFIX)
      ? TOOL_IDS.has(name.slice(TOOL_PREFIX.length))
      : name in PINNABLE;

  // Panel names, in dock order top to bottom. Layers starts docked, where it always lived;
  // its toolbar button hides it and Pin moves it into the popover like any other panel.
  // A restored session keeps whatever arrangement it was left in.
  let pinned = $state(
    (prefs.pinned ?? ["layers"]).filter(pinnableName)
  );

  /** What the floating panel above the toolbar shows. 'tool' follows the armed tool. */
  let panel = $state("tool");
  // The dock key of the armed tool's settings, and of whatever the popover shows.
  const toolKey = $derived(TOOL_PREFIX + (inShapeGroup ? "shape" : tool));
  const panelKey = $derived(panel === "tool" ? toolKey : panel);
  let toolbarEl = $state(null);
  let settingsEl = $state(null);
  // Popover left edge in page pixels; null falls back to centred over the toolbar.
  let popoverLeft = $state(null);

  /**
   * Park the popover above the toolbar button that owns what it shows — the armed tool, the
   * swatch, or a panel toggle — without letting it stick out past the toolbar's own edges.
   * A popover wider than the toolbar is simply centred over it.
   */
  function placePopover() {
    if (!toolbarEl || !settingsEl) return;
    const name = panel === "tool" ? (inShapeGroup ? "shape" : tool) : panel;
    const anchor = toolbarEl.querySelector(`[data-anchor="${name}"]`);
    if (!anchor) {
      popoverLeft = null;
      return;
    }
    const a = anchor.getBoundingClientRect();
    const t = toolbarEl.getBoundingClientRect();
    const width = settingsEl.offsetWidth;
    const centred = a.left + a.width / 2 - width / 2;
    popoverLeft = Math.round(
      width >= t.width
        ? t.left + t.width / 2 - width / 2
        : Math.max(t.left, Math.min(t.right - width, centred))
    );
  }

  $effect(() => {
    // Re-park whenever what the popover shows changes, and whenever its own size does — a
    // brush panel is wider than a pencil one, and the anchor is measured against the width.
    void [panel, tool, inShapeGroup];
    if (!settingsEl) return;
    placePopover();
    const observer = new ResizeObserver(placePopover);
    observer.observe(settingsEl);
    return () => observer.disconnect();
  });
  // How far the toolbar's top edge sits above the app's bottom edge. The popover, toast and
  // status hang off it, and it moves: the bar shrinks on a tablet, and gains a scrollbar's
  // height where it has to scroll.
  let aboveToolbar = $state(110);
  $effect(() => {
    const el = toolbarEl;
    if (!el) return;
    const measure = () => {
      const app = el.offsetParent;
      if (app) aboveToolbar = app.clientHeight - el.offsetTop;
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  });
  const hasToolSettings = $derived(tool !== "move" && tool !== "fill");
  // Hidden is a one-shot dismissal of the popover: it survives until the user asks for a
  // panel again, so a panel that covers the artwork can be pushed out of the way in place.
  let panelHidden = $state(false);
  const panelOpen = $derived(
    panelHidden || pinned.includes(panelKey)
      ? false
      : panel !== "tool" || hasToolSettings
  );
  // A panel button has two lit states: solid while its panel is up in the popover, the way
  // an armed tool is, and a quieter outline while the panel lives in the dock.
  const panelPopped = (name) =>
    panel === name && !panelHidden && !pinned.includes(name);

  function pickTool(id) {
    tool = id === "shape" ? lastShape : id;
    panel = "tool";
    panelHidden = false;
  }

  // A tool panel is named after its tool rather than "Tool"; the shape group's after
  // whichever shape is live.
  const toolLabel = (id) =>
    id === "shape"
      ? shapeButton.label
      : ([...SELECT_TOOLS, ...DRAW_TOOLS].find((t) => t.id === id)?.label ?? id);
  const panelTitle = (name) =>
    name === "tool"
      ? toolLabel(inShapeGroup ? "shape" : tool)
      : name.startsWith(TOOL_PREFIX)
        ? toolLabel(name.slice(TOOL_PREFIX.length))
        : PINNABLE[name];
  /** Which tool a docked tool panel configures; the shape group shows the live shape. */
  function dockTool(name) {
    const id = name.slice(TOOL_PREFIX.length);
    return id === "shape" ? shapeButton.id : id;
  }
  function pinPanel(name) {
    if (!pinned.includes(name)) pinned = [...pinned, name];
    panel = "tool";
    panelHidden = false;
  }

  const unpinPanel = (name) => (pinned = pinned.filter((n) => n !== name));

  /**
   * The toolbar button is show/hide; pinning only decides where the panel lives. So pressing
   * it on a pinned panel closes that panel outright rather than reopening it in the popover.
   */
  function togglePanel(name) {
    if (pinned.includes(name)) unpinPanel(name);
    else if (panel === name && !panelHidden) panel = "tool";
    else {
      panel = name;
      panelHidden = false;
    }
  }

  /** Clicking the primary swatch toggles the character palette. */
  function pickChar() {
    togglePanel("char");
  }

  /** Swatches show a visible stand-in for whitespace rather than an empty box. */
  const showChar = (ch) => (ch === " " ? "SP" : ch);

  // ── Dock ───────────────────────────────────────────────────────────────────
  const DOCK_WIDTH = 308;

  let collapsed = $state({}); // panel name -> collapsed, across the dock
  let panelPos = $state(null); // {x, y}; null until it's parked in its designed spot
  let listEl = $state(null);
  let panelDrag = null;

  $effect(() => {
    if (!panelPos)
      panelPos = { x: window.innerWidth - DOCK_WIDTH - 23, y: 26 };
  });

  /**
   * The dock keeps its distance from the nearer side of the window as the window resizes,
   * so one parked at the right edge stays at the right edge; either way it stays on screen.
   */
  let lastWidth = window.innerWidth;
  function followResize() {
    const width = window.innerWidth;
    if (panelPos && panelPos.x + DOCK_WIDTH / 2 > lastWidth / 2) {
      panelPos = { ...panelPos, x: panelPos.x + width - lastWidth };
    }
    lastWidth = width;
    clampPanel();
  }

  /** Keep a dragged panel on screen when the window shrinks under it. */
  function clampPanel() {
    if (!panelPos) return;
    panelPos = {
      x: Math.max(
        8,
        Math.min(window.innerWidth - DOCK_WIDTH - 8, panelPos.x)
      ),
      y: Math.max(8, Math.min(window.innerHeight - 60, panelPos.y))
    };
  }

  function startPanelDrag(event) {
    if (event.button !== 0 || event.target.closest("button")) return;
    event.preventDefault(); // no text selection sweeping across the panels under the drag
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

  // Dragging the popover's header tears the panel off: a few pixels in, it is unpinned onto
  // the top of the dock and the dock follows the pointer from there, so the header the user
  // grabbed stays under the cursor throughout.
  let tearOff = null; // { name, x, y, dx, dy } from press until it tears or is released
  function startTearOff(event) {
    if (event.button !== 0 || event.target.closest("button")) return;
    event.preventDefault();
    const head = event.currentTarget.getBoundingClientRect();
    tearOff = {
      name: panelKey,
      x: event.clientX,
      y: event.clientY,
      // The grab point within the header, capped so it still lands inside the narrower dock.
      dx: Math.min(event.clientX - head.left, DOCK_WIDTH - 40),
      dy: event.clientY - head.top
    };
    window.addEventListener("pointermove", moveTearOff);
    window.addEventListener("pointerup", endTearOff, { once: true });
  }
  function moveTearOff(event) {
    if (!tearOff) return;
    if (Math.hypot(event.clientX - tearOff.x, event.clientY - tearOff.y) < 6) return;
    const { name, dx, dy } = tearOff;
    endTearOff();
    pinned = [name, ...pinned.filter((n) => n !== name)];
    panel = "tool";
    panelHidden = false;
    panelPos = { x: event.clientX - dx, y: event.clientY - dy };
    clampPanel();
    // Hand the rest of the gesture to the dock drag; the pointer was never captured by a
    // dock header, so the window carries the events until release.
    panelDrag = { dx, dy };
    window.addEventListener("pointermove", movePanelDrag);
    window.addEventListener(
      "pointerup",
      () => {
        endPanelDrag();
        window.removeEventListener("pointermove", movePanelDrag);
      },
      { once: true }
    );
  }
  function endTearOff() {
    tearOff = null;
    window.removeEventListener("pointermove", moveTearOff);
  }

  // The dock — every pinned panel — moves as one column, so every header in it drags the
  // same position.
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
    // Measured from a real row, so the stylesheet is the only place the height is set.
    const rowHeight = listEl.firstElementChild?.offsetHeight || 32;
    const visual = Math.floor((event.clientY - top + listEl.scrollTop) / rowHeight);
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

  // Layers painted from the palette follow it across: white ink becomes black ink, and the
  // bright hues become their deep counterparts. Custom colours are the user's and stay put.
  function toggleTheme() {
    const next = theme === "dark" ? "light" : "dark";
    const from = THEME_PALETTES[theme];
    const to = THEME_PALETTES[next];
    for (const layer of layers) {
      const i = from.indexOf(layer.color);
      if (i !== -1) layer.color = to[i];
    }
    theme = next;
  }

  const closeMenus = () => {
    menu = null;
    colorMenu = null;
    about = false;
  };

  // ── Brand ──────────────────────────────────────────────────────────────────
  // The wordmark is block glyphs straight from the Figma file — it's ASCII art, so it's set
  // in the art font rather than an image. The links under it only show while the pointer
  // (or keyboard focus) is on the block, and About opens a short note in place.
  const REPO_URL = "https://github.com/PavelLaptev/ascii-editor";
  const LOGO = [
    "▄████▄ ██████ ██  ▄██ ██",
    "██  ██ ██▄▄▄▄ ██▄██▀  ██",
    "██████ ▀▀▀▀██ ██▀██▄  ██",
    "██  ██ ██████ ██  ▀██ ██"
  ];
  let brandHover = $state(false);
  let about = $state(false);

  // ── Persistence ────────────────────────────────────────────────────────────
  // The document and display preferences go to localStorage so a reload picks up where the
  // last session left off. Saving is debounced: a brush stroke changes hundreds of cells, and
  // serialising the stack after every one would stall the stroke. The undo history isn't kept.
  const SAVE_DELAY_MS = 500;
  let saveTimer = null;
  let pendingSave = null;
  let storageWarned = false;

  function flushSave() {
    clearTimeout(saveTimer);
    saveTimer = null;
    if (!pendingSave) return;
    const ok = saveSession(pendingSave);
    pendingSave = null;
    if (!ok && !storageWarned) {
      storageWarned = true;
      flash("Couldn't save the session — browser storage is full or blocked");
    }
  }

  $effect(() => {
    // Snapshotting reads every cell, which is exactly what makes this rerun on any edit.
    pendingSave = {
      cols,
      rows,
      activeIndex,
      layers: $state.snapshot(layers),
      prefs: {
        fontSize,
        letterSpacing,
        lineHeight,
        showGrid,
        showGuides,
        char,
        altChar,
        brushSize,
        boxStyle,
        theme,
        pinned: $state.snapshot(pinned)
      }
    };
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushSave, SAVE_DELAY_MS);
  });
</script>

<svelte:window
  onkeydown={onKeyDown}
  onkeyup={(e) => {
    if (e.code === "Space") spaceHeld = false;
    if (e.key === "Shift") constrain = false;
  }}
  onblur={() => (spaceHeld = false)}
  onpaste={onPaste}
  onpointerup={onPointerUp}
  onpointercancel={onPointerUp}
  onresize={() => {
    followResize();
    placePopover();
    if (!viewTouched) fitView();
  }}
  onbeforeunload={flushSave}
  onclick={closeMenus}
/>

{#snippet layersPanel()}
  <div class="layers-body">
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
        title="Join with the layer below"
        disabled={activeIndex === 0}
        onclick={mergeDown}
      >
        <Icon name="join" size={24} />
      </button>
      <button
        title="Delete layer"
        disabled={layers.length === 1}
        onclick={deleteLayer}
      >
        <Icon name="trash" size={24} />
      </button>
    </div>
  </div>
{/snippet}

{#snippet charPanel()}
  <div class="settings-body">
    <div class="field">
      <span class="label">Character</span>
      <input
        class="char-input"
        value={char}
        oninput={(e) => setChar(e.currentTarget.value)}
        spellcheck="false"
      />
      <span class="value"
        >U+{char
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
                class:active={char === p}
                onclick={() => setChar(p)}
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
  <div class="settings-body effects">
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
    <hr class="sep" />
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
  <div class="settings-body canvas">
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
    <hr class="sep" />
    <label
      class="field"
      title="Glyph size in pixels — part of the artwork, unlike the view zoom (− and + to step)"
    >
      <span class="label">Type size</span>
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
      <label
        class="check"
        title="Highlight the row and column under the cursor across the canvas"
      >
        <input type="checkbox" bind:checked={showGuides} /> Cursor guides
      </label>
      <button class="ghost value" onclick={resetSpacing}>Reset spacing</button>
    </div>
    <hr class="sep" />
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
    <hr class="sep" />
    <div class="field">
      <div class="segmented">
        <button onclick={clearAll} title="Clear the active layer"
          >Clear layer</button
        >
      </div>
    </div>
  </div>
{/snippet}

{#snippet toolPanel(t)}
  <div class="settings-body">
    {#if t === "move" || t === "fill"}
      <p class="note">Nothing to configure for this tool.</p>
    {:else if t === "select"}
      <label
        class="check"
        title="Click-to-select stops at a different character instead of at blanks"
      >
        <input type="checkbox" bind:checked={sameCharOnly} /> Same character
        only
      </label>
    {:else if t === "text"}
      {#if activeText}
        <textarea
          class="text-input"
          rows="2"
          value={activeText.content}
          oninput={(e) => editText("content", e.currentTarget.value)}
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
              checked={activeText.bold}
              onchange={(e) => editText("bold", e.currentTarget.checked)}
            /> Bold</label
          >
        </div>
        <label class="field" title="Height of a capital letter, in rows of cells">
          <span class="label">Size</span>
          <input
            type="range"
            min="1"
            max="20"
            step="0.5"
            value={activeText.size}
            oninput={(e) => editText("size", +e.currentTarget.value)}
          />
          <span class="value">{activeText.size}</span>
        </label>
        <hr class="sep" />
        <div class="field">
          <span class="label">Align</span>
          <div class="segmented">
            {#each ["left", "center", "right"] as a}
              <button
                class:active={(activeText.align ?? "left") === a}
                onclick={() => editText("align", a)}>{a}</button
              >
            {/each}
          </div>
        </div>
        <div class="field">
          <span class="label">Style</span>
          <select
            value={activeText.mode}
            onchange={(e) => editText("mode", e.currentTarget.value)}
          >
            <option value="quad">Quadrants</option>
            <option value="half">Half blocks</option>
            <option value="shade">Shading</option>
            <option value="solid">Solid</option>
          </select>
          {#if activeText.mode === "solid"}
            <input
              class="glyph"
              type="text"
              maxlength="2"
              title="Character to draw with"
              value={activeText.solidChar ?? "#"}
              oninput={(e) => {
                const ch = [...e.currentTarget.value].pop();
                if (ch && ch.trim()) editText("solidChar", ch);
              }}
            />
          {:else}
            <span class="value">
              {textSize?.width
                ? `${textSize.width}×${textSize.height}`
                : "—"}
            </span>
          {/if}
        </div>
        <label
          class="field"
          title="How readily a cell is inked — right is bolder"
        >
          <span class="label">Weight</span>
          <!-- Stored as the coverage threshold, which runs the other way: heavier = lower. -->
          <input
            type="range"
            min="0.1"
            max="0.95"
            step="0.05"
            value={textWeight}
            oninput={(e) =>
              editText("threshold", round2(1 - +e.currentTarget.value))}
          />
          <span class="value">{textWeight}</span>
        </label>
        <label class="field" title="Extra space between glyphs, in cells">
          <span class="label">Tracking</span>
          <input
            type="range"
            min="-1"
            max="4"
            step="0.25"
            value={activeText.letterSpacing}
            oninput={(e) =>
              editText("letterSpacing", +e.currentTarget.value)}
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
            value={activeText.lineSpacing}
            oninput={(e) => editText("lineSpacing", +e.currentTarget.value)}
          />
          <span class="value">{activeText.lineSpacing}</span>
        </label>
        <hr class="sep" />
        <div class="field" title="Column and row of the first line's cap line">
          <span class="label">Position</span>
          <input
            type="number"
            value={activeText.x}
            title="Column"
            oninput={(e) => {
              const v = e.currentTarget.valueAsNumber;
              if (Number.isFinite(v)) editText("x", Math.round(v));
            }}
          />
          <input
            type="number"
            value={activeText.y}
            title="Row"
            oninput={(e) => {
              const v = e.currentTarget.valueAsNumber;
              if (Number.isFinite(v)) editText("y", Math.round(v));
            }}
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
    {:else if SHAPES.some((s) => s.id === t)}
      <!-- One icon per shape: seven words don't fit the dock, and the panel title already
           names whichever is live. -->
      <div class="field shape-row" role="group" aria-label="Shape">
        {#each SHAPES as s}
          <button
            class="shape-btn"
            class:active={tool === s.id}
            title={s.key ? `${s.label} (${s.key})` : s.label}
            aria-label={s.label}
            aria-pressed={tool === s.id}
            onclick={() => pickTool(s.id)}
          >
            <Icon name={s.icon} size={20} />
          </button>
        {/each}
      </div>
      {#if t === "path" || t === "box"}
        <div class="field">
          <span class="label">Style</span>
          <select bind:value={boxStyle}>
            {#each BOX_STYLES as s}<option value={s}>{s}</option>{/each}
          </select>
        </div>
      {/if}
      {#if t === "triangle"}
        <div class="field">
          <span class="label">Points</span>
          <div class="segmented">
            {#each [["up", "↑"], ["down", "↓"], ["left", "←"], ["right", "→"]] as [d, arrow]}
              <button
                class="arrow"
                class:active={triangleDir === d}
                title={d}
                aria-label={d}
                onclick={() => (triangleDir = d)}>{arrow}</button
              >
            {/each}
          </div>
        </div>
      {/if}
      {#if ["rect", "ellipse", "triangle", "diamond"].includes(t)}
        <label class="check"
          ><input type="checkbox" bind:checked={filled} /> Filled</label
        >
      {/if}
      {#if t !== "path"}
        <p class="note">
          {t === "line"
            ? "Hold Shift to snap to horizontal, vertical or diagonal."
            : t === "triangle"
              ? "Hold Shift for an equilateral triangle."
              : t === "ellipse"
                ? "Hold Shift for a circle."
                : "Hold Shift for a square."}
        </p>
      {/if}
      {#if t === "line"}
        <label class="field" title="Brush size ([ and ])">
          <span class="label">Size</span>
          <input type="range" min="1" max="9" bind:value={brushSize} />
          <span class="value">{brushSize}×{brushSize}</span>
        </label>
      {/if}
      {#if t === "path"}
        <p class="note">
          Click each corner. Enter, Esc, double-click or right-click
          releases the line so you can start the next one.
        </p>
      {/if}
    {:else}
      <label class="field" title="Brush size ([ and ])">
        <span class="label"
          >{t === "brush" && pressureSize ? "Max size" : "Size"}</span
        >
        <input type="range" min="1" max="9" bind:value={brushSize} />
        <span class="value">{brushSize}×{brushSize}</span>
      </label>
      {#if t === "brush"}
        <hr class="sep" />
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
        <p class="note pre">{dynamicsNote}</p>
      {/if}
    {/if}
  </div>
{/snippet}

<div class="app" style="--above-toolbar:{aboveToolbar}px">
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="viewport"
    class:panning
    class:pannable={spaceHeld}
    bind:this={viewportEl}
    onpointerdowncapture={onTouchDownCapture}
    onpointerdown={onViewPointerDown}
    onpointermove={onViewPointerMove}
    onpointerup={onViewPointerUp}
    onpointercancel={onViewPointerUp}
  >
    <div
      class="stage"
      bind:this={stageEl}
      style="transform: translate({view.x}px, {view.y}px) scale({view.z});"
    >
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
          ></span>{/if}{#if hover && showGuides}<span
            class="guide row"
            style="top:{hover[1] * cellH}px; height:{cellH}px;"
          ></span><span
            class="guide col"
            style="left:{hover[0] * cellW}px; width:{cellW}px;"
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
    </div>
    <!-- Outside the stage: a zoomed rect would report a scaled pitch. -->
    <div class="measure-box" aria-hidden="true">
      <span
        bind:this={measureEl}
        class="measure"
        style="font-size:{fontSize}px; letter-spacing:{letterSpacing}px;"
        >00000000000000000000000000000000000000000000000000</span
      >
    </div>
  </div>

  {#if pinned.length}
    <div
      class="dock"
      style="left:{panelPos?.x ?? 0}px; top:{panelPos?.y ?? 26}px"
    >
      <!-- Panels pinned out of the popover stack in the dock and travel with it. -->
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
            <span class="panel-title">{panelTitle(name)}</span>
            <button
              class="pin"
              title="Pin this panel back above the toolbar"
              onclick={() => unpinPanel(name)}>Pin</button
            >
          </div>
          {#if !collapsed[name]}
            {#if name === "layers"}{@render layersPanel()}
            {:else if name === "char"}{@render charPanel()}
            {:else if name === "effects"}{@render effectsPanel()}
            {:else if name === "canvas"}{@render canvasPanel()}
            {:else}{@render toolPanel(dockTool(name))}{/if}
          {/if}
        </div>
      {/each}
    </div>
  {/if}

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
    <div
      class="panel settings"
      class:anchored={popoverLeft !== null}
      style={popoverLeft !== null ? `left:${popoverLeft}px` : ""}
      bind:this={settingsEl}
    >
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div class="settings-head" onpointerdown={startTearOff}>
        <span class="panel-title">{panelTitle(panel)}</span>
        <div class="head-actions">
          <button
            class="pin"
            title="Unpin this panel into the dock on the right — or drag the header"
            onclick={() => pinPanel(panelKey)}>Unpin</button
          >
          <button
            class="pin hide"
            title="Hide this panel"
            aria-label="Hide this panel"
            onclick={() => (panelHidden = true)}>&minus;</button
          >
        </div>
      </div>
      {#if panel === "layers"}{@render layersPanel()}
      {:else if panel === "char"}{@render charPanel()}
      {:else if panel === "effects"}{@render effectsPanel()}
      {:else if panel === "canvas"}{@render canvasPanel()}
      {:else}{@render toolPanel(tool)}{/if}
    </div>
  {/if}

  <div class="toolbar" bind:this={toolbarEl} onscroll={placePopover}>
    <div class="chars">
      <span
        class="swatch back"
        title="Secondary character — drawn with the right button; press X to swap it in"
        aria-hidden="true">{showChar(altChar)}</span
      >
      <button
        class="swatch front"
        data-anchor="char"
        title="Primary character — drawn with the left button"
        onclick={pickChar}>{showChar(char)}</button
      >
      <button
        class="swap"
        title="Swap the primary and secondary characters (X)"
        aria-label="Swap characters"
        onclick={swapChars}
      >
        <Icon name="swap" size={20} />
      </button>
    </div>

    <span class="divider"></span>

    <div class="tool-group">
      {#each SELECT_TOOLS as t}
        <button
          class="tool"
          class:active={tool === t.id}
          class:open={pinned.includes(TOOL_PREFIX + t.id)}
          data-anchor={t.id}
          title={t.hint}
          onclick={() => pickTool(t.id)}
        >
          <Icon name={t.icon} size={34} />
          <span class="tool-label">
            <span use:glitch={{ text: t.label, live: tool === t.id }}>{t.label}</span>
            <em>{t.key}</em>
          </span>
        </button>
      {/each}
    </div>

    <span class="divider"></span>

    <div class="tool-group">
      {#each DRAW_TOOLS as t}
        {@const isShapeButton = t.id === "shape"}
        {@const label = isShapeButton ? shapeButton.label : t.label}
        <button
          class="tool"
          class:active={isShapeButton ? inShapeGroup : tool === t.id}
          class:open={pinned.includes(TOOL_PREFIX + t.id)}
          data-anchor={t.id}
          title={t.hint}
          onclick={() => pickTool(t.id)}
        >
          <Icon name={t.icon} size={34} />
          <span class="tool-label">
            <span use:glitch={{ text: label, live: isShapeButton ? inShapeGroup : tool === t.id }}>
              {label}
            </span>
            <em>{isShapeButton ? shapeButton.key : t.key}</em>
          </span>
        </button>
      {/each}
    </div>

    <span class="divider"></span>

    <div class="tool-group">
      <button
        class="tool"
        class:active={panelPopped("layers")}
        class:open={pinned.includes("layers")}
        data-anchor="layers"
        title="Show or hide the layer stack"
        onclick={() => togglePanel("layers")}
      >
        <Icon name="layers" size={34} />
        <span class="tool-label">
          <span use:glitch={{ text: "Layers", live: panelPopped("layers") }}>Layers</span>
        </span>
      </button>
      <button
        class="tool"
        class:active={panelPopped("effects")}
        class:open={pinned.includes("effects")}
        data-anchor="effects"
        title="Skew, rotate, flip and keystone the active layer"
        onclick={() => togglePanel("effects")}
      >
        <Icon name="fx" size={34} />
        <span class="tool-label">
          <span use:glitch={{ text: "Effects", live: panelPopped("effects") }}>Effects</span>
        </span>
      </button>
      <button
        class="tool"
        class:active={panelPopped("canvas")}
        class:open={pinned.includes("canvas")}
        data-anchor="canvas"
        title="Canvas size, type size and cell spacing"
        onclick={() => togglePanel("canvas")}
      >
        <Icon name="canvas" size={34} />
        <span class="tool-label">
          <span use:glitch={{ text: "Canvas", live: panelPopped("canvas") }}>Canvas</span>
        </span>
      </button>
    </div>
  </div>

  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="brand"
    onpointerenter={() => (brandHover = true)}
    onpointerleave={() => (brandHover = false)}
  >
    <div class="logo" role="img" aria-label="ASKI">
      {#each LOGO as line}<span>{line}</span>{/each}
    </div>
    <nav class="brand-links" class:shown={brandHover || about} aria-label="About ASKI">
      <button
        class="brand-link"
        class:active={about}
        aria-expanded={about}
        onclick={(e) => {
          e.stopPropagation();
          about = !about;
        }}
      >
        <span use:glitch={{ text: "About", live: brandHover || about }}>About</span>
      </button>
      <a class="brand-link" href={REPO_URL} target="_blank" rel="noopener">
        <span use:glitch={{ text: "GitHub", live: brandHover }}>GitHub</span>
      </a>
      <button
        class="brand-link"
        title="Switch between the dark and light theme"
        onclick={(e) => {
          e.stopPropagation();
          toggleTheme();
        }}
      >
        <span use:glitch={{ text: theme === "dark" ? "Light" : "Dark", live: brandHover }}
          >{theme === "dark" ? "Light" : "Dark"}</span
        >
      </button>
    </nav>
    {#if about}
      <!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
      <div class="panel about" onclick={(e) => e.stopPropagation()}>
        <p>
          <strong>ASKI</strong> is an ASCII art editor. Draw with characters using a pencil,
          brush, shapes and text, on layers you can skew, rotate and flip. Export as text or
          an image.
        </p>
        <p>It runs in your browser and keeps your work on this device.</p>
        <p class="credit">
          Creator: <a href="http://pavellaptev.me/" target="_blank" rel="noopener">Pavel Laptev</a>
        </p>
      </div>
    {/if}
  </div>

  <div class="status">
    <span>{cols} × {rows}</span>
    <span>{hover ? `${hover[0]}, ${hover[1]}` : "–"}</span>
    <button
      class="view-reset"
      title="Fit the canvas on screen (⌘0). Scroll to pan, pinch or ⌘-scroll to zoom, space or middle-drag to pan; on touch, two fingers pan and pinch."
      onclick={resetView}>{Math.round(view.z * 100)}%</button
    >
  </div>
</div>

<style>
  .app {
    position: relative;
    height: 100vh;
    height: 100dvh; /* the visible height on tablets, under the browser's own bars */
    overflow: hidden;
    background: var(--bg);
    color: var(--ink);
    font-family: var(--ui-font);
    /* No double-tap zoom on the chrome, and no long-press callouts on iOS. */
    touch-action: manipulation;
    -webkit-touch-callout: none;
    /* Everything above the toolbar keys off where its top edge lands — --above-toolbar is
       measured and set inline — so a shorter bar, or one with a scrollbar, moves it all. */
    --toolbar-bottom: 19px;
  }

  /* ── Canvas ──────────────────────────────────────────────────────────────── */

  .viewport {
    height: 100%;
    /* Navigation is the view transform, not scrollbars, so nothing scrolls here. */
    overflow: hidden;
    touch-action: none;
    display: flex;
    /* Fixed, so the canvas never shifts as panels open and close — it clears the toolbar and
       lets the settings popover float over it. Pin a panel to get the space back. */
    padding: 96px 24px 136px;
  }
  .viewport.pannable {
    cursor: grab;
  }
  .viewport.panning {
    cursor: grabbing;
  }
  .stage {
    margin: auto;
    /* Pan and zoom ride on top of the centred layout, so the untransformed position stays
       put and zoom-to-cursor can measure against it. */
    transform-origin: 0 0;
    will-change: transform;
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
    /* Keeps the gridlines' negative z-index inside the canvas, under the characters. */
    isolation: isolate;
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
    background: color-mix(in srgb, var(--accent) 45%, transparent);
    pointer-events: none;
  }

  /* Cell guides, drawn from the measured cell size so they line up with glyphs. */
  .gridlines {
    position: absolute;
    inset: 0;
    z-index: -1; /* behind the art, so block characters read as solid shapes */
    pointer-events: none;
    background-image: linear-gradient(
        to right,
        color-mix(in srgb, var(--ink) 8%, transparent) 1px,
        transparent 1px
      ),
      linear-gradient(to bottom, color-mix(in srgb, var(--ink) 8%, transparent) 1px, transparent 1px);
  }

  /* Fill on every selected cell, but border only on the sides facing outwards —
     interior edges get 0px widths inline, leaving a single clean outline. */
  .sel-cell {
    position: absolute;
    pointer-events: none;
    background: color-mix(in srgb, var(--accent) 18%, transparent);
    border-style: solid;
    border-color: var(--accent);
  }

  .marquee {
    position: absolute;
    pointer-events: none;
    background: color-mix(in srgb, var(--accent) 10%, transparent);
    border: 1px dashed var(--accent);
  }

  /* Cursor guides: a band across the full row and column under the pointer, so a cell
     can be lined up against distant ones. */
  .guide {
    position: absolute;
    pointer-events: none;
    background: color-mix(in srgb, var(--ink) 8%, transparent);
  }
  .guide.row {
    left: 0;
    right: 0;
  }
  .guide.col {
    top: 0;
    bottom: 0;
  }

  .hover-cell {
    position: absolute;
    pointer-events: none;
    background: color-mix(in srgb, var(--ink) 10%, transparent);
    outline: 1px solid color-mix(in srgb, var(--ink) 45%, transparent);
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

  /* Clicking shouldn't leave the browser's focus ring behind; keyboard focus still shows.
     Nor should a tap flash the mobile browser's grey highlight. */
  button:focus:not(:focus-visible) {
    outline: none;
  }
  button {
    -webkit-tap-highlight-color: transparent;
  }

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
    background: color-mix(in srgb, var(--ink) 20%, transparent);
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
    width: 308px;
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

  .layers-body {
    display: flex;
    flex-direction: column;
    /* Matches the dock width, so the panel is the same size wherever it lives. */
    min-width: 308px;
  }
  .panel-head {
    display: flex;
    align-items: center;
    gap: 10px;
    /* Same gutters as a popover's head, so a panel looks the same pinned or not. */
    padding: 10px 10px 10px 16px;
    border-bottom: 1px solid var(--divider);
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
    background: color-mix(in srgb, var(--ink) 5%, transparent);
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
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 35%, transparent);
  }
  /* Text layers regenerate from parameters rather than cells; the hollow chip says so. */
  .layer-chip.text {
    background: none;
    box-shadow: inset 0 0 0 2px var(--chip);
  }
  .layer-chip.text:hover {
    box-shadow:
      inset 0 0 0 2px var(--chip),
      0 0 0 2px color-mix(in srgb, var(--ink) 35%, transparent);
  }

  .color-menu {
    z-index: 5;
    padding: 8px;
    box-shadow: var(--shadow);
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
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 35%, transparent);
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
    box-shadow: var(--shadow);
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
    bottom: calc(var(--above-toolbar) + 11px);
    display: flex;
    flex-direction: column;
  }
  /* Once measured, the popover sits over the button that opened it; see placePopover. */
  .settings.anchored {
    transform: none;
  }
  .settings-head {
    display: flex;
    align-items: center;
    gap: 10px;
    cursor: grab;
    touch-action: none;
    /* The buttons sit flush in the corner: right gutter matches the 10px above them. */
    padding: 10px 10px 10px 16px;
    border-bottom: 1px solid var(--divider);
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
  .settings-head + .settings-body,
  .panel-head + .settings-body {
    padding-top: 12px;
  }

  .head-actions {
    display: flex;
    gap: 6px;
  }

  .pin {
    padding: 4px 8px;
    font: inherit;
    font-size: 11px;
    letter-spacing: -0.05em;
    text-transform: uppercase;
    color: var(--ink);
    background: color-mix(in srgb, var(--ink) 8%, transparent);
    border: none;
    opacity: 0.7;
    cursor: pointer;
  }
  .pin:hover {
    opacity: 1;
  }
  /* The minus is a square button so it reads as an icon next to the wider Pin label. */
  .hide {
    width: 26px;
    padding: 4px 0;
    font-size: 14px;
    line-height: 1;
  }

  /* Docked, a panel keeps the popover's paddings and gaps — the dock is sized so its rows
     still fit — but it takes the dock's width rather than its own, and the dock itself
     scrolls rather than each panel. */
  .dock .settings-body {
    min-width: 0;
    max-width: none;
    max-height: none;
    overflow: visible;
  }
  /* Rows of checks and reset links can't shrink, so when they don't fit they break onto a
     second line rather than pushing the dock into a sideways scroll. Slider and icon rows
     stay on one line and shrink instead. */
  .dock .field:has(.check, .ghost) {
    flex-wrap: wrap;
    row-gap: 4px;
  }
  .dock .layers-body {
    min-width: 0;
  }
  /* Not a look, a floor: a docked slider may shrink further than a popover one so the
     widest label row still fits beside a classic scrollbar. */
  .dock .settings-body input[type="range"] {
    min-width: 90px;
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
  /* One label column per panel, so the sliders (and their zero marks) line up regardless
     of whether the label is "Skew X" or the wider "Persp X". In the canvas panel only the
     slider rows share it; the Cols/Rows pair keeps its own tighter spacing. */
  .effects .label {
    min-width: 7ch;
  }
  .canvas label.field .label {
    min-width: 9ch;
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
  /* Hairline between groups of settings, so a long panel reads as blocks, not one stack. */
  .sep {
    width: 100%;
    margin: 6px 0;
    border: 0;
    border-top: 1px solid color-mix(in srgb, var(--ink) 12%, transparent);
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
  }
  .note.pre {
    white-space: pre-line;
  }
  .note.warn {
    color: var(--warn);
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
  .settings-body input.glyph,
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
  .settings-body input.glyph {
    width: 44px;
    font-family: var(--art-font);
    text-align: center;
  }
  .settings-body select {
    flex: 1;
    min-width: 0;
    -webkit-appearance: none;
    appearance: none;
    padding-right: 26px;
    /* The layers panel's chevron, turned to point down. A data URI can't read --ink, so the
       token in app.css carries one image per theme. */
    background-image: var(--select-chevron);
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
    background: color-mix(in srgb, var(--ink) 8%, transparent);
    border: none;
    opacity: 0.7;
    cursor: pointer;
  }
  .segmented button:hover {
    opacity: 1;
  }
  .segmented button.active {
    background: var(--accent);
    color: var(--on-accent);
    opacity: 1;
  }
  /* Arrow-only segments: a fixed square rather than text padding. */
  .segmented button.arrow {
    width: 30px;
    padding: 6px 0;
    font-size: 13px;
  }
  .shape-row {
    gap: 2px;
    /* A little air under the picker before the shape's own settings start. */
    margin-bottom: 8px;
  }
  .shape-btn {
    width: 32px;
    height: 30px;
    display: grid;
    place-items: center;
    padding: 0;
    color: var(--ink);
    background: color-mix(in srgb, var(--ink) 8%, transparent);
    border: none;
    opacity: 0.7;
    cursor: pointer;
  }
  .shape-btn:hover {
    opacity: 1;
  }
  .shape-btn.active {
    background: var(--accent);
    color: var(--on-accent);
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
    background: color-mix(in srgb, var(--ink) 8%, transparent);
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
    background: color-mix(in srgb, var(--ink) 16%, transparent);
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
    border-top: 1px solid color-mix(in srgb, var(--ink) 12%, transparent);
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
    background: color-mix(in srgb, var(--ink) 8%, transparent);
    border: none;
    cursor: pointer;
  }
  .swatch-btn:hover {
    background: color-mix(in srgb, var(--ink) 20%, transparent);
  }
  .swatch-btn.active {
    background: var(--accent);
    color: var(--on-accent);
  }

  /* ── Toolbar ─────────────────────────────────────────────────────────────── */

  .toolbar {
    position: absolute;
    left: 50%;
    transform: translateX(-50%);
    bottom: var(--toolbar-bottom);
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 6px;
    max-width: calc(100vw - 32px);
    background: var(--panel);
    user-select: none;
    -webkit-user-select: none;
    /* Where it can't fit, the bar scrolls sideways with no scrollbar and snaps a button to
       its left edge, so a swipe always lands on whole tools. */
    overflow-x: auto;
    scrollbar-width: none;
    scroll-snap-type: x mandatory;
    scroll-padding-inline: 6px;
    overscroll-behavior-x: contain;
  }
  .toolbar::-webkit-scrollbar {
    display: none;
  }
  .toolbar .chars,
  .toolbar .tool {
    scroll-snap-align: start;
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
  }
  /* Primary sits top-left, in front; the secondary is a read-only peek at what X swaps in. */
  .swatch.back {
    left: 36px;
    top: 27px;
    font-size: 16px;
    opacity: 0.3;
    pointer-events: none;
  }
  .swatch.front {
    left: 0;
    top: 0;
    z-index: 1;
    border-color: var(--accent);
    cursor: pointer;
  }
  /* The X-key swap, sitting in the corner the two swatches leave free. */
  .swap {
    position: absolute;
    left: 65px;
    top: 3px;
    padding: 0;
    background: none;
    border: none;
    color: var(--ink);
    opacity: 0.7;
    cursor: pointer;
  }
  .swap:hover {
    opacity: 1;
  }

  .tool-group {
    display: flex;
    align-items: center;
    gap: 4px;
    flex: none;
  }
  .tool {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    width: 72px;
    height: 70px;
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
    color: var(--on-accent);
    opacity: 1;
  }
  /* A panel button whose panel is pinned in the dock: a thin accent frame and a dot in the
     corner, per the Figma variant. It stays at resting opacity so it doesn't read as a
     second armed tool: only one tool can be live, but several panels can be. */
  .tool.open {
    box-shadow: inset 0 0 0 1px var(--accent);
  }
  .tool.open::after {
    content: "";
    position: absolute;
    top: 6px;
    right: 6px;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--accent);
  }
  /* Per the Figma states: an idle button is just a centred icon; the armed one (and, here,
     the hovered or focused one) grows a label 4px under the icon. The label collapses rather
     than hides so the icon slides between the two centrings instead of jumping. */
  .tool-label {
    display: flex;
    align-items: center;
    justify-content: center;
    /* Wider than the design's 2px: the negative tracking pulls the shortcut into the label. */
    gap: 4px;
    height: 0;
    margin-top: 0;
    width: 100%;
    overflow: hidden;
    font-size: 11px;
    line-height: 15px;
    letter-spacing: -0.05em;
    text-transform: uppercase;
    white-space: nowrap;
    opacity: 0;
    transition:
      height 0.12s,
      margin-top 0.12s,
      opacity 0.12s;
  }
  .tool:hover .tool-label,
  .tool:focus-visible .tool-label,
  .tool.active .tool-label {
    height: 15px;
    margin-top: 4px;
    opacity: 1;
  }
  /* No hover on touch: keep every label visible there, and drop the shortcut keys — there is
     no keyboard to press them on, and the labels have less room. */
  @media (hover: none) {
    .tool-label {
      height: 15px;
      margin-top: 4px;
      opacity: 1;
    }
    .tool-label em {
      display: none;
    }
  }
  .tool-label em {
    font-style: normal;
    opacity: 0.3;
  }

  /* ── Status & toast ──────────────────────────────────────────────────────── */

  /* ── Brand ─────────────────────────────────────────────────────────────────── */

  .brand {
    position: absolute;
    left: 32px;
    top: 28px;
    z-index: 5;
    display: flex;
    flex-direction: column;
    gap: 11px;
    /* A little hit area below the links, so the pointer can drift off the last row without
       the links vanishing under it. */
    padding-bottom: 8px;
  }
  .logo {
    display: flex;
    flex-direction: column;
    font-family: var(--art-font);
    font-size: 9px;
    line-height: 1.2;
    white-space: pre;
    color: var(--accent);
    user-select: none;
  }
  .brand-links {
    display: flex;
    gap: 10px;
    font-size: 11px;
    font-weight: 500;
    letter-spacing: -0.05em;
    text-transform: uppercase;
    opacity: 0;
    transform: translateY(-4px);
    transition:
      opacity 120ms,
      transform 120ms;
    pointer-events: none;
  }
  .brand-links.shown,
  .brand:focus-within .brand-links {
    opacity: 1;
    transform: none;
    pointer-events: auto;
  }
  .brand-link {
    padding: 0;
    background: none;
    border: none;
    font: inherit;
    letter-spacing: inherit;
    text-transform: inherit;
    color: var(--accent);
    text-decoration: none;
    cursor: pointer;
  }
  .brand-link:hover,
  .brand-link.active {
    text-decoration: underline;
  }
  .about {
    top: 100%;
    left: 0;
    width: 260px;
    padding: 12px 14px;
    line-height: 1.4;
    box-shadow: var(--shadow);
  }
  .about p {
    margin: 0 0 8px;
  }
  .about p:last-child {
    margin-bottom: 0;
  }
  .about .credit {
    color: var(--ink-dim);
  }
  .about a {
    color: var(--accent);
  }
  /* Nothing to hover on touch: the links stay out. */
  @media (hover: none) {
    .brand-links {
      opacity: 1;
      transform: none;
      pointer-events: auto;
    }
  }


  .status {
    position: absolute;
    left: 23px;
    bottom: var(--toolbar-bottom);
    display: flex;
    gap: 16px;
    font-size: 11px;
    text-transform: uppercase;
    color: var(--ink-faint);
    font-variant-numeric: tabular-nums;
    pointer-events: none;
  }
  .view-reset {
    pointer-events: auto;
    padding: 0;
    font: inherit;
    text-transform: inherit;
    color: inherit;
    background: none;
    border: none;
    cursor: pointer;
  }
  .view-reset:hover {
    color: var(--ink);
  }

  .toast {
    position: absolute;
    left: 50%;
    transform: translateX(-50%);
    bottom: calc(var(--above-toolbar) + 11px);
    z-index: 6;
    padding: 10px 16px;
    font-size: 12px;
    text-transform: uppercase;
    color: var(--on-accent);
    background: var(--accent);
    pointer-events: none;
  }

  /* ── Tablet ────────────────────────────────────────────────────────────────── */

  /* Under about 1100px — an iPad in either orientation — the toolbar keeps its designed size
     and scrolls sideways instead. The bar now spans the full width and the popover above it
     can land anywhere along it, so the status line moves underneath the bar, which lifts by
     one line to make room above the safe area. */
  @media (max-width: 1100px) {
    .app {
      --toolbar-bottom: calc(30px + env(safe-area-inset-bottom, 0px));
    }
    .viewport {
      padding: 96px 16px calc(var(--above-toolbar) + 24px);
    }
    .toolbar {
      max-width: calc(100vw - 16px);
    }
    .status {
      left: 16px;
      bottom: calc(8px + env(safe-area-inset-bottom, 0px));
    }
  }
</style>
