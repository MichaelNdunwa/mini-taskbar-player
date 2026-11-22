/* ─────────────────────────────────────────────────────────────────────────────
   renderer.js  –  UI logic for the Spotify Taskbar Player widget
   ───────────────────────────────────────────────────────────────────────────── */

// ── DOM refs ──────────────────────────────────────────────────────────────────
const artEl        = document.getElementById('art');
const noArtEl      = document.getElementById('noArt');
const artWrapper   = document.getElementById('artWrapper');
const titleEl      = document.getElementById('title');
const artistEl     = document.getElementById('artist');
const timeEl       = document.getElementById('timeDisplay');
const overlayEl    = document.getElementById('overlay');
const idleEl       = document.getElementById('idle');
const btnPlay      = document.getElementById('btnPlay');
const btnPrev      = document.getElementById('btnPrev');
const btnNext      = document.getElementById('btnNext');
const btnHeart     = document.getElementById('btnHeart');
const btnSetup     = document.getElementById('btnSetup');
const iconPlay     = document.getElementById('iconPlay');
const iconPause    = document.getElementById('iconPause');
const fillRect     = document.getElementById('fillRect');
const trackRect    = document.getElementById('trackRect');
const progressDot  = document.getElementById('progressDot');

// ── Square progress ring setup ────────────────────────────────────────────────
// SVG viewBox 44×44. Rect: x=2,y=2, w=40,h=40, rx=5
// Perimeter = 4*(40 - 2*5) + 2*π*5 = 4*30 + 31.42 ≈ 151.42
const PERIMETER = 4 * (40 - 2 * 5) + 2 * Math.PI * 5;

// Initialise the dashed stroke
fillRect.style.strokeDasharray  = `${PERIMETER}`;
fillRect.style.strokeDashoffset = `${PERIMETER}`;   // 0% filled

// The square path starts at the top-centre of the rect.
// SVG rect with rx=8: the top-centre point in the 72×72 SVG is (36, 4).
// We need to map 0–100% progress to a point along the perimeter
// for the dot. We trace clockwise: top → right → bottom → left → back.
//   Segment lengths in px:
//   TopRight arc  (0° → 90°):   arc length = π/2 × 8 ≈ 12.57  — but we start at mid-top
//   Let's define progress 0 at top-centre (36, 4) and go clockwise.
//
// For simplicity we move the dot along the same mathematical path
// using the parametric approach below.

function dotPositionAt(fraction) {
  // rect: x0=2,y0=2, w=40,h=40, r=5. Start at top-centre=(22,2), clockwise.
  const x0 = 2, y0 = 2, w = 40, h = 40, r = 5;
  const halfW = w / 2; // 20
  const halfH = h / 2; // 20

  const arcLen = Math.PI / 2 * r;
  const segments = [
    { len: halfW - r  },   // 0 top right straight
    { len: arcLen     },   // 1 top-right corner arc
    { len: h - 2 * r  },   // 2 right straight
    { len: arcLen     },   // 3 bottom-right corner arc
    { len: w - 2 * r  },   // 4 bottom straight
    { len: arcLen     },   // 5 bottom-left corner arc
    { len: h - 2 * r  },   // 6 left straight
    { len: arcLen     },   // 7 top-left corner arc
    { len: halfW - r  },   // 8 top-left straight back to start
  ];
  const total = segments.reduce((s, g) => s + g.len, 0);

  let dist = fraction * total;
  let segIdx = 0;
  while (segIdx < segments.length - 1 && dist > segments[segIdx].len) {
    dist -= segments[segIdx].len;
    segIdx++;
  }
  const t = dist / segments[segIdx].len;

  switch (segIdx) {
    case 0: return { x: x0 + halfW + t * (halfW - r),   y: y0 };
    case 1: { const a = -Math.PI/2 + t*Math.PI/2; return { x: x0+w-r + r*Math.cos(a), y: y0+r + r*Math.sin(a) }; }
    case 2: return { x: x0 + w,                         y: y0 + r + t * (h - 2*r) };
    case 3: { const a = 0 + t*Math.PI/2;          return { x: x0+w-r + r*Math.cos(a), y: y0+h-r + r*Math.sin(a) }; }
    case 4: return { x: x0 + w - r - t * (w - 2*r),    y: y0 + h };
    case 5: { const a = Math.PI/2 + t*Math.PI/2;  return { x: x0+r + r*Math.cos(a),   y: y0+h-r + r*Math.sin(a) }; }
    case 6: return { x: x0,                              y: y0 + h - r - t * (h - 2*r) };
    case 7: { const a = Math.PI + t*Math.PI/2;    return { x: x0+r + r*Math.cos(a),   y: y0+r + r*Math.sin(a) }; }
    case 8: return { x: x0 + r + t * (halfW - r),       y: y0 };
    default: return { x: x0 + halfW, y: y0 };
  }
}

