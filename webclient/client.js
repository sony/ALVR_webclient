/**
 * client.js – ALVR Web Client main controller
 *
 * Platform support:
 *   Android Native App – IMU via JavascriptInterface bridge (window.alvrOnImu)
 *   Desktop Chrome     – IMU via WebHID (direct USB access to XR glasses)
 *
 * Responsibilities:
 *   1. Connect to the ALVR Web Server (port 8083) via WebSocket
 *   2. Receive H.264/HEVC/AV1 NAL units and decode them with WebCodecs
 *   3. Render decoded frames to a local preview canvas
 *   4. Open receiver.html on the XR glasses display
 *      - Android Native App: DisplayManager + Presentation (controlled by Java)
 *      - Windows Chrome: Window Management API or window.open()
 *   5. Forward IMU tracking data to the ALVR server tracking WebSocket
 *      - Android Native App: Java ImuRelayManager → window.alvrOnImu() callback
 *      - Desktop Chrome: Direct USB access via WebHID
 *   6. Forward DualSense controller input (WebHID / Android bridge) to the ALVR server
 */

'use strict';

import { VideoDecoderSession } from './video-decoder.js';
import {
  createDualSenseHid,
} from './dualsense-hid.js';
import {
  RAYNEO_HID_FILTERS,
  RAYNEO_VID,
  createRayneoHidAdapter,
  pickRayneoImuDevice,
  sendRayneoImuOff,
  sendRayneoImuOn,
} from './rayneo-hid.js';
import {
  VITURE_HID_FILTERS,
  VITURE_VID,
  VITURE_PRO_2_PID,
  createVitureHidAdapter,
  findVitureControlDevice,
  pickVitureImuDevice,
} from './viture-hid.js';
import {
  XREAL_HID_FILTERS,
  XREAL_VID,
  createXrealHidAdapter,
  pickXrealImuDevice,
  sendXrealImuStart,
  sendXrealImuStop,
} from './xreal-hid.js';

// ---------------------------------------------------------------------------
// Platform detection
// ---------------------------------------------------------------------------

/** true when running inside the alvr_webclient Android native app */
const IS_NATIVE_APP = (typeof window.AlvrNativeBridge !== 'undefined');
const IS_ANDROID    = /Android/i.test(navigator.userAgent);
const HAS_WEBHID    = ('hid' in navigator);

// audio output gain to compensate for WASAPI post-volume capture
const AUDIO_OUTPUT_GAIN = 5.0;

// ---------------------------------------------------------------------------
const XR_HID_FILTERS = [
  ...XREAL_HID_FILTERS,
  ...VITURE_HID_FILTERS,
  ...RAYNEO_HID_FILTERS,
];

// ---------------------------------------------------------------------------
// DualSense → Oculus Touch button / axis mapping
// Browser HID report decoding is handled by dualsense-hid.js.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Application state
// ---------------------------------------------------------------------------

let serverHost = 'localhost';
let serverPort = 8083;
// Fall back to https/wss when loading from the file: protocol (Android assets).
// The ALVR server only accepts HTTPS/WSS on port 8083.
const _proto   = window.location.protocol === 'file:' ? 'https:' : window.location.protocol;
const baseUrl  = () => `${_proto}//${serverHost}:${serverPort}`;
const wsBase   = () => `${_proto === 'https:' ? 'wss' : 'ws'}://${serverHost}:${serverPort}`;
let videoWs    = null;   // WebSocket: ALVR server → client (video)
let _videoWsFrameCount = 0;  // binary frames received on videoWs since last IMU-DBG log
// True once receiver.js owns the video stream (after sendReceiverInit()).
// The local preview /ws/video must stay closed from then on: a second video
// subscriber doubles the stream bitrate and saturates Wi-Fi.
let _receiverOwnsVideo = false;
let trackingWs = null;   // WebSocket: client → ALVR server (tracking)
let eventsWs   = null;   // WebSocket: ALVR server → client (events)

let _sessionGeneration = 0;
let _sessionState = 'idle'; // idle | connecting | connected | disconnecting
const _reconnectTimers = new Map();

function clearReconnectTimers() {
  for (const timerId of _reconnectTimers.values()) clearTimeout(timerId);
  _reconnectTimers.clear();
}

function sessionIsActive(generation = _sessionGeneration) {
  return generation === _sessionGeneration &&
    (_sessionState === 'connecting' || _sessionState === 'connected');
}

function scheduleReconnect(key, callback, delayMs, generation = _sessionGeneration) {
  const previous = _reconnectTimers.get(key);
  if (previous) clearTimeout(previous);
  const timerId = setTimeout(() => {
    _reconnectTimers.delete(key);
    if (sessionIsActive(generation)) callback();
  }, delayMs);
  _reconnectTimers.set(key, timerId);
}

async function reconnectAfterServerRestart() {
  await disconnect();
  const generation = _sessionGeneration;
  const timerId = setTimeout(() => {
    _reconnectTimers.delete('server-restart');
    if (generation === _sessionGeneration && _sessionState === 'idle') connect();
  }, 3000);
  _reconnectTimers.set('server-restart', timerId);
}

// ── WebTransport state ───────────────────────────────────────────────────────
// When WebTransport is available the control session replaces trackingWs
// (tracking datagrams) and eventsWs (server events stream).
// videoWs is a WebSocket for the preview canvas in client.js; it is closed once
// receiver.js opens its own /wt/video (or /ws/video) session for the XR display.
let wtSession      = null;   // WebTransport control session
let _wtDgramWriter = null;   // cached datagram writer (avoids getWriter() per send)
let _usingWt       = false;  // true while WebTransport is the active transport
let _wtFpHex       = null;   // lowercase hex SHA-256 fingerprint of the WT certificate
const _wtTextEnc   = new TextEncoder(); // reused across tracking datagram sends
let _wtDgramErrors = 0;      // datagram write error count (diagnostic only)
// Button/axis events are sent via a dedicated client-initiated unidirectional
// QUIC stream for reliable delivery (Fix B: prevents axis=0.0 loss on datagram drop).
let _wtButtonWriter = null;  // WritableStreamDefaultWriter for the button stream

// ── Audio state ─────────────────────────────────────────────────────────────
let audioCtx       = null;   // AudioContext for game audio playback
let audioOutWs     = null;   // WebSocket: ALVR server → client (game audio PCM)
let audioInWs      = null;   // WebSocket: client → ALVR server (mic PCM)
let audioOutNode   = null;   // AudioWorkletNode (alvr-audio-out)
let audioInNode    = null;   // AudioWorkletNode (alvr-audio-in)
let audioGainNode  = null;   // GainNode: volume compensation (WASAPI loopback is post-volume)
let micStream      = null;   // MediaStream from getUserMedia
let audioWorkletLoaded = false; // true after addModule() succeeds once
let audioOutDecoder = null;  // WebCodecs AudioDecoder (Opus game audio)
let audioInSender   = null;  // Microphone sender (Opus or PCM), see createMicSender()
// Set after an Opus failure so that reconnects fall back to PCM.
let _opusOutDisabled = false;
let _opusInDisabled  = false;
let _opusDecodeSupport = null; // cached Promise<boolean>
const OPUS_OUT_CONFIG = { codec: 'opus', sampleRate: 48000, numberOfChannels: 2 };
const OPUS_PACKET_US = 20000;          // server sends 20 ms Opus packets
const OPUS_MIC_BITRATE = 24000;        // mono voice
const NATIVE_MIC_SAMPLE_RATE = 48000;  // AlvrAudioBridge records at 48 kHz
// Older servers do not answer the mic config; send PCM after this delay.
const MIC_CODEC_REPLY_TIMEOUT_MS = 3000;
// Audio feature version tag — appears in DevTools immediately on page load.
// If this line is absent in the console, the old binary is still running.
console.log('[ALVR][audio] client.js audio module v2 (Opus) loaded');

let videoDecoder  = null;
let codecConfig   = null;  // VideoConfigMessage from server
let previewCtx    = null;  // CanvasRenderingContext2D for local preview

// Tracking heartbeat – sends a pose to the server at ~60 Hz even when no
// IMU device is connected.  Without continuous pose updates SteamVR's
// compositor never calls Present() on the first connection, so no video
// frames are produced and only a gray screen appears.
let trackingHeartbeatId = null;
let lastTrackedPose = {
  qw: 1, qx: 0, qy: 0, qz: 0,
  gyrX: 0, gyrY: 0, gyrZ: 0,
  accX: 0, accY: 0, accZ: 0,
};

// Statistics
let frameCount     = 0;

// ---------------------------------------------------------------------------
// Debug: IMU tracking diagnostics
// ---------------------------------------------------------------------------

/** Total number of times sendImuTracking has been called. */
let _imuSendCount = 0;
/** How many of the above were from the heartbeat (not a real IMU device). */
let _imuHeartbeatCount = 0;
/** Timestamp of the last periodic diagnostic log. */
let _imuLastLogTime = 0;
/** Set to true while processing a real IMU input report (not the heartbeat). */
let _imuFromDevice = false;
/** Set to true while the server connection is active (tracking WS open).
 *  IMU data is not sent to ALVR while false, preventing unnecessary processing
 *  and log noise after Disconnect / before the next Connect. */
let _imuStreamingEnabled = false;
const TRACKING_SEND_RATE_HZ = 90;
const TRACKING_SEND_INTERVAL_MS = 1000 / TRACKING_SEND_RATE_HZ;
let _lastTrackingSendMs = 0;

// WebHID state (desktop Chrome)
let hidDevice     = null;  // selected HIDDevice (XR glasses)
let hidControlDevice = null; // optional command-only VITURE HIDDevice
let _vitureImuDeviceConfirmed = false;
let _hidRawDump   = true;  // true until the first input report is received
// Watchdog: detects when the device goes silent and triggers close→reopen recovery
let _lastHidInputReportMs = 0;    // performance.now() at last inputreport
let _hidWatchdogId        = null; // setInterval handle; non-null while device open

// DualSense state shared with the Android native bridge.
let dsHidConnected   = false;
let dsConnectionType = null;   // 'usb' | 'bluetooth' | null
let dsPrevButtons    = {};     // { path: value } – for delta detection
let dsPrevAxes       = {};     // { path: value } – for delta detection
let dsPendingButtons = [];     // Button entries to include in the next /ws/tracking send.
let _pendingRecenter = false;  // One-shot flag to send recenter: true in the next sendImuTracking().
let _recenterYaw    = 0;       // headQuat yaw (radians) at the most recent recenter.
                               // Used to align L-Stick / D-pad movement with SteamVR coordinates.
                               // effectiveYaw = dsVirtualYaw - _recenterYaw
// Virtual 6DoF mode
let dsVirtual6DofMode  = false;   // Toggled by a short press of Options.
let dsOptionsHoldStart = 0;       // Time Options was pressed (ms; 0 = not pressed).
let dsOptionsWasHeld   = false;   // Whether the long-press threshold has been reached.
let _dsTpClickPrev     = false;   // Previous touchpad click state.
let _dsTpLastClickMs   = null;    // Time of the last single touchpad click (ms), for double-click detection.

// Virtual camera orientation
let dsVirtualPos   = { x: 0, y: 1.36, z: 0 };
let dsVirtualYaw   = 0;   // Horizontal rotation angle (rad).
let dsVirtualPitch = 0;   // Vertical rotation angle (rad).
let dsLastMoveTime = 0;

// Game loop (DPAD / stick -> time-based movement)
let _dsDpadHeld      = { up: false, down: false, left: false, right: false };
let _dsStickHeld     = { lx: 0, ly: 0, rx: 0, ry: 0 };  // Deadzone already applied.
let _dsGameLoopId    = null;   // requestAnimationFrame handle
let _dsGameLoopPrev  = null;   // performance.now() from the previous frame.

// IDR request throttling – prevent IDR spiral caused by RecvError::Lagged storm
let _lastIdrRequestMs  = 0;
const IDR_COOLDOWN_MS  = 1000;  // at most one IDR request per second

// Threshold for considering a trigger pressed.
const TRIGGER_THRESHOLD = 0.1;

// Virtual controllers
const DS_TP_WIDTH    = 1920;
const DS_TP_HEIGHT   = 942;
const DS_TP_CENTER_X = DS_TP_WIDTH / 2;
let dsTouchToSide      = {};   // { [touchId]: 'left' | 'right' }
let dsActiveControllers = {};  // { left?: {x,y}, right?: {x,y} }
let dsTouchDepthMode    = false;  // false: vertical movement; true: forward/backward movement.
const DS_CONTROLLER_DEFAULT_DEPTH = -0.3;  // Default camera-local Z position of the virtual controllers (m).
function defaultDsControllerPosition() {
  return {
    left: { x: 0, y: 0, z: DS_CONTROLLER_DEFAULT_DEPTH },
    right: { x: 0, y: 0, z: DS_CONTROLLER_DEFAULT_DEPTH },
  };
}
let dsControllerPosition = defaultDsControllerPosition();  // Last camera-local position per side (m).
let dsTouchPositionAnchors = {};  // Relative positioning origins, keyed by touch ID.

// DualSense gyro -> virtual controller rotation offset.
// One finger: live gyro offset on the 1st touched controller.
// Two fingers: the 1st controller keeps the offset it had when the 2nd finger touched
// (dsGyroHeldOffsetQuat); the live gyro offset (reset at that moment) goes to the 2nd controller.
// Touch count change resets the live offset to identity, except 2 -> 1: if the 1st finger remains it
// resumes from dsGyroHeldOffsetQuat, if the 2nd finger remains it keeps its live offset.
// dsGyroHeldOffsetQuat itself is cleared when the count drops to 0.
let dsTouchOrder         = [];    // Active touch IDs in the order they touched (object keys are numerically sorted).
let dsGyroOffsetQuat     = { w: 1, x: 0, y: 0, z: 0 };
let dsGyroTargetSide     = null;  // 'left' | 'right' | null – controller receiving the live gyro offset.
let dsGyroHeldOffsetQuat = null;  // 1st controller's offset saved when the 2nd finger touched (null if none; kept until 0 fingers).
let dsGyroHeldSide       = null;  // 'left' | 'right' | null – controller receiving dsGyroHeldOffsetQuat.
let dsGyroHeldTouchId    = null;  // Touch ID owning dsGyroHeldOffsetQuat (the 1st finger).
let dsGyroLiveTouchId    = null;  // Touch ID owning the live dsGyroOffsetQuat.
let dsGyroPrevTouchCount = 0;
let dsGyroPrevSensorTs   = null;  // WebHID: previous raw motion timestamp (uint32, 1/3 µs units).
let dsGyroCalib          = null;  // WebHID: { bias: [x,y,z], scale: [x,y,z] (rad/s per LSB) }

let lastFrameTime  = performance.now();
let totalLatencyMs = 0;
// Last video frame timestamp (BigInt ns, from video packet header).
// performance.now()-based, same domain as tracking timestamps.
// Used in reportStats() to match the server-side history frame.
let _lastVideoTimestampNs = 0n;

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------

const $ = id => document.getElementById(id);

function setStatus(state, text) {
  const badge = $('status-badge');
  badge.className = `badge ${state}`;
  badge.textContent = text;
}

// ---------------------------------------------------------------------------
// Log level
// ---------------------------------------------------------------------------

/**
 * Current log level (hardcoded).
 *   0 = info  – only log() output is emitted (default)
 *   7 = debug – also emits logDebug() output (all [DS diag] lines)
 * To enable debug logging, change the value to 7 below and rebuild.
 */
const LOG_LEVEL_INFO  = 0;
const LOG_LEVEL_DEBUG = 7;
const _logLevel = LOG_LEVEL_INFO;

