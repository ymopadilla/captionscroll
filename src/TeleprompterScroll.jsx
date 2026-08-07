import { useState, useEffect, useRef, useCallback } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useAuth } from './hooks/useAuth';
import { useSubscription } from './hooks/useSubscription';
import { startCheckout } from './components/StripeCheckout';
import SubscriptionGate from './components/SubscriptionGate';
import TrialPicker from './components/TrialPicker';
import { supabase } from './lib/supabaseClient';
import { TIER_LABELS, endedAgoText } from './lib/tiers';
import { GreenScreenProcessor, intensityDefault } from './lib/greenScreen';
import BackgroundGallery from './components/BackgroundGallery';
import TextOverlayDialog from './components/TextOverlayDialog';
import {
  createOverlay,
  clampOverlayPosition,
  coverTransform,
  drawTextOverlays,
} from './lib/textOverlayUtils';
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
  { label: 'Red', value: '#c62828' },
  { label: 'Black', value: '#000000' },
  { label: 'Gray', value: '#6c757d' },
];

// Camera PIP sizing rules.
const PIP_DEFAULT = { w: 120, h: 150 };
const PIP_MIN = { w: 80, h: 100 };
const PIP_MAX = { w: 300, h: 400 };

// Teleprompter speed range. 1.0x is the fastest (40 px/s, matching the
// previous "1x"), 0.1x is a slow crawl for careful on-camera reading.
const SPEED_MIN = 0.1;
const SPEED_MAX = 1.0;
const SPEED_DEFAULT = 0.5;
const SPEED_STORAGE_KEY = 'cs-scroll-speed';
// Pixels per second at 1.0x (the old engine moved 2px every 50ms per unit).
const SPEED_PX_PER_SECOND = 40;

/** Parse + clamp a speed value; returns null when it isn't usable. */
function sanitizeSpeed(value) {
  const n = typeof value === 'number' ? value : parseFloat(value);
  if (!Number.isFinite(n)) return null;
  if (n < SPEED_MIN || n > SPEED_MAX) return null;
  return Math.round(n * 100) / 100;
}

/** Last speed the user picked, restored across sessions. */
function loadStoredSpeed() {
  try {
    const stored = sanitizeSpeed(window.localStorage.getItem(SPEED_STORAGE_KEY));
    if (stored !== null) return stored;
  } catch {
    /* private mode — fall through to the default */
  }
  return SPEED_DEFAULT;
}

// Desktop split-screen breakpoint. ≥1024px: teleprompter left, camera +
// recording controls right. Below that (tablet + phone) the floating
// camera PIP layout is used unchanged.
const DESKTOP_QUERY = '(min-width: 1024px)';

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

/**
 * Draggable text/emoji layers over a camera preview box.
 *
 * Overlays live in recording coordinates (1280x720); this component
 * measures the preview box it sits in and maps them through the same
 * cover-fit transform the compositor uses, so what the user drags is
 * exactly where the text lands in the saved video. A press that never
 * moves (>4px) is a tap → opens the editor for that layer.
 */
