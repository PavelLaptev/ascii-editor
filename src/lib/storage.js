// The session in localStorage: the layer stack, canvas size and display preferences, so a
// reload picks up where the last one left off. Nothing here touches Svelte state — it takes
// and returns plain data, and everything read back is checked, since a stale or hand-edited
// entry must never be able to break the editor on startup.

import { EMPTY, makeGrid } from './ascii.js'
import { TEXT_DEFAULTS } from './textRender.js'

const KEY = 'ascii-editor:session'
const VERSION = 1

// Canvas ceilings, matching the Canvas panel's inputs.
const MAX_COLS = 400
const MAX_ROWS = 200

const clampInt = (value, min, max, fallback) =>
  Number.isFinite(value) ? Math.max(min, Math.min(max, Math.round(value))) : fallback

/** A grid as one string per row: a 400×200 layer is 200 strings rather than 80,000 cells. */
const packGrid = (grid) => grid.map((row) => row.join(''))

/** The inverse of `packGrid`, padded back out to a rectangle as every grid helper assumes. */
function unpackGrid(rows) {
  if (!Array.isArray(rows)) return null
  const cells = rows.map((row) => (typeof row === 'string' ? [...row] : []))
  const width = Math.max(0, ...cells.map((r) => r.length))
  return cells.map((row) =>
    row.length === width ? row : [...row, ...new Array(width - row.length).fill(EMPTY)],
  )
}

const TEXT_STRINGS = ['content', 'family', 'mode', 'solidChar', 'align']
const TEXT_NUMBERS = [
  'size', 'threshold', 'letterSpacing', 'lineSpacing', 'x', 'y',
  'skewX', 'skewY', 'rotate', 'perspX', 'perspY',
]
const TEXT_BOOLEANS = ['bold', 'flipH', 'flipV']

/** Text-layer parameters with every field typed as the renderer expects; unknown keys are dropped. */
function sanitizeText(raw) {
  if (!raw || typeof raw !== 'object') return null
  const text = { ...TEXT_DEFAULTS }
  for (const key of TEXT_STRINGS) if (typeof raw[key] === 'string') text[key] = raw[key]
  for (const key of TEXT_NUMBERS) if (Number.isFinite(raw[key])) text[key] = raw[key]
  for (const key of TEXT_BOOLEANS) if (typeof raw[key] === 'boolean') text[key] = raw[key]
  return text
}

function serializeLayer(layer) {
  const out = {
    id: layer.id,
    name: layer.name,
    visible: layer.visible,
    color: layer.color,
    ox: layer.ox ?? 0,
    oy: layer.oy ?? 0,
  }
  // A text layer is rebuilt from its parameters on load, so its cells aren't worth storing.
  if (layer.text) out.text = layer.text
  else out.rows = packGrid(layer.grid)
  return out
}

function deserializeLayer(raw, index, cols, rows) {
  if (!raw || typeof raw !== 'object') return null
  const layer = {
    id: Number.isInteger(raw.id) && raw.id > 0 ? raw.id : 0, // 0: assigned below
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name : `Layer ${index + 1}`,
    visible: raw.visible !== false,
    color: typeof raw.color === 'string' ? raw.color : '#ffffff',
    ox: clampInt(raw.ox, -10000, 10000, 0),
    oy: clampInt(raw.oy, -10000, 10000, 0),
  }
  const text = sanitizeText(raw.text)
  if (text) {
    layer.text = text
    layer.grid = []
  } else {
    layer.grid = unpackGrid(raw.rows) ?? makeGrid(cols, rows)
  }
  return layer
}

// Preferences that are plain numbers, with the same ranges as their controls.
const PREF_RANGES = {
  fontSize: [8, 56],
  letterSpacing: [-2, 16],
  lineHeight: [0.6, 3],
  brushSize: [1, 9],
}

function sanitizePrefs(raw) {
  const prefs = {}
  if (!raw || typeof raw !== 'object') return prefs
  for (const [key, [min, max]] of Object.entries(PREF_RANGES)) {
    if (Number.isFinite(raw[key])) prefs[key] = Math.max(min, Math.min(max, raw[key]))
  }
  for (const key of ['showGrid', 'showGuides']) {
    if (typeof raw[key] === 'boolean') prefs[key] = raw[key]
  }
  for (const key of ['char', 'altChar']) {
    if (typeof raw[key] === 'string' && [...raw[key]].length === 1) prefs[key] = raw[key]
  }
  // Validated against the real option lists by the editor, which owns them.
  if (typeof raw.boxStyle === 'string') prefs.boxStyle = raw.boxStyle
  if (Array.isArray(raw.pinned)) prefs.pinned = raw.pinned.filter((n) => typeof n === 'string')
  return prefs
}

/**
 * The last saved session, or null when there isn't one that can be trusted. Layers that don't
 * parse are dropped rather than failing the whole load; ids are made unique so the stack's
 * keyed rendering and undo history can rely on them.
 */
export function loadSession() {
  let raw
  try {
    const json = localStorage.getItem(KEY)
    if (!json) return null
    raw = JSON.parse(json)
  } catch {
    return null
  }
  if (!raw || raw.version !== VERSION || !raw.doc || typeof raw.doc !== 'object') return null

  const cols = clampInt(raw.doc.cols, 1, MAX_COLS, 80)
  const rows = clampInt(raw.doc.rows, 1, MAX_ROWS, 24)
  const layers = (Array.isArray(raw.doc.layers) ? raw.doc.layers : [])
    .map((layer, i) => deserializeLayer(layer, i, cols, rows))
    .filter(Boolean)
  if (!layers.length) return null

  const seen = new Set()
  let nextId = Math.max(0, ...layers.map((l) => l.id)) + 1
  for (const layer of layers) {
    if (!layer.id || seen.has(layer.id)) layer.id = nextId++
    seen.add(layer.id)
  }

  return {
    cols,
    rows,
    layers,
    activeIndex: clampInt(raw.doc.activeIndex, 0, layers.length - 1, layers.length - 1),
    prefs: sanitizePrefs(raw.prefs),
  }
}

/** Write the session; false when storage is full or unavailable, so the caller can say so. */
export function saveSession({ cols, rows, activeIndex, layers, prefs }) {
  try {
    const doc = { cols, rows, activeIndex, layers: layers.map(serializeLayer) }
    localStorage.setItem(KEY, JSON.stringify({ version: VERSION, doc, prefs }))
    return true
  } catch {
    return false
  }
}