function log(msg) {
  console.log('[ALVR]', msg);
}

/** Verbose debug log – only emitted when _logLevel >= LOG_LEVEL_DEBUG. */
function logDebug(msg) {
  if (_logLevel >= LOG_LEVEL_DEBUG) console.log('[ALVR]', msg);
}

function showImuMode(mode) {
  const el = $('imu-mode');
  if (el) el.textContent = `IMU: ${mode}`;
}

// ---------------------------------------------------------------------------
// Android Native App: DualSense Bluetooth bridge callbacks.
// Java DualSenseInputProcessor calls these through evaluateJavascript.
// ---------------------------------------------------------------------------

/**
 * Callback invoked by Java DualSenseInputProcessor.
 * Includes touchpad data (available through SOURCE_TOUCHPAD over Bluetooth).
 */
window.alvrOnDsInput = function(
    stickLX, stickLY, stickRX, stickRY,
    trigL, trigR, btn0, btn1, btn2,
    tp0Active, tp0x, tp0y,
    tp1Active, tp1x, tp1y,
    tp0Id = 0, tp1Id = 1   // MotionEvent pointer IDs (stable per finger).
) {
  const tp = {
    t0: { active: !!tp0Active, id: tp0Id, x: tp0x, y: tp0y },
    t1: { active: !!tp1Active, id: tp1Id, x: tp1x, y: tp1y },
  };
  processDsInput(stickLX, stickLY, stickRX, stickRY, trigL, trigR, btn0, btn1, btn2, tp);
};

/**
 * Callback invoked by Java DualSenseGyroRelay (~60 Hz) with the body-frame rotation
 * accumulated since the previous call (unit quaternion, same axes as the WebHID path).
 */
window.alvrOnDsGyroDelta = function(qw, qx, qy, qz) {
  if (!presentationRequested) return;
  dsGyroApplyDelta({ w: qw, x: qx, y: qy, z: qz });
};

window.alvrOnDsConnected = function(connectionType) {
  dsHidConnected = false;
  dsConnectionType = connectionType || 'bluetooth';
  log(`DualSense connected via native bridge (${dsConnectionType})`);
  showDsStatus(`Connected (${dsConnectionType})`);
  startDsGameLoop();
};

window.alvrOnDsDisconnected = function() {
  dsHidConnected = false;
  dsConnectionType   = null;
  dsPrevButtons      = {};
  dsPrevAxes         = {};
  dsPendingButtons   = [];
  resetDsGyroState();
  stopDsGameLoop();
  log('DualSense disconnected (native bridge)');
  showDsStatus('–');
};

function showDsStatus(status) {
  const el = $('ds-status');
  if (el) el.textContent = `DualSense: ${status}`;
}

const dualSenseHid = createDualSenseHid({
  isNativeApp: IS_NATIVE_APP,
  log,
  logDebug,
  showDsStatus,
  onInput: input => processDsInput(
    input.stickLX, input.stickLY, input.stickRX, input.stickRY,
    input.trigL, input.trigR, input.btn0, input.btn1, input.btn2,
    input.touchPoints, input.imu,
  ),
  onConnectionChange: connectionType => {
    dsHidConnected = connectionType !== null;
    dsConnectionType = connectionType;
    if (connectionType !== null) startDsGameLoop();
  },
  onCalibration: calibration => { dsGyroCalib = calibration; },
  onDisconnected: () => {
    dsOptionsHoldStart = 0;
    dsPrevButtons = {};
    dsPrevAxes = {};
    dsPendingButtons = [];
    _dsDiagPrev = null;
    resetDsGyroState();
    stopDsGameLoop();
  },
});

const xrealHid = createXrealHidAdapter({
  log,
  onTracking: sendDeviceTracking,
});
const vitureHid = createVitureHidAdapter({
  log,
  onTracking: sendDeviceTracking,
});
const rayneoHid = createRayneoHidAdapter({
  log,
  onTracking: sendDeviceTracking,
});

function showDsPose(pos, yawRad, pitchRad) {
  const el = $('ds-pose');
  if (!el) return;
  const m = v => v.toFixed(2);
  const deg = v => (v * 180 / Math.PI).toFixed(1);
  el.textContent = `Pose: (${m(pos.x)}, ${m(pos.y)}, ${m(pos.z)}) | Yaw: ${deg(yawRad)}° Pitch: ${deg(pitchRad)}°`;
}

// ---------------------------------------------------------------------------
// Connection lifecycle
// ---------------------------------------------------------------------------

async function connect() {
  clearReconnectTimers();
  const generation = ++_sessionGeneration;
  _sessionState = 'connecting';
  _receiverOwnsVideo = false;
  serverHost = $('server-host').value.trim() || window.location.hostname || 'localhost';
  serverPort = parseInt($('server-port').value) || 8083;

  setStatus('connecting', 'Connecting…');
  $('btn-connect').disabled = true;

  try {
    // 1. Fetch codec config (may return 204 if stream not yet started)
    const resp = await fetch(`${baseUrl()}/api/config`);
    if (resp.ok && resp.status !== 204) {
      codecConfig = await resp.json();
      log(`Codec: ${codecConfig.codec} ${codecConfig.width}×${codecConfig.height} @ ${codecConfig.refresh_rate} fps`);
      updateCodecInfo();
    }

    // 2. Open server WebSockets
    // Reset IDR cooldown so the very first IDR request of the new session
    // is never blocked by a leftover cooldown from the previous session.
    _lastIdrRequestMs = 0;

    // Try WebTransport for tracking + events (falls back to WebSocket transparently).
    _usingWt = await tryConnectWebTransport(generation);
    if (!sessionIsActive(generation)) return;
    if (!_usingWt) {
      // WebSocket fallback: open events and tracking channels.
      openEventsWs(generation);
      openTrackingWs(generation);
    }
    // Video WebSocket is used for the local preview canvas until receiver.js
    // takes over the video stream (sendReceiverInit()).
    openVideoWs(generation);
    // Audio pipeline is intentionally NOT started here.
    // It starts only when the user presses "Stream to XR Glasses" (startPresentation),
    // so that reconnecting while a game is already running does not resume audio
    // before the user explicitly requests presentation.

    // 3. IMU source selection
    await setupImuSource();
    if (!sessionIsActive(generation)) return;

    // 4. Try to connect to DualSense via WebHID (open an already-authorized device if available).
    await dualSenseHid.tryConnect();
    if (!sessionIsActive(generation)) return;

    _sessionState = 'connected';
    setStatus('connected', 'Connected');
    $('connect-panel').hidden    = true;
    $('stream-panel').hidden     = false;
    $('btn-disconnect').disabled = false;

  } catch (err) {
    if (generation !== _sessionGeneration) return;
    _sessionState = 'idle';
    log(`Connection failed: ${err}`);
    setStatus('error', 'Error: ' + err.message);
    $('btn-connect').disabled = false;
  }
}

async function disconnect() {
  clearReconnectTimers();
  const generation = ++_sessionGeneration;
  _sessionState = 'disconnecting';
  videoDecoder?.close();
  videoDecoder = null;
  $('video-error').hidden = true;
  // Notify the receiver to close the video stream and restore its overlay.
  sendToReceiver(JSON.stringify({ type: 'disconnect' }));
  presentationRequested = false;
  _receiverOwnsVideo = false;

  // Reset virtual 6DoF mode on disconnect so the next session starts with it off.
  if (dsVirtual6DofMode) {
    dsVirtual6DofMode = false;
    _dsStickHeld = { lx: 0, ly: 0, rx: 0, ry: 0 };
    log('[DualSense] Virtual 6DoF mode reset on disconnect');
  }

  // Stop IMU forwarding immediately (trackingWs.onclose is async).
  _imuStreamingEnabled = false;
  // Pause HID polling in the native app immediately (before trackingWs.onclose fires).
  window.AlvrNativeBridge?.onServerDisconnect?.();

  // Close WebTransport session (if active) before nulling WebSocket refs.
  if (_usingWt && wtSession) {
    _usingWt = false;
    const _closingWt = wtSession;
    wtSession      = null;
    _wtDgramWriter = null;
    _wtButtonWriter = null;
    _closingWt.close();
    stopTrackingHeartbeat();
  }

  // Null all onclose handlers BEFORE calling close().
  // disconnect() is async and awaits the DualSense HID adapter below.
  // During that await the JS event loop runs, so onclose handlers can fire
  // while sibling WS references are still non-null, triggering phantom
  // setTimeout reconnects that leak into the next session.
  if (videoWs)    videoWs.onclose    = null;
  if (trackingWs) trackingWs.onclose = null;
  if (eventsWs)   eventsWs.onclose   = null;
  if (audioOutWs) audioOutWs.onclose = null;
  if (audioInWs)  audioInWs.onclose  = null;

  videoWs?.close();
  trackingWs?.close();
  eventsWs?.close();
  cleanupAudio();
  if (receiverWindow && !receiverWindow.closed) receiverWindow.close();
  receiverWindow = null;
  await dualSenseHid.close();
  await closeWebHid();

  if (generation !== _sessionGeneration) return;

  videoWs = trackingWs = eventsWs = null;
  audioOutWs = audioInWs = null;
  _videoWsFrameCount = 0;

  _sessionState = 'idle';
  setStatus('disconnected', 'Disconnected');
  $('connect-panel').hidden    = false;
  $('stream-panel').hidden     = true;
  $('btn-connect').disabled    = false;
  $('btn-disconnect').disabled = true;
}

// ---------------------------------------------------------------------------
// IMU source selection
// ---------------------------------------------------------------------------

/**
 * Selects the IMU data source:
 *   - Android Native App         → Java ImuRelayManager → window.alvrOnImu() bridge
 *   - Desktop Chrome with WebHID → direct HID access
 *   - Fallback                   → no head tracking (identity pose)
 */
async function setupImuSource() {
  if (IS_NATIVE_APP) {
    // Android Native App: IMU data is injected directly from Java's
    // ImuRelayManager via window.alvrOnImu(). Register the callback here.
    window.alvrOnImu = function(pkt) {
      // Use performance.now() for timestamp to stay in the same clock domain as
      // the heartbeat. Java's System.nanoTime() is relative to device boot
      // (~68 hours = ~2.45×10^14 ns), while the heartbeat uses performance.now()
      // (page-load-relative, tens of seconds). Mixing them causes the ALVR server
      // to receive timestamps from two unrelated clock domains, producing the
      // anomalous ts=54062ms jumps visible in the dashboard log.
      const nowMs = performance.now();
      const tsNs = BigInt(Math.floor(nowMs * 1e6));

      // Suppress the tracking heartbeat while the device is actively sending.
      // The heartbeat checks _lastTrackingSendMs but this is only updated in the
      // XREAL/Mahony code path (line ~1047). The VITURE path goes directly through
      // alvrOnImu → sendImuTracking, bypassing that update. Without this line the
      // heartbeat always fires at 10 Hz alongside the device's 60 Hz stream.
      _lastTrackingSendMs = nowMs;

      _imuFromDevice = true;
      try {
        sendImuTracking(
          tsNs,
          pkt.qw  ?? 1, pkt.qx  ?? 0, pkt.qy  ?? 0, pkt.qz  ?? 0,
          pkt.gyrX ?? 0, pkt.gyrY ?? 0, pkt.gyrZ ?? 0,
          pkt.accX ?? 0, pkt.accY ?? 0, pkt.accZ ?? 0,
        );
      } finally {
        _imuFromDevice = false;
      }
    };
    showImuMode('Native Bridge');
    return;
  }

  if (!IS_ANDROID && HAS_WEBHID) {
    // Desktop Chrome: try only *already-permitted* devices (no prompt).
    // The user must click "Connect XR Glasses" to grant access
    // the first time.  This prevents an unexpected device-picker dialog
    // from blocking the connect flow when no XR glasses are plugged in.
    const devices = await navigator.hid.getDevices();
    // Check for any matching device by vendorId (not productId alone, because
    // the device may be represented as multiple HIDDevice objects per collection).
    const hasPermitted = devices.some(d =>
      d.vendorId === XREAL_VID || d.vendorId === VITURE_VID || d.vendorId === RAYNEO_VID);
    if (hasPermitted) {
      const success = await tryConnectWebHid();
      if (success) {
        showImuMode('WebHID (direct)');
        return;
      }
    }
    log('No pre-permitted WebHID device; use "Connect XR Glasses" button to pair');
  }

  // Fallback: no head tracking
  showImuMode('None (no head tracking)');
  log('No IMU source available');
}

// ---------------------------------------------------------------------------
// WebHID – direct IMU access (Windows Chrome)
// ---------------------------------------------------------------------------

/**
 * Requests access to a supported XR glasses HID device.
 * Returns true if a device was successfully opened and IMU streaming started.
 */
