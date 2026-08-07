/**
 * Green screen (virtual background) processing.
 *
 * Uses MediaPipe Selfie Segmentation (loaded lazily from CDN) to
 * separate the speaker from the background, then composites onto an
 * offscreen canvas. Background modes:
 *   - 'blur'       — original background, blurred (intensity = radius)
 *   - 'color'      — solid color background
 *   - 'image'      — custom uploaded background (Pro)
 *   - 'office'     — preset photo: professional shelves/desk
 *   - 'bokeh'      — preset photo: warm defocused lights
 *   - 'nature'     — preset photo: soft greenery
 *   - 'sunset'     — canvas-drawn warm gradient (orange→pink→purple)
 *   - 'minimalist' — canvas-drawn light gradient (white→gray)
 *
 * Every preset has a 0–1 `intensity` knob that maps onto a mode-specific
 * range (blur radius, brightness, saturation, glow, gradient depth) —
 * see INTENSITY_RANGES below, shared with the gallery UI.
 *
 * The recording pipeline reads processor.canvas each frame, exactly the
 * way it already reads the raw <video> element, so captions composite
 * on top unchanged.
 */

const CDN = 'https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation';

// Preset photos served from public/backgrounds/ (canvas-drawn presets
// need no image).
const PRESET_IMAGE_MODES = ['office', 'bokeh', 'nature'];

/**
 * How the 0–1 intensity slider maps per mode. `label` formats the live
 * readout shown under the gallery slider.
 */
export const INTENSITY_RANGES = {
  blur: {
    name: 'Blur',
    default: 0.35, // → 12px, the classic radius
    map: (i) => 5 + 20 * i, // 5–25px
    label: (i) => `Blur: ${Math.round(5 + 20 * i)}px`,
  },
  office: {
    name: 'Brightness',
    default: 0.5,
    map: (i) => 0.5 + i, // 0.5–1.5
    label: (i) => `Brightness: ${(0.5 + i).toFixed(2)}x`,
  },
  bokeh: {
    name: 'Glow',
    default: 0.57, // → ~0.7 glow
    map: (i) => 0.3 + 0.7 * i, // 0.3–1.0
    label: (i) => `Glow: ${(0.3 + 0.7 * i).toFixed(2)}`,
  },
  sunset: {
    name: 'Saturation',
    default: 0.5,
    map: (i) => 0.5 + i, // 0.5–1.5
    label: (i) => `Saturation: ${(0.5 + i).toFixed(2)}x`,
  },
  nature: {
    name: 'Saturation',
    default: 0.5,
    map: (i) => 0.5 + i, // 0.5–1.5
    label: (i) => `Saturation: ${(0.5 + i).toFixed(2)}x`,
  },
  minimalist: {
    name: 'Depth',
    default: 0.5,
    map: (i) => 0.1 + 0.9 * i, // 0.1–1.0
    label: (i) => `Depth: ${(0.1 + 0.9 * i).toFixed(2)}`,
  },
};

export const DEFAULT_INTENSITY = 0.5;

/** Default slider position for a mode (0–1). */
export function intensityDefault(mode) {
  return INTENSITY_RANGES[mode]?.default ?? DEFAULT_INTENSITY;
}

let loadPromise = null;

/** Load the MediaPipe script once and cache the constructor. */
function loadSelfieSegmentation() {
  if (typeof window !== 'undefined' && window.SelfieSegmentation) {
    return Promise.resolve(window.SelfieSegmentation);
  }
  if (!loadPromise) {
    loadPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = `${CDN}/selfie_segmentation.js`;
      script.crossOrigin = 'anonymous';
      script.onload = () => {
        if (window.SelfieSegmentation) resolve(window.SelfieSegmentation);
        else reject(new Error('Segmentation library failed to initialize.'));
      };
      script.onerror = () =>
        reject(new Error('Could not load the background-effects library.'));
      document.head.appendChild(script);
    });
    // Allow a retry after a failed load (e.g. offline once).
    loadPromise.catch(() => {
      loadPromise = null;
    });
  }
  return loadPromise;
}

