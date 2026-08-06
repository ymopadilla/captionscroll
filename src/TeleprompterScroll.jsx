import { useState, useEffect, useRef, useCallback } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useAuth } from './hooks/useAuth';
import { useSubscription } from './hooks/useSubscription';
import { startCheckout } from './components/StripeCheckout';
import SubscriptionGate from './components/SubscriptionGate';
import { supabase } from './lib/supabaseClient';
import { TIER_LABELS } from './lib/tiers';
import { GreenScreenProcessor } from './lib/greenScreen';
import { SOCIAL_PRESETS, downloadBlob, reencodeTake } from './lib/socialExport';
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

// Solid-color green screen options (Starter+).
const GS_COLORS = [
  { label: 'White', value: '#ffffff' },
  { label: 'Blue', value: '#1e5aa8' },
  { label: 'Green', value: '#0b8a43' },
  { label: 'Black', value: '#000000' },
  { label: 'Gray', value: '#6c757d' },
];

// Camera PIP sizing rules.
const PIP_DEFAULT = { w: 120, h: 150 };
const PIP_MIN = { w: 80, h: 100 };
const PIP_MAX = { w: 300, h: 400 };

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

/** Lowercase words with punctuation stripped, for speech matching. */
function toWords(text) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Find the caption segment that best matches the most recently spoken
 * words, searching a small window around the current segment so captions
 * advance with the speaker instead of the scroll position.
 */