async function tryConnectWebHid() {
  // If a device is already open, skip silently.
  if (hidDevice) {
    log('WebHID device already open');
    return true;
  }
  try {
    // Check if a previously paired device is already available.
    // getDevices() returns HIDDevice objects; each represents one top-level
    // HID collection.  Match against our filters supporting both productId-
    // based and usagePage-based filter entries.
    const matchesAnyFilter = (device) =>
      XR_HID_FILTERS.some(f => {
        if (f.vendorId !== device.vendorId) return false;
        if (f.productId !== undefined && f.productId !== device.productId) return false;
        if (f.usagePage !== undefined) {
          // Check if any collection on this HIDDevice has the required usagePage.
          const hasPage = device.collections.some(c => c.usagePage === f.usagePage);
          if (!hasPage) return false;
        }
        return true;
      });

    /**
     * From a list of candidate HIDDevice objects (potentially one per top-level
     * HID collection of the same physical device), pick the one that carries the
     * IMU data.
     */
    const pickImuDevice = candidates =>
      pickXrealImuDevice(candidates, log) ??
      pickVitureImuDevice(candidates, log) ??
      pickRayneoImuDevice(candidates) ??
      candidates.find(d =>
        matchesAnyFilter(d) &&
        d.collections.some(c => c.usagePage === 0x0041 || c.usagePage === 0xFF00 || c.usagePage === 0xFF01)
      ) ?? candidates.find(matchesAnyFilter) ?? null;

    let devices = await navigator.hid.getDevices();

    // Log ALL candidate devices so we can diagnose collection selection.
    const allCandidates = devices.filter(matchesAnyFilter);
    log(`WebHID candidates from getDevices(): ${allCandidates.length}`);
    allCandidates.forEach((d, i) => {
      const colInfo = d.collections.map(c => {
        const ins  = c.inputReports?.map(r => `id=${r.reportId}`).join(',') ?? '-';
        const outs = c.outputReports?.map(r => `id=${r.reportId}`).join(',') ?? '-';
        return `{page=0x${c.usagePage?.toString(16)} in=[${ins}] out=[${outs}]}`;
      }).join(' ');
      log(`  [${i}] VID=${d.vendorId.toString(16)} PID=${d.productId.toString(16)} opened=${d.opened} | ${colInfo}`);
    });

    let candidatePool = allCandidates;
    let device = pickImuDevice(allCandidates);

    if (!device) {
      // Prompt user to select a device (requires user gesture).
      // requestDevice() may return MULTIPLE HIDDevice objects (one per top-level
      // collection) when the physical USB device has multiple collections.
      // We must apply pickImuDevice() to the full set, not just take index 0.
      const selected = await navigator.hid.requestDevice({ filters: XR_HID_FILTERS });
      candidatePool = selected;
      log(`requestDevice returned ${selected.length} device(s)`);
      selected.forEach((d, i) => {
        const colInfo = d.collections.map(c => {
          const ins  = c.inputReports?.map(r => `id=${r.reportId}`).join(',') ?? '-';
          const outs = c.outputReports?.map(r => `id=${r.reportId}`).join(',') ?? '-';
          return `{page=0x${c.usagePage?.toString(16)} in=[${ins}] out=[${outs}]}`;
        }).join(' ');
        log(`  selected[${i}] VID=${d.vendorId.toString(16)} PID=${d.productId.toString(16)} | ${colInfo}`);
      });
      device = pickImuDevice(selected);
      if (!device) device = selected[0]; // last-resort fallback
    }

    if (!device) return false;

    await device.open();
    hidDevice = device;
    log(`WebHID opened: ${device.productName} (VID=${device.vendorId.toString(16)} PID=${device.productId.toString(16)})`);

    // Log HID collections for diagnostics (helps confirm correct usagePage / reportId)
    for (const col of device.collections) {
      const inputs  = col.inputReports?.map(r => `id=${r.reportId} len=${r.items?.length}`).join(', ') ?? '';
      const outputs = col.outputReports?.map(r => `id=${r.reportId} len=${r.items?.length}`).join(', ') ?? '';
      log(`  collection: usagePage=0x${col.usagePage?.toString(16)} usage=0x${col.usage?.toString(16)} in=[${inputs}] out=[${outputs}]`);
    }

    let inputListenersRegistered = false;

    // Pro 2 has one V2 HID interface; do not use the legacy multi-interface discovery.
    if (device.vendorId === VITURE_VID && device.productId === VITURE_PRO_2_PID) {
      vitureHid.reset();
      device.addEventListener('inputreport', onHidInputReport);
      inputListenersRegistered = true;
      if (!await vitureHid.sendImuEnable(device, true)) {
        throw new Error('VITURE Pro 2 IMU enable failed');
      }
    }

    // Legacy VITURE devices discover the IMU interface and use the CRC-16 command.
    if (device.vendorId === VITURE_VID && device.productId !== VITURE_PRO_2_PID) {
      // macOS and Windows may enumerate the indistinguishable MCU/IMU interfaces
      // in different orders. Listen on both only until the first valid IMU packet
      // identifies the input source; the other listener is then removed.
      _vitureImuDeviceConfirmed = false;
      hidControlDevice = findVitureControlDevice(candidatePool, device);
      if (hidControlDevice && !hidControlDevice.opened) {
        await hidControlDevice.open();
        log('VITURE: opened second interface for IMU discovery');
      }

      const commandTargets = hidControlDevice ? [device, hidControlDevice] : [device];
      for (const target of commandTargets) {
        target.addEventListener('inputreport', onHidInputReport);
      }
      inputListenersRegistered = true;

      let enabled = false;
      for (const target of commandTargets) {
        enabled = await vitureHid.sendImuEnable(target, true) || enabled;
      }
      if (!enabled) throw new Error('VITURE IMU enable failed on all interfaces');
    }

    // For XREAL devices: send START_IMU_DATA command (0x19) to enable streaming.
    // Without this the device is completely silent; it does NOT auto-stream.
    if (device.vendorId === XREAL_VID) {
      xrealHid.reset();
      await sendXrealImuStart(device, log);
    }

    // For RAYNEO devices: enable IMU streaming.
    // Display mode (Side-by-side) must be set manually by the user, same as XREAL/VITURE.
    if (device.vendorId === RAYNEO_VID) {
      rayneoHid.reset();
      await sendRayneoImuOn(device, log);
    }

    // Register input report handler for devices that do not need discovery.
    if (!inputListenersRegistered) {
      device.addEventListener('inputreport', onHidInputReport);
    }

    // Start the liveness watchdog.  Reset timestamp so the first few seconds
    // of silence (before the first report arrives) do not trigger recovery.
    _lastHidInputReportMs = performance.now();
    if (!_hidWatchdogId) {
      _hidWatchdogId = setInterval(_hidWatchdogTick, 2000);
    }

    return true;
  } catch (err) {
    log(`WebHID error: ${err.message}`);
    await closeWebHid();
    return false;
  }
}

/**
 * Handles HID input reports from the XR glasses.
 * Dispatches to the appropriate parser based on vendor ID and report ID.
 *
 * @param {HIDInputReportEvent} event
 */
let _hidFirstReport = true;  // log the first report for diagnostics
function onHidInputReport(event) {
  const { device, reportId, data } = event;
  const discoveringViture =
    device.vendorId === VITURE_VID &&
    device.productId !== VITURE_PRO_2_PID &&
    !_vitureImuDeviceConfirmed &&
    (device === hidDevice || device === hidControlDevice);
  if (device !== hidDevice && !discoveringViture) {
    log(`WebHID: ignored report from non-selected device VID=${device.vendorId.toString(16)} PID=${device.productId.toString(16)}`);
    return;
  }

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

  if (_hidRawDump) {
    _hidRawDump = false;
    const rawHex = Array.from(new Uint8Array(data.buffer, data.byteOffset, Math.min(data.byteLength, 40)))
      .map(b => b.toString(16).padStart(2, '0')).join(' ');
    log('[WebHID] First input report from candidate device:');
    log(`  reportId=0x${reportId.toString(16)} len=${data.byteLength} raw[0..${Math.min(data.byteLength, 40)}]: ${rawHex}`);
  }

  if (_hidFirstReport) {
    _hidFirstReport = false;
    log(`HID first report: VID=${device.vendorId.toString(16)} PID=${device.productId.toString(16)} reportId=${reportId} len=${data.byteLength}`);
  }

  if (device.vendorId === XREAL_VID) {
    _lastHidInputReportMs = performance.now();
    xrealHid.parseReport(reportId, view);
  } else if (device.vendorId === VITURE_VID) {
    _lastHidInputReportMs = performance.now();
    if (device.productId === VITURE_PRO_2_PID) {
      vitureHid.parseReport(reportId, view, device.productId);
    } else if (vitureHid.parseReport(reportId, view, device.productId)) {
      if (!_vitureImuDeviceConfirmed) {
        const previousInputDevice = hidDevice;
        const otherDevice = device === previousInputDevice
          ? hidControlDevice
          : previousInputDevice;
        hidDevice = device;
        hidControlDevice = otherDevice;
        _vitureImuDeviceConfirmed = true;
        hidControlDevice?.removeEventListener('inputreport', onHidInputReport);
        log(`VITURE: IMU interface confirmed from valid packet; detached listener from ${hidControlDevice ? 'MCU interface' : 'no secondary interface'}`);
      }
    }
  } else if (device.vendorId === RAYNEO_VID) {
    _lastHidInputReportMs = performance.now();
    rayneoHid.parseReport(reportId, view);
  }
}

async function closeWebHid() {
  // Stop the liveness watchdog before any async awaits.
  if (_hidWatchdogId) { clearInterval(_hidWatchdogId); _hidWatchdogId = null; }
  if (hidControlDevice) {
    hidControlDevice.removeEventListener('inputreport', onHidInputReport);
    await vitureHid.sendImuEnable(hidControlDevice, false);
    await hidControlDevice.close();
    hidControlDevice = null;
  }
  if (!hidDevice) return;
  if (hidDevice.vendorId === VITURE_VID) {
    await vitureHid.sendImuEnable(hidDevice, false);
  }
  if (hidDevice.vendorId === XREAL_VID) {
    await sendXrealImuStop(hidDevice, log);
  }
  if (hidDevice.vendorId === RAYNEO_VID) {
    await sendRayneoImuOff(hidDevice, log);
  }
  hidDevice.removeEventListener('inputreport', onHidInputReport);
  await hidDevice.close().catch(() => {});
  hidDevice = null;
  _vitureImuDeviceConfirmed = false;
  _hidFirstReport = true;
  _hidRawDump = true;
  xrealHid.reset();
  vitureHid.reset();
  rayneoHid.reset();
  _lastTrackingSendMs = 0;  // reset throttle so first packet after reconnect is sent immediately
  _lastHidInputReportMs = 0;
}

// ---------------------------------------------------------------------------
// WebHID liveness watchdog
// ---------------------------------------------------------------------------

/**
 * How long (ms) the device may be silent before recovery is attempted.
 * At 60–90 Hz a 3-second gap means >180 missed reports.
 */
const HID_WATCHDOG_SILENCE_MS = 3000;

/**
 * Fired every 2 s by setInterval.  If no inputreport has arrived for
 * HID_WATCHDOG_SILENCE_MS the device is considered frozen (firmware
 * timeout, USB glitch, Chrome focus/throttle) and a close→reopen
 * recovery is attempted automatically.
 */
async function _hidWatchdogTick() {
  if (!hidDevice || !hidDevice.opened) return;
  if (!_imuStreamingEnabled) return;
  const silenceMs = performance.now() - _lastHidInputReportMs;
  if (silenceMs < HID_WATCHDOG_SILENCE_MS) return;
  log(`[WebHID] No inputreport for ${silenceMs.toFixed(0)}ms — attempting IMU recovery`);
  // Bump the timestamp now so a slow recovery does not retrigger on the next tick.
  _lastHidInputReportMs = performance.now();
  await closeWebHid();
  const ok = await tryConnectWebHid();
  if (ok) {
    log('[WebHID] IMU recovery successful');
    showImuMode('WebHID (direct)');
  } else {
    log('[WebHID] IMU recovery failed — no head tracking');
  }
}

// ---------------------------------------------------------------------------
// DualSense gyro -> virtual controller rotation offset
// ---------------------------------------------------------------------------

// Maps DualSense gyro axes [pitch(X), yaw(Y), roll(Z)] to client space: [source index, sign].
const DS_GYRO_AXIS_MAP = { x: [0, +1], y: [1, +1], z: [2, +1] };
// 'view': rotate about head/view axes (headQuat × gyro × base); 'local': about controller axes.
const DS_GYRO_COMPOSE_MODE = 'view';
const DS_GYRO_DEADBAND     = 0.5 * Math.PI / 180;  // rad/s; suppresses drift while at rest.
const DS_GYRO_MAX_DT       = 0.1;                  // s; skip integration across report gaps.
const DS_GYRO_GAIN           = 2.0;                  // Apparent rotation = gyro offset angle × gain (linear region).
const DS_GYRO_MAX_VIEW_ANGLE = Math.PI / 2;          // Per-axis asymptotic limit of the apparent rotation.
const DS_GYRO_KNEE_ANGLE     = Math.PI / 3;          // Apparent angle where soft saturation starts (0 = pure tanh).
const DS_GYRO_SAFETY_ANGLE   = 150 * Math.PI / 180;  // Max total angle of dsGyroOffsetQuat; keeps log map away from 180°.
const DS_MOTION_TS_PER_SEC = 3e6;                  // Motion timestamp unit: 1/3 µs.
// Fallback when calibration is unavailable: ±2000 °/s full scale.

function quatNormalize(q) {
  const n = Math.hypot(q.w, q.x, q.y, q.z);
  return n > 0 ? { w: q.w / n, x: q.x / n, y: q.y / n, z: q.z / n } : { w: 1, x: 0, y: 0, z: 0 };
}

/** Unit quaternion -> rotation vector (axis × angle, rad), using the w >= 0 hemisphere. */
function quatToRotVec(q) {
  const s = q.w < 0 ? -1 : 1;
  const w = s * q.w, x = s * q.x, y = s * q.y, z = s * q.z;
  const n = Math.hypot(x, y, z);
  if (n < 1e-9) return { x: 2 * x, y: 2 * y, z: 2 * z };
  const k = 2 * Math.atan2(n, w) / n;
  return { x: x * k, y: y * k, z: z * k };
}

/** Rotation vector (rad) -> unit quaternion. */
function rotVecToQuat(r) {
  const th = Math.hypot(r.x, r.y, r.z);
  if (th < 1e-9) return quatNormalize({ w: 1, x: r.x / 2, y: r.y / 2, z: r.z / 2 });
  const k = Math.sin(th / 2) / th;
  return { w: Math.cos(th / 2), x: r.x * k, y: r.y * k, z: r.z * k };
}

function limitDsGyroOffsetAngle(q) {
  const r = quatToRotVec(q);
  const th = Math.hypot(r.x, r.y, r.z);
  if (th <= DS_GYRO_SAFETY_ANGLE) return q;
  const k = DS_GYRO_SAFETY_ANGLE / th;
  return rotVecToQuat({ x: r.x * k, y: r.y * k, z: r.z * k });
}

/** Per-axis apparent angle: linear gain up to the knee, then tanh toward DS_GYRO_MAX_VIEW_ANGLE. */
function dsGyroViewAngle(v) {
  const u = DS_GYRO_GAIN * v;
  const a = Math.abs(u);
  if (a <= DS_GYRO_KNEE_ANGLE) return u;
  const span = DS_GYRO_MAX_VIEW_ANGLE - DS_GYRO_KNEE_ANGLE;
  return Math.sign(u) * (DS_GYRO_KNEE_ANGLE + span * Math.tanh((a - DS_GYRO_KNEE_ANGLE) / span));
}

/** Maps the stored gyro offset (DualSense orientation) to the rotation applied to the virtual controller. */
function dsGyroViewQuat(q) {
  const r = quatToRotVec(q);
  return rotVecToQuat({ x: dsGyroViewAngle(r.x), y: dsGyroViewAngle(r.y), z: dsGyroViewAngle(r.z) });
}

function resetDsGyroOffset() {
  dsGyroOffsetQuat = { w: 1, x: 0, y: 0, z: 0 };
}

/** Controller reset (Options long press / touchpad double click): also clears the held 1st-controller offset. */
function resetDsGyroAllOffsets() {
  resetDsGyroOffset();
  if (dsGyroHeldOffsetQuat) dsGyroHeldOffsetQuat = { w: 1, x: 0, y: 0, z: 0 };
}

/** Full reset on disconnect. */
function resetDsGyroState() {
  resetDsGyroOffset();
  dsGyroHeldOffsetQuat = null;
  dsGyroHeldSide       = null;
  dsGyroHeldTouchId    = null;
  dsGyroLiveTouchId    = null;
  dsTouchToSide        = {};
  dsActiveControllers  = {};
  dsTouchDepthMode     = false;
  dsControllerPosition = defaultDsControllerPosition();
  dsTouchPositionAnchors = {};
  _dsTpClickPrev       = false;
  _dsTpLastClickMs     = null;
  dsTouchOrder         = [];
  dsGyroTargetSide     = null;
  dsGyroPrevTouchCount = 0;
  dsGyroPrevSensorTs   = null;
  dsGyroCalib          = null;
}

/** Composes a body-frame delta rotation into the gyro offset (shared by WebHID and native paths). */
function dsGyroApplyDelta(dq) {
  if (dsGyroTargetSide === null) return;
  dsGyroOffsetQuat = limitDsGyroOffsetAngle(quatNormalize(quatMultiply(dsGyroOffsetQuat, dq)));
}

/** Integrates angular velocity (rad/s, client axes) over dtSec. */
function dsGyroIntegrateRate(gx, gy, gz, dtSec) {
  const w = Math.hypot(gx, gy, gz);
  if (w < DS_GYRO_DEADBAND) return;
  const half = w * dtSec * 0.5;
  const s = Math.sin(half) / w;
  dsGyroApplyDelta({ w: Math.cos(half), x: gx * s, y: gy * s, z: gz * s });
}

