import { useState, useEffect, useRef, useCallback } from 'react';
import './TeleprompterScroll.css';

/* ============================================================
 * Recording constants
 * ============================================================ */

// Minimum output resolution required for recordings (16:9).
const RECORD_WIDTH = 1280;
const RECORD_HEIGHT = 720;

// Preferred container/codec combos, best first. Safari supports MP4
// natively; Chrome/Firefox/Edge fall back to WebM.
const CANDIDATE_MIME_TYPES = [
  'video/mp4;codecs=avc1',
  'video/mp4',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
];

// Max characters shown in one caption segment before splitting.
const MAX_CAPTION_CHARS = 110;

/** Pick the best MediaRecorder MIME type this browser supports. */
function pickMimeType() {
  if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) {
    return '';
  }
  return CANDIDATE_MIME_TYPES.find((t) => MediaRecorder.isTypeSupported(t)) || '';
}

/**
 * Split the script into short caption-sized segments, each with a
 * cumulative character range so scroll progress can be mapped onto them.
 * Splits on newlines, then on sentence boundaries, then (for very long
 * sentences) on word boundaries.
 */
function buildCaptionSegments(text) {
  const texts = [];

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    let chunk = '';
    for (const sentence of line.split(/(?<=[.!?])\s+/)) {
      const candidate = chunk ? `${chunk} ${sentence}` : sentence;
      if (candidate.length > MAX_CAPTION_CHARS && chunk) {
        texts.push(chunk);
        chunk = sentence;
      } else {
        chunk = candidate;
      }
    }

    // A single sentence longer than the cap gets split on words.
    while (chunk.length > MAX_CAPTION_CHARS) {
      const cut = chunk.lastIndexOf(' ', MAX_CAPTION_CHARS);
      if (cut <= 0) break;
      texts.push(chunk.slice(0, cut));
      chunk = chunk.slice(cut + 1);
    }
    if (chunk) texts.push(chunk);
  }

  // Assign each segment a character range for proportional scroll mapping.
  let offset = 0;
  const segments = texts.map((t) => {
    const seg = { text: t, start: offset, end: offset + t.length };
    offset += t.length + 1;
    return seg;
  });
  return { segments, totalChars: offset };
}

