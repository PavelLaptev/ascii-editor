// Decode-style scramble for short labels: the text appears as random ASCII glyphs that
// resolve, left to right, into the real word. Used on the toolbox labels, which only show
// on hover or while the tool is armed, so the reveal doubles as the reveal animation.

const GLYPHS = "#%&*+-/<=>?@[]^_{|}~░▒▓█";
const DURATION = 360; // ms, whole word settled
const TICK = 40; // ms between glyph swaps — slower than a frame so the noise is readable

const reducedMotion = () =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Svelte action. `text` is the resolved label; `live` flips true when the label is shown for
 * a reason other than hover (the tool got armed by a click or shortcut) and triggers a run.
 * Hover is picked up from the nearest button so the label itself needs no pointer events.
 */
export function glitch(node, { text, live }) {
  let raf = 0;
  let current = text;

  function stop() {
    cancelAnimationFrame(raf);
    raf = 0;
    node.textContent = current;
  }

  function run() {
    stop();
    if (reducedMotion() || !current) return;
    const chars = [...current];
    // Each glyph settles at a staggered moment: mostly by position, with a little jitter so
    // the front doesn't sweep like a wipe.
    const settle = chars.map(
      (_, i) => ((i / chars.length) * 0.6 + Math.random() * 0.4) * DURATION
    );
    const start = performance.now();
    let lastTick = -Infinity;
    let frame = "";
    const step = (now) => {
      const t = now - start;
      if (now - lastTick >= TICK) {
        lastTick = now;
        frame = chars
          .map((c, i) =>
            t >= settle[i] || c === " "
              ? c
              : GLYPHS[Math.floor(Math.random() * GLYPHS.length)]
          )
          .join("");
        node.textContent = frame;
      }
      if (t < DURATION) raf = requestAnimationFrame(step);
      else stop();
    };
    raf = requestAnimationFrame(step);
  }

  const host = node.closest("button") ?? node;
  host.addEventListener("pointerenter", run);

  return {
    update({ text: nextText, live: nextLive }) {
      if (nextText !== current) {
        current = nextText;
        if (!raf) node.textContent = current;
      }
      if (nextLive && !live) run();
      live = nextLive;
    },
    destroy() {
      cancelAnimationFrame(raf);
      host.removeEventListener("pointerenter", run);
    }
  };
}
