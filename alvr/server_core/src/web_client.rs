// web_client.rs
//
// Web-based ALVR client server (port 8083, separate from the dashboard web server on port 8082).
//
// This module provides:
//   - HTTP server for serving the Web Client static assets (HTML/JS/CSS)
//   - WebSocket endpoint `/ws/video`    : streams H.264/HEVC/AV1 NAL units to the browser
//   - WebSocket endpoint `/ws/tracking` : receives IMU + controller tracking data from the browser
//   - WebSocket endpoint `/ws/events`   : pushes server-side events (haptics, IDR request, etc.)
//   - REST endpoint  GET  `/api/config`      : returns codec / resolution negotiation info
//   - REST endpoint  GET  `/api/wt-fingerprint`: SHA-256 fingerprint of the WT certificate
//   - REST endpoint  POST `/api/stats`   : receives client-side statistics
//   - WebTransport path `/wt/control`   : tracking datagrams (client→server) + events stream
//   - WebTransport path `/wt/video`     : video streams (server→client, one per frame)
//
// Design constraints:
//   - Must NOT import or reference anything from `web_server.rs`.
//   - Uses the same tokio runtime as the caller (spawned from lib.rs).
//   - All state is passed via `Arc<ConnectionContext>` (read-only access to shared globals).

use crate::{web_audio, ConnectionContext, ServerCoreEvent, SESSION_MANAGER, FILESYSTEM_LAYOUT};
use alvr_common::{
    anyhow::{self, Context as _, Result},
    debug, error, info, warn,
    parking_lot::Mutex,
};
use alvr_packets::{
    ButtonEntry, ClientStatistics, DecoderInitializationConfig, Tracking, VideoPacketHeader,
};
use futures::{SinkExt, StreamExt, stream};
use headers::HeaderMapExt;
use hyper::{
    header::{HeaderValue, ACCESS_CONTROL_ALLOW_ORIGIN, CACHE_CONTROL, CONTENT_TYPE},
    server::accept::from_stream,
    service, Body, Method, Request, Response, StatusCode,
};
use rcgen::generate_simple_self_signed;
use serde::{Deserialize, Serialize};
use serde_json as json;
use std::{
    collections::VecDeque,
    net::SocketAddr,
    sync::{
        atomic::{AtomicBool, AtomicU32, AtomicUsize, Ordering},
        Arc,
    },
    thread,
    time::Duration,
};
use tokio::io::AsyncWriteExt;
use tokio::net::TcpListener;
use tokio::sync::broadcast::{self, error::RecvError};
use tokio::sync::watch;
use tokio_rustls::{
    rustls::{pki_types::PrivateKeyDer, ServerConfig},
    TlsAcceptor,
};
use tokio_tungstenite::{tungstenite::protocol, WebSocketStream};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// Capacity of the broadcast channel used for video frame distribution.
/// 16 frames gives ~222 ms headroom at 72 Hz before RecvError::Lagged fires,
/// reducing spurious IDR requests caused by brief receiver slowdowns.
pub const VIDEO_BROADCAST_CAPACITY: usize = 16;

/// Capacity of the broadcast channel used for server-side event distribution.
pub const EVENT_BROADCAST_CAPACITY: usize = 64;

/// Capacity of the audio PCM broadcast channel.
/// 64 × 10 ms frames = 640 ms of headroom before Lagged fires.
pub const AUDIO_BROADCAST_CAPACITY: usize = 64;

/// Upper bound for opening an IDR stream (peer stream-count limit).  Once open,
/// an IDR is never reset (see `wt_send_video_stream`).
const WT_IDR_OPEN_TIMEOUT: Duration = Duration::from_secs(2);
/// Maximum number of unacknowledged video frame streams.
const WT_VIDEO_MAX_STREAMS: usize = 64;
/// New P frames are dropped while the oldest unacknowledged frame is older than
/// max(this, 2 × baseline RTT + WT_BACKLOG_RTT_MARGIN).
const WT_BACKLOG_MIN_AGE: Duration = Duration::from_millis(250);
const WT_BACKLOG_RTT_MARGIN: Duration = Duration::from_millis(100);
/// Unacknowledged P frames older than max(this, 2 × backlog limit) are reset.
const WT_P_FRAME_MIN_MAX_AGE: Duration = Duration::from_millis(500);
/// Interval of the congestion evaluation that caps the encoder bitrate.
const WT_CONGESTION_WINDOW: Duration = Duration::from_millis(500);
const WT_CAP_DECREASE_INTERVAL: Duration = Duration::from_secs(1);
const WT_CAP_INCREASE_DELAY: Duration = Duration::from_secs(3);
const WT_CAP_INCREASE_FACTOR: f32 = 1.05;
const WT_MIN_CAP_BPS: f32 = 2e6;
/// Minimum interval between server-originated IDR requests for one session.
const WT_SERVER_IDR_REQUEST_INTERVAL: Duration = Duration::from_secs(1);

/// Default port for the Web Client server (distinct from dashboard port 8082).
pub const WEB_CLIENT_DEFAULT_PORT: u16 = 8083;

// ---------------------------------------------------------------------------
// Shared state for the Web Client server
// ---------------------------------------------------------------------------

/// Codec + SPS/PPS initialisation data sent to the browser once per stream.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct VideoConfigMessage {
    /// "h264" | "hevc" | "av1"
    pub codec: String,
    /// Base64-encoded SPS+PPS NAL units (H.264/HEVC) or Sequence Header OBU (AV1).
    pub config_buffer_b64: String,
    /// Negotiated frame width in pixels.
    pub width: u32,
    /// Negotiated frame height in pixels.
    pub height: u32,
    /// Target refresh rate in Hz.
    pub refresh_rate: f32,
}

/// A single video frame message sent over the video WebSocket.
///
/// Binary layout:
///   [0..8]   timestamp_nanos  : u64 little-endian
///   [8]      is_idr           : u8  (0 = P-frame, 1 = IDR)
///   [9..]    NAL payload bytes
#[inline]
fn encode_video_frame(header: &VideoPacketHeader, payload: &[u8]) -> Vec<u8> {
    let ts_nanos = header.timestamp.as_nanos() as u64;
    let mut buf = Vec::with_capacity(9 + payload.len());
    buf.extend_from_slice(&ts_nanos.to_le_bytes());
    buf.push(header.is_idr as u8);
    buf.extend_from_slice(payload);
    buf
}

/// Server-to-client event message sent over the events WebSocket.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientEvent {
    /// Request the client to send an IDR frame (used after video glitch recovery).
    RequestIdr,
    /// Haptic feedback for a controller.
    Haptics {
        /// "left" | "right"
        hand: String,
        duration_ms: u64,
        frequency: f32,
        amplitude: f32,
    },
    /// Server is restarting; client should reconnect.
    Restarting,
}

