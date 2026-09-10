# Askew

**An ASCII graphics tool.**

Askew is a layered ASCII art editor built with Svelte 5 and Vite. Draw with characters instead of
pixels: freehand and shape tools, a pressure-sensitive brush for pen tablets, layers with
transparency, selections you can move, and plain-text export.

```
    ..:::::-----=====++++*****#####%%%%@@@@@@@@
```

## Running it

```bash
npm install
npm run dev      # dev server with hot reload
npm run build    # production build into dist/
npm run preview  # serve the production build
```

No dependencies beyond Svelte and Vite. Everything runs in the browser; nothing is uploaded.

## Layout

The canvas sits alone in the middle; everything else floats above it.

- **Bottom toolbar** — the character swatches on the left, then the tools in three groups:
  selection, drawing, and the two panel toggles (**Effects**, **Canvas**).
- **Settings panel**, just above the toolbar — the controls for whatever is armed. It follows
  the active tool, and **Effects** / **Canvas** / a character swatch take it over while open.
- **Layers panel**, top right — drag any header in that column to move the whole column, and
  click a chevron to collapse a panel.

The settings panel opens above whichever toolbar button called for it. **Characters**,
**Effects** and **Canvas** carry an **Unpin** button that floats them into the dock under
Layers, so they stay open while you draw instead of being swapped out by the next tool; dragging
the panel's header does the same and drops it wherever you let go. **Pin** sends one back above
the toolbar. Their toolbar button (or, for characters, the armed swatch) closes
them wherever they happen to be. Tool settings can't be pinned — they belong to whatever tool
is armed, so they have nowhere fixed to live.

Undo, redo and the clipboard have no buttons — they're keyboard-only. **Export** and **Clear**
live at the foot of the **Canvas** panel.

## Tools

Each tool's shortcut is in parentheses. Shortcuts work whenever the app has focus, except
while you're typing in a text field (the layer rename box, the canvas size inputs, or the
character input).

**Path**, **Line**, **Rect**, **Box**, **Ellipse**, **Triangle** and **Diamond** share one
toolbar button: it shows whichever of them is live, and the settings panel switches between
them. Their shortcuts still reach each one directly. Hold **Shift** while dragging a shape to
constrain it: a square, a circle, an equilateral triangle, or a line snapped to horizontal,
vertical or the diagonal. "Square" and "circle" mean on screen, so the constraint accounts for
cells being taller than they are wide.

