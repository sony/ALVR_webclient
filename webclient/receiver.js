/**
 * receiver.js – ALVR Web Client receiver page
 *
 * This page is opened by client.js and receives messages to display video.
 *
 * Two communication modes:
 *   - Android Native App: AlvrReceiverBridge (JavascriptInterface)
 *     - window.alvrReceiverOnMessage(jsonStr) is called from Java
 *     - 'ready' notifications are sent via window.AlvrNativeBridge.postToClient()
 *   - Windows Chrome: BroadcastChannel('alvr-receiver')
 *     - Posts 'ready' and waits for an 'init' message from client.js
 *
 * Common behaviour:
 *   1. Send 'ready' to notify client.js that the page has loaded
 *   2. Receive an 'init' message with { wsUrl, codec }
 *   3. Open a WebSocket to the ALVR Web Server at /ws/video
 *   4. Decode H.264/HEVC/AV1 frames with WebCodecs
 *   5. Draw decoded frames full-screen to <canvas>
 */

import { VideoDecoderSession } from './video-decoder.js';

// ---------------------------------------------------------------------------
// Platform detection
// ---------------------------------------------------------------------------

/** true when running inside the alvr_webclient Android native app */
const IS_NATIVE_APP = (typeof window.AlvrNativeBridge !== 'undefined');

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let videoWs      = null;
let videoDecoder = null;
let codecConfig  = null;
let canvas       = null;
let ctx2d        = null;
// True after configure()/flush() – drop delta frames until the first IDR.
let needsKeyFrame = true;

// ── WebTransport video state ─────────────────────────────────────────────────
// When init.wtUrl is provided receiver.js uses a /wt/video WT session instead
// of the /ws/video WebSocket.  Falls back to WebSocket on any WT error.
let _wtVideoSession = null;  // active WebTransport video session
let _wsVideoUrl     = null;  // wss://.../ws/video  (fallback)
let _wtVideoUrl     = null;  // https://.../wt/video
let _wtVideoFp      = null;  // hex SHA-256 fingerprint for certificate pinning
let _videoGeneration = 0;
const _videoReconnectTimers = new Map();
// Reorder window: a missing frame is declared lost only after it has been
// overdue for WT_REORDER_WINDOW_MS (or WT_REORDER_MAX_FRAMES successors are
// buffered).  A frame-count window (2 frames ≈ 20 ms) misread network jitter as
// loss and sent the receiver into IDR waits on high-jitter (mobile) links.
const WT_REORDER_WINDOW_MS = 150;
const WT_REORDER_MAX_FRAMES = 24;
const _wtPendingFrames = new Map();
let _wtNextFrameId = null;
let _wtReorderTimer = null;
let _wtGapSinceMs = null;  // when the current gap at _wtNextFrameId was first seen

function resetWtReorderBuffer() {
  clearTimeout(_wtReorderTimer);
  _wtReorderTimer = null;
  _wtGapSinceMs = null;
  _wtPendingFrames.clear();
  _wtNextFrameId = null;
  _wtKeyWaitStash.clear();
  _wtLastDecodedId = null;
  _idrRetryIntervalMs = IDR_RETRY_BASE_MS;
}

// ── Key-frame wait recovery ──────────────────────────────────────────────────
// While needsKeyFrame is true, the IDR request is retried with a back-off
// (IDR_RETRY_BASE_MS doubling up to IDR_RETRY_MAX_MS) instead of relying on the
// 3 s watchdog.  The back-off resets once an IDR is decoded.  Retrying
// immediately on every reset IDR flooded a congested link with 63 KB IDRs and
// filled the server's in-flight window with IDRs.
// Frames dropped while waiting are kept in a small stash so that an IDR
// arriving after its successors (reordered by the network) can still be used:
// it is decoded and the stashed successors are replayed to catch up with the
// reorder position.
const IDR_RETRY_BASE_MS = 500;
const IDR_RETRY_MAX_MS = 2000;
let _idrRetryIntervalMs = IDR_RETRY_BASE_MS;
const WT_KEYWAIT_STASH_MAX = 30;
const _wtKeyWaitStash = new Map(); // frameId → frame held while waiting for an IDR
let _wtLastDecodedId = null;       // frameId of the last frame passed to the decoder

function retryIdrWhileWaiting(reason) {
  if (!needsKeyFrame || videoDecoder?.state !== 'configured') return;
  const sinceMs = performance.now() - _lastReceiverIdrMs;
  if (sinceMs < _idrRetryIntervalMs) return;
  rlog(`[IDR-RETRY] ${reason}: no usable IDR ${sinceMs.toFixed(0)}ms after last request — re-requesting`);
  requestIdrFromReceiver(true, true);
  _idrRetryIntervalMs = Math.min(_idrRetryIntervalMs * 2, IDR_RETRY_MAX_MS);
}

/** Call when an IDR has been passed to the decoder: the pending request was served. */
function onIdrDecoded() {
  _idrRetryIntervalMs = IDR_RETRY_BASE_MS;
}

function stashKeyWaitFrame(frame) {
  if (_wtLastDecodedId !== null && frame.frameId <= _wtLastDecodedId) return;
  _wtKeyWaitStash.set(frame.frameId, frame);
  if (_wtKeyWaitStash.size > WT_KEYWAIT_STASH_MAX) {
    let oldest = null;
    for (const id of _wtKeyWaitStash.keys()) if (oldest === null || id < oldest) oldest = id;
    _wtKeyWaitStash.delete(oldest);
  }
}