/** WebHID path: convert one raw IMU sample and integrate it. */
function handleDsGyroSample(imu) {
  const prevTs = dsGyroPrevSensorTs;
  dsGyroPrevSensorTs = imu.ts;
  if (prevTs === null || !dsGyroCalib) return;
  const dt = ((imu.ts - prevTs) >>> 0) / DS_MOTION_TS_PER_SEC;
  if (dt <= 0 || dt > DS_GYRO_MAX_DT) return;

  const raw = [imu.gx, imu.gy, imu.gz];
  const rate = i => (raw[i] - dsGyroCalib.bias[i]) * dsGyroCalib.scale[i];
  const axis = ([idx, sign]) => sign * rate(idx);
  dsGyroIntegrateRate(axis(DS_GYRO_AXIS_MAP.x), axis(DS_GYRO_AXIS_MAP.y), axis(DS_GYRO_AXIS_MAP.z), dt);
}

/** Applies the reset-on-count-change rule and picks the gyro target (dsTouchOrder must be up to date). */
function updateDsGyroTarget() {
  const count = dsTouchOrder.length;
  if (count !== dsGyroPrevTouchCount) {
    const prevCount = dsGyroPrevTouchCount;
    // A 2nd finger touched: keep the 1st controller's gyro offset applied while two fingers are down.
    if (count >= 2 && prevCount < 2) {
      dsGyroHeldOffsetQuat = dsGyroOffsetQuat;
      dsGyroHeldTouchId    = dsTouchOrder[0];
    } else if (count === 0) {
      dsGyroHeldOffsetQuat = null;
      dsGyroHeldTouchId    = null;
    }
    const remainingId = dsTouchOrder[0];
    if (count === 1 && prevCount >= 2 && remainingId === dsGyroHeldTouchId && dsGyroHeldOffsetQuat) {
      // 2 -> 1, 1st finger remains: resume from its held offset.
      dsGyroOffsetQuat = dsGyroHeldOffsetQuat;
    } else if (count === 1 && prevCount >= 2 && remainingId === dsGyroLiveTouchId) {
      // 2 -> 1, 2nd finger remains: keep its live offset.
    } else {
      resetDsGyroOffset();
    }
    dsGyroPrevTouchCount = count;
  }

  const prevTarget = dsGyroTargetSide;
  const liveIndex = count >= 2 ? 1 : 0;
  dsGyroLiveTouchId = count > 0 ? dsTouchOrder[liveIndex] : null;
  dsGyroTargetSide  = count > 0 ? (dsTouchToSide[dsGyroLiveTouchId] ?? null) : null;
  dsGyroHeldSide    = (count >= 2) ? (dsTouchToSide[dsTouchOrder[0]] ?? null) : null;
  if (dsGyroTargetSide !== prevTarget) {
    logDebug(`[DS gyro] target=${dsGyroTargetSide} held=${dsGyroHeldSide} touches=${count}`);
  }
}

/** Returns the gyro rotation offset to compose into the given side's controller, or null. */
function getDsGyroOffsetForSide(side) {
  if (side === dsGyroTargetSide) return dsGyroOffsetQuat;
  if (side === dsGyroHeldSide && dsGyroHeldOffsetQuat) return dsGyroHeldOffsetQuat;
  return null;
}

// Diagnostic: previous raw input state for change detection
let _dsDiagPrev = null;

function processDsInput(stickLX, stickLY, stickRX, stickRY,
                        trigL, trigR, btn0, btn1, btn2, tp, imu = null) {
  // Do not process DS input before the user presses "Stream to XR Glasses".
  // This prevents dsPendingButtons from accumulating stale events that would
  // be flushed as phantom button presses when streaming actually starts.
  if (!presentationRequested) return;

  // --- Diagnostic: log on any state change ---
  const _cur = { stickLX, stickLY, stickRX, stickRY, trigL, trigR, btn0, btn1, btn2 };
  if (_dsDiagPrev === null ||
      _cur.stickLX !== _dsDiagPrev.stickLX || _cur.stickLY !== _dsDiagPrev.stickLY ||
      _cur.stickRX !== _dsDiagPrev.stickRX || _cur.stickRY !== _dsDiagPrev.stickRY ||
      _cur.trigL   !== _dsDiagPrev.trigL   || _cur.trigR   !== _dsDiagPrev.trigR   ||
      _cur.btn0    !== _dsDiagPrev.btn0    || _cur.btn1    !== _dsDiagPrev.btn1    ||
      _cur.btn2    !== _dsDiagPrev.btn2) {
    const h = v => v.toString(16).padStart(2, '0');
    logDebug(`[DS diag] LX=${stickLX} LY=${stickLY} RX=${stickRX} RY=${stickRY}` +
        ` L2=${trigL} R2=${trigR}` +
        ` btn0=0x${h(btn0)} btn1=0x${h(btn1)} btn2=0x${h(btn2)}`);
    _dsDiagPrev = _cur;
  }

  const entries = [];

  // ── Buttons ──
  pushBtnEntry(entries, btn0 & 0x20, '/user/hand/right/input/a/click');       // Cross
  pushBtnEntry(entries, btn0 & 0x40, '/user/hand/right/input/b/click');       // Circle
  pushBtnEntry(entries, btn0 & 0x10, '/user/hand/left/input/x/click');        // Square
  pushBtnEntry(entries, btn0 & 0x80, '/user/hand/left/input/y/click');        // Triangle
  pushBtnEntry(entries, btn1 & 0x01, '/user/hand/left/input/squeeze/click');  // L1
  // Also send grip/value (1.0/0.0) so games that bind squeeze/value respond to L1
  const _l1v = (btn1 & 0x01) ? 1.0 : 0.0;
  if ((dsPrevAxes['l1'] ?? -1) !== _l1v) {
    dsPrevAxes['l1'] = _l1v;
    entries.push({ path: '/user/hand/left/input/squeeze/value', value: _l1v });
  }
  pushBtnEntry(entries, btn1 & 0x02, '/user/hand/right/input/squeeze/click'); // R1
  // Also send grip/value (1.0/0.0) so games that bind squeeze/value respond to R1
  const _r1v = (btn1 & 0x02) ? 1.0 : 0.0;
  if ((dsPrevAxes['r1'] ?? -1) !== _r1v) {
    dsPrevAxes['r1'] = _r1v;
    entries.push({ path: '/user/hand/right/input/squeeze/value', value: _r1v });
  }
  // Share is not supported.
  // pushBtnEntry(entries, btn1 & 0x10, '/user/hand/left/input/menu/click'); // Share
  pushBtnEntry(entries, btn2 & 0x01, '/user/hand/left/input/menu/click');     // PS
  pushBtnEntry(entries, btn1 & 0x40, '/user/hand/left/input/thumbstick/click');  // L3
  pushBtnEntry(entries, btn1 & 0x80, '/user/hand/right/input/thumbstick/click'); // R3

  // ── Triggers ──
  const l2Val = normTrigger(trigL);
  const r2Val = normTrigger(trigR);
  pushAnalogEntry(entries, l2Val, '/user/hand/left/input/trigger/value',
                             '/user/hand/left/input/trigger/click', 'trigL');
  pushAnalogEntry(entries, r2Val, '/user/hand/right/input/trigger/value',
                             '/user/hand/right/input/trigger/click', 'trigR');

  // ── Options button (short press = 6DoF toggle / long press = reset) ──
  handleOptionsButton(!!(btn1 & 0x20));
  // ── Touchpad click: toggle vertical / depth positioning; double click: reset controller offsets ──
  handleTpClick(!!(btn2 & 0x02));

  // ── DPAD: update held state (the game loop applies time-based movement) ──
  const dpad = btn0 & 0x0F;
  const dpadUp    = (dpad === 0 || dpad === 1 || dpad === 7);
  const dpadDown  = (dpad === 3 || dpad === 4 || dpad === 5);
  const dpadLeft  = (dpad === 5 || dpad === 6 || dpad === 7);
  const dpadRight = (dpad === 1 || dpad === 2 || dpad === 3);
  _dsDpadHeld = { up: dpadUp, down: dpadDown, left: dpadLeft, right: dpadRight };

  // ── Sticks ──
  const lx = normStick(stickLX);
  const ly = normStick(stickLY);
  const rx = normStick(stickRX);
  const ry = normStick(stickRY);

  const applyDZ = v => Math.abs(v) < DS_STICK_DEADZONE ? 0 : v;
  if (dsVirtual6DofMode) {
    // Only store the deadzone-adjusted state; movement is applied by the game loop.
    _dsStickHeld = { lx: applyDZ(lx), ly: applyDZ(ly), rx: applyDZ(rx), ry: applyDZ(ry) };
  } else {
    _dsStickHeld = { lx: 0, ly: 0, rx: 0, ry: 0 };  // The game loop is unnecessary when 6DoF is off.
    pushAxisEntry(entries, lx,  '/user/hand/left/input/thumbstick/x',  'lx');
    pushAxisEntry(entries, -ly, '/user/hand/left/input/thumbstick/y',  'ly');
    pushAxisEntry(entries, rx,  '/user/hand/right/input/thumbstick/x', 'rx');
    pushAxisEntry(entries, -ry, '/user/hand/right/input/thumbstick/y', 'ry');
  }

  // ── Touchpad virtual controllers ──
  updateVirtualControllers(tp);
  // ── Gyro: integrate after the touch-count reset has been decided ──
  if (imu) handleDsGyroSample(imu);

  if (entries.length > 0) {
    dsPendingButtons = dsPendingButtons.concat(entries);
  }
}

function normStick(v)   { return (2 * v) / 0xFF - 1.0; }
function normTrigger(v) { return v / 0xFF; }

function pushBtnEntry(entries, rawBit, path) {
  const val = !!rawBit;  // boolean true/false → Rust Binary(bool) → BUTTON_TYPE_BINARY
  if (dsPrevButtons[path] === val) return;
  dsPrevButtons[path] = val;
  entries.push({ path, value: val });
}

function pushAnalogEntry(entries, val, valuePath, clickPath, key) {
  const prev = dsPrevAxes[key] ?? 0;
  if (Math.abs(val - prev) <= 0.01) return;
  dsPrevAxes[key] = val;
  entries.push({ path: valuePath, value: val });
  const clicked = val > TRIGGER_THRESHOLD, prevClicked = prev > TRIGGER_THRESHOLD;
  if (clicked !== prevClicked)
    entries.push({ path: clickPath, value: clicked });  // boolean → Binary(bool)
}

function pushAxisEntry(entries, val, path, key) {
  const prev = dsPrevAxes[key] ?? 0;
  if (Math.abs(val - prev) <= 0.02) return;
  dsPrevAxes[key] = val;
  entries.push({ path, value: val });
}

// ── Virtual 6DoF ──────────────────────────────────────────────────────────

const DS_OPTIONS_LONG_PRESS_MS = 2000;
const DS_6DOF_MOVE_SPEED   = 1.5;   // m/s (time-based)
const DS_6DOF_ROTATE_SPEED = 2.0;   // rad/s (time-based)
const DS_STICK_DEADZONE    = 0.12;
const DS_DPAD_MOVE_SPEED   = 1.5;   // m/s (time-based)
const DS_TP_DOUBLE_CLICK_MS = 400;  // Max interval between touchpad clicks for a double click.

function handleOptionsButton(pressed) {
  const now = performance.now();
  if (pressed) {
    if (dsOptionsHoldStart === 0) {
      dsOptionsHoldStart = now;
      dsOptionsWasHeld = false;
    } else if (!dsOptionsWasHeld &&
               now - dsOptionsHoldStart >= DS_OPTIONS_LONG_PRESS_MS) {
      dsOptionsWasHeld = true;
      resetVirtual6DoFCamera();
      log('[DualSense] Camera reset (Options long press)');
    }
  } else {
    if (dsOptionsHoldStart !== 0) {
      const held = now - dsOptionsHoldStart;
      dsOptionsHoldStart = 0;
      if (!dsOptionsWasHeld && held < DS_OPTIONS_LONG_PRESS_MS) {
        dsVirtual6DofMode = !dsVirtual6DofMode;
        _dsStickHeld = { lx: 0, ly: 0, rx: 0, ry: 0 };  // Reset stick state when switching modes.
        log(`[DualSense] Virtual 6DoF mode: ${dsVirtual6DofMode ? 'ON' : 'OFF'}`);
        sendToReceiver(JSON.stringify({ type: 'set_6dof_mode', enabled: dsVirtual6DofMode }));
      }
      dsOptionsWasHeld = false;
    }
  }
}

/** Resets virtual controller position, depth, positioning mode and gyro offsets (not the camera). */
function resetDsControllerOffsets() {
  dsTouchDepthMode = false;
  dsControllerPosition = defaultDsControllerPosition();
  dsTouchPositionAnchors = {};
  resetDsGyroAllOffsets();
}

function handleTpClick(pressed) {
  if (pressed && !_dsTpClickPrev) {
    const now = performance.now();
    if (_dsTpLastClickMs !== null && now - _dsTpLastClickMs <= DS_TP_DOUBLE_CLICK_MS) {
      _dsTpLastClickMs = null;  // A third click starts a new sequence.
      resetDsControllerOffsets();
      log('[DualSense] Controller offsets reset (touchpad double click)');
      _dsTpClickPrev = pressed;
      return;
    }
    _dsTpLastClickMs = now;
    dsTouchDepthMode = !dsTouchDepthMode;
    for (const id of dsTouchOrder) {
      dsTouchPositionAnchors[id] = {
        x: 0, y: 0,
        position: { ...dsControllerPosition[dsTouchToSide[id]] },
        pending: true,
      };
    }
    log(`[DualSense] Touchpad position mode: ${dsTouchDepthMode ? 'depth' : 'vertical'}`);
  }
  _dsTpClickPrev = pressed;
}

// ── Game loop: apply time-based movement on each frame ─────────────────────

function startDsGameLoop() {
  if (_dsGameLoopId !== null) return;
  _dsGameLoopPrev = performance.now();
  function tick() {
    const now = performance.now();
    const dt = Math.min((now - _dsGameLoopPrev) / 1000, 0.1); // Seconds, clamped to 100 ms.
    _dsGameLoopPrev = now;

    const { up, down, left, right } = _dsDpadHeld;
    if (up || down || left || right) {
      _applyDpadMove(up, down, left, right, dt);
    }

    if (dsVirtual6DofMode) {
      const { lx, ly, rx, ry } = _dsStickHeld;
      if (lx !== 0 || ly !== 0 || rx !== 0 || ry !== 0) {
        _applyStickMove(lx, ly, rx, ry, dt);
      }
    }

    _dsGameLoopId = requestAnimationFrame(tick);
  }
  _dsGameLoopId = requestAnimationFrame(tick);
}

function stopDsGameLoop() {
  if (_dsGameLoopId !== null) {
    cancelAnimationFrame(_dsGameLoopId);
    _dsGameLoopId = null;
  }
  // Reset held state.
  _dsDpadHeld  = { up: false, down: false, left: false, right: false };
  _dsStickHeld = { lx: 0, ly: 0, rx: 0, ry: 0 };
}

function _applyStickMove(lx, ly, rx, ry, dt) {
  // Right stick: left/right = Yaw rotation, up/down = Y-axis translation
  dsVirtualYaw   -= rx * DS_6DOF_ROTATE_SPEED * dt;
  dsVirtualPos.y -= ry * DS_6DOF_MOVE_SPEED   * dt;

  // Left stick: translate in the Yaw-rotated local XZ plane
  //
  // Forward vector in SteamVR world coordinates = (-sinθ, 0, -cosθ) (correct value).
  //   dy = 0 (movement on the xz plane), ly=-1 (up), lx=+1 (right)
  //
  // The server applies the headQuat yaw at recenter time (physical device yaw ≈ _recenterYaw)
  // as an inverse transform to the coordinates of all poses.
  // The client must account for this inverse transform when calculating movement
  //   effectiveYaw = dsVirtualYaw + _recenterYaw
  // so the signs in the movement equations are correct.
  //
  // Derivation:
  //   raw_delta = (-sin(eY), 0, -cos(eY)) (correct forward delta for ly=-1)
  //   SteamVR_delta = R_y(-_recenterYaw) * raw_delta = (-sin(dsVY), 0, -cos(dsVY))
  const effectiveYaw = dsVirtualYaw + _recenterYaw;
  const cosY = Math.cos(effectiveYaw);
  const sinY = Math.sin(effectiveYaw);
  dsVirtualPos.x += ( lx * cosY + ly * sinY) * DS_6DOF_MOVE_SPEED * dt;
  dsVirtualPos.z += (-lx * sinY + ly * cosY) * DS_6DOF_MOVE_SPEED * dt;
}