/// Client-to-server tracking message received over the tracking WebSocket.
///
/// JSON schema (matches `alvr_packets::Tracking` fields):
/// ```json
/// {
///   "target_timestamp_ns": 123456789,
///   "head": {
///     "orientation": { "x": 0.0, "y": 0.0, "z": 0.0, "w": 1.0 },
///     "position":    { "x": 0.0, "y": 0.0, "z": 0.0 },
///     "linear_velocity":  { "x": 0.0, "y": 0.0, "z": 0.0 },
///     "angular_velocity": { "x": 0.0, "y": 0.0, "z": 0.0 }
///   },
///   "left_controller":  { ... },   // optional
///   "right_controller": { ... }    // optional
/// }
/// ```
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct TrackingMessage {
    pub target_timestamp_ns: u64,
    pub head: DeviceMotionJson,
    pub left_controller: Option<DeviceMotionJson>,
    pub right_controller: Option<DeviceMotionJson>,
    /// Button, trigger, and stick inputs. Used only with the WebSocket fallback.
    /// With WebTransport, buttons are sent over a dedicated reliable QUIC stream,
    /// so this field is always empty. Missing values are treated as an empty array.
    #[serde(default)]
    pub buttons: Vec<ButtonEntryJson>,
    /// If true, call TrackingManager::recenter() before applying tracking data.
    /// Missing values are treated as false for backward compatibility.
    #[serde(default)]
    pub recenter: bool,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct DeviceMotionJson {
    pub orientation: QuatJson,
    pub position: Vec3Json,
    pub linear_velocity: Vec3Json,
    pub angular_velocity: Vec3Json,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct QuatJson {
    pub x: f32,
    pub y: f32,
    pub z: f32,
    pub w: f32,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Vec3Json {
    pub x: f32,
    pub y: f32,
    pub z: f32,
}

/// Client-side statistics message received via POST `/api/stats`.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ClientStatsMessage {
    pub target_timestamp_ns: u64,
    pub frame_interval_ms: f32,
    pub video_decode_ms: f32,
    pub video_decoder_queue_ms: f32,
    pub rendering_ms: f32,
    pub vsync_queue_ms: f32,
    pub total_pipeline_latency_ms: f32,
}

// ---------------------------------------------------------------------------
// Broadcast senders (created once, shared across all WebSocket connections)
// ---------------------------------------------------------------------------

pub struct WebClientState {
    /// Broadcast channel for raw video frames: `(header, payload)`.
    pub video_sender: broadcast::Sender<(VideoPacketHeader, Vec<u8>)>,
    /// Broadcast channel for server-side events (haptics, IDR, restart).
    pub event_sender: broadcast::Sender<ClientEvent>,
    /// Latest decoder initialisation config (SPS/PPS), set by `set_video_config_nals`.
    pub decoder_config: Mutex<Option<DecoderInitializationConfig>>,
    /// Number of tracking WebSocket connections currently active.
    /// `ClientConnected` is sent when this goes 0→1.
    /// `ClientDisconnected` is sent when it goes 1→0.
    pub active_tracking_count: Arc<AtomicUsize>,
    /// Watch channel: fires `true` when `decoder_config` is first populated.
    /// Video WS handlers subscribe to this and wait if config is not yet ready.
    pub config_notify: watch::Sender<bool>,

    // ── Audio fields ──────────────────────────────────────────────────────
    /// Broadcast channel: game audio PCM i16 LE frames (Server → Browser).
    /// Populated by `web_audio::audio_out_loop`; subscribed by `/ws/audio_out`.
    pub audio_out_sender: broadcast::Sender<Vec<u8>>,
    /// Broadcast channel: game audio Opus packets (48 kHz stereo, 20 ms each).
    /// Populated by `web_audio::audio_out_opus_loop` while subscribed by
    /// `/ws/audio_out?codec=opus`.
    pub audio_out_opus_sender: broadcast::Sender<Vec<u8>>,
    /// Broadcast channel: microphone PCM i16 LE frames (Browser → Server).
    /// Populated by `/ws/audio_in` (Opus packets are decoded first);
    /// subscribed by `web_audio::audio_in_loop`.
    pub audio_in_sender: broadcast::Sender<Vec<u8>>,
    /// Game audio sample rate determined by the audio_out_loop thread.
    /// 0 means the thread has not started recording yet.
    pub audio_out_sample_rate: Arc<AtomicU32>,
    /// Microphone sample rate reported by the browser in the first WS frame.
    pub audio_in_sample_rate: Arc<AtomicU32>,
    /// Set to `true` when the first tracking WebSocket connects and `false`
    /// when the last one disconnects.  The audio loops use this to idle.
    pub audio_streaming: Arc<AtomicBool>,
    /// Set to `true` while a browser has an active `/ws/audio_in` WebSocket
    /// open.  The VAC output stream is only opened when this is `true`,
    /// preventing spurious retries when the user has not enabled the mic.
    pub audio_in_active: Arc<AtomicBool>,
    /// SHA-256 fingerprint (lowercase hex, no separators) of the WebTransport
    /// TLS certificate.  Set by `run_webtransport_server()` once the QUIC
    /// endpoint has started.  Served via `GET /api/wt-fingerprint` so browsers
    /// can use `serverCertificateHashes` for certificate pinning.
    pub wt_cert_fingerprint_hex: Mutex<Option<String>>,
}

impl WebClientState {
    pub fn new() -> Arc<Self> {
        let (video_sender, _) = broadcast::channel(VIDEO_BROADCAST_CAPACITY);
        let (event_sender, _) = broadcast::channel(EVENT_BROADCAST_CAPACITY);
        let (config_notify, _) = watch::channel(false);
        let (audio_out_sender, _) = broadcast::channel(AUDIO_BROADCAST_CAPACITY);
        let (audio_out_opus_sender, _) = broadcast::channel(AUDIO_BROADCAST_CAPACITY);
        let (audio_in_sender, _) = broadcast::channel(AUDIO_BROADCAST_CAPACITY);
        let audio_out_sample_rate = Arc::new(AtomicU32::new(0));
        let audio_in_sample_rate = Arc::new(AtomicU32::new(0));
        let audio_streaming = Arc::new(AtomicBool::new(false));
        let audio_in_active = Arc::new(AtomicBool::new(false));

        let state = Arc::new(Self {
            video_sender,
            event_sender,
            decoder_config: Mutex::new(None),
            active_tracking_count: Arc::new(AtomicUsize::new(0)),
            config_notify,
            audio_out_sender,
            audio_out_opus_sender,
            audio_in_sender,
            audio_out_sample_rate,
            audio_in_sample_rate,
            audio_streaming,
            audio_in_active,
            wt_cert_fingerprint_hex: Mutex::new(None),
        });

        // ── Spawn audio threads ───────────────────────────────────────────
        // These threads run for the lifetime of the process.  They idle
        // (sleep) when `audio_streaming` is false.
        {
            let sender = state.audio_out_sender.clone();
            let rate   = Arc::clone(&state.audio_out_sample_rate);
            let active = Arc::clone(&state.audio_streaming);
            thread::spawn(move || web_audio::audio_out_loop(sender, rate, active));
        }
        {
            let pcm_sender  = state.audio_out_sender.clone();
            let opus_sender = state.audio_out_opus_sender.clone();
            let rate        = Arc::clone(&state.audio_out_sample_rate);
            thread::spawn(move || web_audio::audio_out_opus_loop(pcm_sender, opus_sender, rate));
        }
        {
            let rx     = state.audio_in_sender.subscribe();
            let rate   = Arc::clone(&state.audio_in_sample_rate);
            let active = Arc::clone(&state.audio_streaming);
            let in_active = Arc::clone(&state.audio_in_active);
            thread::spawn(move || web_audio::audio_in_loop(rx, rate, active, in_active));
        }

        state
    }
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

fn reply(code: StatusCode) -> Result<Response<Body>> {
    Ok(Response::builder().status(code).body(Body::empty())?)
}

fn json_response<T: Serialize>(value: &T) -> Result<Response<Body>> {
    let body = json::to_string(value)?;
    Ok(Response::builder()
        .status(StatusCode::OK)
        .header(CONTENT_TYPE, "application/json")
        .body(body.into())?)
}

async fn read_json_body<T: serde::de::DeserializeOwned>(req: Request<Body>) -> Result<T> {
    let bytes = hyper::body::to_bytes(req.into_body()).await?;
    Ok(json::from_slice(&bytes)?)
}

fn add_cors_headers(resp: &mut Response<Body>) {
    resp.headers_mut().insert(
        ACCESS_CONTROL_ALLOW_ORIGIN,
        HeaderValue::from_static("*"),
    );
    resp.headers_mut().insert(
        CACHE_CONTROL,
        HeaderValue::from_static("no-cache, no-store, must-revalidate"),
    );
}

// ---------------------------------------------------------------------------
// WebSocket helpers
// ---------------------------------------------------------------------------

/// Handles a message read from a send-only WebSocket. Returns true when the
/// connection is closed: the socket must be read so the browser's Close frame
/// is processed and the send loop stops instead of streaming to a dead socket.
fn websocket_closed_by_client(
    incoming: Option<std::result::Result<protocol::Message, tokio_tungstenite::tungstenite::Error>>,
) -> bool {
    // Pings are answered by tungstenite on the next write.
    matches!(incoming, Some(Ok(protocol::Message::Close(_))) | Some(Err(_)) | None)
}

/// Upgrade an HTTP request to a WebSocket connection and spawn a task that
/// forwards messages from `sender` to the WebSocket.
fn websocket_send_only<T: Clone + Send + 'static>(
    request: Request<Body>,
    sender: broadcast::Sender<T>,
    message_builder: impl Fn(T) -> protocol::Message + Send + Sync + 'static,
) -> Result<Response<Body>> {
    if let Some(key) = request
        .headers()
        .typed_get::<headers::SecWebsocketKey>()
    {
        tokio::spawn(async move {
            match hyper::upgrade::on(request).await {
                Ok(upgraded) => {
                    let mut rx = sender.subscribe();
                    let mut ws =
                        WebSocketStream::from_raw_socket(upgraded, protocol::Role::Server, None)
                            .await;
                    loop {
                        tokio::select! {
                            message = rx.recv() => match message {
                                Ok(data) => {
                                    if ws.send(message_builder(data)).await.is_err() {
                                        break;
                                    }
                                    ws.flush().await.ok();
                                }
                                Err(RecvError::Lagged(_)) => {
                                    // Drop lagged frames silently; the client will request IDR.
                                }
                                Err(RecvError::Closed) => break,
                            },
                            incoming = ws.next() => {
                                if websocket_closed_by_client(incoming) {
                                    break;
                                }
                            }
                        }
                    }
                    ws.close(None).await.ok();
                }
                Err(e) => error!("WebSocket upgrade error: {e}"),
            }
        });

        let mut response = Response::builder()
            .status(StatusCode::SWITCHING_PROTOCOLS)
            .body(Body::empty())?;
        let h = response.headers_mut();
        h.typed_insert(headers::Upgrade::websocket());
        h.typed_insert(headers::SecWebsocketAccept::from(key));
        h.typed_insert(headers::Connection::upgrade());
        Ok(response)
    } else {
        reply(StatusCode::BAD_REQUEST)
    }
}

/// Upgrade an HTTP request to a WebSocket connection for the video stream.
///
/// On connection, sends the current decoder config as a JSON text frame first,
/// then streams binary video frames from `video_sender`.
/// Also sends an IDR request via `event_sender` so the encoder produces a
/// keyframe immediately after the browser has initialised its VideoDecoder.
///
/// The handler also watches for `config_notify` changes: if the decoder config
/// arrives *after* the WebSocket has already connected (e.g. because SteamVR
/// takes time to render the first frame when the Web Client is the first
/// connection), the updated config is pushed to the browser so it can
/// (re-)initialise its VideoDecoder.
fn websocket_video(
    request: Request<Body>,
    web_state: Arc<WebClientState>,
) -> Result<Response<Body>> {
    if let Some(key) = request
        .headers()
        .typed_get::<headers::SecWebsocketKey>()
    {
        tokio::spawn(async move {
            match hyper::upgrade::on(request).await {
                Ok(upgraded) => {
                    // Subscribe *before* building the WebSocket so we don't miss
                    // frames that arrive between upgrade and the first recv().
                    let mut rx = web_state.video_sender.subscribe();
                    // Subscribe to config changes before the initial check so
                    // we never miss a notification between the check and the
                    // select! loop below.
                    let mut cfg_rx = web_state.config_notify.subscribe();

                    let mut ws =
                        WebSocketStream::from_raw_socket(upgraded, protocol::Role::Server, None)
                            .await;

                    /// Build a VideoConfigMessage JSON string from the current
                    /// decoder config, or return `None` if no config is set yet.
                    fn build_config_json(web_state: &WebClientState) -> Option<String> {
                        let guard = web_state.decoder_config.lock();
                        if let Some(config) = &*guard {
                            let (width, height, refresh_rate) = negotiated_resolution_and_fps();
                            let config_msg = VideoConfigMessage {
                                codec: codec_type_to_str(config.codec).to_owned(),
                                config_buffer_b64: base64_encode(&config.config_buffer),
                                width,
                                height,
                                refresh_rate,
                            };
                            json::to_string(&config_msg).ok()
                        } else {
                            None
                        }
                    }

                    // Send decoder config immediately if it is already available.
                    // If it is not yet available we will send it from inside the
                    // select! loop once `config_notify` fires.
                    if let Some(json_str) = build_config_json(&web_state) {
                        if ws.send(protocol::Message::Text(json_str)).await.is_err() {
                            ws.close(None).await.ok();
                            return;
                        }
                        // Request an IDR so the browser can start decoding immediately.
                        web_state.event_sender.send(ClientEvent::RequestIdr).ok();
                    }

                    // Stream binary video frames, and also watch for late-arriving
                    // decoder config (common when the Web Client is the very first
                    // client connection and SteamVR hasn't started rendering yet).
                    loop {
                        tokio::select! {
                            // ---- Video frame from encoder ----
                            frame = rx.recv() => {
                                match frame {
                                    Ok((header, payload)) => {
                                        let msg = encode_video_frame(&header, &payload);
                                        if ws.send(protocol::Message::Binary(msg)).await.is_err() {
                                            break;
                                        }
                                        ws.flush().await.ok();
                                    }
                                    Err(RecvError::Lagged(_)) => {
                                        web_state.event_sender.send(ClientEvent::RequestIdr).ok();
                                    }
                                    Err(RecvError::Closed) => break,
                                }
                            }

                            // ---- Decoder config became available or changed ----
                            cfg_change = cfg_rx.changed() => {
                                if cfg_change.is_err() { break; }
                                if let Some(json_str) = build_config_json(&web_state) {
                                    if ws.send(protocol::Message::Text(json_str)).await.is_err() {
                                        break;
                                    }
                                    // Request IDR so the browser can start decoding immediately.
                                    web_state.event_sender.send(ClientEvent::RequestIdr).ok();
                                }
                            }

                            // ---- Messages from the browser (Close / Ping) ----
                            // The socket must be read: otherwise the browser's Close
                            // frame is never processed, Chromium keeps the socket in
                            // CLOSING state for up to 60 s, and this loop keeps
                            // streaming video next to the receiver's own stream
                            // (double bitrate → Wi-Fi saturation → freeze).
                            incoming = ws.next() => {
                                match incoming {
                                    Some(Ok(protocol::Message::Close(_))) | None => {
                                        info!("Video WebSocket: closed by client — stopping video stream");
                                        break;
                                    }
                                    Some(Err(e)) => {
                                        info!("Video WebSocket: read error ({e}) — stopping video stream");
                                        break;
                                    }
                                    // Pings are answered by tungstenite on the next write.
                                    Some(Ok(_)) => {}
                                }
                            }
                        }
                    }
                    ws.close(None).await.ok();
                }
                Err(e) => error!("Video WebSocket upgrade error: {e}"),
            }
        });

        let mut response = Response::builder()
            .status(StatusCode::SWITCHING_PROTOCOLS)
            .body(Body::empty())?;
        let h = response.headers_mut();
        h.typed_insert(headers::Upgrade::websocket());
        h.typed_insert(headers::SecWebsocketAccept::from(key));
        h.typed_insert(headers::Connection::upgrade());
        Ok(response)
    } else {
        reply(StatusCode::BAD_REQUEST)
    }
}

/// Upgrade an HTTP request to a WebSocket connection and spawn a task that
/// reads messages from the WebSocket and calls `on_message` for each one.
/// Dedicated WebSocket handler for `/ws/tracking`.
///
/// Fires `ClientConnected` (+ `ViewsConfig`, `PlayspaceSync`) when the first
/// browser tracking client connects, and `ClientDisconnected` when the last
/// one disconnects.  This is the signal that makes `InitializeStreaming()` run
/// inside the OpenVR driver and activates SteamVR rendering.
fn websocket_tracking(
    request: Request<Body>,
    ctx: Arc<ConnectionContext>,
    web_state: Arc<WebClientState>,
) -> Result<Response<Body>> {
    if let Some(key) = request
        .headers()
        .typed_get::<headers::SecWebsocketKey>()
    {
        tokio::spawn(async move {
            match hyper::upgrade::on(request).await {
                Ok(upgraded) => {
                    // --- ON CONNECT -----------------------------------------------
                    let prev = web_state
                        .active_tracking_count
                        .fetch_add(1, Ordering::SeqCst);
                    if prev == 0 {
                        web_state.audio_streaming.store(true, Ordering::Relaxed);
                        // First browser client: tell SteamVR a headset is present.
                        use alvr_common::{Fov, Pose};
                        use alvr_common::glam::{Quat, Vec2, Vec3};

                        // FOV: tangent half-angles matching XREAL Air 2 Ultra
                        // (~46° H / ~35° V).
                        let fov = Fov {
                            left:  -0.83,
                            right:  0.83,
                            up:     0.63,
                            down:  -0.63,
                        };
                        let ipd_half = 0.032_f32; // 64 mm IPD, ±32 mm per eye
                        let rot = Quat::IDENTITY;
                        ctx.events_sender
                            .send(ServerCoreEvent::ViewsConfig(crate::ViewsConfig {
                                local_view_transforms: [
                                    Pose {
                                        orientation: rot,
                                        position: Vec3::new(-ipd_half, 0.0, 0.0),
                                    },
                                    Pose {
                                        orientation: rot,
                                        position: Vec3::new(ipd_half, 0.0, 0.0),
                                    },
                                ],
                                fov: [fov, fov],
                            }))
                            .ok();
                        ctx.events_sender
                            .send(ServerCoreEvent::PlayspaceSync(Vec2::new(2.0, 2.0)))
                            .ok();
                        ctx.events_sender
                            .send(ServerCoreEvent::ClientConnected)
                            .ok();
                        info!("Web client connected — streaming initialised");
                    }

                    let mut ws = WebSocketStream::from_raw_socket(
                        upgraded,
                        protocol::Role::Server,
                        None,
                    )
                    .await;

                    while let Some(msg) = ws.next().await {
                        match msg {
                            Ok(protocol::Message::Text(text)) => {
                                match json::from_str::<TrackingMessage>(&text) {
                                    Ok(msg) => {

                                        let tracking = tracking_msg_to_alvr(&msg);
                                        let timestamp = tracking.target_timestamp;
                                        if let Some(stats) =
                                            &mut *ctx.statistics_manager.write()
                                        {
                                            stats.report_tracking_received(timestamp);
                                        }
                                        {
                                            let mut tm = ctx.tracking_manager.write();
                                            let session_lock = SESSION_MANAGER.read();
                                            let headset_config =
                                                &session_lock.settings().headset;
                                            tm.report_device_motions(
                                                headset_config,
                                                timestamp,
                                                &tracking.device_motions,
                                            );
                                            // Run recenter after report_device_motions().
                                            // The Web Client sends the new position (the virtual origin)
                                            // after resetVirtual6DoFCamera() and then sets the recenter
                                            // flag, so calculate the recenter origin after last_head_pose
                                            // has been updated to the reset position.
                                            // Running it earlier leaves last_head_pose at the old position
                                            // and moves the origin off-center.
                                            if msg.recenter {
                                                let pos_mode =
                                                    headset_config.position_recentering_mode.clone();
                                                let rot_mode =
                                                    headset_config.rotation_recentering_mode.clone();
                                                tm.recenter(pos_mode, rot_mode);
                                                info!("Web client requested recenter");
                                            }
                                        }
                                        // Process button, trigger, and stick inputs.
                                        if !msg.buttons.is_empty() {
                                            let button_entries: Vec<ButtonEntry> = msg
                                                .buttons
                                                .iter()
                                                .map(|e| ButtonEntry {
                                                    path_id: alvr_common::hash_string(&e.path),
                                                    value: e.value.clone().into(),
                                                })
                                                .collect();
                                            ctx.events_sender
                                                .send(ServerCoreEvent::Buttons(button_entries))
                                                .ok();
                                        }
                                        ctx.events_sender
                                            .send(ServerCoreEvent::Tracking {
                                                sample_timestamp: timestamp,
                                            })
                                            .ok();
                                    }
                                    Err(e) => {
                                        debug!("Failed to parse tracking message: {e}");
                                    }
                                }
                            }
                            Ok(protocol::Message::Close(_)) => break,
                            Err(e) => {
                                info!("Tracking WebSocket error: {e}");
                                break;
                            }
                            _ => {}
                        }
                    }

                    ws.close(None).await.ok();

                    // --- ON DISCONNECT --------------------------------------------
                    let remaining = web_state
                        .active_tracking_count
                        .fetch_sub(1, Ordering::SeqCst)
                        .saturating_sub(1);
                    if remaining == 0 {
                        web_state.audio_streaming.store(false, Ordering::Relaxed);
                        ctx.events_sender
                            .send(ServerCoreEvent::ClientDisconnected)
                            .ok();
                        info!("Web client disconnected — streaming stopped");
                    }
                }
                Err(e) => error!("WebSocket upgrade error: {e}"),
            }
        });

        let mut response = Response::builder()
            .status(StatusCode::SWITCHING_PROTOCOLS)
            .body(Body::empty())?;
        let h = response.headers_mut();
        h.typed_insert(headers::Upgrade::websocket());
        h.typed_insert(headers::SecWebsocketAccept::from(key));
        h.typed_insert(headers::Connection::upgrade());
        Ok(response)
    } else {
        reply(StatusCode::BAD_REQUEST)
    }
}

// ---------------------------------------------------------------------------
// Audio WebSocket handlers
// ---------------------------------------------------------------------------

/// `/ws/audio_out` — sends game audio PCM i16 LE frames to the browser.
///
/// First frame is a JSON text message:
/// ```json
/// {"type":"config","codec":"pcm","sample_rate":48000,"channels":2}
/// ```
/// Subsequent frames are binary PCM i16 LE interleaved stereo.
///
/// With `?codec=opus` in the URL, the config is
/// `{"type":"config","codec":"opus","sample_rate":48000,"channels":2}` and
/// each subsequent binary frame is one Opus packet (20 ms).  Clients that do
/// not request Opus, or that ignore `codec`, keep receiving PCM.
fn websocket_audio_out(
    request: Request<Body>,
    web_state: Arc<WebClientState>,
) -> Result<Response<Body>> {
    if let Some(key) = request.headers().typed_get::<headers::SecWebsocketKey>() {
        let use_opus = request
            .uri()
            .query()
            .is_some_and(|query| query.split('&').any(|param| param == "codec=opus"));
        tokio::spawn(async move {
            match hyper::upgrade::on(request).await {
                Ok(upgraded) => {
                    let mut rx = if use_opus {
                        web_state.audio_out_opus_sender.subscribe()
                    } else {
                        web_state.audio_out_sender.subscribe()
                    };
                    let mut ws =
                        WebSocketStream::from_raw_socket(upgraded, protocol::Role::Server, None)
                            .await;

                    // Send config frame first.
                    let sample_rate = web_state.audio_out_sample_rate.load(Ordering::Relaxed);
                    let config_json = json::json!({
                        "type": "config",
                        "codec": if use_opus { "opus" } else { "pcm" },
                        "sample_rate": if use_opus || sample_rate == 0 {
                            web_audio::OPUS_SAMPLE_RATE
                        } else {
                            sample_rate
                        },
                        "channels": 2u32,
                    })
                    .to_string();
                    info!(
                        "audio_out WebSocket: streaming {}",
                        if use_opus { "Opus" } else { "PCM" }
                    );
                    if ws
                        .send(protocol::Message::Text(config_json))
                        .await
                        .is_err()
                    {
                        ws.close(None).await.ok();
                        return;
                    }

                    // Stream PCM frames / Opus packets.
                    loop {
                        tokio::select! {
                            pcm = rx.recv() => match pcm {
                                Ok(pcm) => {
                                    if ws.send(protocol::Message::Binary(pcm)).await.is_err() {
                                        break;
                                    }
                                    ws.flush().await.ok();
                                }
                                Err(RecvError::Lagged(_)) => {} // skip frames
                                Err(RecvError::Closed) => break,
                            },
                            incoming = ws.next() => {
                                if websocket_closed_by_client(incoming) {
                                    break;
                                }
                            }
                        }
                    }
                    ws.close(None).await.ok();
                }
                Err(e) => error!("audio_out WebSocket upgrade error: {e}"),
            }
        });

        let mut response = Response::builder()
            .status(StatusCode::SWITCHING_PROTOCOLS)
            .body(Body::empty())?;
        let h = response.headers_mut();
        h.typed_insert(headers::Upgrade::websocket());
        h.typed_insert(headers::SecWebsocketAccept::from(key));
        h.typed_insert(headers::Connection::upgrade());
        Ok(response)
    } else {
        reply(StatusCode::BAD_REQUEST)
    }
}

/// `/ws/audio_in` — receives microphone audio from the browser.
///
/// First frame from the browser is a JSON text message:
/// ```json
/// {"type":"config","sample_rate":48000,"channels":1,"codec":"opus"}
/// ```
/// The server answers with `{"type":"config","codec":"opus"|"pcm"}`.
/// Subsequent frames are one Opus packet each (48 kHz mono) when `opus` was
/// accepted, otherwise binary PCM i16 LE mono.  Clients that omit `codec`, or
/// that receive no answer (older servers), send PCM.
fn websocket_audio_in(
    request: Request<Body>,
    web_state: Arc<WebClientState>,
) -> Result<Response<Body>> {
    if let Some(key) = request.headers().typed_get::<headers::SecWebsocketKey>() {
        tokio::spawn(async move {
            match hyper::upgrade::on(request).await {
                Ok(upgraded) => {
                    let mut ws =
                        WebSocketStream::from_raw_socket(upgraded, protocol::Role::Server, None)
                            .await;

                    // Mark mic as active so audio_in_loop opens VAC.
                    web_state.audio_in_active.store(true, Ordering::Relaxed);

                    let mut config_received = false;
                    let mut opus_decoder: Option<web_audio::OpusMicDecoder> = None;
                    let mut decode_errors: u64 = 0;

                    while let Some(msg) = ws.next().await {
                        match msg {
                            Ok(protocol::Message::Text(text)) if !config_received => {
                                // Parse config frame from the browser.
                                let config = json::from_str::<json::Value>(&text).ok();
                                let wants_opus = config
                                    .as_ref()
                                    .and_then(|v| v.get("codec"))
                                    .and_then(|v| v.as_str())
                                    == Some("opus");
                                if wants_opus {
                                    match web_audio::OpusMicDecoder::new() {
                                        Ok(decoder) => opus_decoder = Some(decoder),
                                        Err(e) => error!("audio_in: Opus decoder init error: {e}"),
                                    }
                                }
                                let sample_rate = if opus_decoder.is_some() {
                                    Some(web_audio::OPUS_SAMPLE_RATE as u64)
                                } else {
                                    config
                                        .as_ref()
                                        .and_then(|v| v.get("sample_rate"))
                                        .and_then(|v| v.as_u64())
                                };
                                if let Some(sr) = sample_rate {
                                    web_state
                                        .audio_in_sample_rate
                                        .store(sr as u32, Ordering::Relaxed);
                                }
                                config_received = true;

                                let codec = if opus_decoder.is_some() { "opus" } else { "pcm" };
                                info!("audio_in WebSocket: receiving {codec}");
                                let reply = json::json!({ "type": "config", "codec": codec })
                                    .to_string();
                                if ws.send(protocol::Message::Text(reply)).await.is_err() {
                                    break;
                                }
                            }
                            Ok(protocol::Message::Binary(data)) => {
                                let pcm = match &mut opus_decoder {
                                    Some(decoder) => match decoder.decode(&data) {
                                        Ok(pcm) => pcm,
                                        Err(e) => {
                                            decode_errors += 1;
                                            if decode_errors == 1 || decode_errors.is_multiple_of(500) {
                                                warn!(
                                                    "audio_in: Opus decode error \
                                                     ({decode_errors} total): {e}"
                                                );
                                            }
                                            continue;
                                        }
                                    },
                                    None => data,
                                };
                                web_state.audio_in_sender.send(pcm).ok();
                            }
                            Ok(protocol::Message::Close(_)) => break,
                            Err(e) => {
                                info!("audio_in WebSocket error: {e}");
                                break;
                            }
                            _ => {}
                        }
                    }

                    // Browser disconnected – stop the VAC stream.
                    web_state.audio_in_active.store(false, Ordering::Relaxed);
                    ws.close(None).await.ok();
                }
                Err(e) => error!("audio_in WebSocket upgrade error: {e}"),
            }
        });

        let mut response = Response::builder()
            .status(StatusCode::SWITCHING_PROTOCOLS)
            .body(Body::empty())?;
        let h = response.headers_mut();
        h.typed_insert(headers::Upgrade::websocket());
        h.typed_insert(headers::SecWebsocketAccept::from(key));
        h.typed_insert(headers::Connection::upgrade());
        Ok(response)
    } else {
        reply(StatusCode::BAD_REQUEST)
    }
}

// ---------------------------------------------------------------------------
// HTTP → HTTPS redirect helper
// ---------------------------------------------------------------------------

/// Respond to a plain-HTTP connection with a `301 Moved Permanently` redirect
/// to the equivalent `https://` URL.
///
/// The redirect target is built from:
/// - the local address of the accepted TCP socket (gives the correct IP:port),
/// - the request path parsed from the first line of the HTTP request.
///
/// This prevents "TLS handshake error: received corrupt message of type
/// invalidContentType" spam in the ALVR Dashboard whenever a browser tab
/// still has the old `http://` URL open.
async fn redirect_http_to_https(mut tcp: tokio::net::TcpStream) {
    use tokio::io::AsyncReadExt;

    // Obtain the server-side address (IP + port) from the socket.
    let local_addr = tcp
        .local_addr()
        .map(|a| a.to_string())
        .unwrap_or_else(|_| "localhost".to_string());

    // Read the HTTP request to extract the path.
    let mut buf = [0u8; 2048];
    let n = match tcp.read(&mut buf).await {
        Ok(n) if n > 0 => n,
        _ => return,
    };

    // Parse request line: "GET /path HTTP/1.1"
    let path = std::str::from_utf8(&buf[..n])
        .unwrap_or("")
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .unwrap_or("/");

    // Clamp path length to avoid redirect targets that are absurdly long.
    let path = if path.len() > 256 { "/" } else { path };

    let location = format!("https://{local_addr}{path}");
    let body = format!(
        "<html><body>Redirecting to <a href=\"{location}\">{location}</a></body></html>"
    );
    let response = format!(
        "HTTP/1.1 301 Moved Permanently\r\n\
         Location: {location}\r\n\
         Content-Type: text/html; charset=utf-8\r\n\
         Content-Length: {}\r\n\
         Connection: close\r\n\
         \r\n\
         {body}",
        body.len()
    );

    tcp.write_all(response.as_bytes()).await.ok();
}

// ---------------------------------------------------------------------------
// Static asset serving
// ---------------------------------------------------------------------------

/// Serve embedded static Web Client assets.
///
/// In production the assets are compiled into the binary via `include_str!` /
/// `include_bytes!`.  During development they can be served from the file
/// system by setting the `ALVR_WEB_CLIENT_DIR` environment variable.
fn serve_static(path: &str) -> Result<Response<Body>> {
    // Normalise path: strip leading '/' and default to index.html.
    let rel = path.trim_start_matches('/');
    let rel = if rel.is_empty() { "index.html" } else { rel };

    // Development override: serve from filesystem when env var is set.
    if let Ok(dir) = std::env::var("ALVR_WEB_CLIENT_DIR") {
        let full_path = std::path::Path::new(&dir).join(rel);
        match std::fs::read(&full_path) {
            Ok(bytes) => {
                let mime = mime_for_path(rel);
                return Ok(Response::builder()
                    .status(StatusCode::OK)
                    .header(CONTENT_TYPE, mime)
                    .body(bytes.into())?);
            }
            Err(_) => return reply(StatusCode::NOT_FOUND),
        }
    }

    // Production: embedded assets.
    match rel {
        "index.html" => {
            let html = include_str!("../../../webclient/index.html");
            Ok(Response::builder()
                .status(StatusCode::OK)
                .header(CONTENT_TYPE, "text/html; charset=utf-8")
                .body(html.into())?)
        }
        "receiver.html" => {
            let html = include_str!("../../../webclient/receiver.html");
            Ok(Response::builder()
                .status(StatusCode::OK)
                .header(CONTENT_TYPE, "text/html; charset=utf-8")
                .body(html.into())?)
        }
        "client.js" => {
            let js = include_str!("../../../webclient/client.js");
            Ok(Response::builder()
                .status(StatusCode::OK)
                .header(CONTENT_TYPE, "application/javascript; charset=utf-8")
                .body(js.into())?)
        }
        "video-decoder.js" => {
            let js = include_str!("../../../webclient/video-decoder.js");
            Ok(Response::builder()
                .status(StatusCode::OK)
                .header(CONTENT_TYPE, "application/javascript; charset=utf-8")
                .body(js.into())?)
        }
        "dualsense-hid.js" => {
            let js = include_str!("../../../webclient/dualsense-hid.js");
            Ok(Response::builder()
                .status(StatusCode::OK)
                .header(CONTENT_TYPE, "application/javascript; charset=utf-8")
                .body(js.into())?)
        }
        "viture-hid.js" => {
            let js = include_str!("../../../webclient/viture-hid.js");
            Ok(Response::builder()
                .status(StatusCode::OK)
                .header(CONTENT_TYPE, "application/javascript; charset=utf-8")
                .body(js.into())?)
        }
        "xreal-hid.js" => {
            let js = include_str!("../../../webclient/xreal-hid.js");
            Ok(Response::builder()
                .status(StatusCode::OK)
                .header(CONTENT_TYPE, "application/javascript; charset=utf-8")
                .body(js.into())?)
        }
        "rayneo-hid.js" => {
            let js = include_str!("../../../webclient/rayneo-hid.js");
            Ok(Response::builder()
                .status(StatusCode::OK)
                .header(CONTENT_TYPE, "application/javascript; charset=utf-8")
                .body(js.into())?)
        }
        "mahony.js" => {
            let js = include_str!("../../../webclient/mahony.js");
            Ok(Response::builder()
                .status(StatusCode::OK)
                .header(CONTENT_TYPE, "application/javascript; charset=utf-8")
                .body(js.into())?)
        }
        "receiver.js" => {
            let js = include_str!("../../../webclient/receiver.js");
            Ok(Response::builder()
                .status(StatusCode::OK)
                .header(CONTENT_TYPE, "application/javascript; charset=utf-8")
                .body(js.into())?)
        }
        "style.css" => {
            let css = include_str!("../../../webclient/style.css");
            Ok(Response::builder()
                .status(StatusCode::OK)
                .header(CONTENT_TYPE, "text/css; charset=utf-8")
                .body(css.into())?)
        }
        "audio-processor.js" => {
            let js = include_str!("../../../webclient/audio-processor.js");
            Ok(Response::builder()
                .status(StatusCode::OK)
                .header(CONTENT_TYPE, "application/javascript; charset=utf-8")
                .body(js.into())?)
        }
        "controller_icon.png" => {
            let png = include_bytes!("../../../webclient/controller_icon.png");
            Ok(Response::builder()
                .status(StatusCode::OK)
                .header(CONTENT_TYPE, "image/png")
                .body(Body::from(png.as_ref()))?)
        }
        _ => reply(StatusCode::NOT_FOUND),
    }
}

fn mime_for_path(path: &str) -> &'static str {
    if path.ends_with(".html") {
        "text/html; charset=utf-8"
    } else if path.ends_with(".js") || path.ends_with(".mjs") {
        "application/javascript; charset=utf-8"
    } else if path.ends_with(".css") {
        "text/css; charset=utf-8"
    } else if path.ends_with(".wasm") {
        "application/wasm"
    } else if path.ends_with(".png") {
        "image/png"
    } else if path.ends_with(".svg") {
        "image/svg+xml"
    } else {
        "application/octet-stream"
    }
}

// ---------------------------------------------------------------------------
// Tracking message → ALVR packets conversion
// ---------------------------------------------------------------------------

fn tracking_msg_to_alvr(msg: &TrackingMessage) -> Tracking {
    use alvr_common::glam::{Quat, Vec3};
    use alvr_common::{DeviceMotion, Pose, HEAD_ID, HAND_LEFT_ID, HAND_RIGHT_ID};

    let to_quat = |q: &QuatJson| Quat::from_xyzw(q.x, q.y, q.z, q.w).normalize();
    let to_vec3 = |v: &Vec3Json| Vec3::new(v.x, v.y, v.z);

    let to_motion = |m: &DeviceMotionJson| DeviceMotion {
        pose: Pose {
            orientation: to_quat(&m.orientation),
            position: to_vec3(&m.position),
        },
        linear_velocity: to_vec3(&m.linear_velocity),
        angular_velocity: to_vec3(&m.angular_velocity),
    };

    let mut device_motions = vec![(*HEAD_ID, to_motion(&msg.head))];

    if let Some(lc) = &msg.left_controller {
        device_motions.push((*HAND_LEFT_ID, to_motion(lc)));
    }
    if let Some(rc) = &msg.right_controller {
        device_motions.push((*HAND_RIGHT_ID, to_motion(rc)));
    }

    Tracking {
        target_timestamp: Duration::from_nanos(msg.target_timestamp_ns),
        device_motions,
        hand_skeletons: [None, None],
        face_data: Default::default(),
    }
}

// ---------------------------------------------------------------------------
// ClientStatistics conversion
// ---------------------------------------------------------------------------

fn stats_msg_to_alvr(msg: &ClientStatsMessage) -> ClientStatistics {
    ClientStatistics {
        target_timestamp: Duration::from_nanos(msg.target_timestamp_ns),
        frame_interval: Duration::from_secs_f32(msg.frame_interval_ms / 1000.0),
        video_decode: Duration::from_secs_f32(msg.video_decode_ms / 1000.0),
        video_decoder_queue: Duration::from_secs_f32(msg.video_decoder_queue_ms / 1000.0),
        rendering: Duration::from_secs_f32(msg.rendering_ms / 1000.0),
        vsync_queue: Duration::from_secs_f32(msg.vsync_queue_ms / 1000.0),
        total_pipeline_latency: Duration::from_secs_f32(msg.total_pipeline_latency_ms / 1000.0),
    }
}

// ---------------------------------------------------------------------------
// HTTP request router
// ---------------------------------------------------------------------------

async fn handle_request(
    connection_context: Arc<ConnectionContext>,
    web_state: Arc<WebClientState>,
    request: Request<Body>,
) -> Result<Response<Body>> {
    let path = request.uri().path().to_owned();
    let method = request.method().clone();

    let mut response = match (method.clone(), path.as_str()) {
        // ------------------------------------------------------------------
        // WebSocket: video stream  (server → client, binary frames)
        // ------------------------------------------------------------------
        (Method::GET, "/ws/video") => {
            // Delegate to the dedicated video WebSocket handler which:
            //   1. Sends the decoder config as a JSON text frame on connect.
            //   2. Requests an IDR so the browser can start decoding immediately.
            //   3. Streams binary video frames until the connection closes.
            websocket_video(request, Arc::clone(&web_state))?
        }

        // ------------------------------------------------------------------
        // WebSocket: tracking  (client → server, JSON)
        // ------------------------------------------------------------------
        (Method::GET, "/ws/tracking") => {
            let ctx = Arc::clone(&connection_context);
            let wstate = Arc::clone(&web_state);
            websocket_tracking(request, ctx, wstate)?
        }

        // ------------------------------------------------------------------
        // WebSocket: game audio  (server → client, binary PCM i16 LE)
        // ------------------------------------------------------------------
        (Method::GET, "/ws/audio_out") => {
            websocket_audio_out(request, Arc::clone(&web_state))?
        }

        // ------------------------------------------------------------------
        // WebSocket: microphone  (client → server, binary PCM i16 LE)
        // ------------------------------------------------------------------
        (Method::GET, "/ws/audio_in") => {
            websocket_audio_in(request, Arc::clone(&web_state))?
        }

        // ------------------------------------------------------------------
        // WebSocket: server events  (server → client, JSON text)
        // ------------------------------------------------------------------
        (Method::GET, "/ws/events") => websocket_send_only(
            request,
            web_state.event_sender.clone(),
            |event| {
                protocol::Message::Text(json::to_string(&event).unwrap_or_default())
            },
        )?,

        // ------------------------------------------------------------------
        // REST: video config  GET /api/config
        // ------------------------------------------------------------------
        (Method::GET, "/api/config") => {
            if let Some(config) = &*web_state.decoder_config.lock() {
                let (width, height, refresh_rate) = negotiated_resolution_and_fps();
                let msg = VideoConfigMessage {
                    codec: codec_type_to_str(config.codec).to_owned(),
                    config_buffer_b64: base64_encode(&config.config_buffer),
                    width,
                    height,
                    refresh_rate,
                };
                json_response(&msg)?
            } else {
                reply(StatusCode::NO_CONTENT)?
            }
        }

        // ------------------------------------------------------------------
        // REST: WebTransport certificate fingerprint  GET /api/wt-fingerprint
        //
        // Returns the SHA-256 fingerprint of the WebTransport TLS certificate
        // (14-day self-signed, generated on server start) as a lowercase hex
        // string.  The browser uses this for serverCertificateHashes pinning.
        // Returns 503 until the WebTransport server has started.
        // ------------------------------------------------------------------
        (Method::GET, "/api/wt-fingerprint") => {
            match &*web_state.wt_cert_fingerprint_hex.lock() {
                Some(fp) => {
                    json_response(&serde_json::json!({ "fingerprint_hex": fp }))?
                }
                None => reply(StatusCode::SERVICE_UNAVAILABLE)?,
            }
        }

        // ------------------------------------------------------------------
        // REST: client statistics  POST /api/stats
        // ------------------------------------------------------------------
        (Method::POST, "/api/stats") => {
            match read_json_body::<ClientStatsMessage>(request).await {
                Ok(msg) => {
                    let stats = stats_msg_to_alvr(&msg);
                    if let Some(sm) = &mut *connection_context.statistics_manager.write() {
                        let timestamp = stats.target_timestamp;
                        let decoder_latency = stats.video_decode;
                        let (network_latency, game_time_latency) =
                            sm.report_statistics(stats);
                        connection_context
                            .events_sender
                            .send(ServerCoreEvent::GameRenderLatencyFeedback(game_time_latency))
                            .ok();
                        let session_lock = SESSION_MANAGER.read();
                        connection_context
                            .bitrate_manager
                            .lock()
                            .report_frame_latencies(
                                &session_lock.settings().video.bitrate.mode,
                                timestamp,
                                network_latency,
                                decoder_latency,
                            );
                    }
                    reply(StatusCode::OK)?
                }
                Err(e) => {
                    error!("Failed to parse stats message: {e}");
                    reply(StatusCode::BAD_REQUEST)?
                }
            }
        }

        // ------------------------------------------------------------------
        // REST: request IDR  POST /api/request-idr
        // ------------------------------------------------------------------
        (Method::POST, "/api/request-idr") => {
            connection_context
                .events_sender
                .send(ServerCoreEvent::RequestIDR)
                .ok();
            reply(StatusCode::OK)?
        }

        // ------------------------------------------------------------------
        // REST: server version  GET /api/version
        // ------------------------------------------------------------------
        (Method::GET, "/api/version") => Response::builder()
            .status(StatusCode::OK)
            .body(alvr_common::ALVR_VERSION.to_string().into())?,

        // ------------------------------------------------------------------
        // REST: ping  GET /api/ping
        // ------------------------------------------------------------------
        (Method::GET, "/api/ping") => reply(StatusCode::OK)?,

        // ------------------------------------------------------------------
        // CORS preflight
        // ------------------------------------------------------------------
        (Method::OPTIONS, _) => {
            let mut resp = Response::builder()
                .status(StatusCode::OK)
                .body(Body::empty())?;
            add_cors_headers(&mut resp);
            return Ok(resp);
        }

        // ------------------------------------------------------------------
        // Static assets (HTML / JS / CSS)
        // ------------------------------------------------------------------
        _ => serve_static(&path)?,
    };

    add_cors_headers(&mut response);
    Ok(response)
}

// ---------------------------------------------------------------------------
// JSON types for button entries (browser-friendly)
// ---------------------------------------------------------------------------

/// Received from the dedicated button QUIC stream (`/wt/control` client-initiated
/// unidirectional stream).  Contains only button/axis entries — no pose data.
#[derive(Deserialize, Debug)]
struct ButtonsOnlyMessage {
    #[serde(default)]
    buttons: Vec<ButtonEntryJson>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ButtonEntryJson {
    pub path: String,
    pub value: ButtonValueJson,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(untagged)]
pub enum ButtonValueJson {
    Binary(bool),
    Scalar(f32),
}

impl From<ButtonValueJson> for alvr_packets::ButtonValue {
    fn from(v: ButtonValueJson) -> Self {
        match v {
            ButtonValueJson::Binary(b) => alvr_packets::ButtonValue::Binary(b),
            ButtonValueJson::Scalar(f) => alvr_packets::ButtonValue::Scalar(f),
        }
    }
}

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

fn codec_type_to_str(codec: alvr_session::CodecType) -> &'static str {
    match codec {
        alvr_session::CodecType::H264 => "h264",
        alvr_session::CodecType::Hevc => "hevc",
        alvr_session::CodecType::AV1 => "av1",
    }
}

/// Returns `(total_width, height, refresh_rate)` for the video stream that the
/// encoder will produce.
///
/// ALVR encodes both eyes side-by-side, so the total video width is
/// `eye_resolution_width * 2`.  This is the dimension the browser canvas must
/// match so that the decoded frame fills the receiver window exactly.
fn negotiated_resolution_and_fps() -> (u32, u32, f32) {
    let session = SESSION_MANAGER.read();
    let cfg = &session.session().openvr_config;
    let total_width  = cfg.eye_resolution_width.saturating_mul(2);
    let height       = cfg.eye_resolution_height;
    let fps          = cfg.refresh_rate as f32;
    // Fall back to 3840×1080@90 if openvr_config hasn't been initialised yet.
    if total_width == 0 || height == 0 {
        return (3840, 1080, 90.0);
    }
    (total_width, height, fps)
}

/// Minimal base64 encoder (avoids pulling in the `base64` crate).
fn base64_encode(data: &[u8]) -> String {
    const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as usize;
        let b1 = if chunk.len() > 1 { chunk[1] as usize } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] as usize } else { 0 };
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(CHARS[(n >> 18) & 0x3f] as char);
        out.push(CHARS[(n >> 12) & 0x3f] as char);
        if chunk.len() > 1 {
            out.push(CHARS[(n >> 6) & 0x3f] as char);
        } else {
            out.push('=');
        }
        if chunk.len() > 2 {
            out.push(CHARS[n & 0x3f] as char);
        } else {
            out.push('=');
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Public API: notify the web server of new video data
// ---------------------------------------------------------------------------

impl WebClientState {
    /// Called by `ServerCoreContext::set_video_config_nals` to store the
    /// decoder initialisation config and notify connected browsers.
    ///
    /// `config_notify` is only fired when the config *actually changes* (different
    /// codec or SPS/PPS bytes).  NVENC emits identical SPS+PPS before every IDR
    /// frame; firing on each of those would cause an IDR request feedback loop
    /// (each notify → RequestIdr event → client POSTs /api/request-idr → NVENC
    /// emits SPS+PPS again → notify again → …).
    pub fn set_video_config_nals(
        &self,
        config_buffer: Vec<u8>,
        codec: alvr_session::CodecType,
    ) {
        let mut guard = self.decoder_config.lock();
        let changed = guard.as_ref().map_or(true, |existing| {
            existing.codec != codec || existing.config_buffer != config_buffer
        });
        *guard = Some(DecoderInitializationConfig {
            codec,
            config_buffer,
        });
        drop(guard);
        if changed {
            // Wake any video WebSocket handlers that are waiting for the config,
            // or that need to push the updated config to the browser.
            let _ = self.config_notify.send(true);
        }
    }

    /// Called by `ServerCoreContext::send_video_nal` to forward a NAL unit
    /// to all connected browser clients.
    pub fn send_video_nal(
        &self,
        target_timestamp: Duration,
        nal_buffer: Vec<u8>,
        is_idr: bool,
    ) {
        let header = VideoPacketHeader {
            timestamp: target_timestamp,
            is_idr,
        };
        // `try_send` drops the frame if no subscriber is connected or the
        // channel is full (browser is too slow).  This is intentional: we
        // never block the encoder thread.
        self.video_sender.send((header, nal_buffer)).ok();
    }

    /// Send a haptics event to all connected browser clients.
    pub fn send_haptics(
        &self,
        hand: &str,
        duration: Duration,
        frequency: f32,
        amplitude: f32,
    ) {
        self.event_sender
            .send(ClientEvent::Haptics {
                hand: hand.to_owned(),
                duration_ms: duration.as_millis() as u64,
                frequency,
                amplitude,
            })
            .ok();
    }

    /// Notify all connected browser clients that the server is restarting.
    pub fn notify_restarting(&self) {
        self.event_sender.send(ClientEvent::Restarting).ok();
    }

    /// Request all connected browser clients to send an IDR frame.
    pub fn request_idr(&self) {
        self.event_sender.send(ClientEvent::RequestIdr).ok();
    }
}

// ---------------------------------------------------------------------------
// TLS certificate persistence
// ---------------------------------------------------------------------------

/// Paths for the persisted TLS certificate and private key (DER format).
fn tls_cert_path() -> Option<std::path::PathBuf> {
    FILESYSTEM_LAYOUT.get().map(|l| l.config_dir.join("web_client_cert.der"))
}
fn tls_key_path() -> Option<std::path::PathBuf> {
    FILESYSTEM_LAYOUT.get().map(|l| l.config_dir.join("web_client_key.der"))
}

/// Load or generate the self-signed TLS certificate.
///
/// Reuses the certificate from disk so that browsers that already accepted it
/// do not receive `CertificateUnknown` on every server restart.  A new
/// certificate is generated only when no valid files exist on disk.
fn load_or_generate_cert(subject_alt_names: Vec<String>) -> Result<(Vec<u8>, Vec<u8>)> {
    if let (Some(cert_path), Some(key_path)) = (tls_cert_path(), tls_key_path()) {
        if cert_path.exists() && key_path.exists() {
            match (std::fs::read(&cert_path), std::fs::read(&key_path)) {
                (Ok(cert_der), Ok(key_der)) if !cert_der.is_empty() && !key_der.is_empty() => {
                    info!("Reusing existing TLS certificate from {}", cert_path.display());
                    return Ok((cert_der, key_der));
                }
                _ => info!("TLS certificate files invalid; regenerating"),
            }
        }
    }

    // Generate a new certificate.
    let cert = generate_simple_self_signed(subject_alt_names)
        .context("failed to generate self-signed certificate")?;
    let cert_der = cert.cert.der().to_vec();
    let key_der  = cert.key_pair.serialize_der();

    // Persist to disk.
    if let (Some(cert_path), Some(key_path)) = (tls_cert_path(), tls_key_path()) {
        if let Some(parent) = cert_path.parent() {
            std::fs::create_dir_all(parent).ok();
        }
        if std::fs::write(&cert_path, &cert_der).is_ok()
            && std::fs::write(&key_path, &key_der).is_ok()
        {
            info!("TLS certificate saved to {}", cert_path.display());
        } else {
            error!("Failed to save TLS certificate; it will be regenerated on next restart");
        }
    }

    Ok((cert_der, key_der))
}

// ---------------------------------------------------------------------------
// Local IP detection for TLS certificate SAN
// ---------------------------------------------------------------------------

/// Detects the primary outbound local IP address via the OS routing table.
///
/// Uses a UDP "connect" to a well-known public address to trigger the OS to
/// select the default outbound network interface.  No actual traffic is sent.
/// Returns the IP that would be used for LAN traffic (e.g. 192.168.1.23).
fn detect_local_network_ip() -> Option<std::net::IpAddr> {
    let socket = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    // Connecting to a public IP forces the OS to pick the default route interface.
    // No packets are actually sent.
    socket.connect("8.8.8.8:80").ok()?;
    socket.local_addr().ok().map(|a| a.ip())
}

// ---------------------------------------------------------------------------
// WebTransport server (QUIC / HTTP3, same port as HTTPS via UDP)
// ---------------------------------------------------------------------------

/// Stream type tag byte: sent as the first byte of every server-initiated
/// unidirectional WebTransport stream so the browser can dispatch correctly.
const WT_STREAM_CONFIG: u8 = 0x01; // VideoConfigMessage JSON or event JSON (text)
const WT_STREAM_VIDEO:  u8 = 0x02; // binary video frame (timestamp + is_idr + NAL)

/// Lightweight helper: build the VideoConfigMessage JSON string if the decoder
/// config is available, or return `None`.
fn build_wt_config_json(web_state: &WebClientState) -> Option<String> {
    let guard = web_state.decoder_config.lock();
    let config = guard.as_ref()?;
    let (width, height, refresh_rate) = negotiated_resolution_and_fps();
    let msg = VideoConfigMessage {
        codec:               codec_type_to_str(config.codec).to_owned(),
        config_buffer_b64:   base64_encode(&config.config_buffer),
        width,
        height,
        refresh_rate,
    };
    json::to_string(&msg).ok()
}

/// Open a server-initiated unidirectional stream, write `payload`, then finish.
/// Returns `true` on success, `false` if the connection is closed.
async fn wt_send_stream(conn: &wtransport::Connection, payload: &[u8]) -> bool {
    // open_uni() returns OpeningUniStream (a future); must be awaited twice.
    let opening = match conn.open_uni().await {
        Ok(o) => o,
        Err(_) => return false, // connection closed
    };
    let mut stream = match opening.await {
        Ok(s) => s,
        Err(_) => return false, // connection closed
    };
    // Config must not queue behind the video frames (which use high priorities).
    stream.set_priority(i32::MAX);
    // Ignore write/finish errors for individual streams; only the
    // conn.open_uni() failure above signals a dead connection.
    let _ = stream.write_all(payload).await;
    let _ = stream.finish().await;
    true
}

enum WtSendResult {
    /// All frame data was acknowledged by the peer after the given time.
    Acked(Duration),
    /// The stream could not be opened or written (peer stopped / connection lost).
    Failed,
    /// The session loop reset the stream (P frame too old).
    Cancelled,
}

/// Send one video frame on its own unidirectional stream and wait for the ACK.
///
/// The send slot is never held while waiting for the ACK: the FIN is sent without
/// blocking and the task only tracks delivery.  P frames are reset when `cancel`
/// fires; IDR frames are never reset, because resetting a half-delivered IDR left
/// the receiver without any usable key frame for seconds during congestion.
async fn wt_send_video_stream(
    conn: wtransport::Connection,
    payload: Vec<u8>,
    is_idr: bool,
    priority: i32,
    mut cancel: tokio::sync::oneshot::Receiver<()>,
) -> WtSendResult {
    let started = tokio::time::Instant::now();
    let open = async {
        let opening = conn.open_uni().await.ok()?;
        opening.await.ok()
    };
    let opened = if is_idr {
        tokio::time::timeout(WT_IDR_OPEN_TIMEOUT, open).await.ok().flatten()
    } else {
        tokio::select! {
            stream = open => stream,
            _ = &mut cancel => return WtSendResult::Cancelled,
        }
    };
    let Some(mut stream) = opened else {
        return WtSendResult::Failed;
    };
    // Older frames first: quinn sends higher priorities first, so frames complete
    // in order instead of being interleaved round-robin (which the receiver
    // misread as frame loss).
    stream.set_priority(priority);

    let written = if is_idr {
        Some(stream.write_all(&payload).await.is_ok())
    } else {
        tokio::select! {
            result = stream.write_all(&payload) => Some(result.is_ok()),
            _ = &mut cancel => None,
        }
    };
    match written {
        Some(true) => {}
        Some(false) => return WtSendResult::Failed,
        None => {
            stream.reset(wtransport::VarInt::from_u32(1)).ok();
            return WtSendResult::Cancelled;
        }
    }

    // Non-blocking FIN; dropping the stream afterwards does not reset it.
    stream.quic_stream_mut().finish().ok();

    let acked = if is_idr {
        Some(stream.quic_stream_mut().stopped().await)
    } else {
        tokio::select! {
            result = stream.quic_stream_mut().stopped() => Some(result),
            _ = &mut cancel => None,
        }
    };
    match acked {
        Some(Ok(None)) => WtSendResult::Acked(started.elapsed()),
        Some(_) => WtSendResult::Failed,
        None => {
            stream.reset(wtransport::VarInt::from_u32(1)).ok();
            WtSendResult::Cancelled
        }
    }
}

struct WtInFlightFrame {
    is_idr: bool,
    size: usize,
    sent_at: tokio::time::Instant,
    /// Resets the stream when fired (P frames only; `None` once fired).
    cancel: Option<tokio::sync::oneshot::Sender<()>>,
    task: tokio::task::JoinHandle<WtSendResult>,
}

/// Video delivery statistics of one congestion window.
#[derive(Default)]
struct WtWindowStats {
    sent_frames: u32,
    /// Frames that will not be delivered: dropped, reset or failed.
    lost_frames: u32,
    acked_frames: u32,
    acked_bytes: u64,
    ack_latency_sum: Duration,
}

/// Caps the encoder bitrate when the WebTransport video path is congested.
///
/// Decreases multiplicatively towards the measured delivery rate (at most once
/// per `WT_CAP_DECREASE_INTERVAL`) and increases slowly after the path has been
/// clean for `WT_CAP_INCREASE_DELAY`.  The cap is removed once it reaches the
/// bitrate requested by the settings.
struct WtCongestionController {
    cap_bps: Option<f32>,
    last_decrease: Option<tokio::time::Instant>,
    clean_since: tokio::time::Instant,
}

impl WtCongestionController {
    fn new(now: tokio::time::Instant) -> Self {
        Self {
            cap_bps: None,
            last_decrease: None,
            clean_since: now,
        }
    }

    fn update(
        &mut self,
        now: tokio::time::Instant,
        window: Duration,
        stats: &WtWindowStats,
        uncapped_bps: f32,
        latency_limit: Duration,
    ) -> Option<f32> {
        if uncapped_bps <= 0.0 || stats.sent_frames == 0 {
            return self.cap_bps;
        }

        let lossy = stats.lost_frames >= 2
            && stats.lost_frames as f32 >= 0.05 * stats.sent_frames as f32;
        let slow = stats.acked_frames > 0
            && stats.ack_latency_sum / stats.acked_frames > latency_limit;
        let stalled = stats.acked_frames == 0 && stats.sent_frames >= 10;

        if lossy || slow || stalled {
            self.clean_since = now;
            let may_decrease = self
                .last_decrease
                .map_or(true, |t| now.duration_since(t) >= WT_CAP_DECREASE_INTERVAL);
            if may_decrease {
                let current = self.cap_bps.unwrap_or(uncapped_bps).min(uncapped_bps);
                let delivered_bps = stats.acked_bytes as f32 * 8.0 / window.as_secs_f32();
                let target = (delivered_bps * 0.85)
                    .clamp(current * 0.5, current * 0.85)
                    .max(WT_MIN_CAP_BPS);
                self.cap_bps = Some(target);
                self.last_decrease = Some(now);
            }
        } else if let Some(cap) = self.cap_bps {
            if now.duration_since(self.clean_since) >= WT_CAP_INCREASE_DELAY {
                self.cap_bps = Some(cap * WT_CAP_INCREASE_FACTOR);
            }
        }

        if self.cap_bps.is_some_and(|cap| cap >= uncapped_bps) {
            self.cap_bps = None;
        }
        self.cap_bps
    }
}

/// Run the WebTransport server.
///
/// QUIC (UDP) and HTTPS (TCP) share the same port number independently, so
/// this server can co-exist with the existing HTTPS/WebSocket server on the
/// same `host:port`.
///
/// # Certificate
/// WebTransport with `serverCertificateHashes` requires the certificate to be
/// valid for ≤ 14 days.  We generate a fresh self-signed cert at startup via
/// `rcgen` (already a dep), write it to a temp file so that
/// `wtransport::Identity::load_pemfiles` can consume it, and compute the
/// SHA-256 fingerprint from the raw DER bytes.
async fn run_webtransport_server(
    port: u16,
    connection_context: Arc<ConnectionContext>,
    web_state: Arc<WebClientState>,
) {
    // ── Generate a 14-day self-signed certificate via rcgen ─────────────
    let mut sans = vec![
        "localhost".to_string(),
        "127.0.0.1".to_string(),
    ];
    if let Some(ip) = detect_local_network_ip() {
        let ip_str = ip.to_string();
        if !sans.contains(&ip_str) {
            sans.push(ip_str);
        }
    }

    // 14-day validity = maximum Chrome allows for serverCertificateHashes pinning.
    let mut params = match rcgen::CertificateParams::new(sans) {
        Ok(p) => p,
        Err(e) => { error!("WebTransport: rcgen params error: {e}"); return; }
    };
    let now = time::OffsetDateTime::now_utc();
    params.not_before = now;
    params.not_after  = now + time::Duration::days(14);

    let key_pair = match rcgen::KeyPair::generate() {
        Ok(k) => k,
        Err(e) => { error!("WebTransport: key generation error: {e}"); return; }
    };
    let rcgen_cert = match params.self_signed(&key_pair) {
        Ok(c) => c,
        Err(e) => { error!("WebTransport: rcgen cert error: {e}"); return; }
    };

    // DER bytes → SHA-256 fingerprint (what the browser must pin).
    let cert_der: Vec<u8> = rcgen_cert.der().to_vec();
    use sha2::Digest as _;
    let fp_hex: String = sha2::Sha256::digest(&cert_der)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    *web_state.wt_cert_fingerprint_hex.lock() = Some(fp_hex.clone());
    info!("WebTransport: certificate fingerprint (SHA-256): {fp_hex}");

    // Write PEM files to the config dir so Identity::load_pemfiles can consume them.
    let cert_pem: String = rcgen_cert.pem();
    let key_pem:  String = key_pair.serialize_pem();

    let config_dir = FILESYSTEM_LAYOUT
        .get()
        .map(|l| l.config_dir.clone())
        .unwrap_or_else(|| std::path::PathBuf::from("."));

    let cert_path = config_dir.join("wt_cert.pem");
    let key_path  = config_dir.join("wt_key.pem");

    if let Err(e) = std::fs::write(&cert_path, &cert_pem) {
        error!("WebTransport: failed to write cert PEM: {e}"); return;
    }
    if let Err(e) = std::fs::write(&key_path, &key_pem) {
        error!("WebTransport: failed to write key PEM: {e}"); return;
    }

    let identity = match wtransport::Identity::load_pemfiles(&cert_path, &key_path).await {
        Ok(id) => id,
        Err(e) => { error!("WebTransport: failed to load identity: {e}"); return; }
    };

    // ── Build and bind the QUIC endpoint ─────────────────────────────────
    let config = match wtransport::ServerConfig::builder()
        .with_bind_default(port)
        .with_identity(identity)
        .keep_alive_interval(Some(Duration::from_secs(3)))
        .max_idle_timeout(Some(Duration::from_secs(30)))
    {
        Ok(b) => b.build(),
        Err(e) => {
            error!("WebTransport: max_idle_timeout invalid: {e}");
            return;
        }
    };

    let server = match wtransport::Endpoint::server(config) {
        Ok(s) => s,
        Err(e) => {
            error!("WebTransport: failed to bind UDP port {port}: {e}");
            return;
        }
    };
    info!("WebTransport server listening on UDP port {port} (same host as HTTPS)");

    // ── Accept sessions ───────────────────────────────────────────────────
    loop {
        let incoming = server.accept().await;
        let ctx   = Arc::clone(&connection_context);
        let state = Arc::clone(&web_state);
        tokio::spawn(async move {
            let session_req = match incoming.await {
                Ok(r) => r,
                Err(e) => {
                    info!("WebTransport: session request error: {e}");
                    return;
                }
            };
            let path = session_req.path().to_owned();
            let conn = match session_req.accept().await {
                Ok(c) => c,
                Err(e) => {
                    info!("WebTransport: session accept error for path '{path}': {e}");
                    return;
                }
            };
            match path.as_str() {
                "/wt/control" => handle_wt_control_session(conn, ctx, state).await,
                "/wt/video"   => handle_wt_video_session(conn, ctx, state).await,
                other => {
                    info!("WebTransport: unknown path '{other}' — ignoring");
                }
            }
        });
    }
}

/// Handle a `/wt/control` WebTransport session opened by client.js.
///
/// ## Server → Client  (one persistent unidirectional stream, type `WT_STREAM_CONFIG`)
/// Newline-delimited JSON events (haptics, IDR requests, restart notices).
///
/// ## Client → Server  (QUIC datagrams)
/// JSON `TrackingMessage` objects at ~90 Hz.
///
/// Lifecycle mirrors `websocket_tracking`: `ClientConnected` fires on the
/// first control session; `ClientDisconnected` fires when the last one closes.
async fn handle_wt_control_session(
    conn: wtransport::Connection,
    ctx: Arc<ConnectionContext>,
    web_state: Arc<WebClientState>,
) {
    // ── ON CONNECT ──────────────────────────────────────────────────────
    let prev = web_state.active_tracking_count.fetch_add(1, Ordering::SeqCst);
    if prev == 0 {
        web_state.audio_streaming.store(true, Ordering::Relaxed);
        use alvr_common::{Fov, Pose};
        use alvr_common::glam::{Quat, Vec2, Vec3};
        let fov = Fov { left: -0.83, right: 0.83, up: 0.63, down: -0.63 };
        let ipd_half = 0.032_f32;
        let rot = Quat::IDENTITY;
        ctx.events_sender.send(ServerCoreEvent::ViewsConfig(crate::ViewsConfig {
            local_view_transforms: [
                Pose { orientation: rot, position: Vec3::new(-ipd_half, 0.0, 0.0) },
                Pose { orientation: rot, position: Vec3::new(ipd_half,  0.0, 0.0) },
            ],
            fov: [fov, fov],
        })).ok();
        ctx.events_sender.send(ServerCoreEvent::PlayspaceSync(Vec2::new(2.0, 2.0))).ok();
        ctx.events_sender.send(ServerCoreEvent::ClientConnected).ok();
        info!("WebTransport: control session connected — streaming initialised");
    }

    // Open the persistent events stream (server → client).
    // open_uni() in wtransport 0.7 returns OpeningUniStream; must be awaited twice.
    let event_opening = match conn.open_uni().await {
        Ok(o) => o,
        Err(e) => {
            error!("WebTransport: failed to open events stream (phase 1): {e}");
            let remaining = web_state.active_tracking_count
                .fetch_sub(1, Ordering::SeqCst)
                .saturating_sub(1);
            if remaining == 0 {
                web_state.audio_streaming.store(false, Ordering::Relaxed);
                ctx.events_sender.send(ServerCoreEvent::ClientDisconnected).ok();
            }
            return;
        }
    };
    let mut event_stream = match event_opening.await {
        Ok(s) => s,
        Err(e) => {
            error!("WebTransport: failed to open events stream (phase 2): {e}");
            let remaining = web_state.active_tracking_count
                .fetch_sub(1, Ordering::SeqCst)
                .saturating_sub(1);
            if remaining == 0 {
                web_state.audio_streaming.store(false, Ordering::Relaxed);
                ctx.events_sender.send(ServerCoreEvent::ClientDisconnected).ok();
            }
            return;
        }
    };
    // Write the type byte to identify this as the events stream.
    if event_stream.write_all(&[WT_STREAM_CONFIG]).await.is_err() {
        return;
    }

    let mut event_rx = web_state.event_sender.subscribe();

    // ── Main loop: forward events + receive tracking datagrams ───────────
    loop {
        tokio::select! {
            // Forward server events to the browser via the persistent stream.
            ev = event_rx.recv() => {
                match ev {
                    Ok(event) => {
                        let json = json::to_string(&event).unwrap_or_default();
                        let mut line = json.into_bytes();
                        line.push(b'\n');
                        if event_stream.write_all(&line).await.is_err() {
                            break; // events stream closed → session lost
                        }
                    }
                    Err(RecvError::Lagged(_)) => {} // skip lagged events
                    Err(RecvError::Closed)    => break,
                }
            }

            // Receive tracking datagrams from the browser.
            dgram = conn.receive_datagram() => {
                match dgram {
                    Ok(data) => {
                        let payload_bytes = data.payload();
                        let Ok(text) = std::str::from_utf8(&payload_bytes) else { continue };
                        match json::from_str::<TrackingMessage>(text) {
                            Ok(msg) => {
                                let tracking = tracking_msg_to_alvr(&msg);
                                let timestamp = tracking.target_timestamp;
                                if let Some(stats) = &mut *ctx.statistics_manager.write() {
                                    stats.report_tracking_received(timestamp);
                                }
                                {
                                    let mut tm = ctx.tracking_manager.write();
                                    let session_lock = SESSION_MANAGER.read();
                                    let headset_config = &session_lock.settings().headset;
                                    tm.report_device_motions(
                                        headset_config, timestamp, &tracking.device_motions,
                                    );
                                    if msg.recenter {
                                        let pos_mode =
                                            headset_config.position_recentering_mode.clone();
                                        let rot_mode =
                                            headset_config.rotation_recentering_mode.clone();
                                        tm.recenter(pos_mode, rot_mode);
                                        info!("WebTransport: recenter requested");
                                    }
                                }
                                // Button/axis events arrive over a dedicated reliable stream (Fix B).
                                // Do not include button data in the datagram.
                                ctx.events_sender
                                    .send(ServerCoreEvent::Tracking {
                                        sample_timestamp: timestamp,
                                    })
                                    .ok();
                            }
                            Err(e) => debug!("WT: failed to parse tracking datagram: {e}"),
                        }
                    }
                    Err(e) => {
                        info!("WebTransport: control session lost: {e}");
                        break;
                    }
                }
            }

            // Accept client-initiated unidirectional streams (button/axis events).
            // Each stream carries newline-delimited JSON: {"buttons":[...]}.
            // Using a reliable QUIC stream ensures axis=0.0 events are never lost.
            stream = conn.accept_uni() => {
                match stream {
                    Ok(recv_stream) => {
                        tokio::spawn(handle_wt_button_stream(recv_stream, ctx.clone()));
                    }
                    Err(e) => {
                        info!("WebTransport: control session lost while accepting stream: {e}");
                        break;
                    }
                }
            }
        }
    }

    // ── ON DISCONNECT ────────────────────────────────────────────────────
    let remaining = web_state
        .active_tracking_count
        .fetch_sub(1, Ordering::SeqCst)
        .saturating_sub(1);
    if remaining == 0 {
        web_state.audio_streaming.store(false, Ordering::Relaxed);
        ctx.events_sender.send(ServerCoreEvent::ClientDisconnected).ok();
        info!("WebTransport: control session disconnected — streaming stopped");
    }
}

/// Read button/axis events from a client-initiated unidirectional QUIC stream.
///
/// The stream carries newline-delimited JSON objects:
///   `{"buttons": [{"path": "...", "value": <bool|float>}, ...]}`
///
/// Using a reliable QUIC stream guarantees that axis=0.0 (neutral) events are
/// never silently dropped, which was the failure mode with QUIC datagrams.
async fn handle_wt_button_stream(
    mut stream: wtransport::RecvStream,
    ctx: Arc<ConnectionContext>,
) {
    let mut buf = Vec::<u8>::new();
    let mut tmp = [0u8; 4096];
    loop {
        match stream.read(&mut tmp).await {
            Ok(Some(n)) => buf.extend_from_slice(&tmp[..n]),
            Ok(None)    => break, // stream finished
            Err(e)      => { debug!("WT button stream read error: {e}"); break; }
        }
        // Parse all complete newline-delimited JSON lines.
        while let Some(pos) = buf.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = buf.drain(..=pos).collect();
            let Ok(text) = std::str::from_utf8(&line) else { continue };
            match json::from_str::<ButtonsOnlyMessage>(text) {
                Ok(msg) if !msg.buttons.is_empty() => {
                    let button_entries: Vec<ButtonEntry> = msg
                        .buttons
                        .iter()
                        .map(|e| ButtonEntry {
                            path_id: alvr_common::hash_string(&e.path),
                            value: e.value.clone().into(),
                        })
                        .collect();
                    ctx.events_sender
                        .send(ServerCoreEvent::Buttons(button_entries))
                        .ok();
                }
                Ok(_)  => {}
                Err(e) => debug!("WT button stream parse error: {e}"),
            }
        }
    }
}

