/**
 * Social export helpers (Pro).
 *
 * YouTube / LinkedIn use the recording's native 16:9 frame, so those
 * exports download directly. TikTok / Instagram are 9:16 vertical, so
 * the take is re-encoded through a canvas center-crop.
 */

export const SOCIAL_PRESETS = {
  youtube: { label: 'YouTube', aspect: '16:9', width: 1280, height: 720 },
  linkedin: { label: 'LinkedIn', aspect: '16:9', width: 1280, height: 720 },
  tiktok: { label: 'TikTok', aspect: '9:16', width: 720, height: 1280 },
  instagram: { label: 'Instagram', aspect: '9:16', width: 720, height: 1280 },
};

function pickExportMime() {
  if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) {
    return '';
  }
  return (
    [
      'video/mp4;codecs=avc1',
      'video/mp4',
      'video/webm;codecs=vp9',
      'video/webm',
    ].find((t) => MediaRecorder.isTypeSupported(t)) || ''
  );
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Re-encode a recorded take to the given dimensions with a center crop
 * (cover-fit). Returns { blob, ext }. Falls back by throwing if the
 * browser can't capture streams from media elements.
 */
export function reencodeTake(blob, { width, height }) {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.muted = false;
    video.volume = 0; // silent playback; audio still flows to the stream
    video.playsInline = true;
    video.src = URL.createObjectURL(blob);

    const cleanup = () => URL.revokeObjectURL(video.src);

    video.onerror = () => {
      cleanup();
      reject(new Error('Could not read the recording for export.'));
    };

    video.onloadedmetadata = async () => {
      const capture =
        video.captureStream?.bind(video) || video.mozCaptureStream?.bind(video);
      if (!capture) {
        cleanup();
        reject(new Error('This browser does not support re-encoding exports.'));
        return;
      }

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');

      const outStream = canvas.captureStream(30);
      // Bring the take's audio along.
      const sourceStream = capture();
      sourceStream.getAudioTracks().forEach((t) => outStream.addTrack(t));

      const mime = pickExportMime();
      let recorder;
      try {
        recorder = new MediaRecorder(outStream, {
          mimeType: mime || undefined,
          videoBitsPerSecond: 5_000_000,
        });
      } catch (err) {
        cleanup();
        reject(err);
        return;
      }

      const chunks = [];
      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunks.push(e.data);
      };
      recorder.onstop = () => {
        cleanup();
        const ext = (mime || '').includes('mp4') ? 'mp4' : 'webm';
        resolve({
          blob: new Blob(chunks, { type: mime || 'video/webm' }),
          ext,
        });
      };

      let raf = null;
      const draw = () => {
        const vw = video.videoWidth;
        const vh = video.videoHeight;
        if (vw && vh) {
          const scale = Math.max(width / vw, height / vh);
          const dw = vw * scale;
          const dh = vh * scale;
          ctx.drawImage(video, (width - dw) / 2, (height - dh) / 2, dw, dh);
        }
        raf = requestAnimationFrame(draw);
      };

      video.onended = () => {
        if (raf) cancelAnimationFrame(raf);
        if (recorder.state !== 'inactive') recorder.stop();
      };

      try {
        await video.play();
        recorder.start(1000);
        draw();
      } catch (err) {
        cleanup();
        reject(err);
      }
    };
  });
}