function _applyDpadMove(up, down, left, right, dt) {
  if (up)   dsVirtualPos.y += DS_DPAD_MOVE_SPEED * dt;
  if (down) dsVirtualPos.y -= DS_DPAD_MOVE_SPEED * dt;
  // Right = (cos(eY), 0, -sin(eY)); left = (-cos(eY), 0, +sin(eY)).
  const effectiveYaw = dsVirtualYaw + _recenterYaw;
  const cosY = Math.cos(effectiveYaw);
  const sinY = Math.sin(effectiveYaw);
  if (left) {
    dsVirtualPos.x -= cosY * DS_DPAD_MOVE_SPEED * dt;
    dsVirtualPos.z += sinY * DS_DPAD_MOVE_SPEED * dt;  // Left = +sin(eY).
  }
  if (right) {
    dsVirtualPos.x += cosY * DS_DPAD_MOVE_SPEED * dt;
    dsVirtualPos.z -= sinY * DS_DPAD_MOVE_SPEED * dt;  // Right = -sin(eY).
  }
}

// (The old updateVirtual6DoF / updateDpadPosition were replaced by the logic above.)
function updateVirtual6DoF(lx, ly, rx, ry) {
  // Keep as an alias for compatibility (for event-driven calls).
  const applyDZ = v => Math.abs(v) < DS_STICK_DEADZONE ? 0 : v;
  _dsStickHeld = { lx: applyDZ(lx), ly: applyDZ(ly), rx: applyDZ(rx), ry: applyDZ(ry) };
}

function updateDpadPosition(up, down, left, right) {
  _dsDpadHeld = { up, down, left, right };
}

function resetVirtual6DoFCamera() {
  // Trigger server-side TrackingManager::recenter() on the next tracking send.
  _pendingRecenter = true;

  dsVirtualPos   = { x: 0, y: 1.36, z: 0 };
  dsVirtualYaw   = 0;
  dsVirtualPitch = 0;
  resetDsControllerOffsets();
  lastTrackedPose = { qw: 1, qx: 0, qy: 0, qz: 0,
                      gyrX: 0, gyrY: 0, gyrZ: 0,
                      accX: 0, accY: 0, accZ: 0 };
}

// ── Quaternion utilities ──────────────────────────────────────────────────

function yawPitchToQuat(yaw, pitch) {
  const cy = Math.cos(yaw * 0.5),   sy = Math.sin(yaw * 0.5);
  const cp = Math.cos(pitch * 0.5), sp = Math.sin(pitch * 0.5);
  return { w: cy*cp, x: cy*sp, y: sy*cp, z: -sy*sp };
}

function quatMultiply(q1, q2) {
  return {
    w: q1.w*q2.w - q1.x*q2.x - q1.y*q2.y - q1.z*q2.z,
    x: q1.w*q2.x + q1.x*q2.w + q1.y*q2.z - q1.z*q2.y,
    y: q1.w*q2.y - q1.x*q2.z + q1.y*q2.w + q1.z*q2.x,
    z: q1.w*q2.z + q1.x*q2.y - q1.y*q2.x + q1.z*q2.w,
  };
}

function quatRotateVec(q, v) {
  const qv = { w: 0, x: v.x, y: v.y, z: v.z };
  const qc = { w: q.w, x: -q.x, y: -q.y, z: -q.z };
  const t  = quatMultiply(q, qv);
  const r  = quatMultiply(t, qc);
  return { x: r.x, y: r.y, z: r.z };
}

// ── Virtual controllers (touchpad) ───────────────────────────────────────

function updateVirtualControllers(tp) {
  const touches  = [tp.t0, tp.t1].filter(t => t.active);
  const activeIds = new Set(touches.map(t => t.id));

  for (const touch of touches) {
    if (dsTouchToSide[touch.id] !== undefined) continue;
    if (dsTouchOrder.length === 0) {
      dsTouchToSide[touch.id] = touch.x < DS_TP_CENTER_X ? 'left' : 'right';
    } else {
      const firstSide = dsTouchToSide[dsTouchOrder[0]];
      dsTouchToSide[touch.id] = firstSide === 'left' ? 'right' : 'left';
    }
    dsTouchOrder.push(touch.id);
  }

  for (const id of Object.keys(dsTouchToSide)) {
    if (!activeIds.has(parseInt(id))) {
      const side = dsTouchToSide[id];
      delete dsTouchToSide[id];
      delete dsActiveControllers[side];
      delete dsTouchPositionAnchors[id];
    }
  }
  dsTouchOrder = dsTouchOrder.filter(id => activeIds.has(id));

  dsActiveControllers = {};
  for (const touch of touches) {
    const side = dsTouchToSide[touch.id];
    if (side) {
      dsActiveControllers[side] = { x: touch.x, y: touch.y };
      const position = dsControllerPosition[side];
      const anchor = dsTouchPositionAnchors[touch.id];
      if (anchor?.pending) {
        // Use the click report's coordinates so movement since the previous report cannot cause a jump.
        anchor.x = touch.x;
        anchor.y = touch.y;
        anchor.pending = false;
      }
      const dx = (touch.x - (anchor ? anchor.x : DS_TP_WIDTH / 2)) / DS_TP_WIDTH * 0.7;
      const dy = (touch.y - (anchor ? anchor.y : DS_TP_HEIGHT / 2)) / DS_TP_HEIGHT * 0.7;
      position.x = (anchor ? anchor.position.x : 0) + dx;
      if (dsTouchDepthMode) {
        position.z = (anchor ? anchor.position.z : DS_CONTROLLER_DEFAULT_DEPTH) + dy;
      } else {
        position.y = (anchor ? anchor.position.y : 0) - dy;
      }
    }
  }

  updateDsGyroTarget();
}

function controllerToWorldPos(localPos, headQuat, headPos) {
  const rotated = quatRotateVec(headQuat, localPos);
  return {
    x: headPos.x + rotated.x,
    y: headPos.y + rotated.y,
    z: headPos.z + rotated.z,
  };
}

function buildVirtualControllerPose(headQuat, headPos) {
  const result = {};
  const zeroVel = { x: 0, y: 0, z: 0 };

  // Do not create controllers when the DualSense is disconnected.
  // WebHID connection state and native bridge connection type are separate.
  if (!dsHidConnected && !dsConnectionType) return result;

  // Base pitch offset (initially tilted upward).
  const PITCH_OFFSET = Math.PI / 3;    // +60°
  const pitchUp = { w: Math.cos(PITCH_OFFSET / 2), x: Math.sin(PITCH_OFFSET / 2), y: 0, z: 0 };

  for (const side of ['left', 'right']) {
    const tc = dsActiveControllers[side];
    let pos;
    if (tc) {
      pos = controllerToWorldPos(dsControllerPosition[side], headQuat, headPos);
    } else {
      // When the touchpad is not touched, use a fixed offset in front of and below the camera.
      // Left: -0.25 m (left), -1.0 m (down) / right: +0.25 m (right), -1.0 m (down).
      const localX = side === 'left' ? -0.25 : 0.25;
      const rotated = quatRotateVec(headQuat, { x: localX, y: -1.0, z: 0 });
      pos = {
        x: headPos.x + rotated.x,
        y: headPos.y + rotated.y,
        z: headPos.z + rotated.z,
      };
    }

    // Compose the base orientation in controller-local space.
    // Do not apply the PITCH_OFFSET when the touchpad is not touched (replace it with the identity quaternion).
    const baseQuat = tc ? pitchUp : { w: 1, x: 0, y: 0, z: 0 };
    const localOffset  = baseQuat;
    // DualSense gyro offset: live offset on the target, held offset on the 1st controller (two fingers).
    const gyroOffset = tc ? getDsGyroOffsetForSide(side) : null;
    const gyroQ = gyroOffset ? dsGyroViewQuat(gyroOffset) : null;
    let orientation;
    if (!gyroQ) {
      orientation = quatMultiply(headQuat, localOffset);
    } else if (DS_GYRO_COMPOSE_MODE === 'local') {
      orientation = quatMultiply(headQuat, quatMultiply(localOffset, gyroQ));
    } else {
      orientation = quatMultiply(headQuat, quatMultiply(gyroQ, localOffset));
    }
    const orientEntry  = { x: orientation.x, y: orientation.y, z: orientation.z, w: orientation.w };

    result[side] = {
      orientation:      orientEntry,
      position:         pos,
      linear_velocity:  zeroVel,
      angular_velocity: zeroVel,
    };
  }
  return result;
}

async function requestDualSenseHid() {
  await dualSenseHid.requestDevice();
}

// ---------------------------------------------------------------------------
// Tracking WebSocket (client → ALVR server)
// ---------------------------------------------------------------------------

function openTrackingWs(generation = _sessionGeneration) {
  if (!sessionIsActive(generation)) return;
  const ws = new WebSocket(`${wsBase()}/ws/tracking`);
  trackingWs = ws;
  ws.onopen  = () => {
    if (trackingWs !== ws || !sessionIsActive(generation)) return;
    log('Tracking WebSocket connected');
    _imuStreamingEnabled = true;
    _imuSendCount = 0;
    _imuHeartbeatCount = 0;
    _imuLastLogTime = 0;
    startTrackingHeartbeat();
    // Resume HID polling in the native app (no-op in browser).
    window.AlvrNativeBridge?.onServerConnect?.();
  };
  ws.onclose = () => {
    if (trackingWs !== ws || !sessionIsActive(generation)) return;
    trackingWs = null;
    _imuStreamingEnabled = false;
    stopTrackingHeartbeat();
    // Pause HID polling in the native app (covers unexpected server drops).
    window.AlvrNativeBridge?.onServerDisconnect?.();
    scheduleReconnect('tracking', () => openTrackingWs(generation), 2000, generation);
  };
}

/** Sends the current (or identity) pose at 10 Hz to keep SteamVR alive when no IMU is active.
 *  When an IMU device is connected it sends at TRACKING_SEND_RATE_HZ (90 Hz), the heartbeat
 *  is suppressed to avoid pushing the ALVR server event queue above its ~90 Hz design limit.
 *
 *  NOTE: the _imuFromDevice flag is only true during the synchronous sendImuTracking() call
 *  from sendDeviceTracking, so it is always false when this timer fires (JS is single-threaded).
 *  We therefore guard on _lastTrackingSendMs instead.
 */
function startTrackingHeartbeat() {
  if (trackingHeartbeatId) return;
  trackingHeartbeatId = setInterval(() => {
    // Suppress heartbeat while the device is actively sending.
    // If the last device send was within 3 × TRACKING_SEND_INTERVAL_MS (~33 ms),
    // the device is streaming at ~90 Hz and the heartbeat is not needed.
    if (performance.now() - _lastTrackingSendMs < TRACKING_SEND_INTERVAL_MS * 3) return;
    const tsNs = BigInt(Math.floor(performance.now() * 1e6));
    const p = lastTrackedPose;
    // _imuFromDevice stays false here → heartbeat path
    sendImuTracking(tsNs, p.qw, p.qx, p.qy, p.qz,
                    p.gyrX, p.gyrY, p.gyrZ, p.accX, p.accY, p.accZ);
  }, 1000 / 10);  // 10 Hz — just enough to keep SteamVR alive when no IMU
}

function stopTrackingHeartbeat() {
  if (trackingHeartbeatId) {
    clearInterval(trackingHeartbeatId);
    trackingHeartbeatId = null;
  }
}

/**
 * Sends a normalised IMU reading to the ALVR server tracking WebSocket.
 *
 * Maps to the TrackingMessage JSON schema expected by web_client.rs:
 * {
 *   "target_timestamp_ns": <number>,
 *   "head": {
 *     "orientation": { "x", "y", "z", "w" },
 *     "position":    { "x", "y", "z" },
 *     "linear_velocity":  { "x", "y", "z" },
 *     "angular_velocity": { "x", "y", "z" }
 *   }
 * }
 */
function sendImuTracking(timestampNs, qw, qx, qy, qz, gyrX, gyrY, gyrZ, accX, accY, accZ) {
  // Keep the latest known pose so the heartbeat can replay it.
  lastTrackedPose = { qw, qx, qy, qz, gyrX, gyrY, gyrZ, accX, accY, accZ };

  // Do not send tracking data unless the server is connected AND the user
  // has pressed "Stream to XR Glasses".
  // _imuStreamingEnabled is cleared by the trackingWs onclose handler (covers
  // disconnect / server drop).  presentationRequested is only true after the
  // user explicitly starts the XR presentation, preventing pose and controller
  // events from being forwarded before streaming is intentionally started.
  if (!_imuStreamingEnabled || !presentationRequested) return;

  // ---- Debug diagnostics ----
  const fromDevice = _imuFromDevice;
  _imuSendCount++;
  if (!fromDevice) _imuHeartbeatCount++;

  // Log once per second: quaternion values + source breakdown
  const now = performance.now();
  if (now - _imuLastLogTime >= 1000) {
    _imuLastLogTime = now;
    const deviceCount = _imuSendCount - _imuHeartbeatCount;
    const wsState = trackingWs ? ['CONNECTING','OPEN','CLOSING','CLOSED'][trackingWs.readyState] : 'null';
    // Validate quaternion (detect NaN / near-zero norm)
    const norm = Math.sqrt(qw*qw + qx*qx + qy*qy + qz*qz);
    const normOk = !isNaN(norm) && norm > 0.9 && norm < 1.1;
    log(`[IMU-DBG] sends/s: ${_imuSendCount} (device=${deviceCount} heartbeat=${_imuHeartbeatCount})` +
        ` | qw=${qw.toFixed(4)} qx=${qx.toFixed(4)} qy=${qy.toFixed(4)} qz=${qz.toFixed(4)}` +
        ` | norm=${norm.toFixed(4)} ${normOk ? 'OK' : 'WARN:bad-quat'}` +
        ` | gyr=(${gyrX.toFixed(3)},${gyrY.toFixed(3)},${gyrZ.toFixed(3)})` +
        ` | wsState=${wsState}` +
        ` | vidWs=${_videoWsFrameCount}/s` +
        (_usingWt ? ` | wtDgramErr=${_wtDgramErrors}` : ''));
    _imuSendCount = 0;
    _imuHeartbeatCount = 0;
    _videoWsFrameCount = 0;
  }
  // ---- End debug diagnostics ----

  // Guard: skip if the WebSocket transport is not ready.
  // When WebTransport is active (_usingWt=true) this guard is bypassed because
  // trackingWs is intentionally null – the datagram path is used instead.
  if (!_usingWt && trackingWs?.readyState !== WebSocket.OPEN) return;

  // Always compose the virtual camera orientation (6DoF on: updated by sticks; off: updated by DPAD).
  const headPos = { x: dsVirtualPos.x, y: dsVirtualPos.y, z: dsVirtualPos.z };
  const virtualQuat = yawPitchToQuat(dsVirtualYaw, dsVirtualPitch);
  showDsPose(headPos, dsVirtualYaw, dsVirtualPitch);
  let headQuat = quatMultiply(virtualQuat, { x: qx, y: qy, z: qz, w: qw });

  const trackMsg = {
    target_timestamp_ns: Number(timestampNs),
    head: {
      orientation:      { x: headQuat.x, y: headQuat.y, z: headQuat.z, w: headQuat.w },
      position:         headPos,
      linear_velocity:  { x: 0, y: 0, z: 0 },
      angular_velocity: { x: gyrX, y: gyrY, z: gyrZ },
    },
  };

  // Attach virtual controllers.
  const vcResult = buildVirtualControllerPose(headQuat, headPos);
  if (vcResult.left)  trackMsg.left_controller  = vcResult.left;
  if (vcResult.right) trackMsg.right_controller = vcResult.right;

  // Send button/axis input.
  // With WebTransport: send separately over a reliable, low-latency QUIC stream, apart from datagrams.
  // With the WebSocket fallback: include it in TrackingMessage because TCP guarantees delivery.
  if (dsPendingButtons.length > 0) {
    if (_usingWt && _wtButtonWriter) {
      // Send over a reliable QUIC unidirectional stream.
      // This prevents axis=0.0 updates from being lost with a datagram.
      const line = JSON.stringify({ buttons: dsPendingButtons }) + '\n';
      _wtButtonWriter.write(_wtTextEnc.encode(line)).catch(e => {
        log(`[WT btn] stream write error: ${e.message}`);
      });
    } else if (!_usingWt) {
      // WebSocket fallback: include it in TrackingMessage because TCP guarantees delivery.
      trackMsg.buttons = dsPendingButtons;
    }
    dsPendingButtons = [];
  }

  // Set the recenter flag, then clear it after sending (one-shot).
  if (_pendingRecenter) {
    trackMsg.recenter = true;
    _pendingRecenter = false;
    // Save the headQuat yaw at the time of recenter.
    // The server applies this yaw as an inverse transform to all poses,
    // so subtract the same yaw when calculating L-Stick / D-pad movement directions.
    // extractYaw(q) = atan2(2*(w*y - x*z), 1 - 2*(y² + z²))
    _recenterYaw = Math.atan2(
      2 * (headQuat.w * headQuat.y - headQuat.x * headQuat.z),
      1 - 2 * (headQuat.y * headQuat.y + headQuat.z * headQuat.z)
    );
  }

  if (_usingWt && _wtDgramWriter) {
    // WebTransport datagram: unreliable, no retransmission → minimal latency.
    // Old poses are obsolete anyway; dropping is preferable to queuing.
    _wtDgramWriter
      .write(_wtTextEnc.encode(JSON.stringify(trackMsg)))
      .catch(() => { _wtDgramErrors++; });
  } else if (trackingWs?.readyState === WebSocket.OPEN) {
    trackingWs.send(JSON.stringify(trackMsg));
  }
}