/** Decode an IDR that arrived after the reorder position and replay stashed successors. */
function resyncFromLateIdr(idr) {
  needsKeyFrame = false;
  decodeFrame(idr.timestampNs, true, idr.nal, true);
  onIdrDecoded();
  _wtLastDecodedId = idr.frameId;
  let id = idr.frameId + 1n;
  let caughtUp = 0;
  while (id < _wtNextFrameId && !needsKeyFrame) {
    const f = _wtKeyWaitStash.get(id);
    if (!f) break;
    decodeFrame(f.timestampNs, f.isIdr, f.nal, true);
    _wtLastDecodedId = id;
    caughtUp++;
    id++;
  }
  _wtKeyWaitStash.clear();
  const complete = id >= _wtNextFrameId && !needsKeyFrame;
  rlog(`[WT-RESYNC] late IDR #${idr.frameId} accepted (next=#${_wtNextFrameId}): replayed ${caughtUp} stashed frame(s)` +
       (complete ? ' — stream resynchronised' : ` — frame #${id} unavailable, waiting for next IDR`));
  if (!complete) {
    needsKeyFrame = true;
    requestIdrFromReceiver(true, true);
  }
}

function clearVideoReconnectTimers() {
  for (const timerId of _videoReconnectTimers.values()) clearTimeout(timerId);
  _videoReconnectTimers.clear();
}

function videoGenerationIsActive(generation) {
  return generation === _videoGeneration && (_wtVideoUrl || _wsVideoUrl);
}

function scheduleVideoReconnect(key, callback, delayMs, generation) {
  const previous = _videoReconnectTimers.get(key);
  if (previous) clearTimeout(previous);
  const timerId = setTimeout(() => {
    _videoReconnectTimers.delete(key);
    if (videoGenerationIsActive(generation)) callback();
  }, delayMs);
  _videoReconnectTimers.set(key, timerId);
}

// ── Debug counters ────────────────────────────────────────────────────────────
// (stream counters removed after investigation; kept: rate-limit timer for decoder-skip log)

// GPU blit error counter – surfaces createImageBitmap() failures that were
// previously swallowed silently by catch(() => {}).
let _bitmapErrors = 0;
let _lastBitmapErrorLogMs = 0;

// ---------------------------------------------------------------------------
// Communication channel setup
// ---------------------------------------------------------------------------

/** Used only in Windows Chrome (BroadcastChannel mode). */
const channel = IS_NATIVE_APP ? null : new BroadcastChannel('alvr-receiver');

// Forward logs to client.js
function rlog(msg) {
  console.log('[ALVR receiver]', msg);
  const logMsg = JSON.stringify({ type: 'log', msg });
  if (IS_NATIVE_APP) {
    try { window.AlvrNativeBridge.postToClient(logMsg); } catch (_) {}
  } else if (channel) {
    try { channel.postMessage({ type: 'log', msg }); } catch (_) {}
  }
}

/** Native app: called from Java (DisplayMessageBroker) when a message arrives. */
window.alvrReceiverOnMessage = function(jsonStr) {
  let msg;
  try { msg = JSON.parse(jsonStr); } catch (_) { return; }
  handleInitMessage(msg);
};

function handleInitMessage(msg) {
  if (msg.type === 'init') {
    videoDecoder?.close();
    videoDecoder = null;
    clearVideoReconnectTimers();
    resetWtReorderBuffer();
    const generation = ++_videoGeneration;
    if (_wtVideoSession) {
      try { _wtVideoSession.close(); } catch (_) {}
      _wtVideoSession = null;
    }
    if (videoWs) {
      videoWs.onclose = null;
      videoWs.close();
      videoWs = null;
    }
    stopWatchdog();
    rlog(`Init received: wsUrl=${msg.wsUrl} codec=${msg.codec?.codec ?? 'null'} wtUrl=${msg.wtUrl ?? 'none'}`);
    codecConfig  = msg.codec;
    _wsVideoUrl  = msg.wsUrl;
    _wtVideoUrl  = msg.wtUrl  ?? null;
    _wtVideoFp   = msg.wtFingerprint ?? null;
    _clientTimeOriginMs = typeof msg.clientTimeOrigin === 'number' ? msg.clientTimeOrigin : null;
    _statsFrameCount = 0;
    showOverlay('Waiting for video stream…');
    initCanvas();
    // Use WebTransport video when available; fall back to WebSocket.
    if (_wtVideoUrl && _wtVideoFp && typeof WebTransport !== 'undefined') {
      openVideoWt(generation);
    } else {
      openVideoWs(msg.wsUrl, generation);
    }
  } else if (msg.type === 'disconnect') {
    clearVideoReconnectTimers();
    resetWtReorderBuffer();
    ++_videoGeneration;
    // Close WT video session first.
    // Setting _wtVideoUrl = null signals the wt.closed handler not to reconnect.
    _wtVideoUrl = null;
    _wtVideoFp  = null;
    _wsVideoUrl = null;
    if (_wtVideoSession) {
      try { _wtVideoSession.close(); } catch (_) {}
      _wtVideoSession = null;
    }
    stopWatchdog(); // Stop IDR requests immediately on disconnect.

    // Close WebSocket video if active.
    if (videoWs) {
      videoWs.onclose = null; // prevent automatic reconnect
      videoWs.close();
      videoWs = null;
    }
    videoDecoder?.close();
    videoDecoder = null;
    // Clear the last rendered frame to black.
    if (ctx2d && canvas) { ctx2d.clearRect(0, 0, canvas.width, canvas.height); }
    showOverlay('Waiting for video stream…');
    // Hide 6DoF mode indicators when disconnected.
    document.getElementById('indicator-left')?.classList.remove('visible');
    document.getElementById('indicator-right')?.classList.remove('visible');
    rlog('Disconnect received – overlay restored');
  } else if (msg.type === 'set_6dof_mode') {
    const indL = document.getElementById('indicator-left');
    const indR = document.getElementById('indicator-right');
    if (indL && indR) {
      if (msg.enabled) {
        // Load the PNG lazily on first activation to avoid competing with the
        // video decoder for GPU resources during the initial streaming period.
        if (!indL.src || indL.src === window.location.href) {
          indL.src = 'controller_icon.png';
          indR.src = 'controller_icon.png';
        }
        indL.classList.add('visible');
        indR.classList.add('visible');
      } else {
        indL.classList.remove('visible');
        indR.classList.remove('visible');
      }
    }
    rlog(`6DoF indicator: ${msg.enabled ? 'shown' : 'hidden'}`);
  }
}