/** Word-wrap caption text to fit maxWidth; caps at 3 rendered lines. */
function wrapCaptionLines(ctx, text, maxWidth) {
  const words = text.split(/\s+/);
  const lines = [];
  let line = '';
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (line && ctx.measureText(test).width > maxWidth) {
      lines.push(line);
      line = word;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  return lines.slice(0, 3);
}

/** Format elapsed seconds as MM:SS. */
function formatTime(totalSeconds) {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export default function TeleprompterScroll() {
  /* ---------- existing teleprompter state ---------- */
  const [scriptText, setScriptText] = useState('');
  const [isPlaying, setIsPlaying] = useState(false);
  const [scrollSpeed, setScrollSpeed] = useState(1);
  const [fontSize, setFontSize] = useState(24);
  const [mirrorMode, setMirrorMode] = useState(false);
  const displayRef = useRef(null);

  /* ---------- recording state ---------- */
  const [showCaptions, setShowCaptions] = useState(false); // "Embed Captions" — default NO
  const [showPreview, setShowPreview] = useState(true); // "Show Camera Preview" — default YES
  const [isRecording, setIsRecording] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const [recordedBlob, setRecordedBlob] = useState(null);
  const [cameraReady, setCameraReady] = useState(false);
  const [cameraError, setCameraError] = useState('');
  const [cameraAttempt, setCameraAttempt] = useState(0); // bump to retry getUserMedia

  const recorderSupported =
    typeof MediaRecorder !== 'undefined' && pickMimeType() !== '';

  /* ---------- refs for recording plumbing ---------- */
  const videoRef = useRef(null); // live <video> preview
  const canvasRef = useRef(null); // hidden compositing canvas
  const streamRef = useRef(null); // camera + mic MediaStream
  const mediaRecorderRef = useRef(null);
  const chunksRef = useRef([]);
  const rafRef = useRef(null); // requestAnimationFrame id for the draw loop
  const mimeTypeRef = useRef('');

  // Mirror fast-changing values into refs so the canvas draw loop
  // (which runs outside React) always reads current values.
  const isPlayingRef = useRef(isPlaying);
  const captionDataRef = useRef({ segments: [], totalChars: 0 });

  useEffect(() => {
    isPlayingRef.current = isPlaying;
  }, [isPlaying]);

  useEffect(() => {
    captionDataRef.current = buildCaptionSegments(scriptText);
  }, [scriptText]);

  /* ============================================================
   * Existing scrolling logic (unchanged)
   * ============================================================ */
  useEffect(() => {
    if (!isPlaying || !displayRef.current) return;

    const interval = setInterval(() => {
      displayRef.current.scrollTop += scrollSpeed * 2;
    }, 50);

    return () => clearInterval(interval);
  }, [isPlaying, scrollSpeed]);

  const handleReset = () => {
    if (displayRef.current) {
      displayRef.current.scrollTop = 0;
    }
  };

  /* ============================================================
   * Camera setup — runs on mount; retry by bumping cameraAttempt
   * ============================================================ */
  useEffect(() => {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setCameraError('Camera access is not supported in this browser.');
      return undefined;
    }

    let cancelled = false;
    let localStream = null;

    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: true,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        localStream = stream;
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
        }
        setCameraError('');
        setCameraReady(true);
        // (A second effect below re-attaches srcObject after re-renders,
        // covering the retry path where the ref target changes.)
      } catch (err) {
        if (cancelled) return;
        if (err.name === 'NotAllowedError' || err.name === 'SecurityError') {
          setCameraError(
            'Camera access was denied. Allow camera and microphone access in your browser settings, then retry.'
          );
        } else if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
          setCameraError('No camera or microphone was found on this device.');
        } else if (err.name === 'NotReadableError') {
          setCameraError('The camera is in use by another application.');
        } else {
          setCameraError(`Could not start the camera: ${err.message}`);
        }
        setCameraReady(false);
      }
    })();

    return () => {
      cancelled = true;
      if (localStream) {
        localStream.getTracks().forEach((t) => t.stop());
      }
      streamRef.current = null;
      setCameraReady(false);
    };
  }, [cameraAttempt]);

  // Keep the video element attached to the live stream across re-renders
  // (e.g. after a camera retry succeeds while the error overlay unmounts).
  useEffect(() => {
    if (cameraReady && videoRef.current && streamRef.current) {
      if (videoRef.current.srcObject !== streamRef.current) {
        videoRef.current.srcObject = streamRef.current;
      }
    }
  }, [cameraReady, cameraError]);

  /* ============================================================
   * Recording timer
   * ============================================================ */
  useEffect(() => {
    if (!isRecording) return undefined;
    const interval = setInterval(() => {
      setRecordingTime((t) => t + 1);
    }, 1000);
    return () => clearInterval(interval);
  }, [isRecording]);

  /* ============================================================
   * Caption compositing (canvas draw loop)
   * ============================================================ */

  /** Current caption based on scroll progress through the script. */
  const getCurrentCaption = useCallback(() => {
    const el = displayRef.current;
    const { segments, totalChars } = captionDataRef.current;
    if (!el || segments.length === 0) return '';

    const maxScroll = el.scrollHeight - el.clientHeight;
    const progress = maxScroll > 0 ? Math.min(el.scrollTop / maxScroll, 1) : 0;
    const charIndex = progress * totalChars;

    const seg =
      segments.find((s) => charIndex >= s.start && charIndex < s.end) ||
      segments[segments.length - 1];
    return seg.text;
  }, []);

  /** Draw the caption block: white text on a semi-transparent dark bar. */
  const drawCaption = useCallback((ctx, caption, width, height) => {
    const PAD_X = 12;
    const PAD_Y = 8;
    const captionFontSize = Math.round(height * 0.045); // ~32px at 720p
    const lineHeight = Math.round(captionFontSize * 1.35);

    ctx.font = `600 ${captionFontSize}px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const maxTextWidth = width * 0.85;
    const lines = wrapCaptionLines(ctx, caption, maxTextWidth);
    if (lines.length === 0) return;

    const widest = Math.max(...lines.map((l) => ctx.measureText(l).width));
    const boxWidth = widest + PAD_X * 2;
    const boxHeight = lines.length * lineHeight + PAD_Y * 2;
    const boxX = (width - boxWidth) / 2;
    const boxY = height - boxHeight - Math.round(height * 0.05);

    ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
    ctx.fillRect(boxX, boxY, boxWidth, boxHeight);

    ctx.fillStyle = '#ffffff';
    lines.forEach((line, i) => {
      ctx.fillText(line, width / 2, boxY + PAD_Y + lineHeight * i + lineHeight / 2);
    });
  }, []);

  /** rAF loop: draw the camera frame (cover-fit) + caption onto the canvas. */
  const drawFrame = useCallback(() => {
    const canvas = canvasRef.current;
    const video = videoRef.current;
    if (!canvas || !video) return;

    const ctx = canvas.getContext('2d');
    const { width, height } = canvas;

    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, width, height);

    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (vw && vh) {
      // Cover-fit: fill the 1280x720 frame, cropping overflow.
      const scale = Math.max(width / vw, height / vh);
      const dw = vw * scale;
      const dh = vh * scale;
      ctx.drawImage(video, (width - dw) / 2, (height - dh) / 2, dw, dh);
    }

    // Captions only render while the teleprompter is playing.
    if (isPlayingRef.current) {
      const caption = getCurrentCaption();
      if (caption) drawCaption(ctx, caption, width, height);
    }

    rafRef.current = requestAnimationFrame(drawFrame);
  }, [drawCaption, getCurrentCaption]);

  /* ============================================================
   * Start / stop recording
   * ============================================================ */
  const startRecording = useCallback(() => {
    if (!recorderSupported || !streamRef.current || isRecording) return;

    chunksRef.current = [];
    setRecordedBlob(null);
    setRecordingTime(0);

    let streamToRecord;
    if (showCaptions) {
      // Captions ON: composite camera + caption overlay on a canvas,
      // record the canvas stream, and re-attach the mic audio track.
      const canvas = canvasRef.current;
      canvas.width = RECORD_WIDTH;
      canvas.height = RECORD_HEIGHT;
      drawFrame();

      const canvasStream = canvas.captureStream(30);
      streamRef.current.getAudioTracks().forEach((t) => canvasStream.addTrack(t));
      streamToRecord = canvasStream;
    } else {
      // Captions OFF: record the raw camera stream — no overlay.
      streamToRecord = streamRef.current;
    }

    const mimeType = pickMimeType();
    mimeTypeRef.current = mimeType;

    let recorder;
    try {
      recorder = new MediaRecorder(streamToRecord, {
        mimeType,
        videoBitsPerSecond: 5_000_000,
      });
    } catch (err) {
      setCameraError(`Recording could not start: ${err.message}`);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      return;
    }

    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
    };
    recorder.onstop = () => {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      const blob = new Blob(chunksRef.current, {
        type: mimeTypeRef.current || 'video/webm',
      });
      setRecordedBlob(blob);
    };

    mediaRecorderRef.current = recorder;
    recorder.start(1000); // gather data every second
    setIsRecording(true);

    // Auto-start the teleprompter so the user can read naturally the
    // moment recording begins — no manual scrolling required. The ref is
    // set synchronously so captions render from the very first frame.
    isPlayingRef.current = true;
    setIsPlaying(true);
  }, [recorderSupported, isRecording, showCaptions, drawFrame]);

  const stopRecording = useCallback(() => {
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== 'inactive') {
      recorder.stop();
    }
    setIsRecording(false);

    // Stop the teleprompter along with the recording.
    isPlayingRef.current = false;
    setIsPlaying(false);
  }, []);

  // Safety net: stop everything if the component unmounts mid-recording.
  useEffect(() => {
    return () => {
      const recorder = mediaRecorderRef.current;
      if (recorder && recorder.state !== 'inactive') recorder.stop();
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  /* ============================================================
   * Download
   * ============================================================ */
  const handleDownload = useCallback(() => {
    if (!recordedBlob) return;
    const ext = (mimeTypeRef.current || '').includes('mp4') ? 'mp4' : 'webm';
    const url = URL.createObjectURL(recordedBlob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `speakscroll-recording.${ext}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, [recordedBlob]);

  /* ============================================================
   * Render
   * ============================================================ */
  return (
    <div className="teleprompter-container">
      {/* Header */}
      <header className="header">
        <img src="/hero-banner.png" alt="SpeakScroll Hero" className="hero-banner" />
      </header>

      {/* Controls */}
      <div className="controls">
        <div className="control-group">
          <label>Speed:</label>
          <input
            type="range"
            min="0.5"
            max="3"
            step="0.1"
            value={scrollSpeed}
            onChange={(e) => setScrollSpeed(parseFloat(e.target.value))}
          />
          <span>{scrollSpeed.toFixed(1)}x</span>
        </div>

        <div className="control-group">
          <label>Font Size:</label>
          <input
            type="range"
            min="12"
            max="48"
            step="1"
            value={fontSize}
            onChange={(e) => setFontSize(parseFloat(e.target.value))}
          />
          <span>{fontSize}px</span>
        </div>

        <div className="control-group">
          <label>
            <input
              type="checkbox"
              checked={mirrorMode}
              onChange={(e) => setMirrorMode(e.target.checked)}
            />
            Mirror Mode
          </label>
        </div>

        {/* Show Camera Preview toggle — hiding it only affects what the
            USER sees; the camera keeps recording in the background */}
        <div className="control-group caption-toggle">
          <label>Camera Preview:</label>
          <label className="caption-radio">
            <input
              type="radio"
              name="show-preview"
              checked={showPreview}
              onChange={() => setShowPreview(true)}
            />
            Yes
          </label>
          <label className="caption-radio">
            <input
              type="radio"
              name="show-preview"
              checked={!showPreview}
              onChange={() => setShowPreview(false)}
            />
            No
          </label>
        </div>

        {/* Embed Captions toggle — locked while recording */}
        <div className="control-group caption-toggle">
          <label>Embed Captions:</label>
          <label className="caption-radio">
            <input
              type="radio"
              name="embed-captions"
              checked={showCaptions}
              disabled={isRecording}
              onChange={() => setShowCaptions(true)}
            />
            Yes
          </label>
          <label className="caption-radio">
            <input
              type="radio"
              name="embed-captions"
              checked={!showCaptions}
              disabled={isRecording}
              onChange={() => setShowCaptions(false)}
            />
            No
          </label>
        </div>

        <button
          className={`play-pause-btn ${isPlaying ? 'playing' : ''}`}
          onClick={() => setIsPlaying(!isPlaying)}
        >
          {isPlaying ? '⏸ Pause' : '▶ Play'}
        </button>

        <button className="reset-btn" onClick={handleReset}>
          ↺ Reset
        </button>
      </div>

      {/* Script Input */}
      <textarea
        className="script-input"
        placeholder="Paste or type your script here..."
        value={scriptText}
        onChange={(e) => setScriptText(e.target.value)}
      />

      {/* Split screen: camera (left) + teleprompter (right).
          Preview OFF collapses the camera panel so the script takes the
          full width — the <video> element stays mounted (just 0 wide) so
          the canvas compositor keeps receiving frames and the recording
          continues untouched. A camera error forces the panel visible so
          the message and Retry button are never hidden. */}
      <div
        className={`split-screen ${
          showPreview || cameraError ? '' : 'no-preview'
        }`}
      >
        <div className="camera-panel">
          <video
            ref={videoRef}
            className="camera-video"
            autoPlay
            playsInline
            muted /* mute preview to avoid feedback; mic still records */
          />
          {cameraError && (
            <div className="camera-error">
              <p>{cameraError}</p>
              <button
                className="retry-camera-btn"
                onClick={() => setCameraAttempt((n) => n + 1)}
              >
                Retry Camera
              </button>
            </div>
          )}
        </div>

        {/* REC badge sits on the split screen so it stays visible even
            when the camera preview is hidden */}
        {isRecording && (
          <div className="rec-badge">
            <span className="rec-dot" /> REC
          </div>
        )}

        <div
          ref={displayRef}
          className={`script-display ${mirrorMode ? 'mirror' : ''}`}
          style={{ fontSize: `${fontSize}px` }}
        >
          {scriptText}
        </div>
      </div>

      {/* Hidden canvas used to composite captions into the recording */}
      <canvas ref={canvasRef} className="compositing-canvas" aria-hidden="true" />

      {/* Recording controls */}
      <div className="recording-controls">
        {!recorderSupported && (
          <span className="recording-unsupported">
            Video recording is not supported in this browser. Try the latest
            Chrome, Edge, Firefox, or Safari.
          </span>
        )}

        <button
          className="record-btn start"
          onClick={startRecording}
          disabled={!recorderSupported || !cameraReady || isRecording}
        >
          ⏺ Start Recording
        </button>

        <button
          className="record-btn stop"
          onClick={stopRecording}
          disabled={!isRecording}
        >
          ⏹ Stop Recording
        </button>

        <span className={`recording-timer ${isRecording ? 'active' : ''}`}>
          {formatTime(recordingTime)}
        </span>

        {recordedBlob && !isRecording && (
          <button className="record-btn download" onClick={handleDownload}>
            ⬇ Download Video
          </button>
        )}
      </div>
    </div>
  );
}