function sendDeviceTracking(pose) {
  const nowMs = performance.now();
  if (nowMs - _lastTrackingSendMs < TRACKING_SEND_INTERVAL_MS) return;
  _lastTrackingSendMs = nowMs;
  _imuFromDevice = true;
  try {
    sendImuTracking(
      pose.timestampNs,
      pose.qw, pose.qx, pose.qy, pose.qz,
      pose.gyrX, pose.gyrY, pose.gyrZ,
      pose.accX, pose.accY, pose.accZ,
    );
  } finally {
    _imuFromDevice = false;
  }
}

// ---------------------------------------------------------------------------
// WebTransport – control channel (tracking datagrams + events stream)
// ---------------------------------------------------------------------------

/**
 * Convert lowercase hex string to Uint8Array (for WT certificate pinning).
 * @param {string} hex  e.g. "aabbccdd..."
 * @returns {Uint8Array}
 */
function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length >> 1);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes;
}

/**
 * Attempt to establish a WebTransport control session at `/wt/control`.
 * On success the session replaces `trackingWs` and `eventsWs`.
 * On failure (browser unsupported, fingerprint unavailable, network error)
 * returns false so the caller falls back to WebSocket.
 *
 * @returns {Promise<boolean>} true if WebTransport is now active
 */
async function tryConnectWebTransport(generation = _sessionGeneration) {
  if (typeof WebTransport === 'undefined') {
    log('[WT] WebTransport API not available – WebSocket fallback');
    return false;
  }
  try {
    // 1. Fetch the server's WebTransport certificate fingerprint.
    const resp = await fetch(`${baseUrl()}/api/wt-fingerprint`);
    if (!resp.ok) {
      log('[WT] /api/wt-fingerprint unavailable – WebSocket fallback');
      return false;
    }
    const { fingerprint_hex } = await resp.json();
    _wtFpHex = fingerprint_hex;
    const fpBytes = hexToBytes(fingerprint_hex);

    // 2. Open WebTransport session (certificate pinning via SHA-256 hash).
    const wtUrl = `https://${serverHost}:${serverPort}/wt/control`;
    log(`[WT] Opening control session at ${wtUrl}`);
    const wt = new WebTransport(wtUrl, {
      serverCertificateHashes: [{ algorithm: 'sha-256', value: fpBytes.buffer }],
    });
    await wt.ready;
    if (!sessionIsActive(generation)) {
      wt.close();
      return false;
    }
    wtSession      = wt;
    _usingWt       = true;

    // 3. Tracking heartbeat (same as trackingWs.onopen).
    _imuStreamingEnabled = true;
    _imuSendCount        = 0;
    _imuHeartbeatCount   = 0;
    _imuLastLogTime      = 0;
    startTrackingHeartbeat();
    window.AlvrNativeBridge?.onServerConnect?.();

    // 4. Cache datagram writer for zero-overhead tracking sends.
    _wtDgramWriter = wt.datagrams.writable.getWriter();

    // 5. Open a client-initiated unidirectional stream for reliable button/axis delivery.
    // This is a persistent stream used for the lifetime of the WT session.
    // The server receives it via conn.accept_uni() and routes to handle_wt_button_stream().
    try {
      const buttonSendStream = await wt.createUnidirectionalStream();
      _wtButtonWriter = buttonSendStream.getWriter();
      log('[WT] Button stream opened');
    } catch (e) {
      log(`[WT] Button stream open failed: ${e.message} – buttons will be dropped in WT mode`);
      _wtButtonWriter = null;
    }

    // 6. Start reading server-initiated streams (events).
    readWtIncomingStreams(wt, generation);

    // 7. Handle session closure → fall back to WebSocket.
    wt.closed.then(() => {
      if (wtSession !== wt || !sessionIsActive(generation)) return;
      log('[WT] Control session closed – reconnecting via WebSocket in 2s…');
      _imuStreamingEnabled = false;
      _usingWt       = false;
      wtSession      = null;
      _wtDgramWriter = null;
      _wtButtonWriter = null;
      stopTrackingHeartbeat();
      window.AlvrNativeBridge?.onServerDisconnect?.();
      scheduleReconnect('control-fallback', () => {
        openTrackingWs(generation);
        openEventsWs(generation);
      }, 2000, generation);
    }).catch(() => {});

    log('[WT] Control session established (tracking=datagram, buttons=stream, events=stream)');
    return true;
  } catch (err) {
    if (!sessionIsActive(generation)) return false;
    log(`[WT] Connection failed: ${err.message} – WebSocket fallback`);
    _usingWt       = false;
    wtSession      = null;
    _wtDgramWriter = null;
    _wtButtonWriter = null;
    return false;
  }
}

/**
 * Read server-initiated unidirectional streams from the WT control session.
 * Each stream starts with a type byte (0x01 = events).
 */
async function readWtIncomingStreams(wt, generation) {
  const reader = wt.incomingUnidirectionalStreams.getReader();
  try {
    for (;;) {
      const { value: streamReadable, done } = await reader.read();
      if (done) break;
      if (!sessionIsActive(generation) || wtSession !== wt) {
        await reader.cancel();
        break;
      }
      handleWtIncomingStream(streamReadable, generation);
    }
  } catch (err) {
    log(`[WT] incoming streams reader error: ${err.message}`);
  }
}

/**
 * Read one server-initiated stream, parse the type byte, dispatch to handler.
 * The events stream (0x01) stays open for the whole session, so its
 * newline-delimited JSON is parsed as it arrives rather than after FIN.
 * @param {ReadableStream} streamReadable
 */
async function handleWtIncomingStream(streamReadable, generation) {
  const reader = streamReadable.getReader();
  const decoder = new TextDecoder();
  let streamType = -1;
  let pending = '';

  const dispatchLines = (text) => {
    pending += text;
    let newline;
    while ((newline = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, newline).trim();
      pending = pending.slice(newline + 1);
      if (!line || !sessionIsActive(generation)) continue;
      try {
        handleServerEvent(JSON.parse(line));
      } catch (_) {}
    }
  };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!sessionIsActive(generation)) {
        reader.cancel().catch(() => {});
        return;
      }
      if (!value || value.length === 0) continue;

      let chunk = value;
      if (streamType < 0) {
        streamType = chunk[0];
        chunk = chunk.subarray(1);
        if (streamType !== 0x01) {
          const typeHex = streamType.toString(16).padStart(2, '0');
          log(`[WT-ctrl] UNKNOWN stream type 0x${typeHex} (expected 0x01)`);
          reader.cancel().catch(() => {});
          return;
        }
      }
      dispatchLines(decoder.decode(chunk, { stream: true }));
    }
  } catch (err) {
    log(`[WT] stream read error: ${err.message}`);
    return;
  }
  if (streamType === 0x01) dispatchLines(decoder.decode() + '\n');
  // 0x02 (video) streams are not sent to the control session
}

// ---------------------------------------------------------------------------
// Events WebSocket (ALVR server → client, JSON text)
// ---------------------------------------------------------------------------

function openEventsWs(generation = _sessionGeneration) {
  if (!sessionIsActive(generation)) return;
  const ws = new WebSocket(`${wsBase()}/ws/events`);
  eventsWs = ws;
  ws.onmessage = e => {
    if (eventsWs !== ws || !sessionIsActive(generation)) return;
    try { handleServerEvent(JSON.parse(e.data)); } catch (_) {}
  };
  ws.onclose = () => {
    if (eventsWs !== ws || !sessionIsActive(generation)) return;
    eventsWs = null;
    // Use trackingWs (not videoWs) as the liveness check.
    // After sendReceiverInit() the receiver owns /ws/video so videoWs is set
    // to null, but the session is still active.  If we checked videoWs here
    // we would never reconnect eventsWs after the receiver opens, which means
    // server request_idr events stop reaching the client.  Without IDR
    // requests the receiver decoder cannot recover from errors — causing the
    // stream to freeze some time after reconnect.
    scheduleReconnect('events', () => openEventsWs(generation), 2000, generation);
  };
}

/** Sends POST /api/request-idr, rate-limited unless decoder recovery forces it.
 *  @param {string} reason  Short label for the log message.
 *  @param {boolean} force  Bypass the cooldown once the decoder is ready for an IDR.
 */
function requestIdr(reason, force = false) {
  const now = performance.now();
  if (!force && now - _lastIdrRequestMs < IDR_COOLDOWN_MS) return;
  _lastIdrRequestMs = now;
  log(`IDR request (${reason})`);
  fetch(`${baseUrl()}/api/request-idr`, { method: 'POST' })
    .then(response => {
      if (!response.ok) log(`[ERROR] IDR request failed (${reason}): HTTP ${response.status}`);
    })
    .catch(error => log(`[ERROR] IDR request failed (${reason}): ${error.message}`));
}

function handleServerEvent(event) {
  switch (event.type) {
    case 'request_idr':
      requestIdr('server event');
      break;
    case 'haptics':
      triggerHaptics(event);
      break;
    case 'restarting':
      log('Server is restarting; reconnecting in 3 s…');
      reconnectAfterServerRestart();
      break;
  }
}

// ---------------------------------------------------------------------------
// Video WebSocket (ALVR server → client, binary frames)
// ---------------------------------------------------------------------------

function openVideoWs(generation = _sessionGeneration) {
  if (!sessionIsActive(generation)) return;
  if (_receiverOwnsVideo) return;
  videoDecoder?.close();
  videoDecoder = null;
  const ws = new WebSocket(`${wsBase()}/ws/video`);
  videoWs = ws;
  ws.binaryType = 'arraybuffer';

  ws.onopen = () => {
    if (videoWs !== ws || !sessionIsActive(generation)) return;
    log('Video WebSocket connected');
    initDecoder();
  };

  ws.onmessage = e => {
    if (videoWs !== ws || !sessionIsActive(generation)) return;
    if (typeof e.data === 'string') {
      // JSON text frame = VideoConfigMessage (decoder config)
      try {
        const msg = JSON.parse(e.data);
        if (msg.codec) {
          const sameConfig = codecConfig &&
            codecConfig.codec             === msg.codec &&
            codecConfig.width             === msg.width &&
            codecConfig.height            === msg.height &&
            codecConfig.config_buffer_b64 === msg.config_buffer_b64;
          codecConfig = msg;
          updateCodecInfo();
          if (!sameConfig) {
            initDecoder();
          }
        }
      } catch (_) {}
      return;
    }

    // Binary frame: [0..8]=timestamp_nanos u64LE, [8]=is_idr u8, [9..]=NAL payload
    const buf = new Uint8Array(e.data);
    if (buf.length < 9) return;

    // Parse 8-byte little-endian timestamp. >>> 0 ensures unsigned 32-bit.
    const tsLo = (buf[0] | (buf[1] << 8) | (buf[2] << 16) | (buf[3] << 24)) >>> 0;
    const tsHi = (buf[4] | (buf[5] << 8) | (buf[6] << 16) | (buf[7] << 24)) >>> 0;
    const timestampNs = BigInt(tsLo) | (BigInt(tsHi) << 32n);
    _lastVideoTimestampNs = timestampNs;  // track for stats reporting
    _videoWsFrameCount++;
    const isIdr = buf[8] !== 0;
    const nal   = buf.slice(9);

    decodeFrame(timestampNs, isIdr, nal);
  };

  ws.onclose = () => {
    if (videoWs !== ws || !sessionIsActive(generation)) return;
    videoWs = null;
    videoDecoder?.close();
    videoDecoder = null;
    scheduleReconnect('preview-video', () => openVideoWs(generation), 2000, generation);
  };
}

function updateCodecInfo() {
  if (!codecConfig) return;
  const el = $('codec-info');
  if (el) el.textContent =
    `${codecConfig.codec.toUpperCase()}  ${codecConfig.width}×${codecConfig.height}  ${codecConfig.refresh_rate} fps`;
}

// ---------------------------------------------------------------------------
// Audio – Web Audio API + AudioWorklet integration
// ---------------------------------------------------------------------------

/**
 * Initialise game audio output and (optionally) microphone input.
 *
 * Called from connect() after the video/tracking WebSockets are opened.
 * Returns without throwing even if audio fails – audio is non-critical.
 */