if (channel) {
  channel.onmessage = e => {
    const msg = e.data;
    if (!msg) return;
    handleInitMessage(msg);
  };
}

// Signal readiness to client.js
function sendReady() {
  const msg = JSON.stringify({ type: 'ready' });
  if (IS_NATIVE_APP) {
    try { window.AlvrNativeBridge.postToClient(msg); } catch (_) {}
  } else if (channel) {
    channel.postMessage({ type: 'ready' });
  }
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    sendReady();
    // The Presentation window is already full-screen in the native app.
    if (!IS_NATIVE_APP) requestFullscreen();
  });
} else {
  sendReady();
  if (!IS_NATIVE_APP) requestFullscreen();
}
// Retry once after 500 ms in case client.js wasn't listening yet
setTimeout(sendReady, 500);

// Fallback: read params from URL hash (for manual testing)
const _params = new URLSearchParams(window.location.hash.slice(1));
const _wsUrl  = _params.get('ws');
if (_wsUrl) {
  codecConfig = { codec: _params.get('codec') || 'h264', width: 1920, height: 1080, refresh_rate: 90 };
  initCanvas();
  openVideoWs(_wsUrl);
}

// ---------------------------------------------------------------------------
// Canvas / WebGL initialisation
// ---------------------------------------------------------------------------

function initCanvas() {
  canvas = document.getElementById('render-canvas');
  if (!canvas) {
    rlog('[ERROR] initCanvas: canvas element NOT found (id=render-canvas)');
    return;
  }

  if (codecConfig) {
    canvas.width  = codecConfig.width  || 3840;
    canvas.height = codecConfig.height || 1080;
  }

  // 2D canvas: drawImage() correctly handles hardware-decoded VideoFrames
  // (NV12/P010 GPU textures) that WebGL texImage2D silently renders as black.
  ctx2d = canvas.getContext('2d');

  // Re-request fullscreen if we somehow lost it (e.g. user pressed Escape).
  if (!document.fullscreenElement) {
    requestFullscreen();
  }
}

function requestFullscreen() {
  const el = document.documentElement;
  if (el.requestFullscreen) {
    el.requestFullscreen({ navigationUI: 'hide' }).catch(() => {
      // If autoplay fullscreen is blocked, wait for first touch
      document.addEventListener('click', () => {
        el.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
      }, { once: true });
    });
  }
}

// Counter for per-frame debug logging (first N frames only).
// Maximum pending decode requests before we drop P-frames to shed latency.
const MAX_DECODE_QUEUE_SIZE = 3;
// Minimum ms between IDR requests sent to client.js (receiver-side cooldown,
// complementing the 1000ms cooldown in client.js).
const RECEIVER_IDR_COOLDOWN_MS = 500;
let _lastReceiverIdrMs = 0;
// Accumulated frames dropped due to queue pressure (logged periodically).
let _droppedFrames = 0;
let _renderedFrames = 0;
let _lastQueueLog = 0;
const _decodeTimings = new Map();
// ---------------------------------------------------------------------------
// Watchdog: detect video frame stall after streaming starts
// ---------------------------------------------------------------------------
let _wsVideoFrameCount = 0;   // binary WS frames received since last watchdog tick
let _wsStreamStarted = false; // true after first binary frame arrives
let _watchdogTimer   = null;  // setInterval handle
/** rendered count as of the previous watchdog tick – used to detect stalls. */
let _lastWatchdogRendered = 0;

const WATCHDOG_INTERVAL_MS = 3000;