function TextOverlayLayer({ overlays, onMove, onEdit }) {
  const boxRef = useRef(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const gestureRef = useRef(null);

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return undefined;
    const measure = () =>
      setBox({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const { scale, ox, oy } = coverTransform(box.w, box.h);

  const beginDrag = (e, overlay) => {
    // Don't start a PIP drag underneath.
    e.stopPropagation();
    e.preventDefault();
    gestureRef.current = {
      id: overlay.id,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      origX: overlay.x,
      origY: overlay.y,
      moved: false,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const moveDrag = (e) => {
    const g = gestureRef.current;
    if (!g || scale === 0) return;
    const dx = (e.clientX - g.startX) / scale;
    const dy = (e.clientY - g.startY) / scale;
    if (!g.moved && Math.hypot(e.clientX - g.startX, e.clientY - g.startY) > 4) {
      g.moved = true;
    }
    if (g.moved) {
      const next = clampOverlayPosition(g.origX + dx, g.origY + dy);
      onMove(g.id, next.x, next.y);
    }
  };

  const endDrag = () => {
    const g = gestureRef.current;
    gestureRef.current = null;
    if (g && !g.moved) onEdit(g.id); // tap → edit
  };

  // The host stays mounted even with zero layers (pointer-events: none,
  // so it never blocks anything) — the ResizeObserver needs the element
  // to exist from mount to measure the preview box correctly.
  return (
    <div className="overlay-layer" ref={boxRef}>
      {overlays.map((o) => (
        <div
          key={o.id}
          className="text-overlay"
          style={{
            left: `${ox + o.x * scale}px`,
            top: `${oy + o.y * scale}px`,
            fontSize: `${Math.max(8, o.size * scale)}px`,
            color: o.color,
          }}
          title="Drag to move · tap to edit"
          onPointerDown={(e) => beginDrag(e, o)}
          onPointerMove={moveDrag}
          onPointerUp={endDrag}
          onPointerCancel={() => {
            gestureRef.current = null;
          }}
        >
          {o.text}
        </div>
      ))}
    </div>
  );
}

export default function TeleprompterScroll() {
  /* ---------- account + subscription ---------- */
  const { user, signOut } = useAuth();
  const {
    tier,
    loading: tierLoading,
    refresh: refreshTier,
    subscriptionStatus,
    trialDaysLeft,
    trialExpiresAt,
    trialExpired,
    trialEligible,
    startTrial,
  } = useSubscription();
  // True from first paint when we arrive on a Stripe checkout redirect,
  // until the subscription is verified + refetched. Seeded synchronously
  // from the URL so the UI never flashes a stale FREE state in between.
  const [confirmingCheckout, setConfirmingCheckout] = useState(() => {
    const q = new URLSearchParams(window.location.search);
    // Must match the `fromCheckout` predicate in the effect below, which
    // is what clears this flag again.
    return (
      q.has('session_id') ||
      q.get('checkout') === 'success' ||
      q.has('checkout_success')
    );
  });
  // While this is true the tier is unknown — gate features + show a
  // "checking your plan" indicator instead of tier-dependent UI.
  const tierBusy = tierLoading || confirmingCheckout;
  const canRecord = tier === 'starter' || tier === 'pro';

  /* ---------- 14-day no-card trial UI state ---------- */
  // "No thanks" is remembered per user so the picker doesn't nag on
  // every load; they can still start the trial from /pricing later.
  const pickerDismissKey = `cs-trial-picker-dismissed:${user?.id ?? 'anon'}`;
  const [pickerDismissed, setPickerDismissed] = useState(() => {
    try {
      return window.localStorage.getItem(pickerDismissKey) === '1';
    } catch {
      return false;
    }
  });
  const dismissTrialPicker = () => {
    setPickerDismissed(true);
    try {
      window.localStorage.setItem(pickerDismissKey, '1');
    } catch {
      /* private mode — session-only dismissal is fine */
    }
  };
  const [trialBannerDismissed, setTrialBannerDismissed] = useState(false);
  const isPro = tier === 'pro';
  const isProRef = useRef(isPro);
  useEffect(() => {
    isProRef.current = isPro;
  }, [isPro]);

  /* ---------- existing teleprompter state ---------- */
  const [scriptText, setScriptText] = useState('');
  const [isPlaying, setIsPlaying] = useState(false);
  const [scrollSpeed, setScrollSpeed] = useState(loadStoredSpeed);
  // Draft text in the speed input — kept as a string so partial entries
  // ("0.", "0.3") don't get clobbered mid-keystroke. Committed to
  // scrollSpeed the moment it parses to a valid 0.1–1.0 value.
  const [speedDraft, setSpeedDraft] = useState(() => loadStoredSpeed().toFixed(2));
  const [fontSize, setFontSize] = useState(24);
  const [mirrorMode, setMirrorMode] = useState(false);
  const displayRef = useRef(null);
  // Float scroll position accumulator: at 0.1x the per-frame movement is
  // well under 1px, and element.scrollTop quantizes to whole pixels —
  // "scrollTop += 0.07" would round back down and never move. So the
  // engine advances this float and assigns it each frame instead.
  const scrollPosRef = useRef(0);

  /** Set a new validated speed and mirror it into the input draft. */
  const applySpeed = useCallback((value) => {
    const speed = sanitizeSpeed(value);
    if (speed === null) return false;
    setScrollSpeed(speed);
    setSpeedDraft(speed.toFixed(2));
    return true;
  }, []);

  // Persist the chosen speed across sessions.
  useEffect(() => {
    try {
      window.localStorage.setItem(SPEED_STORAGE_KEY, String(scrollSpeed));
    } catch {
      /* private mode — session-only speed is fine */
    }
  }, [scrollSpeed]);

  /* ---------- responsive layout mode ---------- */
  // ≥1024px: side-by-side split (teleprompter left, camera right).
  // <1024px: the original full-width stage + floating camera PIP.
  const [isDesktop, setIsDesktop] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(DESKTOP_QUERY).matches
  );
  useEffect(() => {
    const mq = window.matchMedia(DESKTOP_QUERY);
    const onChange = (e) => setIsDesktop(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

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
  const deskVideoRef = useRef(null); // desktop split-screen preview (same stream)
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

  /* ---------- background gallery state (Starter+; custom image Pro) ---------- */
  // 'off' | 'blur' | 'color' | 'image' | 'office' | 'bokeh' | 'sunset'
  // | 'nature' | 'minimalist'
  const [gsMode, setGsMode] = useState('off');
  const [gsColor, setGsColor] = useState('#ffffff');
  // 0–1 slider; each effect maps it to its own range (blur px, glow, …).
  const [gsIntensity, setGsIntensity] = useState(intensityDefault('off'));
  const [gsStatus, setGsStatus] = useState(''); // '' | 'loading' | 'ready' | 'error'
  const [gsImageName, setGsImageName] = useState('');
  const gsRef = useRef(null); // GreenScreenProcessor
  const gsIntensityRef = useRef(gsIntensity);

  // Live intensity: pushes straight into the processor each change, so
  // the slider updates the preview without restarting segmentation.
  useEffect(() => {
    gsIntensityRef.current = gsIntensity;
    if (gsRef.current) gsRef.current.setIntensity(gsIntensity);
  }, [gsIntensity]);

  /** Switch background mode; the intensity snaps to that mode's default. */
  const applyGsMode = useCallback((mode) => {
    setGsMode(mode);
    setGsIntensity(intensityDefault(mode));
  }, []);

  /* ---------- text/emoji overlays (session-only, not persisted) ---------- */
  const [textOverlays, setTextOverlays] = useState([]);
  const [editingOverlayId, setEditingOverlayId] = useState(null);
  const textOverlaysRef = useRef(textOverlays);
  useEffect(() => {
    textOverlaysRef.current = textOverlays;
  }, [textOverlays]);

  const patchOverlay = useCallback((id, patch) => {
    setTextOverlays((prev) =>
      prev.map((o) => (o.id === id ? { ...o, ...patch } : o))
    );
  }, []);

  const moveOverlay = useCallback(
    (id, x, y) => patchOverlay(id, { x, y }),
    [patchOverlay]
  );

  const addOverlay = useCallback(() => {
    const overlay = createOverlay({
      // Stagger new layers around the vertical middle: the preview is
      // cover-cropped, so the top/bottom of the 720p frame may be off
      // screen in a wide pane — the middle band is always visible.
      y: 300 + (textOverlaysRef.current.length % 3) * 60,
    });
    setTextOverlays((prev) => [...prev, overlay]);
    setEditingOverlayId(overlay.id);
  }, []);

  const deleteOverlay = useCallback((id) => {
    setTextOverlays((prev) => prev.filter((o) => o.id !== id));
    setEditingOverlayId((cur) => (cur === id ? null : cur));
  }, []);

  const editingOverlay =
    textOverlays.find((o) => o.id === editingOverlayId) || null;
  // Visible preview canvases that mirror the compositor's output live,
  // so the user sees the chosen background BEFORE hitting Record.
  const pipFxRef = useRef(null); // overlay inside the camera PIP
  const deskFxRef = useRef(null); // overlay inside the desktop camera pane

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
    // Any of these params means we just came back from Stripe Checkout.
    const fromCheckout =
      Boolean(sessionId) ||
      searchParams.get('checkout') === 'success' ||
      searchParams.has('checkout_success');

    if (fromCheckout && sessionId) {
      // Back from Stripe — verify server-side, then refresh the tier.
      checkoutHandledRef.current = true;
      setConfirmingCheckout(true);
      setBanner('Confirming your subscription…');
      fetch('/api/verify-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      })
        .then(async (res) => {
          const data = await res.json().catch(() => ({}));
          // ALWAYS refetch, even when verification fails — a Stripe
          // webhook may have updated the tier in Supabase regardless,
          // and the pre-checkout client state is stale either way.
          const next = await refreshTier();
          if (res.ok && data.tier) {
            setBanner(
              `🎉 You're on the ${TIER_LABELS[data.tier]} plan${
                data.status === 'trialing' ? ' — 14-day free trial started' : ''
              }!`
            );
          } else if (next !== 'free') {
            setBanner(`🎉 You're on the ${TIER_LABELS[next]} plan!`);
          } else {
            setBanner(data.error || 'Could not confirm the payment.');
          }
        })
        .catch(async () => {
          const next = await refreshTier().catch(() => 'free');
          setBanner(
            next !== 'free'
              ? `🎉 You're on the ${TIER_LABELS[next]} plan!`
              : 'Could not confirm the payment.'
          );
        })
        .finally(() => {
          setConfirmingCheckout(false);
          setSearchParams({}, { replace: true });
          setTimeout(() => setBanner(''), 8000);
        });
    } else if (fromCheckout) {
      // Redirect from Stripe without a session id (e.g. cancelled, or a
      // trimmed success URL) — clear the flag and refetch so the UI
      // reflects whatever tier Supabase has now.
      checkoutHandledRef.current = true;
      refreshTier()
        .catch(() => {})
        .finally(() => {
          setConfirmingCheckout(false);
          setSearchParams({}, { replace: true });
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
   * Scrolling engine — rAF + float accumulator so sub-pixel speeds
   * (0.1x ≈ 4px/s) still advance smoothly instead of rounding to zero.
   * ============================================================ */
  useEffect(() => {
    const el = displayRef.current;
    if (!isPlaying || !el) return undefined;

    // Programmatic assignments must not fight the CSS smooth-scroll
    // animation (each assignment would restart it and lag the position).
    const prevBehavior = el.style.scrollBehavior;
    el.style.scrollBehavior = 'auto';

    scrollPosRef.current = el.scrollTop;
    let last = performance.now();
    let raf = requestAnimationFrame(function step(now) {
      // Cap the delta so a background-tab pause doesn't jump the script.
      const dt = Math.min((now - last) / 1000, 0.1);
      last = now;
      const node = displayRef.current;
      if (node) {
        // If the user scrolled manually mid-play, resync to their spot.
        if (Math.abs(node.scrollTop - scrollPosRef.current) > 2) {
          scrollPosRef.current = node.scrollTop;
        }
        const maxScroll = Math.max(0, node.scrollHeight - node.clientHeight);
        scrollPosRef.current = Math.min(
          scrollPosRef.current + scrollSpeed * SPEED_PX_PER_SECOND * dt,
          maxScroll
        );
        node.scrollTop = scrollPosRef.current;
      }
      raf = requestAnimationFrame(step);
    });

    return () => {
      cancelAnimationFrame(raf);
      el.style.scrollBehavior = prevBehavior;
    };
  }, [isPlaying, scrollSpeed]);

  const handleReset = () => {
    scrollPosRef.current = 0;
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

  // Keep the video elements attached to the live stream across re-renders
  // (e.g. after a camera retry succeeds while the error overlay unmounts,
  // or when the desktop camera pane mounts on a breakpoint change). The
  // PIP video stays the canonical compositor source on every breakpoint;
  // the desktop pane's <video> just mirrors the same MediaStream.
  useEffect(() => {
    if (!cameraReady || !streamRef.current) return;
    if (videoRef.current && videoRef.current.srcObject !== streamRef.current) {
      videoRef.current.srcObject = streamRef.current;
    }
    if (
      deskVideoRef.current &&
      deskVideoRef.current.srcObject !== streamRef.current
    ) {
      deskVideoRef.current.srcObject = streamRef.current;
    }
  }, [cameraReady, cameraError, isDesktop]);

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
    gs.setIntensity(gsIntensityRef.current);
    gs.smoothEdges = isProRef.current; // Pro gets softer edge blending

    setGsStatus('loading');
    // Photo presets (office/bokeh/nature) also need their image loaded;
    // canvas-drawn presets resolve immediately.
    Promise.all([gs.start(videoRef.current), gs.preparePreset(gsMode)])
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

  /* ============================================================
   * Live effect preview
   *
   * The segmentation compositor above runs the moment an effect is
   * selected — not just while recording. This loop paints its output
   * onto the visible preview canvases (PIP + desktop pane) each frame,
   * so the user sees exactly what the recording will look like and can
   * toggle between effects in real time. The recording pipeline reads
   * the very same gs.canvas, so preview and recording always match.
   * ============================================================ */
  const gsPreviewOn = gsMode !== 'off' && gsStatus === 'ready';
  useEffect(() => {
    if (!gsPreviewOn) return undefined;

    let raf;
    const paint = () => {
      const gs = gsRef.current;
      if (gs && gs.running && gs.hasFrame) {
        for (const ref of [pipFxRef, deskFxRef]) {
          const el = ref.current;
          if (!el) continue;
          if (el.width !== gs.canvas.width || el.height !== gs.canvas.height) {
            el.width = gs.canvas.width;
            el.height = gs.canvas.height;
          }
          el.getContext('2d').drawImage(gs.canvas, 0, 0);
        }
      }
      raf = requestAnimationFrame(paint);
    };
    raf = requestAnimationFrame(paint);

    return () => {
      cancelAnimationFrame(raf);
      // Clear both canvases so a stale frame never flashes the next
      // time an effect is switched on.
      for (const ref of [pipFxRef, deskFxRef]) {
        const el = ref.current;
        if (el) el.getContext('2d').clearRect(0, 0, el.width, el.height);
      }
    };
  }, [gsPreviewOn]);

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
        applyGsMode('image');
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

    // Decorative text/emoji overlays bake into the recording — after the
    // background/effects, under the caption bar.
    drawTextOverlays(ctx, textOverlaysRef.current, width, height);

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
    const needsCanvas =
      showCaptions ||
      gsMode !== 'off' ||
      filtersActive ||
      textOverlays.length > 0;

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
    textOverlays,
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
      setPip((p) => {
        // Mobile: the PIP lives in the bottom-quarter "safe zone" so it
        // never sits over the script the speaker is reading. (If the PIP
        // is taller than the quarter, the zone grows just enough.)
        const minY = isDesktop
          ? 0
          : Math.max(0, Math.min(s.stageH * 0.75, s.stageH - p.h - 8));
        return {
          ...p,
          x: clamp(s.origX + dx, 0, Math.max(0, s.stageW - p.w)),
          y: clamp(s.origY + dy, minY, Math.max(minY, s.stageH - p.h)),
        };
      });
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
  // Default dock: BOTTOM-right corner — inside the mobile safe zone, out
  // of the way of the script. Dragging switches to explicit coordinates.
  const pipStyle = {
    width: `${pip.w}px`,
    height: `${pip.h}px`,
    ...(pip.x === null
      ? { bottom: '16px', right: '16px' }
      : { top: `${pip.y}px`, left: `${pip.x}px` }),
  };

  /* ============================================================
   * Render
   * ============================================================ */
  // Effects the preview can NOT show live (they composite only into the
  // recording): captions + Pro filters. Green-screen backgrounds preview
  // live now, so they no longer trigger the "recording only" note.
  const recordOnlyEffects = filtersActive || showCaptions;

  // First-visit trial picker: only for definitively trial-eligible users
  // (free tier, no trial record) who aren't mid-checkout and didn't say
  // "no thanks". Checkout intents (?plan=&cycle=, Stripe redirects) win.
  const hasCheckoutIntent =
    searchParams.has('session_id') ||
    searchParams.get('checkout') === 'success' ||
    searchParams.has('checkout_success') ||
    (searchParams.has('plan') && searchParams.has('cycle'));
  const showTrialPicker =
    !tierBusy && trialEligible && !pickerDismissed && !hasCheckoutIntent;
  const inTrial = subscriptionStatus === 'trial';

  // Rendered in exactly ONE place per breakpoint: inside the camera pane
  // on desktop (below the feed), full-width below the stage otherwise.
  const recordingControls = (
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
          tierBusy ||
          !canRecord ||
          !recorderSupported ||
          !cameraReady ||
          isRecording
        }
      >
        ⏺ Start Recording
      </button>

      {tierBusy ? (
        <span className="tier-checking" role="status">
          <span className="tier-spinner" aria-hidden="true" />
          Checking your plan…
        </span>
      ) : (
        !canRecord && (
          <Link to="/pricing" className="record-locked">
            🔒 Upgrade to Starter to start recording
          </Link>
        )
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
  );


  // Tap-to-pause: while a mobile recording is rolling, tapping the
  // script toggles pause/resume (same as the floating pause button).
  const handleStageTap = () => {
    if (isRecording && !isDesktop) setIsPlaying((p) => !p);
  };

  // Mobile recording focus: while a take is rolling AND playing on a
  // phone/tablet, the controls bar + script entry hide so the
  // teleprompter fills the screen. Pausing (tap or button) brings
  // them back so Stop Recording is always reachable.
  const mobileRecFocus = isRecording && isPlaying && !isDesktop;

  // Main controls row — rendered once, inside the full-width bottom bar.
  const controlsRow = (
      <div className="controls">
        <div className="control-group speed-group">
          <label htmlFor="speed-slider">Speed:</label>
          <input
            id="speed-slider"
            type="range"
            min={SPEED_MIN}
            max={SPEED_MAX}
            step="0.01"
            value={scrollSpeed}
            aria-label="Scroll speed"
            onChange={(e) => applySpeed(e.target.value)}
          />
          <input
            className="speed-input"
            type="number"
            inputMode="decimal"
            min={SPEED_MIN}
            max={SPEED_MAX}
            step="0.01"
            value={speedDraft}
            aria-label="Scroll speed (type a value from 0.1 to 1.0)"
            title="Type a speed from 0.1 to 1.0"
            onChange={(e) => {
              // Keep whatever they typed visible; only commit valid values.
              setSpeedDraft(e.target.value);
              const speed = sanitizeSpeed(e.target.value);
              if (speed !== null) setScrollSpeed(speed);
            }}
            onBlur={() => setSpeedDraft(scrollSpeed.toFixed(2))}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
            }}
          />
          <span className="speed-value">{scrollSpeed.toFixed(2)}x</span>
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
              disabled={isRecording || tierBusy || !canRecord}
              onChange={() => setShowCaptions(true)}
            />
            Yes
          </label>
          <label className="caption-radio">
            <input
              type="radio"
              name="embed-captions"
              checked={!showCaptions}
              disabled={isRecording || tierBusy || !canRecord}
              onChange={() => setShowCaptions(false)}
            />
            No
          </label>
        </div>

        {/* Background gallery — Starter+: presets + colors; Pro adds a
            custom image upload. Each preset gets an intensity slider. */}
        <SubscriptionGate
          tier={tier}
          requires="starter"
          mode="hide"
          message="Backgrounds — upgrade to Starter"
        >
          <BackgroundGallery
            isPro={isPro}
            gsMode={gsMode}
            gsColor={gsColor}
            gsColors={GS_COLORS}
            gsIntensity={gsIntensity}
            gsStatus={gsStatus}
            gsImageName={gsImageName}
            disabled={isRecording}
            onMode={applyGsMode}
            onColor={setGsColor}
            onIntensity={setGsIntensity}
            onUpload={handleGsImageUpload}
          />
        </SubscriptionGate>

        {/* Text/emoji overlays: decorate the camera preview + recording */}
        <div className="control-group">
          <button
            type="button"
            className="overlay-add-btn"
            title="Add text or emoji onto your video"
            onClick={addOverlay}
          >
            ✨ Add Text
          </button>
          {textOverlays.length > 0 && (
            <span className="overlay-count">
              {textOverlays.length} layer{textOverlays.length === 1 ? '' : 's'}
            </span>
          )}
        </div>

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
  );

  // Saved-scripts row + textarea: right-hand bottom pane on desktop,
  // full-width row between the stage and the controls bar otherwise.
  const scriptEntry = (
    <>
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
    </>
  );

  return (
    <div
      className={`teleprompter-container ${
        mobileRecFocus ? 'mobile-rec-focus' : ''
      }`}
    >
      {/* Header */}
      <header className="header app-header">
        <img src="/captionscroll-wordmark.jpg" alt="CaptionScroll logo" className="hero-banner" />
        <div className="app-header-right">
          {tierBusy ? (
            <span
              className="tier-badge tier-loading"
              role="status"
              aria-label="Checking your plan"
            >
              <span className="tier-spinner" aria-hidden="true" />
            </span>
          ) : inTrial ? (
            <span className={`tier-badge tier-${tier} tier-trial`}>
              {TIER_LABELS[tier].toUpperCase()} TRIAL
            </span>
          ) : (
            <span className={`tier-badge tier-${tier}`}>{TIER_LABELS[tier]}</span>
          )}
          {!tierBusy && inTrial && (
            <span className="trial-countdown">
              {trialDaysLeft} {trialDaysLeft === 1 ? 'day' : 'days'} left
            </span>
          )}
          {!tierBusy && (tier !== 'pro' || inTrial) && (
            <Link to="/pricing" className="upgrade-link">
              {trialExpired ? '⬆ Upgrade to continue' : '⬆ Upgrade'}
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

      {/* Trial-over notice — shown even weeks later; the app itself stays
          viewable, only recording features are locked. */}
      {!tierBusy && trialExpired && !trialBannerDismissed && (
        <div className="trial-ended-banner" role="status">
          <span className="trial-ended-text">
            Your free trial ended {endedAgoText(trialExpiresAt)}. Upgrade to
            keep recording — your scripts are safe either way.
          </span>
          <Link to="/pricing" className="trial-ended-upgrade">
            Upgrade now
          </Link>
          <button
            className="trial-ended-dismiss"
            aria-label="Dismiss"
            onClick={() => setTrialBannerDismissed(true)}
          >
            ✕
          </button>
        </div>
      )}

      {/* First-visit tier picker: 14 days of Starter or Pro, no card. */}
      {showTrialPicker && (
        <TrialPicker
          startTrial={startTrial}
          onDismiss={dismissTrialPicker}
          onStarted={(chosen) => {
            setBanner(
              `🎉 Your 14-day ${TIER_LABELS[chosen]} trial has started — everything in ${TIER_LABELS[chosen]} is unlocked!`
            );
            setTimeout(() => setBanner(''), 8000);
          }}
        />
      )}

      {/* ============ Workspace ============
          Teleprompter stage on top — full width at every breakpoint,
          50%+ of the viewport tall. Desktop (≥1024px) adds a bottom
          row: camera feed left, script entry right. Phones/tablets keep
          the floating camera PIP (docked to the bottom-right safe zone)
          with the script entry as a full-width row below the stage. All
          controls live in the full-width bar at the very bottom. */}
      <div className="workspace">
        {/* Stage: full-width teleprompter + floating camera PIP.
            The PIP <video> stays MOUNTED on every breakpoint — even
            hidden — because it is the recording compositor's one true
            frame source. A camera error forces the PIP visible so the
            message and Retry button are never hidden. */}
        <div className="stage" ref={stageRef}>
          <div
            ref={displayRef}
            className={`script-display ${mirrorMode ? 'mirror' : ''}`}
            style={{ fontSize: `${fontSize}px` }}
            onClick={handleStageTap}
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

          {/* Mobile recording: floating pause/resume button (the script
              itself is also tappable — see handleStageTap) */}
          {isRecording && !isDesktop && (
            <button
              type="button"
              className="mobile-pause-button"
              onClick={() => setIsPlaying((p) => !p)}
            >
              {isPlaying ? '⏸ Pause' : '▶ Resume'}
            </button>
          )}
          {isRecording && !isDesktop && !isPlaying && (
            <div className="mobile-paused-note" role="status">
              Paused — tap the script to resume
            </div>
          )}

          {/* Camera PIP — draggable + resizable. Docked bottom-right in
              the mobile safe zone; hidden (but mounted) on desktop. */}
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
            {/* Live effect preview overlay — shows the compositor's output
                (background presets/blur/color/image) over the raw video */}
            <canvas
              ref={pipFxRef}
              className={`camera-fx ${gsPreviewOn ? 'fx-on' : ''}`}
              aria-hidden="true"
            />
            {/* Draggable text/emoji layers (phone/tablet preview) */}
            {!isDesktop && (
              <TextOverlayLayer
                overlays={textOverlays}
                onMove={moveOverlay}
                onEdit={setEditingOverlayId}
              />
            )}
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
            {!cameraError && recordOnlyEffects && (
              <span className="pip-note">captions &amp; filters apply to recording</span>
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

        {/* Desktop ≥1024px bottom row: camera feed (left) + script entry
            (right). The floating PIP above stays the compositor's frame
            source; this pane's <video> simply shows the same MediaStream. */}
        {isDesktop && (
          <div className="workspace-bottom">
            <div className="camera-pane-feed">
              <video
                ref={deskVideoRef}
                className="camera-video-desktop"
                autoPlay
                playsInline
                muted /* mute preview to avoid feedback; mic still records */
                style={{ visibility: showPreview ? 'visible' : 'hidden' }}
              />
              {/* Live effect preview overlay (same compositor output as
                  the PIP overlay — and as the recording itself) */}
              <canvas
                ref={deskFxRef}
                className={`camera-fx ${gsPreviewOn ? 'fx-on' : ''}`}
                style={{ visibility: showPreview ? 'visible' : 'hidden' }}
                aria-hidden="true"
              />
              {/* Draggable text/emoji layers — drag to place; tap to edit */}
              {showPreview && (
                <TextOverlayLayer
                  overlays={textOverlays}
                  onMove={moveOverlay}
                  onEdit={setEditingOverlayId}
                />
              )}
              {!showPreview && !cameraError && (
                <div className="camera-off-note">
                  Camera preview hidden — recording still uses the camera
                </div>
              )}
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
              {!cameraError && showPreview && recordOnlyEffects && (
                <span className="pip-note">captions &amp; filters apply to recording</span>
              )}
            </div>
            <div className="script-input-pane">{scriptEntry}</div>
          </div>
        )}
      </div>{/* /workspace */}

      {/* Phone/tablet: script entry as a full-width row below the stage
          (hidden while a mobile recording is rolling) */}
      {!isDesktop && <div className="script-entry">{scriptEntry}</div>}

      {/* Full-width controls bar fixed to the bottom of the app: main
          controls row + recording controls. On phones/tablets it hides
          while a recording is rolling (see mobileRecFocus). */}
      <div className="recording-controls-bar">
        {controlsRow}
        {recordingControls}
      </div>

      {/* Hidden canvas used to composite effects + captions into the recording */}
      <canvas ref={canvasRef} className="compositing-canvas" aria-hidden="true" />

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

      {/* Text overlay editor — edits apply live to the preview layers */}
      {editingOverlay && (
        <TextOverlayDialog
          overlay={editingOverlay}
          onChange={(patch) => patchOverlay(editingOverlay.id, patch)}
          onDelete={() => deleteOverlay(editingOverlay.id)}
          onClose={() => setEditingOverlayId(null)}
        />
      )}
    </div>
  );
}