async function initAudio() {
  log('[audio] initAudio() — game audio + mic always enabled');

  try {
    // Create (or resume) AudioContext.
    if (!audioCtx || audioCtx.state === 'closed') {
      audioCtx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
      log(`[audio] AudioContext created — state=${audioCtx.state} sampleRate=${audioCtx.sampleRate}`);
    } else {
      log(`[audio] AudioContext reused — state=${audioCtx.state}`);
    }
    if (audioCtx.state === 'suspended') {
      log('[audio] AudioContext suspended — calling resume()');
      await audioCtx.resume();
      log(`[audio] AudioContext.resume() done — state=${audioCtx.state}`);
    }

    // Load the AudioWorklet module (only once per page lifetime).
    // Android Native App: load from bundled asset to avoid cross-origin (file:// → https://)
    // restrictions inside AudioWorklet.addModule().
    if (!audioWorkletLoaded) {
      const moduleUrl = IS_NATIVE_APP
        ? 'file:///android_asset/web_client/audio-processor.js'
        : `${baseUrl()}/audio-processor.js`;
      log(`[audio] addModule: fetching ${moduleUrl}`);
      await audioCtx.audioWorklet.addModule(moduleUrl);
      audioWorkletLoaded = true;
      log('[audio] addModule OK — AudioWorklet processors registered');
    } else {
      log('[audio] addModule skipped (already loaded)');
    }

    // Open game-audio WebSocket.
    log('[audio] calling openAudioOutWs()');
    await openAudioOutWs();

    // Open microphone WebSocket (always enabled; requires getUserMedia → HTTPS).
    await openAudioInWs();
  } catch (err) {
    log(`[audio] initAudio FAILED: ${err}`);
    console.error('[ALVR][audio] initAudio error detail:', err);
  }
}

/** Resolves true when game audio can be received as Opus (WebCodecs AudioDecoder). */
function opusDecodeSupported() {
  if (_opusOutDisabled || typeof AudioDecoder === 'undefined') return Promise.resolve(false);
  if (!_opusDecodeSupport) {
    _opusDecodeSupport = AudioDecoder.isConfigSupported(OPUS_OUT_CONFIG)
      .then(result => !!result.supported)
      .catch(() => false);
  }
  return _opusDecodeSupport;
}

/** Copies decoded audio into an interleaved Float32 buffer. */
function audioDataToInterleavedF32(audioData) {
  const frames   = audioData.numberOfFrames;
  const channels = audioData.numberOfChannels;
  const out   = new Float32Array(frames * channels);
  const plane = new Float32Array(frames);
  for (let c = 0; c < channels; c++) {
    audioData.copyTo(plane, { planeIndex: c, format: 'f32-planar' });
    for (let i = 0; i < frames; i++) out[i * channels + c] = plane[i];
  }
  return out.buffer;
}

function closeAudioOutDecoder() {
  if (audioOutDecoder && audioOutDecoder.state !== 'closed') audioOutDecoder.close();
  audioOutDecoder = null;
}

/**
 * Opens the `/ws/audio_out` WebSocket and pipes incoming game audio to the
 * `alvr-audio-out` AudioWorkletNode.  Requests Opus (decoded with WebCodecs)
 * when supported; the server's config frame says which codec it sends.
 */
async function openAudioOutWs(generation = _sessionGeneration) {
  if (!sessionIsActive(generation)) return;
  log(`[audio] openAudioOutWs() — audioCtx=${audioCtx?.state ?? 'null'}`);
  if (!audioCtx) {
    log('[audio] openAudioOutWs: aborted (no AudioContext)');
    return;
  }

  const requestOpus = await opusDecodeSupported();
  if (!sessionIsActive(generation) || !audioCtx) return;

  const url = `${wsBase()}/ws/audio_out${requestOpus ? '?codec=opus' : ''}`;
  log(`[audio] opening WebSocket ${url}`);
  const ws = new WebSocket(url);
  audioOutWs = ws;
  ws.binaryType = 'arraybuffer';

  let outNode = null;
  let decoder = null;
  let chunkTimestampUs = 0;

  ws.onopen = () => {
    if (audioOutWs !== ws || !sessionIsActive(generation)) return;
    log('[audio] audio_out WebSocket opened — waiting for config frame');
  };

  ws.onmessage = (ev) => {
    if (audioOutWs !== ws || !sessionIsActive(generation)) return;
    if (typeof ev.data === 'string') {
      // Config frame: {"type":"config","sample_rate":48000,"channels":2}
      try {
        const cfg = JSON.parse(ev.data);
        if (cfg.type === 'config' && audioCtx) {
          // Create the AudioWorkletNode now that we know the stream config.
          outNode = new AudioWorkletNode(audioCtx, 'alvr-audio-out', {
            numberOfInputs:  0,
            numberOfOutputs: 1,
            outputChannelCount: [2],
          });
          // Insert a GainNode so the browser-side volume slider controls
          // the output independently of the Desktop PC's OS volume setting.
          // WASAPI Loopback captures post-OS-volume audio; multiplying here
          // lets the user compensate on the Laptop side.
          if (!audioGainNode) {
            audioGainNode = audioCtx.createGain();
            audioGainNode.gain.value = AUDIO_OUTPUT_GAIN;
            audioGainNode.connect(audioCtx.destination);
          }
          outNode.connect(audioGainNode);
          outNode.port.postMessage({
            type: 'config',
            sampleRate: cfg.sample_rate || audioCtx.sampleRate,
            channels: cfg.channels || 2,
          });
          audioOutNode = outNode;

          closeAudioOutDecoder();
          decoder = null;
          if (cfg.codec === 'opus') {
            try {
              decoder = new AudioDecoder({
                output: (audioData) => {
                  try {
                    if (audioOutWs === ws && outNode) {
                      const buffer = audioDataToInterleavedF32(audioData);
                      outNode.port.postMessage({ type: 'f32', buffer }, [buffer]);
                    }
                  } finally {
                    audioData.close();
                  }
                },
                error: (err) => {
                  log(`[audio] Opus decoder error: ${err.message} — reconnecting with PCM`);
                  _opusOutDisabled = true;
                  if (audioOutWs === ws) ws.close();
                },
              });
              decoder.configure(OPUS_OUT_CONFIG);
              audioOutDecoder = decoder;
            } catch (err) {
              log(`[audio] Opus decoder unavailable: ${err} — reconnecting with PCM`);
              _opusOutDisabled = true;
              decoder = null;
              ws.close();
              return;
            }
          }
          log(`[audio] audio_out config received: ${cfg.codec || 'pcm'} ${cfg.channels}ch @ ${cfg.sample_rate} Hz — AudioWorkletNode created (gain=5.0)`);
        }
      } catch (_) {}
    } else if (decoder) {
      // Binary Opus packet (20 ms).  Drop when the decoder is backed up so
      // that playback stays current.
      if (decoder.state !== 'configured' || decoder.decodeQueueSize > 25) return;
      decoder.decode(new EncodedAudioChunk({
        type: 'key',
        timestamp: chunkTimestampUs,
        data: ev.data,
      }));
      chunkTimestampUs += OPUS_PACKET_US;
    } else {
      // Binary PCM frame – forward to the worklet.
      if (outNode) {
        outNode.port.postMessage({ type: 'pcm', buffer: ev.data }, [ev.data]);
      }
    }
  };

  ws.onclose = (ev) => {
    if (audioOutWs !== ws || !sessionIsActive(generation)) return;
    audioOutWs = null;
    if (audioOutDecoder === decoder) closeAudioOutDecoder();
    log(`[audio] audio_out WebSocket closed (code=${ev.code})`);
    if (presentationRequested) {
      scheduleReconnect('audio-out', () => openAudioOutWs(generation), 3000, generation);
    }
  };

  ws.onerror = (e) => log(`[audio] audio_out WebSocket ERROR: ${e.type} — server may not support /ws/audio_out`);
}

/** Returns an AudioEncoder config for Opus mic audio, or null if unsupported. */
async function opusMicEncoderConfig(sampleRate) {
  if (_opusInDisabled || typeof AudioEncoder === 'undefined') return null;
  const base = { codec: 'opus', sampleRate, numberOfChannels: 1, bitrate: OPUS_MIC_BITRATE };
  const candidates = [
    { ...base, opus: { frameDuration: OPUS_PACKET_US, usedtx: true } },
    { ...base, opus: { frameDuration: OPUS_PACKET_US } },
    base,
  ];
  for (const config of candidates) {
    try {
      if ((await AudioEncoder.isConfigSupported(config)).supported) return config;
    } catch (_) {}
  }
  return null;
}

function f32ToI16(samples) {
  const pcm = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    pcm[i] = s < 0 ? s * 32768 : s * 32767;
  }
  return pcm;
}

/**
 * Sends the mic config on an open `/ws/audio_in` socket and returns a sender
 * that transmits mono samples as Opus packets (when `encoderConfig` is given
 * and the server accepts it) or as PCM i16 LE.  Samples are dropped until
 * the server answers; older servers never answer, so PCM is used after
 * MIC_CODEC_REPLY_TIMEOUT_MS.
 */
function createMicSender(ws, sampleRate, encoderConfig) {
  let mode = encoderConfig ? 'pending' : 'pcm';
  let encoder = null;
  let samplesEncoded = 0;
  let replyTimer = null;

  const fail = (message) => {
    log(`[audio] ${message} — reconnecting microphone with PCM`);
    _opusInDisabled = true;
    mode = 'closed';
    if (audioInWs === ws) ws.close();
  };

  const choose = (codec, timedOut = false) => {
    if (mode !== 'pending') {
      // The server accepted Opus after we had already fallen back to PCM.
      if (codec === 'opus' && mode === 'pcm' && encoderConfig && audioInWs === ws) ws.close();
      return;
    }
    clearTimeout(replyTimer);
    if (codec !== 'opus') {
      mode = 'pcm';
    } else {
      try {
        encoder = new AudioEncoder({
          output: (chunk) => {
            if (audioInWs !== ws || ws.readyState !== WebSocket.OPEN) return;
            const packet = new Uint8Array(chunk.byteLength);
            chunk.copyTo(packet);
            ws.send(packet.buffer);
          },
          error: (err) => fail(`Opus encoder error: ${err.message}`),
        });
        encoder.configure(encoderConfig);
        mode = 'opus';
      } catch (err) {
        fail(`Opus encoder unavailable: ${err}`);
        return;
      }
    }
    log(`[audio] microphone codec: ${mode}${timedOut ? ' (no answer from server)' : ''}`);
  };

  ws.onmessage = (ev) => {
    if (typeof ev.data !== 'string') return;
    try {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'config') choose(msg.codec);
    } catch (_) {}
  };
  ws.send(JSON.stringify({
    type:        'config',
    sample_rate: sampleRate,
    channels:    1,
    ...(encoderConfig ? { codec: 'opus' } : {}),
  }));
  if (encoderConfig) replyTimer = setTimeout(() => choose('pcm', true), MIC_CODEC_REPLY_TIMEOUT_MS);

  const encode = (samples, format) => {
    if (!encoder || encoder.state !== 'configured' || encoder.encodeQueueSize > 10) return;
    const data = new AudioData({
      format,
      sampleRate,
      numberOfFrames:   samples.length,
      numberOfChannels: 1,
      timestamp:        Math.round(samplesEncoded * 1e6 / sampleRate),
      data:             samples,
    });
    samplesEncoded += samples.length;
    try { encoder.encode(data); } finally { data.close(); }
  };

  return {
    /** @param {Float32Array} samples */
    sendF32(samples) {
      if (mode === 'opus') encode(samples, 'f32');
      else if (mode === 'pcm') ws.send(f32ToI16(samples).buffer);
    },
    /** @param {Int16Array} samples */
    sendS16(samples) {
      if (mode === 'opus') encode(samples, 's16');
      else if (mode === 'pcm') ws.send(samples.buffer);
    },
    close() {
      clearTimeout(replyTimer);
      mode = 'closed';
      if (encoder && encoder.state !== 'closed') encoder.close();
      encoder = null;
    },
  };
}

function closeAudioInSender() {
  if (audioInSender) audioInSender.close();
  audioInSender = null;
}

/**
 * Opens the `/ws/audio_in` WebSocket using the Java AudioRecord bridge.
 * Used when running inside the Android native app where getUserMedia() is
 * unreliable from a file:// origin. PCM data is supplied by AlvrAudioBridge
 * via the window.alvrOnMicData() callback.
 */
async function openAudioInWsNative(generation = _sessionGeneration) {
  if (!sessionIsActive(generation)) return;
  log('[audio] openAudioInWsNative() — using Java AudioRecord bridge');
  if (!audioCtx) return;

  const encoderConfig = await opusMicEncoderConfig(NATIVE_MIC_SAMPLE_RATE);
  if (!sessionIsActive(generation) || !audioCtx) return;

  const ws = new WebSocket(`${wsBase()}/ws/audio_in`);
  audioInWs = ws;
  ws.binaryType = 'arraybuffer';

  ws.onopen = () => {
    if (audioInWs !== ws || !sessionIsActive(generation)) return;
    log('[audio] audio_in (native) WebSocket opened');
    closeAudioInSender();
    const sender = createMicSender(ws, NATIVE_MIC_SAMPLE_RATE, encoderConfig);
    audioInSender = sender;
    // Register the callback that Java AudioRecord uses to push PCM frames.
    window.alvrOnMicData = (b64) => {
      if (audioInWs === ws && ws.readyState === WebSocket.OPEN) {
        const bin = atob(b64);
        const buf = new Uint8Array(bin.length & ~1);
        for (let i = 0; i < buf.length; i++) buf[i] = bin.charCodeAt(i);
        sender.sendS16(new Int16Array(buf.buffer));
      }
    };
    // Signal Java to begin recording.
    if (window.AlvrNativeBridge && window.AlvrNativeBridge.startMicCapture) {
      window.AlvrNativeBridge.startMicCapture();
      log('[audio] Native mic capture started');
    }
  };

  ws.onclose = () => {
    if (audioInWs !== ws || !sessionIsActive(generation)) return;
    audioInWs = null;
    log('[audio] audio_in (native) WebSocket closed');
    window.alvrOnMicData = null;
    closeAudioInSender();
    if (window.AlvrNativeBridge && window.AlvrNativeBridge.stopMicCapture) {
      window.AlvrNativeBridge.stopMicCapture();
    }
    if (presentationRequested) {
      scheduleReconnect('audio-in', () => openAudioInWsNative(generation), 3000, generation);
    }
  };

  ws.onerror = (e) => log(`[audio] audio_in (native) WebSocket error: ${e.type}`);
}

/**
 * Requests microphone access, creates the `alvr-audio-in` AudioWorkletNode,
 * and opens the `/ws/audio_in` WebSocket to send captured PCM to the server.
 * On the Android native app this delegates to openAudioInWsNative() which
 * uses the Java AudioRecord bridge instead of getUserMedia().
 */
async function openAudioInWs(generation = _sessionGeneration) {
  if (!sessionIsActive(generation)) return;
  if (IS_NATIVE_APP) {
    await openAudioInWsNative(generation);
    return;
  }

  log('[audio] openAudioInWs() — requesting getUserMedia');
  if (!audioCtx) return;

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount:  1,
        sampleRate:    48000,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });
  } catch (err) {
    log(`[audio] getUserMedia failed: ${err}`);
    return;
  }
  if (!sessionIsActive(generation)) {
    stream.getTracks().forEach(track => track.stop());
    return;
  }

  micStream = stream;

  const encoderConfig = await opusMicEncoderConfig(audioCtx.sampleRate);
  if (!sessionIsActive(generation) || !audioCtx) {
    stream.getTracks().forEach(track => track.stop());
    if (micStream === stream) micStream = null;
    return;
  }

  const ws = new WebSocket(`${wsBase()}/ws/audio_in`);
  audioInWs = ws;
  ws.binaryType = 'arraybuffer';

  ws.onopen = () => {
    if (audioInWs !== ws || !sessionIsActive(generation)) return;
    log('audio_in WebSocket opened');

    // Send config to the server first and negotiate the codec.
    closeAudioInSender();
    const sender = createMicSender(ws, audioCtx.sampleRate, encoderConfig);
    audioInSender = sender;

    // Create mic source → AudioWorkletNode (alvr-audio-in) → silence.
    const micSource = audioCtx.createMediaStreamSource(micStream);
    const inNode = new AudioWorkletNode(audioCtx, 'alvr-audio-in', {
      numberOfInputs:  1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: { format: 'f32' },
    });

    inNode.port.onmessage = (ev) => {
      if (ev.data.type === 'f32' && audioInWs === ws && ws.readyState === WebSocket.OPEN) {
        sender.sendF32(new Float32Array(ev.data.buffer));
      }
    };

    micSource.connect(inNode);
    // Do NOT connect inNode to destination (prevents mic feedback loop).
    audioInNode = inNode;
  };

  ws.onclose = () => {
    if (audioInWs !== ws || !sessionIsActive(generation)) return;
    audioInWs = null;
    log('audio_in WebSocket closed');
    cleanupAudioIn();
    if (presentationRequested) {
      scheduleReconnect('audio-in', () => openAudioInWs(generation), 3000, generation);
    }
  };

  ws.onerror = (e) => log(`audio_in WebSocket error: ${e}`);
}