/** Start (or restart) the watchdog timer. Call after video WS opens. */
function startWatchdog() {
  clearInterval(_watchdogTimer);
  _wsVideoFrameCount    = 0;
  _wsStreamStarted      = false;
  _lastWatchdogRendered = 0;
  _watchdogTimer = setInterval(() => {
    const framesIn   = _wsVideoFrameCount;
    _wsVideoFrameCount = 0;
    const qSize  = videoDecoder?.decodeQueueSize ?? '?';
    const state  = videoDecoder?.state ?? 'null';
    rlog(`[DIAG] Video frames/${WATCHDOG_INTERVAL_MS}ms: ${framesIn}` +
         ` | rendered: ${_renderedFrames}` +
         ` | decoder: state=${state} queue=${qSize}`);

    // Case 1: server stopped sending frames.
    if (_wsStreamStarted && framesIn === 0) {
      rlog('[WARN] Video frame stall detected – requesting IDR');
      requestIdrFromReceiver(true, true); // bypass both cooldowns for stall recovery
    }
    // Case 2: frames arriving but decoder output frozen.
    // This happens when needsKeyFrame=true was set by queue overflow and the
    // subsequent IDR request was rate-limited, leaving the decoder stuck
    // silently dropping every non-IDR frame.  Detected when the rendered
    // count has not increased despite WS frames continuing to arrive.
    if (_wsStreamStarted && framesIn > 0 && _renderedFrames === _lastWatchdogRendered) {
      rlog('[WARN] Rendered count frozen despite video frames arriving – forcing IDR');
      requestIdrFromReceiver(true, true); // bypass both cooldowns for freeze recovery
    }
    _lastWatchdogRendered = _renderedFrames;
  }, WATCHDOG_INTERVAL_MS);
}

/** Stop the watchdog. Call when the video WS closes or page is unloaded. */
function stopWatchdog() {
  clearInterval(_watchdogTimer);
  _watchdogTimer = null;
}

// ── Latency statistics for the server's bitrate control ─────────────────────
// Reported on frame *arrival* (not on render) so that samples keep flowing while
// the decoder waits for a key frame, i.e. exactly when the link is congested.
const STATS_EVERY_N_FRAMES = 60;
let _statsFrameCount = 0;
let _lastDecodeMs = 0;            // receive-to-output time of the last decoded frame
let _clientTimeOriginMs = null;   // client.js performance.timeOrigin (from init)

/** Current time on client.js's performance.now() clock (the tracking timestamp clock). */
function clientClockNowMs() {
  if (_clientTimeOriginMs === null) return performance.now();
  return performance.now() + performance.timeOrigin - _clientTimeOriginMs;
}

function onVideoFrameArrived(timestampNs) {
  if (++_statsFrameCount % STATS_EVERY_N_FRAMES !== 0) return;
  const arrivalMs = clientClockNowMs() - Number(timestampNs) / 1e6;
  // Without a valid clock mapping the sample would corrupt the estimate: skip it.
  if (!(arrivalMs >= 0 && arrivalMs < 10_000)) return;
  sendReceiverStats({
    target_timestamp_ns: Number(timestampNs),
    frame_interval_ms: 1000 / (codecConfig?.refresh_rate || 90),
    video_decode_ms: _lastDecodeMs,
    video_decoder_queue_ms: 0,
    rendering_ms: 0,
    vsync_queue_ms: 0,
    total_pipeline_latency_ms: arrivalMs + _lastDecodeMs,
  });
}

/** Ask client.js to request an IDR from the ALVR server.
 * @param {boolean} [bypassReceiverCooldown=false]  Skip the RECEIVER_IDR_COOLDOWN_MS
 *   guard.  Use for events where the decoder must receive a keyframe immediately:
 *   initial WS subscribe, decoder error, watchdog stall/freeze detection.
 * @param {boolean} [bypassClientCooldown=false]  Attach force:true so client.js
 *   skips its own IDR_COOLDOWN_MS guard.  Use whenever the receiver cannot rely on
 *   1 s having already elapsed since the last client-side IDR request — for example
 *   when the events-WS IDR fires milliseconds before this WS is even subscribed.
 */
function requestIdrFromReceiver(bypassReceiverCooldown = false, bypassClientCooldown = false) {
  if (videoDecoder?.state !== 'configured') return;
  const nowMs = performance.now();
  if (!bypassReceiverCooldown && nowMs - _lastReceiverIdrMs < RECEIVER_IDR_COOLDOWN_MS) return;
  _lastReceiverIdrMs = nowMs;
  const msg = bypassClientCooldown
    ? { type: 'request_idr', force: true }
    : { type: 'request_idr' };
  if (IS_NATIVE_APP) {
    try { window.AlvrNativeBridge.postToClient(JSON.stringify(msg)); } catch (_) {}
  } else if (channel) {
    try { channel.postMessage(msg); } catch (_) {}
  }
}

function showOverlay(message) {
  const overlay = document.getElementById('overlay');
  if (!overlay) return;
  overlay.classList.remove('hidden');
  for (const label of overlay.querySelectorAll('.overlay-message')) {
    label.textContent = message;
  }
}

function hideOverlay() {
  document.getElementById('overlay')?.classList.add('hidden');
}

