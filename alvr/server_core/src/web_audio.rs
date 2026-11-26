// web_audio.rs
//
// Web Client audio loops for the ALVR Web Client server (port 8083).
//
// audio_out_loop:
//   Records system audio from the default output device (WASAPI Loopback on
//   Windows) and broadcasts PCM i16 little-endian frames to all connected
//   `/ws/audio_out` WebSocket subscribers.  Runs indefinitely; idles while
//   `audio_streaming` is false.
//
// audio_out_opus_loop:
//   Encodes the game audio PCM once into Opus packets (48 kHz stereo, 20 ms)
//   for `/ws/audio_out?codec=opus` subscribers.  Runs only while at least one
//   Opus subscriber is connected.
//
// audio_in_loop:
//   Receives PCM i16 little-endian microphone frames from the browser via the
//   `/ws/audio_in` WebSocket (through `audio_in_sender`; Opus packets are
//   decoded to PCM by `OpusMicDecoder` first) and plays them to the
//   Virtual Audio Cable "Line 1" output device, which SteamVR uses as its
//   default microphone input.  Runs indefinitely; idles while `audio_streaming`
//   is false or no VAC device is present.

use alvr_common::{error, info, warn};
use std::{
    collections::VecDeque,
    sync::{
        atomic::{AtomicBool, AtomicU32, Ordering},
        Arc, Mutex,
    },
    thread,
    time::Duration,
};
use tokio::sync::broadcast;

/// PCM frame batch duration (milliseconds).  Each broadcast frame covers this
/// many milliseconds of audio.  10 ms gives low latency without excessive
/// overhead from small WebSocket messages.
const BATCH_MS: usize = 10;

/// Opus only accepts 8/12/16/24/48 kHz; game audio is always encoded at 48 kHz.
pub const OPUS_SAMPLE_RATE: u32 = 48_000;
/// 20 ms per Opus packet: half the messages of 10 ms and better compression.
const OPUS_FRAME_SAMPLES: usize = OPUS_SAMPLE_RATE as usize / 50;
/// Stereo game audio bitrate (VBR; silence costs only a few bytes per packet).
const OPUS_OUT_BITRATE: i32 = 96_000;
/// Largest Opus packet (RFC 6716 recommends 4000 bytes for the output buffer).
const OPUS_MAX_PACKET_BYTES: usize = 4000;
/// Largest Opus frame (120 ms) at 48 kHz, per channel.
const OPUS_MAX_FRAME_SAMPLES: usize = OPUS_SAMPLE_RATE as usize * 120 / 1000;

// ============================================================
// Opus helpers
// ============================================================

/// Streaming linear-interpolation resampler for interleaved stereo i16.
struct StereoResampler {
    step: f64,
    pos: f64,
    frames: Vec<[f32; 2]>,
}

impl StereoResampler {
    fn new(input_rate: u32, output_rate: u32) -> Self {
        Self {
            step: input_rate as f64 / output_rate as f64,
            pos: 0.0,
            frames: Vec::new(),
        }
    }

    fn process(&mut self, input: &[i16], output: &mut Vec<i16>) {
        self.frames
            .extend(input.chunks_exact(2).map(|f| [f[0] as f32, f[1] as f32]));
        while self.pos + 1.0 < self.frames.len() as f64 {
            let index = self.pos as usize;
            let frac = (self.pos - index as f64) as f32;
            let (a, b) = (self.frames[index], self.frames[index + 1]);
            for c in 0..2 {
                output.push((a[c] + (b[c] - a[c]) * frac).round() as i16);
            }
            self.pos += self.step;
        }
        // Keep the frame under `pos` (and later ones) for the next call.
        let consumed = self.pos as usize;
        self.frames.drain(..consumed);
        self.pos -= consumed as f64;
    }
}

/// Encodes interleaved stereo PCM i16 LE game audio (any sample rate) into
/// 48 kHz Opus packets of 20 ms.
pub struct OpusGameAudioEncoder {
    encoder: opus::Encoder,
    resampler: Option<(u32, StereoResampler)>,
    pending: Vec<i16>,
    packet: Vec<u8>,
}

