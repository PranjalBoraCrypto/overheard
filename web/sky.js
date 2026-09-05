/**
 * The spotlight that follows the pointer, once, for the whole site.
 *
 * Eight pages carried their own copy of this — the same fourteen lines, the
 * same easing constant, with the numbers already drifting. One definition.
 *
 * WHAT IT COSTS. Two custom property writes per frame, and only while the
 * pointer is actually moving: the loop stops itself as soon as the eased
 * position has caught up with the real one. Nothing is measured inside the
 * handler, nothing is laid out, and the only thing that changes is a gradient
 * position on a fixed layer that composites on its own. It is the cheapest
 * possible version of the effect.
 *
 * WHAT IT DOES NOT DO. It does not run for a touch screen, because there is
 * no pointer to follow and the light would jump to wherever a finger last
 * landed and stay there. It does not run for anybody who has asked for less
 * motion. In both cases .spot keeps its default position and reads as ambient
 * light from above, which is what it should be when nobody is pointing at
 * anything.
 */
const fine = matchMedia("(hover:hover) and (pointer:fine)");
const still = matchMedia("(prefers-reduced-motion:reduce)");

if (fine.matches && !still.matches) {
  const root = document.documentElement;
  let x = innerWidth / 2, y = innerHeight / 2, cx = x, cy = y, running = false;

  const paint = () => {
    /* .16 is a lag you feel rather than see. It is what makes the light read
       as having weight instead of being stuck to the cursor. */
    cx += (x - cx) * 0.16;
    cy += (y - cy) * 0.16;
    root.style.setProperty("--px", `${((cx / innerWidth) * 100).toFixed(2)}%`);
    root.style.setProperty("--py", `${((cy / innerHeight) * 100).toFixed(2)}%`);
    /* Half a pixel from where it is going is close enough to stop. Without
       this the loop runs at 60fps for the life of the page. */
    if (Math.abs(x - cx) > 0.5 || Math.abs(y - cy) > 0.5) requestAnimationFrame(paint);
    else running = false;
  };

  addEventListener("pointermove", (e) => {
    x = e.clientX; y = e.clientY;
    if (!running) { running = true; requestAnimationFrame(paint); }
  }, { passive: true });

  requestAnimationFrame(paint);
}