function renderFrame(frame) {
  const timing = _decodeTimings.get(frame.timestamp);
  _decodeTimings.delete(frame.timestamp);
  if (timing) _lastDecodeMs = Math.max(0, performance.now() - timing.receivedAtMs);

  // Hide the "Waiting…" overlay on the very first rendered frame.
  const overlay = document.getElementById('overlay');
  if (overlay && !overlay.classList.contains('hidden')) {
    hideOverlay();
    rlog('First frame rendered');
  }

  _renderedFrames++;

  if (ctx2d) {
    // Close the VideoFrame immediately after handing it to createImageBitmap().
    // createImageBitmap() starts an async GPU blit and reads the frame data
    // right away, so the VideoFrame does not need to stay alive while we wait
    // for the Promise to resolve.  Keeping many VideoFrames open simultaneously
    // (one per pending Promise) exhausts the WebCodecs decoder's output slot
    // budget and silently stalls the decoder — which manifests as a video freeze
    // with no error log.  Closing the frame here keeps the slot count at ≤1.
    const bitmapPromise = createImageBitmap(frame);
    frame.close(); // release decoder output slot immediately
    bitmapPromise
      .then(bitmap => {
        ctx2d.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        bitmap.close();
      })
      .catch(e => {
        _bitmapErrors++;
        const nowMs = performance.now();
        // Rate-limit to once per second to avoid log flooding.
        if (nowMs - _lastBitmapErrorLogMs >= 1000) {
          _lastBitmapErrorLogMs = nowMs;
          rlog(`[ERROR] createImageBitmap failed (total: ${_bitmapErrors}): ${e?.message ?? e}`);
        }
      });
  } else {
    rlog(`[ERROR] renderFrame #${_renderedFrames}: ctx2d is null — frame dropped`);
    frame.close();
  }
}

function sendReceiverStats(stats) {
  const msg = { type: 'receiver_stats', stats };
  if (IS_NATIVE_APP) {
    try { window.AlvrNativeBridge.postToClient(JSON.stringify(msg)); } catch (_) {}
  } else if (channel) {
    try { channel.postMessage(msg); } catch (_) {}
  }
}

// ---------------------------------------------------------------------------
// Video WebSocket
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// WebTransport video session (receiver.js)
// ---------------------------------------------------------------------------

/** Convert lowercase hex string to Uint8Array for WT certificate pinning. */
function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length >> 1);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes;
}

/**
 * Open a WebTransport video session at `/wt/video`.
 * The server sends one unidirectional stream per video frame (type 0x02)
 * and a config stream (type 0x01) on codec/resolution changes.
 * Falls back to WebSocket on any error.
 */
async function openVideoWt(generation = _videoGeneration) {
  if (!videoGenerationIsActive(generation) || !_wtVideoUrl || !_wtVideoFp) return;
  videoDecoder?.close();
  videoDecoder = null;
  // Close any existing WS/WT connection first.
  if (_wtVideoSession) {
    try { _wtVideoSession.close(); } catch (_) {}
    _wtVideoSession = null;
  }
  if (videoWs && videoWs.readyState !== WebSocket.CLOSED) {
    videoWs.onclose = null;
    videoWs.close();
    videoWs = null;
  }

  rlog(`[WT] Opening video session at ${_wtVideoUrl}`);
  let wt = null;
  try {
    const fpBytes = hexToBytes(_wtVideoFp);
    wt = new WebTransport(_wtVideoUrl, {
      serverCertificateHashes: [{ algorithm: 'sha-256', value: fpBytes.buffer }],
    });
    await wt.ready;
    if (!videoGenerationIsActive(generation)) {
      wt.close();
      return;
    }
    _wtVideoSession = wt;
    resetWtReorderBuffer();
    rlog('[WT] Video session established');

    needsKeyFrame = true;
    initDecoder();

    // Reconnect on closure.
    wt.closed.then(() => {
      if (_wtVideoSession !== wt || !videoGenerationIsActive(generation)) return;
      stopWatchdog();
      videoDecoder?.close();
      videoDecoder = null;
      _wtVideoSession = null;
      // _wtVideoUrl is cleared by the disconnect handler to suppress reconnect.
      if (!_wtVideoUrl) {
        rlog('[WT] Video session closed (disconnect — no reconnect)');
        return;
      }
      rlog('[WT] Video session closed — reconnecting in 2s…');
      showOverlay('Stream disconnected. Reconnecting…');
      scheduleVideoReconnect('wt-video', () => openVideoWt(generation), 2000, generation);
    }).catch(() => {});

    // Read server-initiated unidirectional streams.
    const streamsReader = wt.incomingUnidirectionalStreams.getReader();
    for (;;) {
      const { value: streamReadable, done } = await streamsReader.read();
      if (done) {
        rlog('[WT] incomingUnidirectionalStreams reader done (session closed)');
        break;
      }
      if (_wtVideoSession !== wt || !videoGenerationIsActive(generation)) {
        await streamsReader.cancel();
        break;
      }
      _handleWtVideoStream(streamReadable, generation);
    }
  } catch (err) {
    if (!videoGenerationIsActive(generation)) return;
    rlog(`[WT] Video session error: ${err.name ?? ''} ${err.message} — WebSocket fallback in 2s`);
    if (_wtVideoSession === wt) _wtVideoSession = null;
    try { wt?.close(); } catch (_) {}
    stopWatchdog();
    videoDecoder?.close();
    videoDecoder = null;
    scheduleVideoReconnect(
      'ws-video-fallback',
      () => openVideoWs(_wsVideoUrl, generation),
      2000,
      generation,
    );
  }
}

/**
 * Handle one server-initiated unidirectional stream from the video session.
 * Stream type byte: 0x01 = config JSON, 0x02 = binary video frame.
 */