/** Tear down game-audio output resources. */
function cleanupAudioOut() {
  if (audioOutWs) {
    audioOutWs.onclose = null;
    audioOutWs.close();
    audioOutWs = null;
  }
  if (audioOutNode) {
    audioOutNode.disconnect();
    audioOutNode = null;
  }
  closeAudioOutDecoder();
  if (audioGainNode) {
    audioGainNode.disconnect();
    audioGainNode = null;
  }
}

/** Tear down microphone input resources. */
function cleanupAudioIn() {
  closeAudioInSender();
  // Native app: stop Java AudioRecord and clear the PCM callback.
  if (IS_NATIVE_APP) {
    window.alvrOnMicData = null;
    if (window.AlvrNativeBridge && window.AlvrNativeBridge.stopMicCapture) {
      window.AlvrNativeBridge.stopMicCapture();
    }
  }
  if (audioInNode) {
    audioInNode.disconnect();
    audioInNode = null;
  }
  if (micStream) {
    micStream.getTracks().forEach(t => t.stop());
    micStream = null;
  }
  if (audioInWs) {
    audioInWs.onclose = null;
    audioInWs.close();
    audioInWs = null;
  }
}

/** Tear down all audio resources. */
function cleanupAudio() {
  cleanupAudioOut();
  cleanupAudioIn();
  if (audioCtx && audioCtx.state !== 'closed') {
    audioCtx.close();
    audioCtx = null;
    audioWorkletLoaded = false;
  }
}

// ---------------------------------------------------------------------------
// WebCodecs decoder
// ---------------------------------------------------------------------------

function initDecoder() {
  if (!codecConfig) return;
  videoDecoder?.close();
  $('video-error').hidden = true;
  previewCtx = $('preview-canvas')?.getContext('2d');
  videoDecoder = new VideoDecoderSession({
    output: frame => onDecodedFrame(frame),
    onConfigured: () => requestIdr('preview decoder ready', true),
    onError: (message, fatal) => {
      if (fatal) {
        const error = $('video-error');
        error.textContent = message;
        error.hidden = false;
      }
    },
    log,
  });
  videoDecoder.configure(codecConfig);
}

function decodeFrame(timestampNs, isIdr, nal) {
  videoDecoder?.decode(timestampNs, isIdr, nal);
}

function onDecodedFrame(frame) {
  frameCount++;
  const now = performance.now();
  const latencyMs = now - lastFrameTime;
  lastFrameTime = now;
  totalLatencyMs = latencyMs;

  // Draw to local preview canvas
  if (previewCtx) {
    const c = $('preview-canvas');
    previewCtx.drawImage(frame, 0, 0, c.width, c.height);
  }

  frame.close();

  // Report stats to server every 60 frames
  if (frameCount % 60 === 59) reportStats();
}

// ---------------------------------------------------------------------------
// Display management – open receiver.html on XR glasses display
// ---------------------------------------------------------------------------

const RECEIVER_URL = new URL('receiver.html', window.location.href).toString();
// BroadcastChannel is only used outside the native app.
const RECEIVER_CHANNEL = IS_NATIVE_APP ? null : new BroadcastChannel('alvr-receiver');
let receiverWindow = null;
// Becomes true only when the user explicitly presses "Stream to XR Glasses".
// Even if the receiver sends 'ready', init will not be sent until this flag is set.
let presentationRequested = false;

// Persistent listener for log messages forwarded from receiver.js.
if (RECEIVER_CHANNEL) {
  RECEIVER_CHANNEL.addEventListener('message', (e) => {
    if (e.data?.type === 'log') {
      log(`[Receiver] ${e.data.msg}`);
    } else if (e.data?.type === 'receiver_stats') {
      submitReceiverStats(e.data.stats);
    } else if (e.data?.type === 'request_idr') {
      // When the receiver sets force:true it has already applied its own rate
      // limit.  Bypass our 1 s cooldown so the IDR is not suppressed — otherwise
      // a cascade of overflows within 1 s of the last client-side IDR leaves
      // the decoder stuck with needsKeyFrame=true until the watchdog fires.
      requestIdr('receiver frame-drop', e.data.force === true);
    }
  });
}

// Native app: callback invoked by Java when receiver.js posts a message.
window.alvrClientOnMessage = function(jsonStr) {
  let msg;
  try { msg = JSON.parse(jsonStr); } catch (_) { return; }
  if (msg?.type === 'log') log(`[Receiver] ${msg.msg}`);
  if (msg?.type === 'ready') onReceiverReady();
  if (msg?.type === 'receiver_stats') submitReceiverStats(msg.stats);
  if (msg?.type === 'request_idr') {
    requestIdr('receiver frame-drop', msg.force === true);
  }
};

/** Sends an arbitrary JSON string to receiver.js. */
function sendToReceiver(jsonStr) {
  if (IS_NATIVE_APP) {
    try { window.AlvrNativeBridge.postToReceiver(jsonStr); } catch (_) {}
  } else if (RECEIVER_CHANNEL) {
    try { RECEIVER_CHANNEL.postMessage(JSON.parse(jsonStr)); } catch (_) {}
  }
}

// Callback invoked when receiver.js reports it is ready.
// (Native app: called from alvrClientOnMessage.
//  Windows Chrome: called from the BroadcastChannel onmessage listener.)
function onReceiverReady() {
  // Send init only after the user has pressed "Stream to XR Glasses".
  // Do not send on automatic display detection by DisplayManager.
  if (presentationRequested) {
    sendReceiverInit();
  }
}

/** Sends the init message to receiver.js. */
function sendReceiverInit() {
  const msg = {
    type:  'init',
    wsUrl: `${wsBase()}/ws/video`,
    codec: codecConfig,
    // WebTransport video info: receiver.js uses this for low-latency video
    // (one QUIC stream per frame, eliminating TCP head-of-line blocking).
    // null when WT is not active (WebSocket fallback applies).
    wtUrl:         _usingWt ? `https://${serverHost}:${serverPort}/wt/video` : null,
    wtFingerprint: _usingWt ? _wtFpHex : null,
    // Tracking timestamps are this page's performance.now(); receiver.js lives
    // in another document with its own time origin and needs this to convert.
    clientTimeOrigin: performance.timeOrigin,
  };
  sendToReceiver(JSON.stringify(msg));
  log('Init sent to receiver');
  // Sync the 6DoF mode state with the receiver.
  sendToReceiver(JSON.stringify({ type: 'set_6dof_mode', enabled: dsVirtual6DofMode }));

  // The receiver now owns the video stream (/wt/video or /ws/video).  Keeping
  // the preview connection open would make the server send every frame twice,
  // doubling the bitrate and saturating Wi-Fi (freeze / corruption).
  // Mark ownership first so no pending or future preview reconnect reopens it.
  _receiverOwnsVideo = true;
  const pendingPreviewReconnect = _reconnectTimers.get('preview-video');
  if (pendingPreviewReconnect) {
    clearTimeout(pendingPreviewReconnect);
    _reconnectTimers.delete('preview-video');
  }
  if (videoWs) {
    videoWs.onclose = null; // prevent the auto-reconnect in openVideoWs()
    videoWs.close();
    videoWs = null;
    log('Preview video WebSocket closed (receiver owns the video stream)');
  }
  videoDecoder?.close();
  videoDecoder = null;
  $('video-error').hidden = true;
}

/**
 * Opens receiver.html on the XR glasses display.
 *
 * Strategy:
 *   - Android Native App: XrDisplayPresentation is already started by Java.
 *     Only need to send init after receiver.html finishes loading.
 *   - Windows Chrome: Open via Window Management API or window.open().
 */
async function startPresentation() {
  const generation = _sessionGeneration;
  // User explicitly pressed the button; respond to receiver 'ready' events with init.
  presentationRequested = true;

  // Send recenter: true on the first frame that passes the presentationRequested
  // guard in sendImuTracking() below. Also reset the virtual camera coordinates.
  resetVirtual6DoFCamera();

  // Start the audio pipeline here (not in connect()) so audio only begins
  // when the user explicitly presses "Stream to XR Glasses".  This prevents
  // audio from resuming immediately after reconnect while a game is already
  // running (bug: audio played before this button was pressed on reconnect).
  await initAudio();
  if (!sessionIsActive(generation) || !presentationRequested) return;

  if (IS_NATIVE_APP) {
    // Native app: Presentation is already started by Java.
    // Java calls alvrReceiverOnMessage({type:'ready'}) once receiver.html loads,
    // but send init immediately as a fallback in case the receiver is already ready.
    log('Native app: sending init to receiver (Presentation already started by Java)');
    sendReceiverInit();
    return;
  }

  // Windows Chrome
  // Close any existing receiver window
  if (receiverWindow && !receiverWindow.closed) {
    receiverWindow.close();
  }

  // ---- Identify XR screen via Window Management API ----
  let xrScreen = null;
  if ('getScreenDetails' in window) {
    try {
      const screenDetails = await window.getScreenDetails();
      xrScreen = screenDetails.screens.find(s => !s.isPrimary) ?? null;
      if (xrScreen) {
        log(`XR screen: ${xrScreen.width}x${xrScreen.height} at (${xrScreen.left},${xrScreen.top})`);
      }
    } catch (e) {
      log(`Window Management API unavailable: ${e.message}`);
    }
  }

  // Step 1: Open receiver on the PRIMARY screen WITHOUT positioning.
  receiverWindow = window.open(
    RECEIVER_URL,
    'alvr-receiver',
    'menubar=no,toolbar=no,location=no,status=no,resizable=yes,width=640,height=480'
  );
  if (!receiverWindow) {
    alert('Could not open receiver window. Please allow pop-ups for this page.');
    return;
  }

  log('Receiver window opened. Accept any certificate warning, then it will move to your XR display…');

  // Helper: send 'init' and move window to XR screen (Step 2).
  const doSendInit = () => {
    if (!sessionIsActive(generation) || !presentationRequested) return;
    sendReceiverInit();

    if (xrScreen && receiverWindow && !receiverWindow.closed) {
      const { left, top, width, height } = xrScreen;
      try {
        receiverWindow.moveTo(left, top);
        receiverWindow.resizeTo(width, height);
        log(`Moved receiver to XR screen: ${width}x${height} at (${left},${top})`);
      } catch (err) {
        log(`Auto-position failed: ${err.message}. Drag the receiver window to your XR display and press F11.`);
      }
    } else if (!xrScreen) {
      log('No secondary screen found. Drag the receiver window to your XR display and press F11.');
    }
  };

  // Listen for 'ready' from receiver.html, then send init.
  let readyTimeoutId = null;
  const onMsg = (e) => {
    if (e.data?.type === 'ready') {
      RECEIVER_CHANNEL.removeEventListener('message', onMsg);
      clearTimeout(readyTimeoutId);
      _reconnectTimers.delete('receiver-ready');
      doSendInit();
    }
  };
  RECEIVER_CHANNEL.addEventListener('message', onMsg);

  // Timeout fallback: send init anyway after 8 s.
  readyTimeoutId = setTimeout(() => {
    _reconnectTimers.delete('receiver-ready');
    RECEIVER_CHANNEL.removeEventListener('message', onMsg);
    if (!sessionIsActive(generation) || !presentationRequested) return;
    log('Init sent to receiver (timeout fallback)');
    doSendInit();
  }, 8000);
  _reconnectTimers.set('receiver-ready', readyTimeoutId);
}

// ---------------------------------------------------------------------------
// Haptics (DualSense dual-rumble)
// ---------------------------------------------------------------------------

function triggerHaptics(event) {
  // Native App: Android WebView does not expose DualSense through the Gamepad API, so use Java.
  if (IS_NATIVE_APP) {
    window.AlvrNativeBridge?.triggerHaptics?.(
      event.duration_ms ?? 100,
      event.amplitude   ?? 0.5
    );
    return;
  }
  const gamepads = navigator.getGamepads();
  const gp = Array.from(gamepads).find(g => g && g.connected);
  if (!gp?.vibrationActuator) return;

  gp.vibrationActuator.playEffect('dual-rumble', {
    duration:        event.duration_ms ?? 100,
    strongMagnitude: event.amplitude   ?? 0.5,
    weakMagnitude:   (event.amplitude  ?? 0.5) * 0.5,
  }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Statistics reporting
// ---------------------------------------------------------------------------

function reportStats() {
  if (!videoDecoder) return;
  // Use the last video frame timestamp (performance.now()-based, same clock domain as
  // the tracking timestamps stored in the server's statistics history buffer).
  // This allows report_statistics() on the server to find the matching frame and
  // compute accurate network/game latency.  Fall back to performance.now() if no
  // frame has been received yet.
  const statsNs = _lastVideoTimestampNs > 0n
    ? _lastVideoTimestampNs
    : BigInt(Math.floor(performance.now() * 1e6));
  const frameIntervalMs = codecConfig ? 1000 / codecConfig.refresh_rate : 11.1;

  fetch(`${baseUrl()}/api/stats`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      target_timestamp_ns:       Number(statsNs),
      frame_interval_ms:         frameIntervalMs,
      video_decode_ms:           totalLatencyMs * 0.4,
      video_decoder_queue_ms:    0,
      rendering_ms:              totalLatencyMs * 0.2,
      vsync_queue_ms:            0,
      total_pipeline_latency_ms: totalLatencyMs,
    }),
  }).catch(() => {});
}

function submitReceiverStats(stats) {
  if (!sessionIsActive() || !stats) return;
  fetch(`${baseUrl()}/api/stats`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(stats),
  }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

window.addEventListener('DOMContentLoaded', () => {
  $('btn-connect').addEventListener('click', connect);
  $('btn-disconnect').addEventListener('click', disconnect);
  $('btn-present').addEventListener('click', startPresentation);

  // Show WebHID connect buttons only on Windows Chrome
  const btnHid = $('btn-hid-connect');
  if (btnHid) {
    if (!IS_ANDROID && HAS_WEBHID) {
      btnHid.hidden = false;
      btnHid.addEventListener('click', async () => {
        try {
          await navigator.hid.requestDevice({ filters: XR_HID_FILTERS });
        } catch (_) {}
        const ok = await tryConnectWebHid();
        showImuMode(ok ? 'WebHID (direct)' : 'Not connected');
      });
    } else {
      btnHid.hidden = true;
    }
  }
  const btnDs = $('btn-ds-connect');
  if (btnDs) {
    btnDs.hidden = IS_ANDROID || !HAS_WEBHID;
    if (!IS_ANDROID && HAS_WEBHID) {
      btnDs.addEventListener('click', () => requestDualSenseHid());
    }
  }

  // Log level dropdown – reflect current state and wire change handler
  // (Log level is now hardcoded; no dropdown to initialise.)
});
