function base64ToBytes(b64) {
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}

function annexBToNalUnits(data) {
  const nals = [];
  let start = -1;
  for (let i = 0; i <= data.length;) {
    let prefix = 0;
    if (i + 2 < data.length && data[i] === 0 && data[i + 1] === 0) {
      if (data[i + 2] === 1) prefix = 3;
      else if (i + 3 < data.length && data[i + 2] === 0 && data[i + 3] === 1) prefix = 4;
    }
    if (prefix || i === data.length) {
      if (start >= 0 && i > start) {
        let end = i;
        while (end > start && data[end - 1] === 0) end--;
        if (end > start) nals.push(data.subarray(start, end));
      }
      if (prefix) start = i + prefix;
    }
    i += prefix || 1;
  }
  return nals;
}

function buildAvccDescriptor(sps, pps) {
  const buf = new Uint8Array(11 + sps.length + pps.length);
  buf.set([1, sps[1], sps[2], sps[3], 0xFF, 0xE1, sps.length >> 8, sps.length & 0xFF]);
  buf.set(sps, 8);
  const offset = 8 + sps.length;
  buf.set([1, pps.length >> 8, pps.length & 0xFF], offset);
  buf.set(pps, offset + 3);
  return buf;
}

function packNals(nals, annexB = false) {
  const out = new Uint8Array(nals.reduce((size, nal) => size + 4 + nal.length, 0));
  const view = new DataView(out.buffer);
  let offset = 0;
  for (const nal of nals) {
    view.setUint32(offset, annexB ? 1 : nal.length);
    out.set(nal, offset + 4);
    offset += 4 + nal.length;
  }
  return out;
}

function hevcCodecString(sps) {
  // profile_tier_level follows the first SPS RBSP byte. Remove emulation prevention.
  const rbsp = [];
  for (let i = 2; i < sps.length; i++) {
    if (i >= 4 && sps[i] === 3 && sps[i - 1] === 0 && sps[i - 2] === 0) continue;
    rbsp.push(sps[i]);
  }
  if (rbsp.length < 13) throw new Error('HEVC SPS is missing profile_tier_level');
  const profile = rbsp[1];
  const flags = (rbsp[2] * 0x1000000 + rbsp[3] * 0x10000 + rbsp[4] * 0x100 + rbsp[5]) >>> 0;
  // ISO/IEC 14496-15 writes compatibility flags in reversed bit order.
  let compatibility = 0;
  for (let bit = 0; bit < 32; bit++) {
    compatibility = (compatibility * 2) + ((flags >>> bit) & 1);
  }
  const constraints = rbsp.slice(6, 12);
  while (constraints.length > 1 && constraints.at(-1) === 0) constraints.pop();
  const suffix = constraints.map(b => b.toString(16).padStart(2, '0').toUpperCase()).join('.');
  return `hev1.${['', 'A', 'B', 'C'][profile >> 6]}${profile & 31}.` +
    `${compatibility.toString(16).toUpperCase()}.${profile & 32 ? 'H' : 'L'}${rbsp[12]}.${suffix}`;
}

export function createVideoCodec(message) {
  const raw = message.config_buffer_b64 ? base64ToBytes(message.config_buffer_b64) : new Uint8Array();
  const config = {
    codedWidth: message.width,
    codedHeight: message.height,
    hardwareAcceleration: 'prefer-hardware',
    optimizeForLatency: true,
  };
  let prepareChunk;
  switch (message.codec) {
    case 'h264': {
      const nals = annexBToNalUnits(raw);
      const sps = nals.find(n => (n[0] & 31) === 7);
      const pps = nals.find(n => (n[0] & 31) === 8);
      config.codec = sps?.length >= 4
        ? `avc1.${Array.from(sps.subarray(1, 4), b => b.toString(16).padStart(2, '0')).join('')}`
        : 'avc1.640034';
      if (sps && pps) config.description = buildAvccDescriptor(sps, pps);
      prepareChunk = data => {
        if (!config.description) return data;
        const picture = annexBToNalUnits(data).filter(n => ![7, 8].includes(n[0] & 31));
        return picture.length ? packNals(picture) : null;
      };
      break;
    }
    case 'hevc': {
      const type = nal => (nal[0] >> 1) & 63;
      const parameterSets = annexBToNalUnits(raw).filter(n => n.length >= 2 && [32, 33, 34].includes(type(n)));
      if (![32, 33, 34].every(t => parameterSets.some(n => type(n) === t))) {
        throw new Error('HEVC configuration must contain Annex B VPS, SPS and PPS');
      }
      config.codec = hevcCodecString(parameterSets.find(n => type(n) === 33));
      // No description selects Annex B. The server strips parameter sets from frames.
      prepareChunk = (data, isKey) => {
        const nals = annexBToNalUnits(data);
        if (!nals.some(n => n.length >= 2 && type(n) <= 31)) return null;
        if (!isKey) return data;
        const aud = nals.filter(n => type(n) === 35);
        const picture = nals.filter(n => ![32, 33, 34, 35].includes(type(n)));
        return packNals([...aud, ...parameterSets, ...picture], true);
      };
      break;
    }
    case 'av1':
      config.codec = 'av01.0.08M.08';
      prepareChunk = data => data;
      break;
    default:
      throw new Error(`Unsupported video codec: ${message.codec}`);
  }
  return { config, prepareChunk };
}