async function _handleWtVideoStream(streamReadable, generation) {
  const reader = streamReadable.getReader();
  const chunks = [];
  let totalLen = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value);
      totalLen += value.length;
    }
  } catch (err) {
    rlog(`[WT] stream read error: ${err.message}`);
    return;
  }
  if (!videoGenerationIsActive(generation)) return;
  if (totalLen === 0) return;

  const buf = new Uint8Array(totalLen);
  let off = 0;
  for (const c of chunks) { buf.set(c, off); off += c.length; }

  const streamType = buf[0];
  const payload    = buf.subarray(1);

  if (streamType === 0x01) {
    // Config / event JSON (newline-delimited).
    const text = new TextDecoder().decode(payload);
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const msg = JSON.parse(trimmed);
        if (msg.codec) {
          const sameConfig = codecConfig &&
            codecConfig.codec             === msg.codec &&
            codecConfig.width             === msg.width &&
            codecConfig.height            === msg.height &&
            codecConfig.config_buffer_b64 === msg.config_buffer_b64;
          rlog(`[WT] Config: ${msg.codec} ${msg.width}×${msg.height} @ ${msg.refresh_rate}fps (${sameConfig ? 'same' : 'changed'})`);
          codecConfig = msg;
          if (!sameConfig) {
            initCanvas();
            initDecoder();
            needsKeyFrame = true;
          }
        }
      } catch (_) {}
    }
  } else if (streamType === 0x02) {
    // Binary video frame: same layout as WebSocket binary frame.
    // [0..8] frame_id u64 LE, [8..16] timestamp_nanos u64 LE,
    // [16] is_idr u8, [17..] NAL payload.
    if (payload.length < 17) {
      rlog(`[WARN] _handleWtVideoStream: payload too short (${payload.length} bytes, need ≥17)`);
      return;
    }

    _wsVideoFrameCount++;
    _wsStreamStarted = true;

    const idLo = (payload[0] | (payload[1] << 8) | (payload[2] << 16) | (payload[3] << 24)) >>> 0;
    const idHi = (payload[4] | (payload[5] << 8) | (payload[6] << 16) | (payload[7] << 24)) >>> 0;
    const frameId = BigInt(idLo) | (BigInt(idHi) << 32n);

    // Parse 8-byte little-endian timestamp. Use >>> 0 to force unsigned 32-bit
    // interpretation: JS bitwise ops return signed 32-bit, which overflows for
    // timestamps ≥ 2^31 ns (~2.1 s). >>> 0 converts to the correct unsigned value.
    const tsLo = (payload[8] | (payload[9] << 8) | (payload[10] << 16) | (payload[11] << 24)) >>> 0;
    const tsHi = (payload[12] | (payload[13] << 8) | (payload[14] << 16) | (payload[15] << 24)) >>> 0;
    const timestampNs = BigInt(tsLo) | (BigInt(tsHi) << 32n);
    const isIdr = payload[16] !== 0;
    const nal   = payload.subarray(17);

    onVideoFrameArrived(timestampNs);
    queueWtVideoFrame({ frameId, timestampNs, isIdr, nal }, generation);
  } else {
    // Unknown stream type – always log
    const typeHex = streamType.toString(16).padStart(2, '0');
    rlog(`[WARN] _handleWtVideoStream: unknown stream type 0x${typeHex} len=${totalLen} (expected 0x01 or 0x02)`);
  }
}

function queueWtVideoFrame(frame, generation) {
  if (!videoGenerationIsActive(generation)) return;
  if (_wtNextFrameId === null) _wtNextFrameId = frame.frameId;
  if (frame.frameId < _wtNextFrameId) {
    // While waiting for a key frame, a late IDR newer than the last decoded
    // frame is still usable: resynchronise from it instead of discarding it.
    if (needsKeyFrame && frame.isIdr &&
        (_wtLastDecodedId === null || frame.frameId > _wtLastDecodedId)) {
      resyncFromLateIdr(frame);
      return;
    }
    // Late successors of a (possibly still in-flight) late IDR are kept too.
    if (needsKeyFrame && !frame.isIdr) stashKeyWaitFrame(frame);
    return;
  }
  if (_wtPendingFrames.has(frame.frameId)) return;

  _wtPendingFrames.set(frame.frameId, frame);
  drainWtVideoFrames(generation);
}

function clearWtGap() {
  _wtGapSinceMs = null;
  clearTimeout(_wtReorderTimer);
  _wtReorderTimer = null;
}