/// Handle a `/wt/video` WebTransport session opened by receiver.js.
///
/// ## Server → Client
/// - Initial stream (type `WT_STREAM_CONFIG`): VideoConfigMessage JSON + `\n`.
///   Sent again whenever the codec / resolution changes.
/// - Per-frame streams (type `WT_STREAM_VIDEO`): frame ID + 9-byte header + NAL data.
///   One QUIC unidirectional stream per video frame eliminates TCP HOL blocking.
async fn handle_wt_video_session(
    conn: wtransport::Connection,
    ctx: Arc<ConnectionContext>,
    web_state: Arc<WebClientState>,
) {
    info!("WebTransport: video session connected");

    let mut rx     = web_state.video_sender.subscribe();
    let mut cfg_rx = web_state.config_notify.subscribe();

    // Diagnostic counters for the video session.
    let mut _frames_sent: u64 = 0;
    let mut _idr_sent:    u64 = 0;
    let mut next_frame_id: u64 = 1;
    let mut in_flight: VecDeque<WtInFlightFrame> = VecDeque::new();
    let mut send_failures: u64 = 0;
    let mut expired_frames: u64 = 0;
    let mut skipped_frames: u64 = 0;
    let mut last_diagnostic = tokio::time::Instant::now();
    let mut last_server_idr_request: Option<tokio::time::Instant> = None;

    // Congestion control: baseline RTT is the minimum smoothed RTT over the last
    // 10–20 s (two rotating buckets), so it follows path changes.
    let mut congestion = WtCongestionController::new(tokio::time::Instant::now());
    let mut window = WtWindowStats::default();
    let mut window_start = tokio::time::Instant::now();
    let mut rtt_min_current = Duration::MAX;
    let mut rtt_min_previous = Duration::MAX;
    let mut rtt_bucket_start = tokio::time::Instant::now();
    let mut backlog_limit = WT_BACKLOG_MIN_AGE;

    // Request an IDR from the server side, at most once per interval.
    macro_rules! request_idr_throttled {
        ($now:expr) => {
            if last_server_idr_request
                .map_or(true, |t| $now.duration_since(t) >= WT_SERVER_IDR_REQUEST_INTERVAL)
            {
                last_server_idr_request = Some($now);
                web_state.event_sender.send(ClientEvent::RequestIdr).ok();
            }
        };
    }

    // Helper: build and send one config stream.
    macro_rules! send_config {
        () => {
            if let Some(json_str) = build_wt_config_json(&web_state) {
                let mut buf = Vec::with_capacity(1 + json_str.len() + 1);
                buf.push(WT_STREAM_CONFIG);
                buf.extend_from_slice(json_str.as_bytes());
                buf.push(b'\n');
                info!("WebTransport: video — sending config stream ({} bytes)", buf.len());
                if !wt_send_stream(&conn, &buf).await {
                    break;
                }
                // Request IDR so the browser decoder can start immediately.
                web_state.event_sender.send(ClientEvent::RequestIdr).ok();
            }
        };
    }

    // Send the decoder config immediately if it is already available.
    if let Some(json_str) = build_wt_config_json(&web_state) {
        let mut buf = Vec::with_capacity(1 + json_str.len() + 1);
        buf.push(WT_STREAM_CONFIG);
        buf.extend_from_slice(json_str.as_bytes());
        buf.push(b'\n');
        info!("WebTransport: video — initial config stream ({} bytes)", buf.len());
        if !wt_send_stream(&conn, &buf).await {
            info!("WebTransport: video session closed before first config was sent");
            return;
        }
        web_state.event_sender.send(ClientEvent::RequestIdr).ok();
    } else {
        info!("WebTransport: video — no decoder config yet (waiting for SteamVR)");
    }

    loop {
        tokio::select! {
            // ── Video frame from the encoder ──────────────────────────────
            frame = rx.recv() => {
                match frame {
                    Ok((header, payload)) => {
                        let now = tokio::time::Instant::now();

                        // Collect finished sends.
                        let mut index = 0;
                        while index < in_flight.len() {
                            if !in_flight[index].task.is_finished() {
                                index += 1;
                                continue;
                            }
                            let Some(entry) = in_flight.remove(index) else { break };
                            match entry.task.await {
                                Ok(WtSendResult::Acked(latency)) => {
                                    window.acked_frames += 1;
                                    window.acked_bytes += entry.size as u64;
                                    window.ack_latency_sum += latency;
                                }
                                // Already counted as lost when the reset was requested.
                                Ok(WtSendResult::Cancelled) => {}
                                Ok(WtSendResult::Failed) | Err(_) => {
                                    send_failures += 1;
                                    window.lost_frames += 1;
                                    request_idr_throttled!(now);
                                }
                            }
                        }

                        // Reset P frames that are too old to be useful: frees the link
                        // instead of delivering them seconds late.
                        let max_p_frame_age = WT_P_FRAME_MIN_MAX_AGE.max(backlog_limit * 2);
                        for entry in in_flight.iter_mut() {
                            if now.duration_since(entry.sent_at) > max_p_frame_age {
                                if let Some(cancel) = entry.cancel.take() {
                                    cancel.send(()).ok();
                                    expired_frames += 1;
                                    window.lost_frames += 1;
                                }
                            }
                        }

                        // Congestion evaluation → encoder bitrate cap.
                        if now.duration_since(window_start) >= WT_CONGESTION_WINDOW {
                            rtt_min_current = rtt_min_current.min(conn.rtt());
                            if now.duration_since(rtt_bucket_start) >= Duration::from_secs(10) {
                                rtt_min_previous = rtt_min_current;
                                rtt_min_current = conn.rtt();
                                rtt_bucket_start = now;
                            }
                            let rtt_baseline = rtt_min_current.min(rtt_min_previous);
                            backlog_limit = WT_BACKLOG_MIN_AGE.max(rtt_baseline * 2 + WT_BACKLOG_RTT_MARGIN);

                            let uncapped_bps = ctx.bitrate_manager.lock().uncapped_bitrate_bps();
                            let previous_cap = congestion.cap_bps;
                            let cap = congestion.update(
                                now,
                                now.duration_since(window_start),
                                &window,
                                uncapped_bps,
                                backlog_limit,
                            );
                            if cap != previous_cap {
                                ctx.bitrate_manager.lock().set_congestion_cap(cap);
                                if previous_cap.is_none() || cap.is_none()
                                    || cap.zip(previous_cap).is_some_and(|(c, p)| c < p)
                                {
                                    info!(
                                        "WebTransport: video — congestion cap {} (configured {:.1} Mbps, rtt {}ms)",
                                        cap.map_or("removed".to_string(), |c| format!("{:.1} Mbps", c / 1e6)),
                                        uncapped_bps / 1e6,
                                        conn.rtt().as_millis(),
                                    );
                                }
                            }
                            window = WtWindowStats::default();
                            window_start = now;
                        }

                        window.sent_frames += 1;

                        // Drop new P frames while the oldest unacknowledged frame is
                        // too old: sending more only deepens the queue.  The frame ID
                        // is consumed so the receiver detects the gap and waits for a
                        // key frame instead of decoding a P frame whose reference is
                        // missing.  IDRs are always sent.
                        let oldest_age = in_flight
                            .iter()
                            .filter(|entry| entry.is_idr || entry.cancel.is_some())
                            .map(|entry| now.duration_since(entry.sent_at))
                            .max()
                            .unwrap_or_default();
                        if !header.is_idr
                            && (oldest_age > backlog_limit || in_flight.len() >= WT_VIDEO_MAX_STREAMS)
                        {
                            skipped_frames += 1;
                            window.lost_frames += 1;
                            next_frame_id = next_frame_id.wrapping_add(1);
                            continue;
                        }

                        // Binary layout: [type][frame_id][timestamp][is_idr][NAL...]
                        let frame_id = next_frame_id;
                        next_frame_id = next_frame_id.wrapping_add(1);
                        let frame_bytes = encode_video_frame(&header, &payload);
                        let mut buf = Vec::with_capacity(9 + frame_bytes.len());
                        buf.push(WT_STREAM_VIDEO);
                        buf.extend_from_slice(&frame_id.to_le_bytes());
                        buf.extend_from_slice(&frame_bytes);

                        // Log first 5 frames for diagnosis.
                        _frames_sent += 1;
                        if header.is_idr { _idr_sent += 1; }
                        if _frames_sent <= 5 {
                            info!("WebTransport: video — frame #{}: is_idr={} size={}B ts={:?}",
                                _frames_sent, header.is_idr, frame_bytes.len(), header.timestamp);
                        }

                        let send_conn = conn.clone();
                        let is_idr = header.is_idr;
                        let size = buf.len();
                        let priority = i32::MAX - (frame_id % i32::MAX as u64) as i32;
                        let (cancel_tx, cancel_rx) = tokio::sync::oneshot::channel();
                        let task = tokio::spawn(async move {
                            wt_send_video_stream(send_conn, buf, is_idr, priority, cancel_rx).await
                        });
                        in_flight.push_back(WtInFlightFrame {
                            is_idr,
                            size,
                            sent_at: now,
                            cancel: (!is_idr).then_some(cancel_tx),
                            task,
                        });

                        if last_diagnostic.elapsed() >= Duration::from_secs(5) {
                            info!(
                                "WebTransport: video — sent={} idr={} in_flight={} send_failures={} expired={} skipped={} rtt={}ms cap={}",
                                _frames_sent,
                                _idr_sent,
                                in_flight.len(),
                                send_failures,
                                expired_frames,
                                skipped_frames,
                                conn.rtt().as_millis(),
                                congestion.cap_bps.map_or("none".to_string(), |c| format!("{:.1}Mbps", c / 1e6)),
                            );
                            last_diagnostic = tokio::time::Instant::now();
                        }
                    }
                    Err(RecvError::Lagged(skipped)) => {
                        skipped_frames += skipped;
                        // Consume the skipped frames' IDs so the receiver detects the gap.
                        next_frame_id = next_frame_id.wrapping_add(skipped);
                        info!("WebTransport: video — broadcast lagged, {skipped} encoder frames skipped");
                        // Buffer overrun: request IDR so the decoder can recover.
                        request_idr_throttled!(tokio::time::Instant::now());
                    }
                    Err(RecvError::Closed) => break,
                }
            }

            // ── Decoder config changed (codec / resolution switch) ────────
            cfg_change = cfg_rx.changed() => {
                if cfg_change.is_err() { break; }
                send_config!();
            }

            close_error = conn.closed() => {
                info!("WebTransport: video connection closed: {close_error}");
                break;
            }
        }
    }

    for entry in in_flight {
        entry.task.abort();
    }
    ctx.bitrate_manager.lock().set_congestion_cap(None);

    info!("WebTransport: video session disconnected (sent {} frames, {} IDRs)", _frames_sent, _idr_sent);
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/// Start the Web Client HTTPS server.
///
/// Generates a self-signed TLS certificate at startup and serves all traffic
/// over HTTPS so that `PresentationRequest`, `WebHID`, and other Secure-Context
/// APIs are available to remote browsers (not just localhost).
///
/// This function is `async` and runs indefinitely.  It should be spawned on
/// the same tokio runtime used by the dashboard web server.
pub async fn web_client(
    connection_context: Arc<ConnectionContext>,
    web_state: Arc<WebClientState>,
) -> Result<()> {
    let port = SESSION_MANAGER
        .read()
        .settings()
        .connection
        .web_client_port;

    // -----------------------------------------------------------------------
    // Build a self-signed TLS certificate valid for common LAN hostnames.
    // -----------------------------------------------------------------------
    // Build a self-signed TLS certificate valid for common LAN hostnames.
    // Reuses the certificate from disk if it already exists, so that browsers
    // that accepted it once do not need to re-accept after every server restart.
    // -----------------------------------------------------------------------
    let mut subject_alt_names = vec![
        "localhost".to_string(),
        "127.0.0.1".to_string(),
    ];
    if let Some(local_ip) = detect_local_network_ip() {
        let ip_str = local_ip.to_string();
        if !subject_alt_names.contains(&ip_str) {
            subject_alt_names.push(ip_str);
        }
    }
    let (cert_der, key_der) = load_or_generate_cert(subject_alt_names)
        .context("failed to load or generate TLS certificate")?;

    let tls_config = ServerConfig::builder_with_provider(
        Arc::new(tokio_rustls::rustls::crypto::ring::default_provider()),
    )
    .with_safe_default_protocol_versions()
    .context("failed to set TLS protocol versions")?
    .with_no_client_auth()
    .with_single_cert(
            vec![tokio_rustls::rustls::pki_types::CertificateDer::from(cert_der)],
            PrivateKeyDer::try_from(key_der)
                .map_err(|e| anyhow::anyhow!("invalid private key: {e}"))?,
        )
        .context("failed to build TLS ServerConfig")?;

    let acceptor = TlsAcceptor::from(Arc::new(tls_config));

    // -----------------------------------------------------------------------
    // Bind the TCP socket.
    // -----------------------------------------------------------------------
    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    let listener = TcpListener::bind(addr)
        .await
        .with_context(|| format!("failed to bind port {port}"))?;

    info!("Web Client server listening on https://0.0.0.0:{port}");
    info!("  → https://127.0.0.1:{port}/");
    if let Some(lan_ip) = detect_local_network_ip() {
        info!("  → https://{lan_ip}:{port}/");
    }
    info!("  NOTE: Self-signed certificate – open the URL in Chrome and click");
    info!("        Advanced → Proceed to accept the certificate once.");

    // -----------------------------------------------------------------------
    // Spawn the WebTransport (QUIC/UDP) server on the same port.
    // QUIC and TCP share the port number space independently.
    // -----------------------------------------------------------------------
    tokio::spawn(run_webtransport_server(
        port,
        Arc::clone(&connection_context),
        Arc::clone(&web_state),
    ));

    // -----------------------------------------------------------------------
    // Accept TLS connections and drive hyper.
    // -----------------------------------------------------------------------
    // Build a `Stream` of accepted TLS streams using `futures::stream::unfold`
    // (avoids an extra `async-stream` dependency).
    //
    // Before handing off to the TLS acceptor we peek at the first byte:
    //   0x16 (22) = TLS Handshake record → proceed with TLS
    //   anything else = plain HTTP → send HTTP 301 redirect to https:// and drop
    // This handles browsers that still have http:// tabs from before HTTPS was enabled.
    let incoming = stream::unfold(
        (listener, acceptor),
        |(listener, acceptor)| async move {
            loop {
                match listener.accept().await {
                    Ok((tcp, _peer)) => {
                        // Peek at the first byte to detect plain HTTP.
                        let mut first = [0u8; 1];
                        if tcp.peek(&mut first).await.is_err() {
                            continue;
                        }
                        if first[0] != 0x16 {
                            // Plain HTTP (or other non-TLS) — redirect and continue.
                            tokio::spawn(redirect_http_to_https(tcp));
                            continue;
                        }
                        match acceptor.accept(tcp).await {
                            Ok(tls) => {
                                return Some((
                                    Ok::<_, std::io::Error>(tls),
                                    (listener, acceptor),
                                ));
                            }
                            Err(e) => alvr_common::warn!("TLS handshake error: {e}"),
                        }
                    }
                    Err(e) => error!("TCP accept error: {e}"),
                }
            }
        },
    );

    let service = service::make_service_fn(move |_conn| {
        let ctx   = Arc::clone(&connection_context);
        let state = Arc::clone(&web_state);
        async move {
            Ok::<_, anyhow::Error>(service::service_fn(move |req| {
                let ctx   = Arc::clone(&ctx);
                let state = Arc::clone(&state);
                async move {
                    let res = handle_request(ctx, state, req).await;
                    if let Err(ref e) = res {
                        alvr_common::show_e(e);
                    }
                    res
                }
            }))
        }
    });

    hyper::Server::builder(from_stream(incoming))
        .serve(service)
        .await?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn video_decoder_module_is_served() {
        let response = serve_static("/video-decoder.js").unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers()[CONTENT_TYPE],
            "application/javascript; charset=utf-8"
        );
        let body = hyper::body::to_bytes(response.into_body()).await.unwrap();
        assert_eq!(
            &body[..],
            include_bytes!("../../../webclient/video-decoder.js")
        );
    }

    const MBPS: f32 = 1e6;
    const LIMIT: Duration = Duration::from_millis(300);
    const WINDOW: Duration = Duration::from_millis(500);

    /// Stats of one 500 ms window: `acked_mbps` delivered, `lost` of 45 frames, `ack_ms` latency.
    fn window(acked_mbps: f32, lost: u32, ack_ms: u64) -> WtWindowStats {
        let acked_frames = 45 - lost;
        WtWindowStats {
            sent_frames: 45,
            lost_frames: lost,
            acked_frames,
            acked_bytes: (acked_mbps * MBPS / 8.0 * WINDOW.as_secs_f32()) as u64,
            ack_latency_sum: Duration::from_millis(ack_ms) * acked_frames,
        }
    }

    #[test]
    fn congestion_cap_tracks_delivered_rate_and_recovers() {
        let t0 = tokio::time::Instant::now();
        let mut controller = WtCongestionController::new(t0);

        // Healthy link: no cap.
        assert_eq!(controller.update(t0, WINDOW, &window(30.0, 0, 50), 30.0 * MBPS, LIMIT), None);

        // Lossy link delivering 10 Mbps: cut to at most half of the current bitrate per step.
        let t1 = t0 + Duration::from_secs(1);
        let cap = controller.update(t1, WINDOW, &window(10.0, 10, 200), 30.0 * MBPS, LIMIT).unwrap();
        assert!((cap - 15.0 * MBPS).abs() < 1.0);

        // Still congested within 1 s: no further decrease.
        let t2 = t1 + WINDOW;
        assert_eq!(controller.update(t2, WINDOW, &window(10.0, 10, 200), 30.0 * MBPS, LIMIT), Some(cap));

        // Next decrease follows the delivered rate (10 Mbps × 0.85).
        let t3 = t1 + Duration::from_secs(1);
        let cap = controller.update(t3, WINDOW, &window(10.0, 10, 200), 30.0 * MBPS, LIMIT).unwrap();
        assert!((cap - 8.5 * MBPS).abs() < 1.0);

        // Clean, but within 3 s of the last congestion: hold.
        let t4 = t3 + Duration::from_secs(2);
        assert_eq!(controller.update(t4, WINDOW, &window(8.5, 0, 60), 30.0 * MBPS, LIMIT), Some(cap));

        // Clean for 3 s: increase gradually, then remove the cap at the configured bitrate.
        let mut now = t3 + Duration::from_secs(3);
        let increased = controller.update(now, WINDOW, &window(8.5, 0, 60), 30.0 * MBPS, LIMIT).unwrap();
        assert!((increased - cap * WT_CAP_INCREASE_FACTOR).abs() < 1.0);
        let mut steps = 0;
        while controller.cap_bps.is_some() {
            now += WINDOW;
            controller.update(now, WINDOW, &window(30.0, 0, 60), 30.0 * MBPS, LIMIT);
            steps += 1;
            assert!(steps < 100);
        }
    }

    #[test]
    fn high_ack_latency_or_stall_triggers_cap_with_floor() {
        let t0 = tokio::time::Instant::now();

        // No loss, but ACKs slower than the backlog limit.
        let mut controller = WtCongestionController::new(t0);
        let cap = controller.update(t0, WINDOW, &window(25.0, 0, 400), 30.0 * MBPS, LIMIT);
        assert!(cap.is_some_and(|c| c < 30.0 * MBPS));

        // Nothing acknowledged at all: decrease, never below the floor.
        let mut controller = WtCongestionController::new(t0);
        let stalled = WtWindowStats { sent_frames: 45, ..Default::default() };
        let mut now = t0;
        for _ in 0..10 {
            controller.update(now, WINDOW, &stalled, 30.0 * MBPS, LIMIT);
            now += Duration::from_secs(1);
        }
        assert_eq!(controller.cap_bps, Some(WT_MIN_CAP_BPS));
    }

    #[test]
    fn congestion_cap_never_exceeds_configured_bitrate() {
        let t0 = tokio::time::Instant::now();
        let mut controller = WtCongestionController::new(t0);
        controller.update(t0, WINDOW, &window(10.0, 10, 200), 30.0 * MBPS, LIMIT);
        assert!(controller.cap_bps.is_some());

        // Configured bitrate lowered below the cap: the cap is dropped.
        let t1 = t0 + WINDOW;
        assert_eq!(controller.update(t1, WINDOW, &window(5.0, 0, 50), 5.0 * MBPS, LIMIT), None);
    }
}