function setProgress(fraction) {
  fraction = Math.max(0, Math.min(1, fraction));
  const offset = PERIMETER * (1 - fraction);
  fillRect.style.strokeDashoffset = offset;

  const dot = dotPositionAt(fraction);
  progressDot.setAttribute('cx', dot.x);
  progressDot.setAttribute('cy', dot.y);
  progressDot.style.opacity = fraction > 0 ? '1' : '0';
}

// ── State ─────────────────────────────────────────────────────────────────────
let currentState    = null;
let localProgress   = 0;   // ms, interpolated between polls
let localPlaying    = false;
let interpolateTick = null;

function startInterpolation() {
  stopInterpolation();
  interpolateTick = setInterval(() => {
    if (!localPlaying || !currentState) return;
    localProgress = Math.min(localProgress + 1000, currentState.duration);
    updateProgress();
  }, 1000);
}
function stopInterpolation() {
  if (interpolateTick) { clearInterval(interpolateTick); interpolateTick = null; }
}

function updateProgress() {
  if (!currentState) return;
  const fraction = currentState.duration > 0 ? localProgress / currentState.duration : 0;
  setProgress(fraction);
  timeEl.textContent = `${msToTime(localProgress)} / ${msToTime(currentState.duration)}`;
}

function msToTime(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

// ── Handle incoming playback state from main ──────────────────────────────────
window.spotify.onPlaybackState((state) => {
  if (!state) {
    // Nothing playing
    showIdle();
    return;
  }

  hideOverlay();
  idleEl.classList.remove('visible');
  document.getElementById('widget').style.display = '';

  const changed = !currentState || currentState.trackId !== state.trackId;
  currentState  = state;
  localProgress = state.progress;
  localPlaying  = state.isPlaying;

  // ── Title
  titleEl.textContent = state.title;
  titleEl.classList.remove('scrolling');
  void titleEl.offsetWidth; // reflow to restart animation
  if (titleEl.scrollWidth > titleEl.clientWidth) {
    const dist = titleEl.scrollWidth - titleEl.clientWidth;
    titleEl.style.setProperty('--scroll-dist', `-${dist}px`);
    titleEl.classList.add('scrolling');
  }

  // ── Artist
  artistEl.textContent = state.artist;

  // ── Album art
  if (changed && state.artUrl) {
    artEl.style.opacity = '0';
    noArtEl.style.display = 'none';
    artEl.style.display   = 'block';
    artEl.src = state.artUrl;
    artEl.onload = () => { artEl.style.opacity = '1'; };
  } else if (!state.artUrl) {
    artEl.style.display   = 'none';
    noArtEl.style.display = 'flex';
  }

  // ── Play / Pause icon
  iconPlay.style.display   = state.isPlaying ? 'none'  : 'block';
  iconPause.style.display  = state.isPlaying ? 'block' : 'none';

  // ── Heart
  btnHeart.classList.toggle('saved', state.isSaved);
  btnHeart.querySelector('svg').style.fill   = state.isSaved ? '#1DB954' : 'none';
  btnHeart.querySelector('svg').style.stroke = state.isSaved ? '#1DB954' : 'currentColor';
  btnHeart.title = state.isSaved ? 'Remove from Liked Songs' : 'Save to Liked Songs';

  // ── Progress
  updateProgress();
  if (state.isPlaying) startInterpolation();
  else                 stopInterpolation();
});

// ── Auth events ───────────────────────────────────────────────────────────────
window.spotify.onAuthSuccess(() => { hideOverlay(); });
window.spotify.onAuthError((msg) => { alert(`Auth error: ${msg}`); });

// ── Button handlers ───────────────────────────────────────────────────────────
btnPlay.addEventListener('click',  () => window.spotify.playPause());
btnPrev.addEventListener('click',  () => window.spotify.prevTrack());
btnNext.addEventListener('click',  () => window.spotify.nextTrack());
artWrapper.addEventListener('click', () => window.spotify.openSpotify());

btnHeart.addEventListener('click', async () => {
  if (!currentState) return;
  const newSaved = await window.spotify.toggleSave({
    trackId: currentState.trackId,
    isSaved: currentState.isSaved,
  });
  currentState.isSaved = newSaved;
  btnHeart.classList.toggle('saved', newSaved);
  btnHeart.querySelector('svg').style.fill   = newSaved ? '#1DB954' : 'none';
  btnHeart.querySelector('svg').style.stroke = newSaved ? '#1DB954' : 'currentColor';
});

// ── Setup button → open settings window ──────────────────────────────────────
btnSetup.addEventListener('click', () => {
  window.spotify.openSettings();
});

// ── Overlay helpers ───────────────────────────────────────────────────────────
function hideOverlay() { overlayEl.classList.remove('visible'); }
function showIdle()    {
  hideOverlay();
  idleEl.classList.add('visible');
  stopInterpolation();
  currentState = null;
  setProgress(0);
  titleEl.textContent  = 'Not playing';
  artistEl.textContent = '—';
  timeEl.textContent   = '';
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────
(async () => {
  const creds = await window.spotify.getStoredCredentials();
  if (creds.hasToken) {
    hideOverlay();
    idleEl.classList.add('visible');  // wait for first poll
  } else {
    overlayEl.classList.add('visible');
  }
})();