export class GreenScreenProcessor {
  constructor(width = 1280, height = 720) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = width;
    this.canvas.height = height;
    this.ctx = this.canvas.getContext('2d');

    this.mode = 'off';
    this.color = '#ffffff';
    this.intensity = DEFAULT_INTENSITY; // 0–1, mode-specific meaning
    this.bgImage = null; // HTMLImageElement for 'image' mode
    this.presetImages = {}; // mode -> HTMLImageElement (office/bokeh/nature)
    this.smoothEdges = false; // Pro: softer mask edges

    this.running = false;
    this.hasFrame = false;
    this._busy = false;
    this._raf = null;
    this._seg = null;
    this._presetLoads = {}; // mode -> in-flight Promise
  }

  setMode(mode) {
    this.mode = mode;
  }

  setColor(color) {
    this.color = color;
  }

  /** 0–1 slider value; each mode maps it onto its own range. */
  setIntensity(value) {
    const n = Number(value);
    this.intensity = Number.isFinite(n) ? Math.min(Math.max(n, 0), 1) : DEFAULT_INTENSITY;
  }

  /** dataUrl -> background image for 'image' mode. */
  setBackgroundImage(dataUrl) {
    if (!dataUrl) {
      this.bgImage = null;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        this.bgImage = img;
        resolve();
      };
      img.onerror = () => reject(new Error('Could not read that image.'));
      img.src = dataUrl;
    });
  }

  /**
   * Make sure the given mode's preset photo (if any) is loaded. Resolves
   * immediately for canvas-drawn presets. A missing/broken photo resolves
   * anyway — _compose falls back to a solid tone, never a black frame.
   */
  preparePreset(mode) {
    if (!PRESET_IMAGE_MODES.includes(mode) || this.presetImages[mode]) {
      return Promise.resolve();
    }
    if (!this._presetLoads[mode]) {
      this._presetLoads[mode] = new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
          this.presetImages[mode] = img;
          resolve();
        };
        img.onerror = () => resolve(); // fall back to the solid tone
        img.src = `/backgrounds/${mode}.jpg`;
      }).finally(() => {
        delete this._presetLoads[mode];
      });
    }
    return this._presetLoads[mode];
  }

  /** Start segmenting frames from the given <video> element. */
  async start(videoEl) {
    if (this.running) return;
    const SelfieSegmentation = await loadSelfieSegmentation();
    this._seg = new SelfieSegmentation({
      locateFile: (file) => `${CDN}/${file}`,
    });
    // modelSelection 1 = landscape model, better for 16:9 webcam frames.
    this._seg.setOptions({ modelSelection: 1 });
    this._seg.onResults((results) => this._compose(results));

    this.running = true;

    const pump = async () => {
      if (!this.running) return;
      if (videoEl.readyState >= 2 && !this._busy) {
        this._busy = true;
        try {
          await this._seg.send({ image: videoEl });
        } catch {
          // Skip the frame; keep the loop alive.
        }
        this._busy = false;
      }
      this._raf = requestAnimationFrame(pump);
    };
    pump();
  }

  /** Cover-fit draw an image onto the full canvas. */
  _drawCover(img) {
    const { ctx } = this;
    const { width, height } = this.canvas;
    const scale = Math.max(width / img.width, height / img.height);
    const dw = img.width * scale;
    const dh = img.height * scale;
    ctx.drawImage(img, (width - dw) / 2, (height - dh) / 2, dw, dh);
  }

  /** Fill the canvas with a vertical gradient from the given stops. */
  _drawGradient(stops) {
    const { ctx } = this;
    const { width, height } = this.canvas;
    const grad = ctx.createLinearGradient(0, 0, 0, height);
    for (const [at, color] of stops) grad.addColorStop(at, color);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, width, height);
  }

  /** Paint the chosen background (called with 'destination-over' active). */
  _drawBackground(results) {
    const { ctx } = this;
    const { width, height } = this.canvas;
    const i = this.intensity;

    switch (this.mode) {
      case 'blur': {
        ctx.filter = `blur(${(5 + 20 * i).toFixed(1)}px)`; // 5–25px
        ctx.drawImage(results.image, 0, 0, width, height);
        ctx.filter = 'none';
        break;
      }
      case 'office': {
        const img = this.presetImages.office;
        if (img) {
          ctx.filter = `brightness(${(0.5 + i).toFixed(3)})`; // 0.5–1.5
          this._drawCover(img);
          ctx.filter = 'none';
        } else {
          this._drawGradient([[0, '#8a7256'], [1, '#4a3b2a']]);
        }
        break;
      }
      case 'bokeh': {
        const img = this.presetImages.bokeh;
        if (img) {
          // Glow 0.3–1.0 → brightness lift on the warm lights.
          const glow = 0.3 + 0.7 * i;
          ctx.filter = `brightness(${(0.45 + glow).toFixed(3)}) saturate(1.15)`;
          this._drawCover(img);
          ctx.filter = 'none';
        } else {
          this._drawGradient([[0, '#3a2320'], [1, '#120a08']]);
        }
        break;
      }
      case 'nature': {
        const img = this.presetImages.nature;
        if (img) {
          ctx.filter = `saturate(${(0.5 + i).toFixed(3)})`; // 0.5–1.5
          this._drawCover(img);
          ctx.filter = 'none';
        } else {
          this._drawGradient([[0, '#5c8a4f'], [1, '#2e4d28']]);
        }
        break;
      }
      case 'sunset': {
        // Warm gradient; the slider drives saturation 0.5–1.5.
        ctx.filter = `saturate(${(0.5 + i).toFixed(3)})`;
        this._drawGradient([
          [0, '#ff9046'],
          [0.5, '#ff5e8a'],
          [1, '#7a3fd8'],
        ]);
        ctx.filter = 'none';
        break;
      }
      case 'minimalist': {
        // White → gray; the slider drives how deep the gray goes.
        const depth = 0.1 + 0.9 * i; // 0.1–1.0
        const g = Math.round(255 - 96 * depth);
        this._drawGradient([
          [0, '#ffffff'],
          [1, `rgb(${g}, ${g}, ${Math.min(255, g + 4)})`],
        ]);
        break;
      }
      case 'image': {
        if (this.bgImage) {
          this._drawCover(this.bgImage);
        } else {
          ctx.fillStyle = '#000000';
          ctx.fillRect(0, 0, width, height);
        }
        break;
      }
      default: {
        // 'color'
        ctx.fillStyle = this.mode === 'color' ? this.color : '#000000';
        ctx.fillRect(0, 0, width, height);
      }
    }
  }

  /** Composite person cutout over the chosen background. */
  _compose(results) {
    const { ctx } = this;
    const { width, height } = this.canvas;

    ctx.save();
    ctx.clearRect(0, 0, width, height);

    // 1. Draw the person mask (optionally softened for smoother edges).
    if (this.smoothEdges) ctx.filter = 'blur(3px)';
    ctx.drawImage(results.segmentationMask, 0, 0, width, height);
    ctx.filter = 'none';

    // 2. Keep only the camera pixels where the mask says "person".
    ctx.globalCompositeOperation = 'source-in';
    ctx.drawImage(results.image, 0, 0, width, height);

    // 3. Paint the background behind the person.
    ctx.globalCompositeOperation = 'destination-over';
    this._drawBackground(results);

    ctx.restore();
    this.hasFrame = true;
  }

  stop() {
    this.running = false;
    this.hasFrame = false;
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = null;
    if (this._seg) {
      try {
        this._seg.close();
      } catch {
        // ignore
      }
      this._seg = null;
    }
  }
}