impl OpusGameAudioEncoder {
    pub fn new() -> Result<Self, opus::Error> {
        let mut encoder = opus::Encoder::new(
            OPUS_SAMPLE_RATE,
            opus::Channels::Stereo,
            opus::Application::Audio,
        )?;
        encoder.set_bitrate(opus::Bitrate::Bits(OPUS_OUT_BITRATE))?;
        Ok(Self {
            encoder,
            resampler: None,
            pending: Vec::new(),
            packet: vec![0; OPUS_MAX_PACKET_BYTES],
        })
    }

    /// Feeds `pcm` (stereo i16 LE at `sample_rate`) and calls `on_packet` for
    /// each complete 20 ms Opus packet.
    pub fn push(&mut self, pcm: &[u8], sample_rate: u32, mut on_packet: impl FnMut(Vec<u8>)) {
        let samples: Vec<i16> = pcm
            .chunks_exact(2)
            .map(|b| i16::from_le_bytes([b[0], b[1]]))
            .collect();

        if sample_rate == 0 || sample_rate == OPUS_SAMPLE_RATE {
            self.resampler = None;
            self.pending.extend_from_slice(&samples);
        } else {
            if self
                .resampler
                .as_ref()
                .is_none_or(|(rate, _)| *rate != sample_rate)
            {
                self.resampler = Some((
                    sample_rate,
                    StereoResampler::new(sample_rate, OPUS_SAMPLE_RATE),
                ));
            }
            if let Some((_, resampler)) = &mut self.resampler {
                resampler.process(&samples, &mut self.pending);
            }
        }

        let frame_len = OPUS_FRAME_SAMPLES * 2;
        let mut offset = 0;
        while self.pending.len() - offset >= frame_len {
            match self
                .encoder
                .encode(&self.pending[offset..offset + frame_len], &mut self.packet)
            {
                Ok(len) => on_packet(self.packet[..len].to_vec()),
                Err(e) => warn!("[web-audio-out] Opus encode error: {e}"),
            }
            offset += frame_len;
        }
        self.pending.drain(..offset);
    }

    /// Drops buffered audio after a gap (e.g. broadcast lag).
    pub fn reset(&mut self) {
        self.pending.clear();
        self.resampler = None;
    }
}

/// Decodes 48 kHz mono Opus microphone packets into PCM i16 LE.
pub struct OpusMicDecoder {
    decoder: opus::Decoder,
    samples: Vec<i16>,
}

impl OpusMicDecoder {
    pub fn new() -> Result<Self, opus::Error> {
        Ok(Self {
            decoder: opus::Decoder::new(OPUS_SAMPLE_RATE, opus::Channels::Mono)?,
            samples: vec![0; OPUS_MAX_FRAME_SAMPLES],
        })
    }

    pub fn decode(&mut self, packet: &[u8]) -> Result<Vec<u8>, opus::Error> {
        let count = self.decoder.decode(packet, &mut self.samples, false)?;
        Ok(self.samples[..count]
            .iter()
            .flat_map(|s| s.to_le_bytes())
            .collect())
    }
}

// ============================================================
// Audio Out (Opus) – PCM broadcast → Opus broadcast
// ============================================================

/// Encodes the game audio PCM broadcast into Opus packets for
/// `/ws/audio_out?codec=opus` subscribers.  The audio is encoded once
/// regardless of the number of subscribers, and only while there is at least
/// one.  The function never returns.
pub fn audio_out_opus_loop(
    pcm_sender: broadcast::Sender<Vec<u8>>,
    opus_sender: broadcast::Sender<Vec<u8>>,
    sample_rate_store: Arc<AtomicU32>,
) {
    loop {
        while opus_sender.receiver_count() == 0 {
            thread::sleep(Duration::from_millis(100));
        }

        let mut encoder = match OpusGameAudioEncoder::new() {
            Ok(encoder) => encoder,
            Err(e) => {
                error!("[web-audio-out] Opus encoder init error: {e}");
                thread::sleep(Duration::from_secs(10));
                continue;
            }
        };
        let mut rx = pcm_sender.subscribe();
        info!(
            "[web-audio-out] Opus encoder started ({} kbit/s, 20 ms)",
            OPUS_OUT_BITRATE / 1000
        );

        while opus_sender.receiver_count() > 0 {
            match rx.try_recv() {
                Ok(pcm) => {
                    let sample_rate = sample_rate_store.load(Ordering::Relaxed);
                    encoder.push(&pcm, sample_rate, |packet| {
                        opus_sender.send(packet).ok();
                    });
                }
                Err(broadcast::error::TryRecvError::Empty) => {
                    thread::sleep(Duration::from_millis(5));
                }
                Err(broadcast::error::TryRecvError::Lagged(_)) => encoder.reset(),
                Err(broadcast::error::TryRecvError::Closed) => return,
            }
        }
        info!("[web-audio-out] Opus encoder stopped");
    }
}