function drainWtVideoFrames(generation) {
  let drained = 0;
  while (_wtNextFrameId !== null) {
    let frame = _wtPendingFrames.get(_wtNextFrameId);
    if (!frame) {
      if (_wtPendingFrames.size === 0) {
        clearWtGap();
        return;
      }
      const nowMs = performance.now();
      if (_wtGapSinceMs === null) _wtGapSinceMs = nowMs;
      let lowestId = null;
      let lowestIdrId = null;
      for (const [id, f] of _wtPendingFrames) {
        if (lowestId === null || id < lowestId) lowestId = id;
        if (f.isIdr && (lowestIdrId === null || id < lowestIdrId)) lowestIdrId = id;
      }
      // Keep waiting for the missing frame unless an IDR makes it irrelevant,
      // we are already waiting for a key frame, or the window has expired.
      const waitedMs = nowMs - _wtGapSinceMs;
      if (lowestIdrId === null && !needsKeyFrame &&
          waitedMs < WT_REORDER_WINDOW_MS && _wtPendingFrames.size < WT_REORDER_MAX_FRAMES) {
        clearTimeout(_wtReorderTimer);
        _wtReorderTimer = setTimeout(() => {
          _wtReorderTimer = null;
          if (videoGenerationIsActive(generation)) drainWtVideoFrames(generation);
        }, WT_REORDER_WINDOW_MS - waitedMs);
        return;
      }
      // An IDR does not reference earlier frames: jump straight to it and drop
      // the buffered frames before it.  Otherwise skip to the lowest buffered
      // frame and wait for a key frame.
      const targetId = lowestIdrId ?? lowestId;
      for (const id of [..._wtPendingFrames.keys()]) {
        if (id < targetId) _wtPendingFrames.delete(id);
      }
      clearWtGap();
      _wtNextFrameId = targetId;
      frame = _wtPendingFrames.get(targetId);
      if (!frame.isIdr && !needsKeyFrame) {
        needsKeyFrame = true;
        requestIdrFromReceiver(true, true);
      }
    }

    _wtPendingFrames.delete(frame.frameId);
    _wtNextFrameId = frame.frameId + 1n;
    if (!frame.isIdr && needsKeyFrame) {
      stashKeyWaitFrame(frame);
      retryIdrWhileWaiting('key-frame wait');
      continue;
    }
    if (frame.isIdr) {
      needsKeyFrame = false;
      _wtKeyWaitStash.clear();
      onIdrDecoded();
    }
    // Frames released together after a gap closes are a burst: bypass the
    // decode-queue back-pressure so the burst is not dropped into a key-frame wait.
    decodeFrame(frame.timestampNs, frame.isIdr, frame.nal, drained > 0);
    drained++;
    _wtLastDecodedId = frame.frameId;
  }
}

function openVideoWs(wsUrl, generation = _videoGeneration) {
  if (!videoGenerationIsActive(generation) || !wsUrl) return;
  videoDecoder?.close();
  videoDecoder = null;
  // Close any existing connection before opening a new one.  openVideoWs()
  // can be called while a WS is already open (e.g., when handleInitMessage
  // is invoked on page reuse, or if a config change triggers re-init).
  // Without this guard, the old WS becomes an orphaned server subscriber that
  // doubles decode work and causes spurious IDR requests.
  if (videoWs && videoWs.readyState !== WebSocket.CLOSED) {
    videoWs.onclose = null; // prevent auto-reconnect from the old WS
    videoWs.close();
  }
  const ws = new WebSocket(wsUrl);
  videoWs = ws;
  ws.binaryType = 'arraybuffer';

  ws.onopen = () => {
    if (videoWs !== ws || !videoGenerationIsActive(generation)) return;
    rlog('Video WebSocket connected');
    needsKeyFrame = true;
    initDecoder();
  };

  ws.onmessage = e => {
    if (videoWs !== ws || !videoGenerationIsActive(generation)) return;
    if (typeof e.data === 'string') {
      // VideoConfigMessage (JSON text frame)
      try {
        const msg = JSON.parse(e.data);
        if (msg.codec) {
          // Only reinitialise canvas + decoder when the config actually changes.
          // The server sends a new config message before every IDR frame, so
          // identical-config messages are very common.  Re-initialising on each
          // one would close the decoder before it can output any frames.
          const sameConfig = codecConfig &&
            codecConfig.codec             === msg.codec &&
            codecConfig.width             === msg.width &&
            codecConfig.height            === msg.height &&
            codecConfig.config_buffer_b64 === msg.config_buffer_b64;

          rlog(`Config received: ${msg.codec} ${msg.width}×${msg.height} @ ${msg.refresh_rate}fps (${sameConfig ? 'same – skip reset' : 'changed – reinit'})`);
          codecConfig = msg;

          if (!sameConfig) {
            // Config genuinely changed (resolution / codec switch).
            // Re-initialise canvas + WebGL, then the decoder.
            initCanvas();
            initDecoder();
            needsKeyFrame  = true;
          }
          // If config is the same, leave the running decoder untouched.
        }
      } catch (_) {}
      return;
    }

    const buf = new Uint8Array(e.data);
    if (buf.length < 9) return;

    // Count every binary frame for the watchdog.
    _wsVideoFrameCount++;
    _wsStreamStarted = true;

    // Parse 8-byte little-endian timestamp. >>> 0 ensures unsigned 32-bit.
    const tsLo = (buf[0] | (buf[1] << 8) | (buf[2] << 16) | (buf[3] << 24)) >>> 0;
    const tsHi = (buf[4] | (buf[5] << 8) | (buf[6] << 16) | (buf[7] << 24)) >>> 0;
    const timestampNs = BigInt(tsLo) | (BigInt(tsHi) << 32n);
    const isIdr = buf[8] !== 0;
    const nal   = buf.slice(9);
    onVideoFrameArrived(timestampNs);

    // After configure() the decoder requires the very first chunk to be a key
    // frame.  Drop any delta frames that arrive before the first IDR instead of
    // throwing an error (the server will send another IDR shortly).
    if (!isIdr && needsKeyFrame) {
      retryIdrWhileWaiting('key-frame wait (WebSocket)');
      return; // wait for IDR
    }
    if (isIdr) {
      needsKeyFrame = false;
      onIdrDecoded();
    }

    decodeFrame(timestampNs, isIdr, nal);
  };

  ws.onclose = () => {
    if (videoWs !== ws || !videoGenerationIsActive(generation)) return;
    videoWs = null;
    videoDecoder?.close();
    videoDecoder = null;
    rlog('Video WebSocket closed — reconnecting in 2 s…');
    stopWatchdog();
    showOverlay('Stream disconnected. Reconnecting…');
    scheduleVideoReconnect(
      'ws-video',
      () => openVideoWs(wsUrl, generation),
      2000,
      generation,
    );
  };
}

