/**
 * audio-processor.js
 *
 * AudioWorklet processors for the ALVR Web Client audio pipeline.
 *
 * Processors registered here:
 *
 *   "alvr-audio-out"  — Receives game audio PCM i16 LE (stereo, 2 ch) from the
 *                       main thread via postMessage and plays it through the
 *                       AudioContext destination.
 *
 *   "alvr-audio-in"   — Captures microphone input (mono, 1 ch) from
 *                       AudioWorkletNode, converts Float32 → PCM i16 LE and
 *                       posts transferable ArrayBuffers back to the main thread.
 *
 * Wire protocol:
 *
 *   audio-out (main → processor):
 *     { type: "config", sampleRate: number, channels: number }
 *     { type: "pcm",    buffer: ArrayBuffer }   ← PCM i16 LE, channels=2
 *     { type: "f32",    buffer: ArrayBuffer }   ← Float32 interleaved (decoded Opus)
 *
 *   audio-in (processor → main):
 *     { type: "pcm", buffer: ArrayBuffer }       ← PCM i16 LE, mono
 *     { type: "f32", buffer: ArrayBuffer }       ← Float32, mono (processorOptions.format = "f32")
 *
 * IMPORTANT:  This file must be served with Content-Type application/javascript
 * and from the same origin as the page (HTTPS).  getUserMedia also requires
 * HTTPS (or localhost).
 */

// ============================================================
// Game audio output (Server → Browser)
// ============================================================

class AlvrAudioOutProcessor extends AudioWorkletProcessor {
    constructor(options) {
        super(options);

        // Keep playout latency bounded. The buffer is resized from the stream
        // config before the first PCM packet arrives.
        this._bufSize = Math.ceil(48_000 * 2 * 0.2);
        this._buf     = new Float32Array(this._bufSize);
        this._head    = 0;   // next write position
        this._tail    = 0;   // next read  position
        this._count   = 0;   // samples currently stored
        this._channels = 2;
        this._fadeSamples = Math.ceil(sampleRate * 0.005);
        this._fadeRemaining = 0;
        this._resumeRemaining = 0;
        this._underrun = true;
        this._lastL = 0;
        this._lastR = 0;

        this.port.onmessage = (ev) => {
            const { type } = ev.data;

            if (type === "config") {
                this._channels = ev.data.channels || 2;
                const streamSampleRate = ev.data.sampleRate || sampleRate;
                this._bufSize = Math.ceil(streamSampleRate * this._channels * 0.2);
                this._buf = new Float32Array(this._bufSize);
                this._head = 0;
                this._tail = 0;
                this._count = 0;

            } else if (type === "pcm") {
                // Incoming data: PCM i16 LE interleaved (channels=2).
                this._push(new Int16Array(ev.data.buffer), 1 / 32768.0);

            } else if (type === "f32") {
                // Incoming data: decoded Opus, Float32 interleaved (channels=2).
                this._push(new Float32Array(ev.data.buffer), 1);
            }
        };
    }

    /** Appends interleaved samples (multiplied by `scale`) to the ring buffer. */
    _push(samples, scale) {
        // Drop the oldest complete sample frames when a burst would
        // exceed the 200 ms hard limit. Live audio must stay current.
        while (this._count + samples.length > this._bufSize &&
               this._count >= this._channels) {
            this._tail = (this._tail + this._channels) % this._bufSize;
            this._count -= this._channels;
        }
        for (let i = 0; i < samples.length; i++) {
            if (this._count < this._bufSize) {
                this._buf[this._head] = samples[i] * scale;
                this._head = (this._head + 1) % this._bufSize;
                this._count++;
            }
        }
    }

    /**
     * Called by the Audio Worklet thread ~every 128 samples.
     * @param {Float32Array[][]} _inputs  — ignored (no audio input here)
     * @param {Float32Array[][]} outputs  — write here to produce sound
     * @returns {boolean} keep-alive flag
     */
    process(_inputs, outputs) {
        const outL = outputs[0][0]; // left  channel
        const outR = outputs[0][1]; // right channel (may be undefined on mono ctx)

        const frames = outL ? outL.length : 0;

        for (let f = 0; f < frames; f++) {
            // Dequeue one stereo pair (2 samples).
            if (this._count >= 2) {
                let l = this._buf[this._tail];
                this._tail = (this._tail + 1) % this._bufSize;
                let r = this._buf[this._tail];
                this._tail = (this._tail + 1) % this._bufSize;
                this._count -= 2;

                if (this._underrun) {
                    this._underrun = false;
                    this._resumeRemaining = this._fadeSamples;
                }
                if (this._resumeRemaining > 0) {
                    const gain = 1 - this._resumeRemaining / this._fadeSamples;
                    l *= gain;
                    r *= gain;
                    this._resumeRemaining--;
                }
                this._lastL = l;
                this._lastR = r;

                if (outL) outL[f] = l;
                if (outR) outR[f] = r;
            } else {
                if (!this._underrun) {
                    this._underrun = true;
                    this._fadeRemaining = this._fadeSamples;
                }
                const gain = this._fadeRemaining > 0
                    ? this._fadeRemaining / this._fadeSamples
                    : 0;
                if (outL) outL[f] = this._lastL * gain;
                if (outR) outR[f] = this._lastR * gain;
                if (this._fadeRemaining > 0) this._fadeRemaining--;
            }
        }

        return true; // keep processor alive
    }
}

registerProcessor("alvr-audio-out", AlvrAudioOutProcessor);

// ============================================================
// Microphone input (Browser → Server)
// ============================================================

class AlvrAudioInProcessor extends AudioWorkletProcessor {
    constructor(options) {
        super(options);
        // "f32": post Float32 samples (encoded to Opus on the main thread).
        // Default: post PCM i16 LE.
        this._f32 = options?.processorOptions?.format === "f32";
    }

    /**
     * Called by the Audio Worklet thread ~every 128 samples.
     * Captures mono microphone input and posts it back to the main thread as
     * a transferable ArrayBuffer (Float32 or PCM i16 LE, see constructor).
     *
     * @param {Float32Array[][]} inputs   — [0][0] = mono mic samples
     * @param {Float32Array[][]} _outputs — unused
     * @returns {boolean} keep-alive flag
     */
    process(inputs) {
        const mic = inputs[0] && inputs[0][0];
        if (!mic || mic.length === 0) {
            return true;
        }

        if (this._f32) {
            // The input buffer is reused by the audio thread: copy it.
            const samples = new Float32Array(mic);
            this.port.postMessage({ type: "f32", buffer: samples.buffer }, [samples.buffer]);
            return true;
        }

        // Convert Float32 → PCM i16 LE.
        const pcm = new Int16Array(mic.length);
        for (let i = 0; i < mic.length; i++) {
            const s = Math.max(-1.0, Math.min(1.0, mic[i]));
            pcm[i] = s < 0 ? s * 32768 : s * 32767;
        }

        // Post as a transferable to avoid a copy in the structured-clone step.
        this.port.postMessage({ type: "pcm", buffer: pcm.buffer }, [pcm.buffer]);

        return true;
    }
}

registerProcessor("alvr-audio-in", AlvrAudioInProcessor);