// ============================================================
// Audio Out – WASAPI Loopback → broadcast::Sender<Vec<u8>>
// ============================================================

/// Records audio from the default system output device using WASAPI Loopback
/// and broadcasts interleaved stereo PCM i16 little-endian frames.
///
/// The function never returns (runs for the lifetime of the process).
/// It idles (sleeping) while `audio_streaming` is `false` and starts/stops
/// the cpal stream automatically as the flag changes.
pub fn audio_out_loop(
    sender: broadcast::Sender<Vec<u8>>,
    sample_rate_store: Arc<AtomicU32>,
    audio_streaming: Arc<AtomicBool>,
) {
    info!("[web-audio-out] Loop started");

    loop {
        // ── Idle phase: wait until a web client connects ──────────────────
        while !audio_streaming.load(Ordering::Relaxed) {
            thread::sleep(Duration::from_millis(100));
        }

        // ── Active phase: open loopback stream and broadcast PCM ──────────
        #[cfg(windows)]
        {
            use cpal::{
                traits::{DeviceTrait, HostTrait, StreamTrait},
                BufferSize, SampleFormat, StreamConfig,
            };

            let host = cpal::default_host();

            // The default OUTPUT device is used in loopback mode.
            let device = match host.default_output_device() {
                Some(d) => d,
                None => {
                    warn!("[web-audio-out] No default output device found");
                    thread::sleep(Duration::from_secs(2));
                    continue;
                }
            };

            // Use the device's native output configuration.
            let config = match device.default_output_config() {
                Ok(c) => c,
                Err(e) => {
                    warn!("[web-audio-out] Output config error: {e}");
                    thread::sleep(Duration::from_secs(2));
                    continue;
                }
            };

            let sample_rate = config.sample_rate().0;
            let native_channels = config.channels() as usize;
            let out_channels: usize = 2; // always produce stereo for the browser

            // Publish sample rate so websocket_audio_out() can send the config.
            sample_rate_store.store(sample_rate, Ordering::Relaxed);
            info!(
                "[web-audio-out] Loopback: {}ch @ {} Hz → 2ch broadcast",
                native_channels, sample_rate
            );

            // Batch size: number of OUTPUT i16 bytes per broadcast frame.
            // Each frame = BATCH_MS ms × sample_rate × out_channels × 2 bytes.
            let frame_bytes = sample_rate as usize * BATCH_MS / 1000 * out_channels * 2;

            let raw_buf: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));
            let sample_fmt = config.sample_format();

            // Build the WASAPI Loopback input stream on the output device.
            let stream_config = StreamConfig {
                channels: native_channels as u16,
                sample_rate: config.sample_rate(),
                buffer_size: BufferSize::Default,
            };

            let stream = device.build_input_stream_raw(
                &stream_config,
                sample_fmt,
                {
                    let raw_buf = Arc::clone(&raw_buf);
                    let sender = sender.clone();
                    move |data, _| {
                        // Convert to interleaved i16 LE (stereo: L, R).
                        let i16_bytes: Vec<u8> = match sample_fmt {
                            SampleFormat::F32 => data
                                .bytes()
                                .chunks_exact(4 * native_channels)
                                .flat_map(|frame| {
                                    let l = f32::from_ne_bytes([
                                        frame[0], frame[1], frame[2], frame[3],
                                    ]);
                                    let r = if native_channels >= 2 {
                                        f32::from_ne_bytes([
                                            frame[4], frame[5], frame[6], frame[7],
                                        ])
                                    } else {
                                        l
                                    };
                                    let ls = (l.clamp(-1.0, 1.0) * 32767.0) as i16;
                                    let rs = (r.clamp(-1.0, 1.0) * 32767.0) as i16;
                                    let mut v = ls.to_le_bytes().to_vec();
                                    v.extend_from_slice(&rs.to_le_bytes());
                                    v
                                })
                                .collect(),
                            SampleFormat::I16 => data
                                .bytes()
                                .chunks_exact(2 * native_channels)
                                .flat_map(|frame| {
                                    // Take L and R as-is (already i16 LE on x86).
                                    let l = [frame[0], frame[1]];
                                    let r = if native_channels >= 2 {
                                        [frame[2], frame[3]]
                                    } else {
                                        l
                                    };
                                    let mut v = l.to_vec();
                                    v.extend_from_slice(&r);
                                    v
                                })
                                .collect(),
                            _ => return, // Unsupported format; skip
                        };

                        let mut buf = raw_buf.lock().unwrap();
                        buf.extend_from_slice(&i16_bytes);

                        // Broadcast complete frames.
                        while buf.len() >= frame_bytes {
                            let frame: Vec<u8> = buf.drain(..frame_bytes).collect();
                            sender.send(frame).ok();
                        }
                    }
                },
                |e| error!("[web-audio-out] Stream error: {e}"),
                None,
            );

            match stream {
                Ok(s) => {
                    if let Err(e) = s.play() {
                        error!("[web-audio-out] play() error: {e}");
                        thread::sleep(Duration::from_secs(1));
                        continue;
                    }

                    // Keep the stream alive while a client is connected.
                    while audio_streaming.load(Ordering::Relaxed) {
                        thread::sleep(Duration::from_millis(50));
                    }
                    // `s` is dropped here → WASAPI Loopback stream stops.
                    info!("[web-audio-out] Loopback stream stopped");
                }
                Err(e) => {
                    error!("[web-audio-out] build_input_stream_raw error: {e}");
                    thread::sleep(Duration::from_secs(2));
                }
            }
        }

        // On Linux, game audio loopback is not implemented in this MVP.
        // The loop simply idles so that audio_out WebSocket subscribers receive
        // no frames (silence) until a future PipeWire loopback is added.
        #[cfg(not(windows))]
        {
            while audio_streaming.load(Ordering::Relaxed) {
                thread::sleep(Duration::from_millis(500));
            }
        }
    }
}