// Close the video WS cleanly when the receiver page is unloaded (e.g., when
// client.js closes the popup via receiverWindow.close() during disconnect).
// The BroadcastChannel 'disconnect' message might not be processed before the
// page is torn down, so we add a pagehide listener as a reliable fallback to
// prevent the onclose handler from scheduling a spurious auto-reconnect timer.
window.addEventListener('pagehide', () => {
  videoDecoder?.close();
  videoDecoder = null;
  clearVideoReconnectTimers();
  resetWtReorderBuffer();
  ++_videoGeneration;
  _wtVideoUrl = null;
  _wsVideoUrl = null;
  stopWatchdog();
  if (_wtVideoSession) {
    try { _wtVideoSession.close(); } catch (_) {}
    _wtVideoSession = null;
  }
  if (videoWs) {
    videoWs.onclose = null; // suppress auto-reconnect on page unload
    videoWs.close();
  }
});

// ---------------------------------------------------------------------------
// WebCodecs decoder
// ---------------------------------------------------------------------------

function initDecoder() {
  if (!codecConfig) return;
  videoDecoder?.close();
  _decodeTimings.clear();
  videoDecoder = new VideoDecoderSession({
    output: frame => renderFrame(frame),
    onConfigured: () => {
      needsKeyFrame = true;
      startWatchdog();
      requestIdrFromReceiver(true, true);
    },
    onError: (message, fatal) => {
      needsKeyFrame = true;
      _decodeTimings.clear();
      showOverlay(`Video decoder error: ${message}`);
      if (fatal) stopWatchdog();
    },
    log: rlog,
  });
  videoDecoder.configure(codecConfig);
}

// Total number of times decodeFrame() was called with valid data.
// Timestamp of the last "decoder not configured" log (to rate-limit the message).
let _decodeSkipLogMs = 0;

/**
 * @param {boolean} [catchUp=false]  true while replaying stashed frames after a
 *   late IDR: skip the decode-queue back-pressure check, which would otherwise
 *   drop the replayed burst and immediately re-enter the key-frame wait.
 */
function decodeFrame(timestampNs, isIdr, nal, catchUp = false) {
  if (!videoDecoder || videoDecoder.state !== 'configured') {
    // Rate-limit to once per second to avoid log flooding after disconnect.
    const nowMs = performance.now();
    if (nowMs - _decodeSkipLogMs >= 1000) {
      _decodeSkipLogMs = nowMs;
      rlog(`[DBG] decodeFrame: skipped — decoder state=${videoDecoder?.state ?? 'null'}`);
    }
    return;
  }

  // Decode queue back-pressure: if the HW decoder is falling behind, drop
  // non-key frames to prevent latency accumulation.  Mark needsKeyFrame so
  // the next IDR cleanly resumes the stream.
  const queueSize = videoDecoder.decodeQueueSize;
  if (!isIdr && !catchUp && queueSize > MAX_DECODE_QUEUE_SIZE) {
    _droppedFrames++;
    needsKeyFrame = true;
    // Bypass BOTH cooldowns: this is the only IDR request that will be sent
    // until the watchdog fires, because needsKeyFrame=true causes all subsequent
    // non-IDR frames to be dropped *before* reaching the queue-size check, so
    // this code path never executes again until the next IDR restores decoding.
    // The receiver's 500 ms cooldown must not suppress this request — if it fires
    // within 500 ms of the startup IDR (videoWs.onopen), the stream would stall
    // silently for up to 6 s until the watchdog detects the frozen render count.
    requestIdrFromReceiver(true, true);
    // Log every 5 seconds to avoid flooding.
    const nowMs = performance.now();
    if (nowMs - _lastQueueLog >= 5000) {
      _lastQueueLog = nowMs;
      rlog(`[WARN] Decode queue full (${queueSize}/${MAX_DECODE_QUEUE_SIZE}) – dropped ${_droppedFrames} frames, rendered ${_renderedFrames}`);
      _droppedFrames = 0;
      // DO NOT reset _renderedFrames here.  The watchdog compares _renderedFrames
      // against _lastWatchdogRendered to detect frozen output.  Resetting
      // _renderedFrames to 0 while _lastWatchdogRendered still holds the old
      // value makes the comparison fail (0 ≠ old), masking the stall for one
      // full watchdog interval (3 s) after each queue-overflow event.
      // Instead, resync the watchdog baseline so the NEXT tick correctly
      // detects if the decoder remains frozen after the IDR round-trip.
      _lastWatchdogRendered = _renderedFrames;
    }
    return;
  }

  const timestamp = Number(timestampNs / 1000n);
  _decodeTimings.set(timestamp, {
    timestampNs,
    receivedAtMs: performance.now(),
  });
  if (_decodeTimings.size > 256) {
    _decodeTimings.delete(_decodeTimings.keys().next().value);
  }
  if (!videoDecoder.decode(timestampNs, isIdr, nal)) {
    _decodeTimings.delete(timestamp);
  }
}