const RETRY_DELAYS_MS = [500, 1000, 2000];

export class VideoDecoderSession {
  constructor({ output, onConfigured, onError, log }) {
    this._output = output;
    this._onConfigured = onConfigured;
    this._onError = onError;
    this._log = log;
    this._generation = 0;
    this._closed = false;
    this._failed = false;
    this._decoder = null;
    this._retryTimer = null;
  }

  get state() {
    if (this._closed || this._failed) return 'closed';
    return this._decoder?.state ?? 'unconfigured';
  }

  get decodeQueueSize() {
    return this._decoder?.decodeQueueSize ?? 0;
  }

  async configure(message) {
    this.close();
    this._closed = false;
    this._failed = false;
    this._failures = 0;
    const generation = this._generation;
    try {
      if (typeof VideoDecoder === 'undefined') throw new Error('WebCodecs VideoDecoder is not supported');
      this._codec = createVideoCodec(message);
      const { supported } = await VideoDecoder.isConfigSupported(this._codec.config);
      if (this._closed || generation !== this._generation) return;
      if (!supported) throw new Error(`Unsupported video decoder configuration: ${this._codec.config.codec}`);
    } catch (error) {
      if (!this._closed && generation === this._generation) this._stop(error);
      return;
    }
    this._startDecoder();
  }

  _startDecoder() {
    this._needsKeyFrame = true;
    let hasOutput = false;
    try {
      const decoder = new VideoDecoder({
        output: frame => {
          if (this._closed || this._decoder !== decoder) {
            frame.close();
            return;
          }
          this._failures = 0;
          if (!hasOutput) {
            hasOutput = true;
            this._log(`Decoder output started: ${this._codec.config.codec}`);
          }
          this._output(frame);
        },
        error: error => {
          if (this._decoder === decoder) this._handleError(error);
        },
      });
      this._decoder = decoder;
      decoder.configure(this._codec.config);
      this._log(`Decoder configure requested: ${this._codec.config.codec}`);
      this._onConfigured();
    } catch (error) {
      this._handleError(error);
    }
  }

  _handleError(error) {
    this._closeDecoder();
    const delay = RETRY_DELAYS_MS[this._failures++];
    if (delay === undefined) {
      this._stop(error);
      return;
    }
    const message = `${error.message ?? error} (retry ${this._failures}/${RETRY_DELAYS_MS.length} in ${delay} ms)`;
    this._log(`[ERROR] Decoder error: ${message}`);
    this._onError(message, false);
    const generation = this._generation;
    this._retryTimer = setTimeout(() => {
      this._retryTimer = null;
      if (!this._closed && generation === this._generation) this._startDecoder();
    }, delay);
  }

  _stop(error) {
    this._closeDecoder();
    this._failed = true;
    const message = `${error.message ?? error}. Video decoding stopped; reconnect or change codec.`;
    this._log(`[ERROR] ${message}`);
    this._onError(message, true);
  }

  decode(timestampNs, isKey, data) {
    if (this.state !== 'configured' || (this._needsKeyFrame && !isKey)) return false;
    try {
      const prepared = this._codec.prepareChunk(data, isKey);
      if (!prepared) return false;
      this._decoder.decode(new EncodedVideoChunk({
        type: isKey ? 'key' : 'delta',
        timestamp: Number(timestampNs / 1000n),
        data: prepared,
      }));
      if (isKey) this._needsKeyFrame = false;
      return true;
    } catch (error) {
      this._handleError(error);
      return false;
    }
  }

  _closeDecoder() {
    if (this._decoder && this._decoder.state !== 'closed') this._decoder.close();
    this._decoder = null;
  }

  close() {
    this._closed = true;
    ++this._generation;
    clearTimeout(this._retryTimer);
    this._retryTimer = null;
    this._closeDecoder();
  }
}
