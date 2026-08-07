/**
 * Text/emoji overlay helpers.
 *
 * Overlays live in RECORDING coordinate space (1280x720) so the same
 * { x, y, size } values drive both the HTML preview (scaled to whatever
 * box the camera preview occupies) and the canvas compositor that bakes
 * them into the saved video. x/y are the CENTER of the text.
 */

export const OVERLAY_FRAME = { width: 1280, height: 720 };
export const OVERLAY_MIN_SIZE = 14;
export const OVERLAY_MAX_SIZE = 72;
export const OVERLAY_DEFAULT = {
  text: 'Your text',
  color: '#ffffff',
  size: 36,
};

export const OVERLAY_FONT_FAMILY =
  "Arial, -apple-system, 'Segoe UI', 'Segoe UI Emoji', 'Noto Color Emoji', sans-serif";

let overlaySeq = 0;

/** Create a new overlay layer with sensible defaults, centered high. */
export function createOverlay(partial = {}) {
  overlaySeq += 1;
  return {
    id: `overlay-${Date.now()}-${overlaySeq}`,
    text: OVERLAY_DEFAULT.text,
    color: OVERLAY_DEFAULT.color,
    size: OVERLAY_DEFAULT.size,
    x: OVERLAY_FRAME.width / 2,
    y: Math.round(OVERLAY_FRAME.height * 0.42), // middle band survives cover-crop
    ...partial,
  };
}

/** Keep an overlay's anchor inside the frame (small margin all around). */
export function clampOverlayPosition(x, y) {
  const M = 10;
  return {
    x: Math.min(Math.max(x, M), OVERLAY_FRAME.width - M),
    y: Math.min(Math.max(y, M), OVERLAY_FRAME.height - M),
  };
}

/** Clamp a font size to the dialog slider's range. */
export function clampOverlaySize(size) {
  const n = Number(size);
  if (!Number.isFinite(n)) return OVERLAY_DEFAULT.size;
  return Math.min(Math.max(Math.round(n), OVERLAY_MIN_SIZE), OVERLAY_MAX_SIZE);
}

/**
 * How the 1280x720 frame maps onto a cover-fit preview box of
 * containerW x containerH: screen = offset + frame * scale.
 */
export function coverTransform(containerW, containerH) {
  const { width, height } = OVERLAY_FRAME;
  if (!containerW || !containerH) return { scale: 1, ox: 0, oy: 0 };
  const scale = Math.max(containerW / width, containerH / height);
  return {
    scale,
    ox: (containerW - width * scale) / 2,
    oy: (containerH - height * scale) / 2,
  };
}

/**
 * Draw every overlay onto a recording-sized canvas context. Runs inside
 * the compositor's rAF loop — after the camera/background frame, before
 * captions — so decorations sit under the caption bar.
 */
export function drawTextOverlays(ctx, overlays, width = OVERLAY_FRAME.width, height = OVERLAY_FRAME.height) {
  if (!overlays || overlays.length === 0) return;
  const sx = width / OVERLAY_FRAME.width;
  const sy = height / OVERLAY_FRAME.height;
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const o of overlays) {
    if (!o.text) continue;
    ctx.font = `600 ${Math.round(o.size * sx)}px ${OVERLAY_FONT_FAMILY}`;
    // Soft shadow so light text stays readable on light backgrounds.
    ctx.shadowColor = 'rgba(0, 0, 0, 0.55)';
    ctx.shadowBlur = Math.max(2, Math.round(o.size * sx * 0.12));
    ctx.shadowOffsetY = 1;
    ctx.fillStyle = o.color;
    ctx.fillText(o.text, o.x * sx, o.y * sy);
  }
  ctx.restore();
}