// ============================================================
// Audio In – broadcast::Receiver<Vec<u8>> → VAC "Line 1"
// ============================================================

/// Receives PCM i16 LE mono frames from the browser and plays them to the
/// Virtual Audio Cable "Line 1" output device (SteamVR virtual microphone).
///
/// The function never returns.  It idles while `audio_streaming` is `false`,
/// `audio_in_active` is `false` (no browser has opened /ws/audio_in), or the
/// VAC device is not found.
///
/// VAC Line 1 is opened using its native output configuration (channel count
/// and sample rate reported by the device driver).  Browser mono PCM is
/// upmixed to stereo before writing to VAC.
pub fn audio_in_loop(
    mut receiver: broadcast::Receiver<Vec<u8>>,
    sample_rate_store: Arc<AtomicU32>,
    audio_streaming: Arc<AtomicBool>,
    audio_in_active: Arc<AtomicBool>,
) {
    info!("[web-audio-in] Loop started");

    loop {
        // ── Idle phase ────────────────────────────────────────────────────
        // Wait until both the tracking WebSocket is connected AND a browser
        // has opened the /ws/audio_in WebSocket (mic enabled by the user).
        while !audio_streaming.load(Ordering::Relaxed)
            || !audio_in_active.load(Ordering::Relaxed)
        {
            // Drain stale messages to prevent the receiver from lagging.
            while let Ok(_) | Err(broadcast::error::TryRecvError::Lagged(_)) =
                receiver.try_recv()
            {}
            thread::sleep(Duration::from_millis(100));
        }

        // ── Active phase ──────────────────────────────────────────────────
        #[cfg(windows)]
        {
            use cpal::{
                traits::{DeviceTrait, HostTrait, StreamTrait},
                BufferSize, SampleFormat, StreamConfig,
            };

            let host = cpal::default_host();

            // Locate the VAC "Line 1" output device.
            let vac_device = host.output_devices().ok().and_then(|mut devs| {
                devs.find(|d| {
                    d.name()
                        .map(|n| n.to_lowercase().contains("line 1"))
                        .unwrap_or(false)
                })
            });

            let vac_device = match vac_device {
                Some(d) => d,
                None => {
                    // VAC not installed; drain and idle until disconnected.
                    while audio_in_active.load(Ordering::Relaxed)
                        && audio_streaming.load(Ordering::Relaxed)
                    {
                        while let Ok(_) | Err(broadcast::error::TryRecvError::Lagged(_)) =
                            receiver.try_recv()
                        {}
                        thread::sleep(Duration::from_millis(200));
                    }
                    continue;
                }
            };

            // ── Detect VAC native format ──────────────────────────────────
            // VAC Line 1 typically requires stereo (2-channel) output.
            // Using mono (1-channel) is not supported and causes
            // "The requested stream configuration is not supported" errors.
            // We use the device's native channel count and upmix mono→stereo.
            let vac_native = match vac_device.default_output_config() {
                Ok(c) => c,
                Err(e) => {
                    warn!("[web-audio-in] VAC default config error: {e}");
                    thread::sleep(Duration::from_secs(10));
                    continue;
                }
            };

            let vac_channels = vac_native.channels();
            let vac_sample_fmt = vac_native.sample_format();

            info!(
                "[web-audio-in] VAC sink: mono(browser) → {vac_channels}ch @ {} Hz ({vac_sample_fmt:?})",
                vac_native.sample_rate().0
            );

            let stream_config = StreamConfig {
                channels: vac_channels,
                sample_rate: vac_native.sample_rate(),
                buffer_size: BufferSize::Default,
            };

            let browser_rate = {
                let r = sample_rate_store.load(Ordering::Relaxed);
                if r == 0 { 48000 } else { r }
            };

            let pcm_buf: Arc<Mutex<VecDeque<i16>>> = Arc::new(Mutex::new(
                VecDeque::with_capacity(browser_rate as usize * 2),
            ));

            let ch = vac_channels as usize;

            let stream = vac_device.build_output_stream_raw(
                &stream_config,
                vac_sample_fmt,
                {
                    let pcm_buf = Arc::clone(&pcm_buf);
                    move |data: &mut cpal::Data, _| {
                        match vac_sample_fmt {
                            SampleFormat::F32 => {
                                let out = data.as_slice_mut::<f32>().unwrap_or(&mut []);
                                let mut buf = pcm_buf.lock().unwrap();
                                for frame in out.chunks_mut(ch) {
                                    // Mono → all channels (e.g. L = R for stereo).
                                    let s = buf
                                        .pop_front()
                                        .map(|v| v as f32 / 32768.0)
                                        .unwrap_or(0.0);
                                    for ch_s in frame.iter_mut() {
                                        *ch_s = s;
                                    }
                                }
                            }
                            SampleFormat::I16 => {
                                let out = data.as_slice_mut::<i16>().unwrap_or(&mut []);
                                let mut buf = pcm_buf.lock().unwrap();
                                for frame in out.chunks_mut(ch) {
                                    let s = buf.pop_front().unwrap_or(0);
                                    for ch_s in frame.iter_mut() {
                                        *ch_s = s;
                                    }
                                }
                            }
                            _ => {} // unsupported format – silently output zeros
                        }
                    }
                },
                |e| error!("[web-audio-in] VAC stream error: {e}"),
                None,
            );

            let stream = match stream {
                Ok(s) => s,
                Err(e) => {
                    error!("[web-audio-in] Failed to open VAC stream: {e}");
                    // Back off for 10 s to avoid log spam on repeated failures.
                    thread::sleep(Duration::from_secs(10));
                    continue;
                }
            };

            if let Err(e) = stream.play() {
                error!("[web-audio-in] VAC play() error: {e}");
                thread::sleep(Duration::from_secs(1));
                continue;
            }

            // Forward received PCM frames into the shared VecDeque.
            while audio_in_active.load(Ordering::Relaxed)
                && audio_streaming.load(Ordering::Relaxed)
            {
                match receiver.try_recv() {
                    Ok(data) => {
                        let mut buf = pcm_buf.lock().unwrap();
                        for chunk in data.chunks_exact(2) {
                            let sample = i16::from_le_bytes([chunk[0], chunk[1]]);
                            buf.push_back(sample);
                        }
                    }
                    Err(broadcast::error::TryRecvError::Empty) => {
                        thread::sleep(Duration::from_millis(5));
                    }
                    Err(broadcast::error::TryRecvError::Lagged(n)) => {
                        warn!("[web-audio-in] Mic buffer overflow; dropped {n} frames");
                        pcm_buf.lock().unwrap().clear();
                    }
                    Err(broadcast::error::TryRecvError::Closed) => {
                        return;
                    }
                }
            }

            // `stream` is dropped → VAC output stream stops.
            info!("[web-audio-in] VAC stream stopped");
        }

        #[cfg(not(windows))]
        {
            while audio_in_active.load(Ordering::Relaxed)
                && audio_streaming.load(Ordering::Relaxed)
            {
                while let Ok(_) | Err(broadcast::error::TryRecvError::Lagged(_)) =
                    receiver.try_recv()
                {}
                thread::sleep(Duration::from_millis(500));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One second of a 440 Hz stereo sine at `rate`, as PCM i16 LE.
    fn sine_pcm(rate: u32) -> Vec<u8> {
        (0..rate)
            .flat_map(|i| {
                let s = ((i as f32 * 440.0 * std::f32::consts::TAU / rate as f32).sin() * 10_000.0)
                    as i16;
                [s.to_le_bytes(), s.to_le_bytes()].concat()
            })
            .collect()
    }

    fn rms(samples: &[i16]) -> f32 {
        (samples.iter().map(|&s| (s as f32).powi(2)).sum::<f32>() / samples.len() as f32).sqrt()
    }

    fn encode_and_decode(rate: u32) -> (usize, Vec<i16>) {
        let mut encoder = OpusGameAudioEncoder::new().unwrap();
        let mut packets = Vec::new();
        // Feed in 10 ms batches like audio_out_loop.
        for chunk in sine_pcm(rate).chunks(rate as usize / 100 * 4) {
            encoder.push(chunk, rate, |p| packets.push(p));
        }
        let mut decoder = opus::Decoder::new(OPUS_SAMPLE_RATE, opus::Channels::Stereo).unwrap();
        let mut decoded = Vec::new();
        let mut buf = vec![0i16; OPUS_MAX_FRAME_SAMPLES * 2];
        for packet in &packets {
            let n = decoder.decode(packet, &mut buf, false).unwrap();
            decoded.extend_from_slice(&buf[..n * 2]);
        }
        (packets.len(), decoded)
    }

    #[test]
    fn game_audio_is_encoded_into_20ms_packets_at_48khz() {
        for rate in [48_000, 44_100] {
            let (packets, decoded) = encode_and_decode(rate);
            // One second of input → 49–50 packets of 20 ms at 48 kHz.
            assert!((49..=50).contains(&packets), "{rate} Hz: {packets} packets");
            assert_eq!(decoded.len(), packets * OPUS_FRAME_SAMPLES * 2);
            // Skip the codec start-up; the tone keeps its level (sine RMS ≈ 7071).
            let level = rms(&decoded[decoded.len() / 2..]);
            assert!(
                (6_000.0..8_000.0).contains(&level),
                "{rate} Hz: rms {level}"
            );
        }
    }

    #[test]
    fn opus_packets_are_much_smaller_than_pcm() {
        let mut encoder = OpusGameAudioEncoder::new().unwrap();
        let mut bytes = 0;
        encoder.push(&sine_pcm(48_000), 48_000, |p| bytes += p.len());
        // 96 kbit/s ≈ 12 kB per second vs 192 kB of PCM.
        assert!(bytes < 20_000, "{bytes} bytes");
    }

    #[test]
    fn resampler_preserves_duration_and_level() {
        let mut resampler = StereoResampler::new(44_100, 48_000);
        let input: Vec<i16> = sine_pcm(44_100)
            .chunks_exact(2)
            .map(|b| i16::from_le_bytes([b[0], b[1]]))
            .collect();
        let mut output = Vec::new();
        for chunk in input.chunks(441 * 2) {
            resampler.process(chunk, &mut output);
        }
        let frames = output.len() / 2;
        assert!((47_990..=48_000).contains(&frames), "{frames} frames");
        let level = rms(&output);
        assert!((6_900.0..7_200.0).contains(&level), "rms {level}");
    }

    #[test]
    fn mic_packets_are_decoded_to_pcm() {
        let mut encoder = opus::Encoder::new(
            OPUS_SAMPLE_RATE,
            opus::Channels::Mono,
            opus::Application::Voip,
        )
        .unwrap();
        let mut decoder = OpusMicDecoder::new().unwrap();
        let frame = vec![1000i16; OPUS_FRAME_SAMPLES];
        let mut packet = vec![0u8; OPUS_MAX_PACKET_BYTES];
        let len = encoder.encode(&frame, &mut packet).unwrap();
        let pcm = decoder.decode(&packet[..len]).unwrap();
        assert_eq!(pcm.len(), OPUS_FRAME_SAMPLES * 2);
    }
}
