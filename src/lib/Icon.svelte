<script>
  // Icons exported from the Figma file. Their fills are normalised to `currentColor`, so a
  // button colours its icon the same way it colours its label.
  import brush from './icons/brush.svg?raw'
  import canvas from './icons/canvas.svg?raw'
  import chevron from './icons/chevron.svg?raw'
  import clone from './icons/clone.svg?raw'
  import eraser from './icons/eraser.svg?raw'
  import eyeClose from './icons/eye-close.svg?raw'
  import eyeOpen from './icons/eye-open.svg?raw'
  import fill from './icons/fill.svg?raw'
  import fx from './icons/fx.svg?raw'
  import join from './icons/join.svg?raw'
  import layers from './icons/layers.svg?raw'
  import move from './icons/move.svg?raw'
  import path from './icons/path.svg?raw'
  import pencil from './icons/pencil.svg?raw'
  import plus from './icons/plus.svg?raw'
  import select from './icons/select.svg?raw'
  import shapeBox from './icons/shape-box.svg?raw'
  import shapeDiamond from './icons/shape-diamond.svg?raw'
  import shapeEllipse from './icons/shape-ellipse.svg?raw'
  import shapeLine from './icons/shape-line.svg?raw'
  import shapePath from './icons/shape-path.svg?raw'
  import shapeRect from './icons/shape-rect.svg?raw'
  import shapeTriangle from './icons/shape-triangle.svg?raw'
  import swap from './icons/swap.svg?raw'
  import text from './icons/text.svg?raw'
  import trash from './icons/trash.svg?raw'

  const ICONS = {
    brush,
    canvas,
    chevron,
    clone,
    eraser,
    'eye-close': eyeClose,
    'eye-open': eyeOpen,
    fill,
    fx,
    join,
    layers,
    move,
    path,
    pencil,
    plus,
    select,
    'shape-box': shapeBox,
    'shape-diamond': shapeDiamond,
    'shape-ellipse': shapeEllipse,
    'shape-line': shapeLine,
    'shape-path': shapePath,
    'shape-rect': shapeRect,
    'shape-triangle': shapeTriangle,
    swap,
    text,
    trash,
  }

  // `size` is the exported artboard size — 34 for tool icons, 24 for panel actions, 18 for
  // the eyes, 20 for the shape picker — so each asset keeps the box it was drawn in.
  let { name, size = 34 } = $props()
</script>

<span class="icon" style="width:{size}px; height:{size}px">{@html ICONS[name]}</span>

<style>
  .icon {
    display: block;
    flex: none;
  }
  /* The markup arrives through {@html}, so scoping has to be opted out of. */
  .icon :global(svg) {
    display: block;
    width: 100%;
    height: 100%;
  }
</style>