function matchSpokenSegment(recentWords, segments, currentIndex) {
  if (!recentWords.length || !segments.length) return null;
  const spoken = new Set(recentWords);
  let best = null;
  let bestScore = 0;
  const from = Math.max(0, currentIndex - 1);
  const to = Math.min(segments.length - 1, currentIndex + 3);
  for (let i = from; i <= to; i++) {
    const segWords = toWords(segments[i].text);
    let score = 0;
    for (const w of segWords) if (spoken.has(w)) score++;
    // Small forward bias so ties move the captions ahead.
    if (i > currentIndex) score += 0.5;
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return bestScore >= 2 ? best : null;
}

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

export default function TeleprompterScroll() {
  /* ---------- account + subscription ---------- */
  const { user, signOut } = useAuth();
  const { tier, refresh: refreshTier } = useSubscription();
  const canRecord = tier === 'starter' || tier === 'pro';
  const isPro = tier === 'pro';
  const isProRef = useRef(isPro);
  useEffect(() => {
    isProRef.current = isPro;
  }, [isPro]);

  /* ---------- existing teleprompter state ---------- */
  const [scriptText, setScriptText] = useState('');
  const [isPlaying, setIsPlaying] = useState(false);
  const [scrollSpeed, setScrollSpeed] = useState(1);
  const [fontSize, setFontSize] = useState(24);
  const [mirrorMode, setMirrorMode] = useState(false);
  const displayRef = useRef(null);

  /* ---------- recording state ---------- */
  const [showCaptions, setShowCaptions] = useState(false); // "Embed Captions" — default NO
  const [showPreview, setShowPreview] = useState(true); // "Show Camera" — default YES
  const [isRecording, setIsRecording] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const [cameraReady, setCameraReady] = useState(false);
  const [cameraError, setCameraError] = useState('');
  const [cameraAttempt, setCameraAttempt] = useState(0); // bump to retry getUserMedia

  const recorderSupported =
    typeof MediaRecorder !== 'undefined' && pickMimeType() !== '';

  /* ---------- refs for recording plumbing ---------- */
  const videoRef = useRef(null); // live <video> preview (inside the PIP)
  const canvasRef = useRef(null); // hidden compositing canvas
  const streamRef = useRef(null); // camera + mic MediaStream
  const mediaRecorderRef = useRef(null);
  const chunksRef = useRef([]);
  const rafRef = useRef(null); // requestAnimationFrame id for the draw loop
  const mimeTypeRef = useRef('');
  const recordingTimeRef = useRef(0);

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

  useEffect(() => {
    recordingTimeRef.current = recordingTime;
  }, [recordingTime]);

  /* ---------- green screen state (Starter: blur/color, Pro: image) ---------- */
  const [gsMode, setGsMode] = useState('off'); // 'off' | 'blur' | 'color' | 'image'
  const [gsColor, setGsColor] = useState('#ffffff');
  const [gsStatus, setGsStatus] = useState(''); // '' | 'loading' | 'ready' | 'error'
  const [gsImageName, setGsImageName] = useState('');
  const gsRef = useRef(null); // GreenScreenProcessor

  /* ---------- video filters (Pro) ---------- */
  const [brightness, setBrightness] = useState(100);
  const [contrast, setContrast] = useState(100);
  const [saturation, setSaturation] = useState(100);
  const filtersActive =
    isPro && (brightness !== 100 || contrast !== 100 || saturation !== 100);
  const filterStringRef = useRef('none');
  useEffect(() => {
    filterStringRef.current = filtersActive
      ? `brightness(${brightness}%) contrast(${contrast}%) saturate(${saturation}%)`
      : 'none';
  }, [filtersActive, brightness, contrast, saturation]);

  /* ---------- speech-to-text caption sync (Pro) ---------- */
  const sttSupported =
    typeof window !== 'undefined' &&
    Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);
  const [sttEnabled, setSttEnabled] = useState(false);
  const sttActiveRef = useRef(false);
  const sttIndexRef = useRef(0);

  /* ---------- takes (Pro keeps multiple; others keep the latest) ---------- */
  const [takes, setTakes] = useState([]);
  const takesRef = useRef(takes);
  useEffect(() => {
    takesRef.current = takes;
  }, [takes]);
  const [selectedTakeId, setSelectedTakeId] = useState(null);
  const [previewTakeId, setPreviewTakeId] = useState(null);
  const [exporting, setExporting] = useState('');
  const [exportError, setExportError] = useState('');
  const selectedTake =
    takes.find((t) => t.id === selectedTakeId) || takes[takes.length - 1] || null;

  /* ---------- saved scripts ---------- */
  const [savedScripts, setSavedScripts] = useState([]);
  const [selectedScriptId, setSelectedScriptId] = useState('');
  const [scriptStatus, setScriptStatus] = useState('');

  /* ---------- checkout confirmation / plan intent ---------- */
  const [searchParams, setSearchParams] = useSearchParams();
  const [banner, setBanner] = useState('');
  const checkoutHandledRef = useRef(false);

  useEffect(() => {
    if (checkoutHandledRef.current) return;

    const sessionId = searchParams.get('session_id');
    const plan = searchParams.get('plan');
    const cycle = searchParams.get('cycle');

    if (searchParams.get('checkout') === 'success' && sessionId) {
      // Back from Stripe — verify server-side, then refresh the tier.
      checkoutHandledRef.current = true;
      setBanner('Confirming your subscription…');
      fetch('/api/verify-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      })
        .then(async (res) => {
          const data = await res.json().catch(() => ({}));
          if (res.ok && data.tier) {
            await refreshTier();
            setBanner(
              `🎉 You're on the ${TIER_LABELS[data.tier]} plan${
                data.status === 'trialing' ? ' — 14-day free trial started' : ''
              }!`
            );
          } else {
            setBanner(data.error || 'Could not confirm the payment.');
          }
        })
        .catch(() => setBanner('Could not confirm the payment.'))
        .finally(() => {
          setSearchParams({}, { replace: true });
          setTimeout(() => setBanner(''), 8000);
        });
    } else if (plan && cycle && user) {
      // Fresh signup that started from a pricing button — go straight
      // to checkout for the chosen plan.
      checkoutHandledRef.current = true;
      setBanner('Taking you to checkout…');
      startCheckout({ tier: plan, cycle, user }).catch((err) => {
        setBanner(err.message);
        setSearchParams({}, { replace: true });
        setTimeout(() => setBanner(''), 8000);
      });
    }
  }, [searchParams, setSearchParams, user, refreshTier]);

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
   * Green screen processor lifecycle
   * ============================================================ */
  useEffect(() => {
    if (gsMode === 'off' || !cameraReady) {
      if (gsRef.current) gsRef.current.stop();
      setGsStatus('');
      return undefined;
    }

    let cancelled = false;
    if (!gsRef.current) {
      gsRef.current = new GreenScreenProcessor(RECORD_WIDTH, RECORD_HEIGHT);
    }
    const gs = gsRef.current;
    gs.setMode(gsMode);
    gs.setColor(gsColor);
    gs.smoothEdges = isProRef.current; // Pro gets softer edge blending

    setGsStatus('loading');
    gs.start(videoRef.current)
      .then(() => {
        if (!cancelled) setGsStatus('ready');
      })
      .catch((err) => {
        if (cancelled) return;
        setGsStatus('error');
        setBanner(
          err.message ||
            'Background effects could not load — recording continues without them.'
        );
        setTimeout(() => setBanner(''), 8000);
        setGsMode('off');
      });

    return () => {
      cancelled = true;
    };
  }, [gsMode, gsColor, cameraReady]);

  // Stop segmentation entirely on unmount.
  useEffect(() => {
    return () => {
      if (gsRef.current) gsRef.current.stop();
    };
  }, []);

  const handleGsImageUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        if (!gsRef.current) {
          gsRef.current = new GreenScreenProcessor(RECORD_WIDTH, RECORD_HEIGHT);
        }
        await gsRef.current.setBackgroundImage(reader.result);
        setGsImageName(file.name);
        setGsMode('image');
      } catch (err) {
        setBanner(err.message);
        setTimeout(() => setBanner(''), 5000);
      }
    };
    reader.readAsDataURL(file);
    e.target.value = ''; // allow re-selecting the same file
  };

  /* ============================================================
   * Speech-to-text caption sync (Pro) — runs only while recording
   * ============================================================ */
  useEffect(() => {
    if (!isRecording || !sttEnabled || !sttSupported || !isPro) {
      sttActiveRef.current = false;
      return undefined;
    }

    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const recognition = new SR();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = navigator.language || 'en-US';

    let stopped = false;

    recognition.onresult = (e) => {
      let text = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        text += ` ${e.results[i][0].transcript}`;
      }
      const recentWords = toWords(text).slice(-10);
      const idx = matchSpokenSegment(
        recentWords,
        captionDataRef.current.segments,
        sttIndexRef.current
      );
      if (idx != null) sttIndexRef.current = idx;
    };
    // Chrome ends recognition periodically; restart while recording.
    recognition.onend = () => {
      if (!stopped) {
        try {
          recognition.start();
        } catch {
          /* already restarting */
        }
      }
    };
    recognition.onerror = () => {
      /* non-fatal — captions fall back to scroll sync */
    };

    sttIndexRef.current = 0;
    sttActiveRef.current = true;
    try {
      recognition.start();
    } catch {
      sttActiveRef.current = false;
    }

    return () => {
      stopped = true;
      sttActiveRef.current = false;
      try {
        recognition.stop();
      } catch {
        /* ignore */
      }
    };
  }, [isRecording, sttEnabled, sttSupported, isPro]);

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

  /** Current caption: spoken position (Pro STT) or scroll progress. */
  const getCurrentCaption = useCallback(() => {
    const { segments, totalChars } = captionDataRef.current;
    if (segments.length === 0) return '';

    // Pro speech sync: captions follow the words actually spoken.
    if (sttActiveRef.current) {
      const idx = clamp(sttIndexRef.current, 0, segments.length - 1);
      return segments[idx].text;
    }

    const el = displayRef.current;
    if (!el) return '';
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

  /**
   * rAF loop: draw the current frame (green-screen output when active,
   * otherwise the raw camera), apply Pro filters, then the caption.
   */
  const drawFrame = useCallback(() => {
    const canvas = canvasRef.current;
    const video = videoRef.current;
    if (!canvas || !video) return;

    const ctx = canvas.getContext('2d');
    const { width, height } = canvas;

    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, width, height);

    // Prefer the green-screen composited frame when it's flowing.
    const gs = gsRef.current;
    const useGs = gs && gs.running && gs.hasFrame;
    const source = useGs ? gs.canvas : video;
    const sw = useGs ? gs.canvas.width : video.videoWidth;
    const sh = useGs ? gs.canvas.height : video.videoHeight;

    if (sw && sh) {
      // Cover-fit: fill the 1280x720 frame, cropping overflow.
      const scale = Math.max(width / sw, height / sh);
      const dw = sw * scale;
      const dh = sh * scale;
      ctx.filter = filterStringRef.current; // 'none' unless Pro filters set
      ctx.drawImage(source, (width - dw) / 2, (height - dh) / 2, dw, dh);
      ctx.filter = 'none';
    }

    // Captions only render while the teleprompter is playing.
    if (isPlayingRef.current) {
      const caption = getCurrentCaption();
      if (caption) drawCaption(ctx, caption, width, height);
    }

    rafRef.current = requestAnimationFrame(drawFrame);
  }, [drawCaption, getCurrentCaption]);

  /* ============================================================
   * Takes management
   * ============================================================ */
  const addTake = useCallback((blob, mime, duration) => {
    const take = {
      id: `take-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
      blob,
      mime,
      duration,
      url: URL.createObjectURL(blob),
    };
    const prev = takesRef.current;
    let next;
    if (isProRef.current) {
      next = [...prev, take]; // Pro: keep every take for comparison
    } else {
      prev.forEach((t) => URL.revokeObjectURL(t.url));
      next = [take]; // Free/Starter: latest take only
    }
    setTakes(next);
    setSelectedTakeId(take.id);
    setPreviewTakeId(null);
  }, []);

  const deleteTake = useCallback((id) => {
    const take = takesRef.current.find((t) => t.id === id);
    if (take) URL.revokeObjectURL(take.url);
    setTakes(takesRef.current.filter((t) => t.id !== id));
    setSelectedTakeId((cur) => (cur === id ? null : cur));
    setPreviewTakeId((cur) => (cur === id ? null : cur));
  }, []);

  // Release all object URLs on unmount.
  useEffect(() => {
    return () => {
      takesRef.current.forEach((t) => URL.revokeObjectURL(t.url));
    };
  }, []);

  /* ============================================================
   * Start / stop recording
   * ============================================================ */
  const startRecording = useCallback(() => {
    if (!recorderSupported || !streamRef.current || isRecording) return;

    chunksRef.current = [];
    setRecordingTime(0);
    recordingTimeRef.current = 0;

    // The canvas pipeline runs whenever any overlay/effect is active.
    const needsCanvas = showCaptions || gsMode !== 'off' || filtersActive;

    let streamToRecord;
    if (needsCanvas) {
      // Composite camera (or green-screen output) + effects + captions
      // on a canvas, record the canvas stream, and re-attach mic audio.
      const canvas = canvasRef.current;
      canvas.width = RECORD_WIDTH;
      canvas.height = RECORD_HEIGHT;
      drawFrame();

      const canvasStream = canvas.captureStream(30);
      streamRef.current.getAudioTracks().forEach((t) => canvasStream.addTrack(t));
      streamToRecord = canvasStream;
    } else {
      // No overlays: record the raw camera stream.
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
      addTake(blob, mimeTypeRef.current || 'video/webm', recordingTimeRef.current);
    };

    mediaRecorderRef.current = recorder;
    recorder.start(1000); // gather data every second
    setIsRecording(true);

    // Auto-start the teleprompter so the user can read naturally the
    // moment recording begins — no manual scrolling required. The ref is
    // set synchronously so captions render from the very first frame.
    isPlayingRef.current = true;
    setIsPlaying(true);
  }, [
    recorderSupported,
    isRecording,
    showCaptions,
    gsMode,
    filtersActive,
    drawFrame,
    addTake,
  ]);

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
   * Download + exports
   * ============================================================ */
  const handleDownload = useCallback(() => {
    if (!selectedTake) return;
    const ext = selectedTake.mime.includes('mp4') ? 'mp4' : 'webm';
    downloadBlob(selectedTake.blob, `captionscroll-recording.${ext}`);
  }, [selectedTake]);

  const handleSocialExport = useCallback(
    async (key) => {
      if (!selectedTake || exporting) return;
      const preset = SOCIAL_PRESETS[key];
      setExportError('');
      if (preset.aspect === '16:9') {
        // Native aspect — download directly with a platform-ready name.
        const ext = selectedTake.mime.includes('mp4') ? 'mp4' : 'webm';
        downloadBlob(selectedTake.blob, `captionscroll-${key}.${ext}`);
        return;
      }
      // Vertical platforms: re-encode with a 9:16 center crop.
      setExporting(preset.label);
      try {
        const { blob, ext } = await reencodeTake(selectedTake.blob, preset);
        downloadBlob(blob, `captionscroll-${key}.${ext}`);
      } catch (err) {
        setExportError(err.message || 'Export failed.');
        setTimeout(() => setExportError(''), 6000);
      } finally {
        setExporting('');
      }
    },
    [selectedTake, exporting]
  );

  const handleTranscriptExport = useCallback(() => {
    if (!scriptText.trim()) return;
    downloadBlob(
      new Blob([scriptText], { type: 'text/plain' }),
      'captionscroll-transcript.txt'
    );
  }, [scriptText]);

  /* ============================================================
   * Saved scripts (Supabase user_scripts)
   * ============================================================ */
  const loadScriptList = useCallback(async () => {
    if (!user) return;
    const { data } = await supabase
      .from('user_scripts')
      .select('id, title')
      .order('updated_at', { ascending: false });
    setSavedScripts(data ?? []);
  }, [user]);

  useEffect(() => {
    loadScriptList();
  }, [loadScriptList]);

  const flashScriptStatus = (msg) => {
    setScriptStatus(msg);
    setTimeout(() => setScriptStatus(''), 3000);
  };

  const handleSaveScript = async () => {
    if (!user || !scriptText.trim()) return;
    const firstLine = scriptText.trim().split('\n')[0].slice(0, 60);
    const title = firstLine || 'Untitled script';
    if (selectedScriptId) {
      const { error } = await supabase
        .from('user_scripts')
        .update({ title, content: scriptText })
        .eq('id', selectedScriptId);
      flashScriptStatus(error ? 'Save failed' : 'Saved ✓');
    } else {
      const { data, error } = await supabase
        .from('user_scripts')
        .insert({ user_id: user.id, title, content: scriptText })
        .select('id')
        .single();
      if (!error && data) setSelectedScriptId(data.id);
      flashScriptStatus(error ? 'Save failed' : 'Saved ✓');
    }
    loadScriptList();
  };

  const handleSelectScript = async (id) => {
    setSelectedScriptId(id);
    if (!id) return;
    const { data } = await supabase
      .from('user_scripts')
      .select('content')
      .eq('id', id)
      .maybeSingle();
    if (data) setScriptText(data.content);
  };

  const handleDeleteScript = async () => {
    if (!selectedScriptId) return;
    await supabase.from('user_scripts').delete().eq('id', selectedScriptId);
    setSelectedScriptId('');
    flashScriptStatus('Deleted');
    loadScriptList();
  };

  /* ============================================================
   * Camera PIP drag + resize
   * ============================================================ */
  const stageRef = useRef(null);
  const pipRef = useRef(null);
  // x === null means "docked to the default top-right corner".
  const [pip, setPip] = useState({ x: null, y: 16, ...PIP_DEFAULT });
  const dragStateRef = useRef(null);

  const beginPipGesture = (e, mode) => {
    if (!stageRef.current || !pipRef.current) return;
    e.preventDefault();
    const stageBox = stageRef.current.getBoundingClientRect();
    const pipBox = pipRef.current.getBoundingClientRect();
    dragStateRef.current = {
      mode, // 'move' | 'resize'
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      origX: pipBox.left - stageBox.left,
      origY: pipBox.top - stageBox.top,
      origW: pipBox.width,
      origH: pipBox.height,
      stageW: stageBox.width,
      stageH: stageBox.height,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPipPointerMove = (e) => {
    const s = dragStateRef.current;
    if (!s) return;
    const dx = e.clientX - s.startX;
    const dy = e.clientY - s.startY;
    if (s.mode === 'move') {
      setPip((p) => ({
        ...p,
        x: clamp(s.origX + dx, 0, Math.max(0, s.stageW - p.w)),
        y: clamp(s.origY + dy, 0, Math.max(0, s.stageH - p.h)),
      }));
    } else {
      const w = clamp(
        s.origW + dx,
        PIP_MIN.w,
        Math.min(PIP_MAX.w, s.stageW - s.origX)
      );
      const h = clamp(
        s.origH + dy,
        PIP_MIN.h,
        Math.min(PIP_MAX.h, s.stageH - s.origY)
      );
      setPip({ x: s.origX, y: s.origY, w, h });
    }
  };

  const endPipGesture = () => {
    dragStateRef.current = null;
  };

  // Keep the PIP inside the stage if the window shrinks.
  useEffect(() => {
    const onResize = () => {
      const stage = stageRef.current;
      if (!stage) return;
      const box = stage.getBoundingClientRect();
      setPip((p) => {
        if (p.x === null) return p; // corner-docked; CSS handles it
        return {
          ...p,
          x: clamp(p.x, 0, Math.max(0, box.width - p.w)),
          y: clamp(p.y, 0, Math.max(0, box.height - p.h)),
        };
      });
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // A camera error forces the PIP visible so Retry is always reachable.
  const pipVisible = showPreview || Boolean(cameraError);
  const pipStyle = {
    width: `${pip.w}px`,
    height: `${pip.h}px`,
    ...(pip.x === null
      ? { top: `${pip.y}px`, right: '16px' }
      : { top: `${pip.y}px`, left: `${pip.x}px` }),
  };

  /* ============================================================
   * Render
   * ============================================================ */
  const effectsActive = gsMode !== 'off' || filtersActive || showCaptions;

  return (
    <div className="teleprompter-container">
      {/* Header */}
      <header className="header app-header">
        <img src="/captionscroll-wordmark.jpg" alt="CaptionScroll logo" className="hero-banner" />
        <div className="app-header-right">
          <span className={`tier-badge tier-${tier}`}>{TIER_LABELS[tier]}</span>
          {tier !== 'pro' && (
            <Link to="/pricing" className="upgrade-link">
              ⬆ Upgrade
            </Link>
          )}
          <span className="user-email" title={user?.email}>
            {user?.email}
          </span>
          <button className="signout-btn" onClick={() => signOut()}>
            Sign Out
          </button>
        </div>
      </header>

      {banner && <div className="app-banner">{banner}</div>}

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

        {/* Show Camera toggle — hiding it only affects what the USER
            sees; the camera keeps feeding the recorder in the background */}
        <div className="control-group">
          <label>
            <input
              type="checkbox"
              checked={showPreview}
              onChange={(e) => setShowPreview(e.target.checked)}
            />
            Show Camera
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
              disabled={isRecording || !canRecord}
              onChange={() => setShowCaptions(true)}
            />
            Yes
          </label>
          <label className="caption-radio">
            <input
              type="radio"
              name="embed-captions"
              checked={!showCaptions}
              disabled={isRecording || !canRecord}
              onChange={() => setShowCaptions(false)}
            />
            No
          </label>
        </div>

        {/* Green screen — Starter: blur + solid colors; Pro: custom image */}
        <SubscriptionGate
          tier={tier}
          requires="starter"
          mode="hide"
          message="Green screen — upgrade to Starter"
        >
          <div className="control-group">
            <label>Green Screen:</label>
            <select
              value={gsMode}
              disabled={isRecording}
              onChange={(e) => setGsMode(e.target.value)}
            >
              <option value="off">Off</option>
              <option value="blur">Blur</option>
              <option value="color">Solid Color</option>
              {isPro && <option value="image">Custom Image (Pro)</option>}
            </select>
            {gsMode === 'color' && (
              <select
                value={gsColor}
                disabled={isRecording}
                onChange={(e) => setGsColor(e.target.value)}
              >
                {GS_COLORS.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
            )}
            {isPro && gsMode === 'image' && (
              <label className="gs-upload">
                <input
                  type="file"
                  accept="image/png,image/jpeg"
                  onChange={handleGsImageUpload}
                />
                {gsImageName ? `🖼 ${gsImageName}` : 'Upload background…'}
              </label>
            )}
            {gsStatus === 'loading' && <span className="gs-status">loading…</span>}
            {gsStatus === 'ready' && <span className="gs-status ready">on</span>}
          </div>
        </SubscriptionGate>

        {/* Pro tools: filters + speech sync */}
        <SubscriptionGate
          tier={tier}
          requires="pro"
          mode="hide"
          message="Filters & speech sync — upgrade to Pro"
        >
          <div className="control-group pro-filters">
            <label>Filters:</label>
            <span className="filter-item">
              ☀
              <input
                type="range"
                min="50"
                max="150"
                value={brightness}
                onChange={(e) => setBrightness(Number(e.target.value))}
                title={`Brightness ${brightness}%`}
              />
            </span>
            <span className="filter-item">
              ◐
              <input
                type="range"
                min="50"
                max="150"
                value={contrast}
                onChange={(e) => setContrast(Number(e.target.value))}
                title={`Contrast ${contrast}%`}
              />
            </span>
            <span className="filter-item">
              🎨
              <input
                type="range"
                min="0"
                max="200"
                value={saturation}
                onChange={(e) => setSaturation(Number(e.target.value))}
                title={`Saturation ${saturation}%`}
              />
            </span>
          </div>
          <div className="control-group">
            <label title={sttSupported ? '' : 'Not supported in this browser'}>
              <input
                type="checkbox"
                checked={sttEnabled && sttSupported}
                disabled={!sttSupported || isRecording}
                onChange={(e) => setSttEnabled(e.target.checked)}
              />
              Speech Caption Sync
            </label>
          </div>
        </SubscriptionGate>

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

      {/* Saved scripts row */}
      <div className="script-bar">
        <select
          value={selectedScriptId}
          onChange={(e) => handleSelectScript(e.target.value)}
        >
          <option value="">— New script —</option>
          {savedScripts.map((s) => (
            <option key={s.id} value={s.id}>
              {s.title}
            </option>
          ))}
        </select>
        <button onClick={handleSaveScript} disabled={!scriptText.trim()}>
          💾 Save
        </button>
        {selectedScriptId && (
          <button className="script-delete" onClick={handleDeleteScript}>
            🗑 Delete
          </button>
        )}
        {scriptStatus && <span className="script-status">{scriptStatus}</span>}
      </div>

      {/* Script Input */}
      <textarea
        className="script-input"
        placeholder="Paste or type your script here..."
        value={scriptText}
        onChange={(e) => setScriptText(e.target.value)}
      />

      {/* Stage: full-width teleprompter + floating camera PIP.
          The <video> element stays mounted even when the PIP is hidden
          so the canvas compositor keeps receiving frames and recording
          continues untouched. A camera error forces the PIP visible so
          the message and Retry button are never hidden. */}
      <div className="stage" ref={stageRef}>
        <div
          ref={displayRef}
          className={`script-display ${mirrorMode ? 'mirror' : ''}`}
          style={{ fontSize: `${fontSize}px` }}
        >
          {scriptText}
        </div>

        {/* REC badge sits on the stage so it stays visible even when
            the camera PIP is hidden */}
        {isRecording && (
          <div className="rec-badge">
            <span className="rec-dot" /> REC
          </div>
        )}

        {/* Camera PIP — draggable + resizable */}
        <div
          ref={pipRef}
          className={`camera-pip ${pipVisible ? '' : 'pip-hidden'} ${
            cameraError ? 'pip-error' : ''
          }`}
          style={pipStyle}
          onPointerDown={(e) => beginPipGesture(e, 'move')}
          onPointerMove={onPipPointerMove}
          onPointerUp={endPipGesture}
          onPointerCancel={endPipGesture}
        >
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
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => setCameraAttempt((n) => n + 1)}
              >
                Retry Camera
              </button>
            </div>
          )}
          {!cameraError && effectsActive && (
            <span className="pip-note">effects apply to recording</span>
          )}
          <span
            className="pip-resize-handle"
            onPointerDown={(e) => {
              e.stopPropagation();
              beginPipGesture(e, 'resize');
            }}
            onPointerMove={onPipPointerMove}
            onPointerUp={endPipGesture}
            onPointerCancel={endPipGesture}
            aria-hidden="true"
          />
        </div>
      </div>

      {/* Hidden canvas used to composite effects + captions into the recording */}
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
          disabled={
            !canRecord || !recorderSupported || !cameraReady || isRecording
          }
        >
          ⏺ Start Recording
        </button>

        {!canRecord && (
          <Link to="/pricing" className="record-locked">
            🔒 Upgrade to Starter to start recording
          </Link>
        )}

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

        {selectedTake && !isRecording && (
          <button className="record-btn download" onClick={handleDownload}>
            ⬇ Download Video
          </button>
        )}

        {/* Pro: transcript + social exports */}
        {isPro && !isRecording && (
          <>
            {selectedTake && (
              <span className="social-export">
                {Object.entries(SOCIAL_PRESETS).map(([key, preset]) => (
                  <button
                    key={key}
                    className="social-btn"
                    disabled={Boolean(exporting)}
                    onClick={() => handleSocialExport(key)}
                    title={`Export for ${preset.label} (${preset.aspect})`}
                  >
                    {exporting === preset.label ? '⏳' : '↗'} {preset.label}
                  </button>
                ))}
              </span>
            )}
            {scriptText.trim() && (
              <button className="social-btn" onClick={handleTranscriptExport}>
                📄 Transcript
              </button>
            )}
          </>
        )}
        {exportError && <span className="export-error">{exportError}</span>}
      </div>

      {/* Pro: multiple takes manager */}
      {isPro && takes.length > 0 && !isRecording && (
        <div className="takes-bar">
          <span className="takes-title">Takes:</span>
          {takes.map((t, i) => (
            <span
              key={t.id}
              className={`take-chip ${t.id === selectedTake?.id ? 'selected' : ''}`}
            >
              <label>
                <input
                  type="radio"
                  name="selected-take"
                  checked={t.id === selectedTake?.id}
                  onChange={() => setSelectedTakeId(t.id)}
                />
                Take {i + 1} · {formatTime(t.duration)}
              </label>
              <button
                className="take-preview"
                onClick={() =>
                  setPreviewTakeId((cur) => (cur === t.id ? null : t.id))
                }
              >
                {previewTakeId === t.id ? 'Hide' : 'Preview'}
              </button>
              <button className="take-delete" onClick={() => deleteTake(t.id)}>
                ✕
              </button>
            </span>
          ))}
          {previewTakeId && (
            <video
              className="take-preview-video"
              src={takes.find((t) => t.id === previewTakeId)?.url}
              controls
              autoPlay
            />
          )}
        </div>
      )}
    </div>
  );
}