| Tool | Key | What it does |
| --- | --- | --- |
| **Pencil** | `P` | Freehand drawing with the current character. |
| **Brush** | `B` | Freehand, but size and character vary with pen pressure or speed. See [Brush dynamics](#brush-dynamics). |
| **Eraser** | `E` | Freehand erase to blank. On a layer, blank is transparent — lower layers show through. |
| **Line** | `L` | Drag a straight line at any angle. Takes a thickness. |
| **Path** | `D` | Click corner to corner to draw a connected line; glyphs are chosen from each segment's direction. See [Paths](#paths). |
| **Rect** | `R` | Drag a rectangle of the current character, outline or filled. |
| **Box** | `O` | Drag a box-drawing frame with proper corners: `ascii`, `single`, `double`, or `round`. |
| **Ellipse** | `C` | Drag an ellipse of the current character, outline or filled. |
| **Triangle** | | Drag an isosceles triangle pointing up, down, left or right, outline or filled. |
| **Diamond** | | Drag a diamond of the current character, outline or filled. |
| **Fill** | `F` | Flood fill a contiguous region of matching cells (4-way). |
| **Text** | `T` | Click to place a caret, then type single characters into cells. For big lettering from a real font, use a [text layer](#text-layers) instead. |
| **Select** | `S` | Select a region and move it. See [Selections](#selections). |
| **Move** | `V` | Drag anywhere to move the whole active layer. Arrow keys nudge it a cell at a time. Nothing is clamped to the canvas — push a layer as far off the edge as you like and the cells that leave the view are kept, not dropped. |

### Drawing basics

- **Left-drag** draws with the primary character, **right-drag** with the secondary one.
- **Hold Shift** with Pencil, Brush, or Eraser to constrain the stroke to a straight line from
  where you pressed to where you release, previewed live as you drag.
- **Size** (`[` and `]`, or the slider) sets the brush footprint from 1×1 to 9×9 for Pencil,
  Brush, Eraser, and Line. Even sizes can't centre exactly on a cell, so they extend right and
  down.
- Strokes are interpolated between pointer samples, so fast drags don't leave gaps.
- Dragging past the canvas edge keeps tracking along it, and releasing anywhere — outside the
  canvas or outside the browser — ends the drag cleanly.
- Every stroke is one undo step, no matter how long.

## Paths

The Path tool draws lines that stay connected around corners. Click each corner in turn; the
segment to your cursor rubber-bands until the next click pins it down. **Enter**, **Esc**,
**double-click** or **right-click** releases the line and leaves you on the tool, ready to
start the next one — nothing is discarded, and switching tools commits what you've clicked so
far too. Each line is its own undo step.

Each glyph comes from the direction of the segment running through it, so runs join up instead
of staying stuck as horizontal dashes:

```
                 ────────                     ───────────────┐
                /        \                                    │
               /          \                                   │
              /            \                                  │
  ───────────                \                                └───────────────
                              ─────────────────
```

- Horizontal runs get `─`, vertical runs `│`, and 45° slopes `/` or `\`.
- Shallower slopes come out as runs of `─` stepping down with `/`, the way ASCII slopes are
  drawn by hand — `/───` repeating rather than a jagged staircase.
- A segment near 45° is drawn entirely with one diagonal. Such a line technically takes the odd
  axis-aligned step, but a lone `─` sitting in a slope reads as a mistake rather than as the
  slightly shallower gradient it really is.
- Where two straight runs meet at a right angle you get a proper corner: `┌ ┐ └ ┘`.
- The **Style** picker (shared with the Box tool) switches between `single`, `double`, `round`
  and `ascii` glyph sets, so the same line can be drawn with `═ ║ ╔`, `╭ ╮ ╰`, or plain
  `- | +`.

Clicking the corners rather than dragging is what makes this reliable: a dragged stroke only
tells you where the pointer wobbled, while a clicked segment has one exact direction.

## Characters

The **Character** panel holds two slots — primary and secondary — like Photoshop's foreground
and background colours.

- **`X`** swaps them.
- **Click a swatch** to make that slot active and open the palette on it; the palette and the
  text input then write into that slot. The active slot is outlined in cyan.

These are characters, not colours — colour is a property of the layer, not the brush. See
[Layers](#layers).

Clicking a swatch opens the palette, grouped by intent, with each group collapsible:

| Group | Contents |
| --- | --- |
| **Blocks & shades** | `░ ▒ ▓ █`, halves, quadrants, and eighths — sub-cell resolution for diagonals and bars. |
| **ASCII ramp** | `. : - = + * % # @` — terminal-safe density, light to dark. |
| **Punctuation**, **Math & signs**, **Brackets**, **Letters & digits** | Everyday glyphs. |
| **Shapes**, **Arrows** | `■ ● ◆ ★ ▲`, `← → ↑ ↓`. |
| **Box — single / double / rounded** | Full sets including tees and crosses. |

A few characters appear in more than one group on purpose; grouping follows intent, not
codepoints.

## Layers

The canvas is a stack of layers, listed top-first in the layers panel. Blank cells are
transparent, so lower layers show through them.

A layer isn't confined to the canvas. It keeps its own cells and its own origin, and the
canvas is just the window you see them through — so moving a layer half off the edge, or
shrinking the canvas under it, crops what's displayed without destroying anything. Draw on a
layer that's been moved and it grows to cover the canvas again, keeping the part still
outside.

- The **eye** toggles a layer's visibility.
- **Click** a row to make that layer active — all drawing goes to the active layer.
- **Double-click** a name to rename it.
- **Drag the `⠿` handle** to reorder the stack.
- **Right-click** a row for rename, duplicate, move up/down, merge down, rasterize, and delete.
- The footer buttons are **new layer**, **duplicate**, and **delete**. A **new text layer**
  comes from the Font tool's settings panel.
- The chip beside each name is the layer's **colour** — click it for a palette, or **Custom**
  for anything else. Everything the layer draws renders in that colour; new layers start white.
  The chip is solid for a painted layer and hollow for a [text layer](#text-layers).

Colour is a view property: export is plain text, so it carries characters only. Merging down
hands the upper layer's cells to the lower layer, and they take on its colour.

Undo captures the whole stack, so adds, deletes, reorders, merges and colour changes are all
undoable.
Resizing the canvas resizes every layer together. **Clear** wipes only the active layer.

## Text layers

**T+** in the layer buttons adds a text layer: real type from Google Fonts, rasterized into
character cells and re-rendered live as you change it.

```
███ ███  ██████ ███    ███    ████████
███████  █████▄ ███    ███    ███  ███
███ ███  ███▄▄▄ ███▄▄▄ ███▄▄▄ ████▄███
███ ███  ██████ ██████ ███████ ▀████▀
```

Controls appear in a **Text layer** panel when one is active:

| Control | What it does |
| --- | --- |
| **Content** | The text. Newlines make multiple lines. |
| **Font** | 22 Google Fonts, tagged by category — pixel, terminal, mono, display, sans, serif, script. |
| **Bold** | Uses the bold face where the browser can synthesize one. |
| **Size** | Cap height in character cells, 1–20. |
| **Style** | **Half blocks** (`▀ ▄ █`, sharpest — samples each cell's top and bottom separately), **Shading** (`░ ▒ ▓ █` by coverage), or **Solid** (one character, the current primary). |
| **Weight** | How much ink a cell needs before it's drawn. Raise it to open up tight counters, lower it to thicken. |
| **Tracking / Leading** | Space between glyphs and between lines. |
| **Position** | Column and row of the top-left corner, also settable by dragging. |

Skew, rotation, perspective and flips live in the [Transform](#transform) panel and apply to
text layers as parameters, so they survive edits to the words, font, or size.

**Moving it.** The Move tool (`V`) and the arrow keys reposition a text layer by its anchor, not
by shifting the rendered cells — so it stays editable and won't jump back on the next re-render.

**It stays live.** The layer regenerates from its parameters, so the drawing tools are blocked
on it; a toast says so if you try. **Rasterize to draw on it** converts the layer to ordinary
cells, after which it's a normal layer and the text controls are gone.

**Going off-canvas is safe.** Text can sit at negative positions or run past the right edge —
only the *view* is cropped, and the text is kept in full, so moving it back restores it exactly.
The panel says when this is happening and offers **Fit canvas to text**, which grows the canvas
and shifts every layer so nothing is cut off.

**Legibility tips.** Very small sizes close up a font's counters and the letters merge into a
blob — heavy faces like Anton need about 7 cells or more, while pixel fonts (Press Start 2P,
Silkscreen) stay readable down to about 4. Raising **Weight** recovers detail at small sizes,
and lighter faces (Montserrat, Source Code Pro) keep their counters open.

**Offline.** Fonts are fetched from Google Fonts on demand and cached by the browser. Without a
network the panel says so and the canvas renders with a system fallback.

## Transform

The **Transform** panel skews, rotates, adds perspective to, and mirrors the active layer.

```
   ┌──────────┐         ┌────┐            ┌┌────────────┐┐
   │          │        │      │           ││            ││
   │          │       │        │          ││            ││
   │          │      │          │         ││            ││
   └──────────┘    └└────────────┘┘       └└────────────┘┘
      original        perspective            rotate 90°
```

- **Skew X** slides each row sideways in proportion to its distance from the layer's centre;
  **Skew Y** does the same for columns, vertically. Measured in cells per row (or column),
  −1.5 to 1.5.
- **Rotate** turns the layer, −180° to 180°. Quarter turns are exact — done by index rather
  than trigonometry, with box-drawing glyphs turned to match, so `─` becomes `│` and a frame
  keeps its corners. Other angles are resampled and come out approximate, as they must on a
  character grid.
- **Persp X / Persp Y** apply a keystone taper, −0.9 to 0.9: positive **Persp X** narrows the
  top and widens the bottom, as though the art were leaning away from you.
- **Flip H / Flip V** mirror the layer about its own bounds — which are the canvas until you
  move the layer off the edge — swapping directional glyphs as they go: `/` becomes
  `\`, `╮` becomes `╭`, `▌` becomes `▐`.

All of them pivot on the centre of the inked content, so art doesn't wander as you adjust, and
they compose in a single resampling pass rather than degrading through repeated passes.

**Why a rotated box has thicker sides.** A character cell is about twice as tall as it is wide,
and rotation is done in visual space so a quarter turn looks like a real turn rather than a
squashed one. A horizontal edge one cell tall is two units thick, so once it's vertical it is
genuinely two cells wide. That's the geometry, not an artefact.

How it commits depends on the layer:

- **Painted layers** show a live preview while you drag the sliders, and bake it when you press
  **Apply to layer** — one undo step. You don't have to remember to press it: a preview is
  applied automatically the moment you do anything that would otherwise discard it — draw on
  the layer, add or switch layers, resize the canvas, or clear. Copy and Export also include
  an unapplied preview, so what you export always matches what's on screen. To discard one
  deliberately, press **reset**.
- **Text layers** keep every transform as a *parameter*, re-applied after each render. Edit the
  words, change the font, resize — the transform stays. There's no Apply button because there's
  nothing to bake.

Cells pushed past the canvas edge are dropped, so leave margin around art you plan to transform
hard — rotation in particular needs roughly twice the width it started with — or use
**Fit canvas to text** afterwards on a text layer.

## Selections

The Select tool has two ways to pick cells:

- **Click** an object to magic-wand it: the connected run of non-blank cells, using 8-way
  connectivity so diagonal strokes count as one object.
- **Drag** a marquee for a rectangular selection.

Turn on **Same character only** to make click-to-select stop at a different character rather
than at blanks — clicking a `#` next to a block of `@` then takes only the `#`s.

With a selection active:

| Action | Result |
| --- | --- |
| Drag inside it | Move the selected content. |
| Alt-drag inside it | Duplicate instead of moving. |
| Shift-drag or Shift-click | Add another rectangle or object to the selection. |
| Arrow keys | Nudge one cell. |
| `Cmd/Ctrl+C` | Copy it to the clipboard. |
| `Cmd/Ctrl+X` | Cut it. |
| `Delete` / `Backspace` | Clear the selected cells. |
| `Esc` or `Cmd/Ctrl+D` | Deselect. |
| `Cmd/Ctrl+A` | Select the whole canvas. |

Selections apply to the active layer only, and are dropped when you switch tools or layers.

**Select vs Move.** Move (`V`) shifts the whole active layer with no setup. `Cmd+A` and a drag
does something subtly different: a full-canvas selection carries its blank cells too, so it
overwrites the destination rather than sliding content over it.

## Brush dynamics

The Brush maps an input force onto the stroke. **Dynamics** picks where that force comes from:

- **Pen pressure** — the tablet's reading. Mice and trackpads report a flat `0.5` while held,
  so anything that isn't a pen draws at full force instead of a permanent mid-tone.
- **Speed** — derived from pointer velocity: slow strokes press hard, fast strokes press light,
  smoothed so it doesn't jitter. Works with any device, including a mouse.
- **Off** — constant full force.

Force then drives either or both of:

- **Force → size** — dab width from 1 cell up to the Max size slider.
- **Force → density** — picks a glyph from a ramp: **ASCII** (`. : - = + * # % @`),
  **Blocks** (`░ ▒ ▓ █`), or **Dots** (`· ∙ • ●`). No ramp starts with a blank, so a light
  touch marks the canvas rather than erasing what's under it.

A live readout under the controls shows the pointer type, the current force, and the min–max
range across the last stroke. It's there to make "pressure isn't working" diagnosable: if it
reads `stroke 1.00–1.00` from a pen, the driver is sending binary pressure rather than analog
values, and Speed is the workaround. Sub-frame samples from `getCoalescedEvents()` are used, so
fast tablet strokes keep the pressure detail a per-frame event would drop.

## Canvas

- **Cols / Rows** resize the canvas, up to 400 × 200. The canvas is a window onto the layers
  rather than their extent, so shrinking it crops the view and nothing else — grow it again
  and the art comes back.
- **Zoom** sets the font size, 8–56px. `−` and `+` step it from the keyboard.
- **H space** / **V space** adjust the gap between columns and the row pitch. These are
  **display-only** — they change how the art looks while editing, not what's in the grid, and
  never affect export. **reset** returns them to the defaults.
- **Show grid** (`G`) toggles cell guides. A highlight also tracks the cell under the cursor,
  sized to the current brush footprint.
- **Export** saves the flattened canvas as **Txt**, **Png** or **Jpg**. **Clear layer** wipes
  the active layer only, and is undoable.

## Files

- **Copy** (`⌘C` / `Ctrl+C`) puts the art on the clipboard. With a selection it copies just
  that, cropped to its bounding box — an irregular wand selection keeps its shape, with the
  cells around it blank. With nothing selected it copies the whole flattened canvas. Requires
  a secure context (`localhost` or HTTPS); a toast reports it if the browser blocks it.
- **Cut** (`⌘X` / `Ctrl+X`) copies the selection, then clears the cells it covers on the active
  layer, as one undo step.
- **Paste** (`⌘V` / `Ctrl+V`) drops clipboard text onto the canvas as a moveable selection —
  drag it straight away, nudge it with the arrow keys, or press `Esc` to drop the selection.
  It lands at the current selection's top-left, else the text caret, else the cell under the
  pointer, else the top-left corner. Blanks in the pasted block are transparent, so pasting art
  over existing work doesn't punch a rectangular hole through it. Pasting while a text layer is
  active puts the paste on a new layer of its own, since a text layer regenerates itself. The
  paste event carries the clipboard directly, so it never needs a permission prompt.
- **Export** (in the **Canvas** panel) saves the flattened canvas three ways:
  - **Txt** → `ascii-art.txt`. Characters only; trailing whitespace is trimmed, so lines don't
    carry padding. Layer colours aren't part of it.
  - **Png** / **Jpg** → `ascii-art.png` / `.jpg`, drawn at twice the on-screen size. The image
    is what you see: same zoom, same cell spacing, same per-layer colours, on the canvas
    background. Neither is written with transparency — JPEG can't carry it, and PNG matches it
    for consistency.

  All three include an unapplied [transform](#transform) preview, so an export can't hand back
  art that looks nothing like the canvas.

There is no file import: pasting is the way text gets in.

## Keyboard reference

| Key | Action |
| --- | --- |
| `P` `B` `E` `L` `R` `O` `C` `F` `T` `S` `V` | Pencil, Brush, Eraser, Line, Rect, Box, Ellipse, Fill, Text, Select, Move |
| `X` | Swap primary and secondary characters |
| `[` `]` | Decrease / increase brush size |
| `G` | Toggle the grid overlay |
| `-` `=` | Zoom out / in |
| `Shift` + drag | Straight line (Pencil, Brush, Eraser); square, circle, equilateral or snapped line (shapes); add to the selection (Select) |
| `Cmd/Ctrl+Z` | Undo (100 steps) |
| `Shift+Cmd/Ctrl+Z`, `Cmd/Ctrl+Y` | Redo |
| `Cmd/Ctrl+C` | Copy the selection, or the whole canvas |
| `Cmd/Ctrl+X` | Cut the selection |
| `Cmd/Ctrl+V` | Paste clipboard text as a moveable selection |
| `Cmd/Ctrl+A` | Select all |
| `Cmd/Ctrl+D`, `Esc` | Deselect |
| Arrow keys | Nudge the selection, the layer (Move tool), or the text caret |
| `Delete` / `Backspace` | Clear the selection |

With the Text tool and an active caret, typing inserts characters; `Enter` returns to the
column you clicked, and `Backspace` erases the cell to the left.

## How it works

```
src/
  App.svelte              mounts the editor
  lib/
    AsciiEditor.svelte    UI, state, pointer and keyboard handling
    ascii.js              pure grid helpers — no framework code
    textRender.js         Google Fonts loading + font-to-cells rasterizer
```

[`ascii.js`](src/lib/ascii.js) holds everything that's just data in / data out: Bresenham
lines, rectangles, box frames with corner selection, flood fill, magic-wand object picking,
brush stamping, grid shift/resize, and text conversion. It has no Svelte dependency, so it can
be exercised directly from Node.

[`AsciiEditor.svelte`](src/lib/AsciiEditor.svelte) uses Svelte 5 runes. A few decisions worth
knowing if you're extending it:

- **The active layer is a `$derived` proxy reference.** `grid[y][x] = ch` writes straight
  through to the active layer and re-renders. Replacing a whole grid must assign to
  `layers[activeIndex].grid` instead.
- **Previews apply to the active layer, then the stack re-flattens.** Painting a preview onto
  the flattened image instead would make lifted content leave a hole rather than revealing the
  layer underneath, and would let it draw over layers that should occlude it.
- **Cell size is measured, not assumed.** A hidden 50-character span carries the same font size
  and letter-spacing as the canvas; its width over 50 is the exact cell pitch, which keeps
  pointer-to-cell mapping accurate at any zoom or spacing. That span lives inside a zero-size
  `overflow: hidden` wrapper so it can't add to the page's scrollable area.
- **The grid renders as one row `<div>` per line**, not a node per cell — 80×24 is 24 DOM nodes
  rather than 1920. Overlays (grid guides, selection outline, caret, hover) are absolutely
  positioned on top and never intercept pointer events.
- **The selection outline draws borders only on cells facing outwards**, so an irregular
  selection gets a single clean outline instead of a mesh.
- **Undo snapshots clone on capture *and* on restore.** Sharing the arrays would let the next
  edit silently rewrite a history entry.
- **Shortcuts are bound to the window**, not the canvas, so they still work after clicking a
  panel control; form fields are excluded so typing in them behaves normally.

[`textRender.js`](src/lib/textRender.js) rasterizes type through a 2D canvas and reduces it to
cells:

- **Cells are sampled as 6×12 pixel blocks.** The 1:2 ratio matches the shape of a monospace
  cell, so a rasterized word keeps the font's real proportions once it lands on the grid.
- **Fonts are loaded as `FontFace` objects, not via a `<link>`.** A stylesheet link plus
  `document.fonts.load()` silently resolves as a no-op while the CSS is still in flight, so the
  first render falls back to a system font and nothing triggers a redraw — different families
  come out pixel-identical. Instead the CSS2 response is fetched, every `@font-face` in it is
  registered (Google splits a family across unicode-range subsets, and the Latin one is usually
  last), and the font files themselves are awaited before re-rendering.
- **The raster is cropped to its inked bounds**, so the layer's (x, y) anchors the visible
  glyphs rather than the font's internal padding, and changing size or family doesn't drift.
- **Text layers regenerate from parameters** in an effect that reads only `text` and writes only
  `grid` — reading the grid there would make it retrigger itself.
