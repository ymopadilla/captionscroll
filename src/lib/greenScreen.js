/**
 * Green screen (virtual background) processing.
 *
 * Uses MediaPipe Selfie Segmentation (loaded lazily from CDN) to
 * separate the speaker from the background, then composites onto an
 * offscreen canvas:
 *   - 'blur'  — original background, blurred
 *   - 'color' — solid color background
 *   - 'image' — custom uploaded background (Pro)
 *
 * The recording pipeline reads processor.canvas each frame, exactly the
 * way it already reads the raw <video> element, so captions composite
 * on top unchanged.
 */

const CDN = 'https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation';

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

    this.mode = 'off'; // 'off' | 'blur' | 'color' | 'image'
    this.color = '#ffffff';
    this.bgImage = null; // HTMLImageElement for 'image' mode
    this.smoothEdges = false; // Pro: softer mask edges

    this.running = false;
    this.hasFrame = false;
    this._busy = false;
    this._raf = null;
    this._seg = null;
  }

  setMode(mode) {
    this.mode = mode;
  }

  setColor(color) {
    this.color = color;
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
    if (this.mode === 'blur') {
      ctx.filter = 'blur(16px)';
      ctx.drawImage(results.image, 0, 0, width, height);
      ctx.filter = 'none';
    } else if (this.mode === 'image' && this.bgImage) {
      // Cover-fit the uploaded background.
      const img = this.bgImage;
      const scale = Math.max(width / img.width, height / img.height);
      const dw = img.width * scale;
      const dh = img.height * scale;
      ctx.drawImage(img, (width - dw) / 2, (height - dh) / 2, dw, dh);
    } else {
      // 'color' — and the fallback for 'image' with no upload yet.
      ctx.fillStyle = this.mode === 'color' ? this.color : '#000000';
      ctx.fillRect(0, 0, width, height);
    }

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
