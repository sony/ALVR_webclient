export const VITURE_VID = 0x35CA;
export const VITURE_PRO_2_PID = 0x1301;

export const VITURE_HID_FILTERS = [
  { vendorId: VITURE_VID, usagePage: 0xFF00 },
  { vendorId: VITURE_VID, productId: 0x1011 },
  { vendorId: VITURE_VID, productId: 0x101D },
  { vendorId: VITURE_VID, productId: VITURE_PRO_2_PID },
];

export function pickVitureImuDevice(candidates, log) {
  const matches = candidates.filter(device =>
    device.vendorId === VITURE_VID &&
    device.collections.some(collection => collection.usagePage === 0xFF00 || collection.usagePage === 0xFF01)
  );
  if (matches.length === 0) return null;

  const score = device => device.collections.reduce((best, collection) => {
    if (collection.usagePage !== 0xFF00 && collection.usagePage !== 0xFF01) return best;
    const hasInput = (collection.inputReports?.length ?? 0) > 0;
    const hasOutput = (collection.outputReports?.length ?? 0) > 0;
    return Math.max(best, (hasInput ? 2 : 0) + (hasOutput ? 1 : 0));
  }, 0);
  const picked = matches.reduce(
    (best, current) => score(current) > score(best) ? current : best,
    matches[0],
  );
  log(`VITURE: ${matches.length} collection(s) found; provisional input source selected (score=${score(picked)})`);
  return picked;
}

export function findVitureControlDevice(candidates, imuDevice) {
  return candidates.find(device =>
    device !== imuDevice &&
    device.vendorId === VITURE_VID &&
    device.productId === imuDevice.productId &&
    device.collections.some(collection => collection.usagePage === 0xFF00 || collection.usagePage === 0xFF01)
  ) ?? null;
}

const VITURE_OUTPUT_REPORT_SIZE = 64;
const VITURE_PRO_2_IMU_CONTROL_MSG_ID = 0x0301;
const VITURE_PRO_2_POSE_EVENT_MSG_ID = 0x7308;
const VITURE_PRO_2_RAW_EVENT_MSG_ID = 0x7309;
const VITURE_PRO_2_ACK_MSG_ID = 0x2301;
const VITURE_PRO_2_POSE_RATE_90_HZ = 0x01;

const VITURE_CRC_TABLE = (() => {
  const table = new Uint16Array(256);
  for (let i = 0; i < 256; i++) {
    let crc = i << 8;
    for (let j = 0; j < 8; j++) crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) : (crc << 1);
    table[i] = crc & 0xFFFF;
  }
  return table;
})();

function crc16(data, start, len, initialValue = 0xFFFF) {
  let crc = initialValue;
  for (let i = start; i < start + len; i++)
    crc = ((crc << 8) ^ VITURE_CRC_TABLE[((crc >> 8) ^ data[i]) & 0xFF]) & 0xFFFF;
  return crc;
}

let messageCounter = 0;

export function buildVitureCmd(cmdId, data) {
  const dataLength = data ? data.length : 0;
  const packetLength = 18 + dataLength + 1;
  const packet = new Uint8Array(packetLength);
  packet[0] = 0xFF; packet[1] = 0xFE;
  const payloadLength = 8 + 2 + 2 + dataLength + 1;
  packet[4] = payloadLength & 0xFF;
  packet[5] = (payloadLength >> 8) & 0xFF;
  packet[14] = cmdId & 0xFF;
  packet[15] = (cmdId >> 8) & 0xFF;
  messageCounter = (messageCounter + 1) & 0xFFFF;
  packet[16] = messageCounter & 0xFF;
  packet[17] = (messageCounter >> 8) & 0xFF;
  if (data && dataLength > 0) packet.set(data, 18);
  packet[packetLength - 1] = 0x03;
  const crc = crc16(packet, 4, packetLength - 4);
  packet[2] = (crc >> 8) & 0xFF;
  packet[3] = crc & 0xFF;
  return packet;
}

export function buildViturePro2Frame(msgId, payload = new Uint8Array()) {
  if (!(payload instanceof Uint8Array) || payload.length > VITURE_OUTPUT_REPORT_SIZE - 8) {
    throw new RangeError('VITURE Pro 2 payload must fit in a 64-byte HID report');
  }

  const frame = new Uint8Array(8 + payload.length);
  const view = new DataView(frame.buffer);
  frame[0] = 0x10;
  frame[1] = 0x00;
  view.setUint16(2, msgId, true);
  view.setUint16(4, payload.length, true);
  const checksum = payload.reduce((sum, byte) => (sum + byte) & 0xFFFF, 0);
  view.setUint16(6, checksum, true);
  frame.set(payload, 8);
  return frame;
}

export function buildViturePro2ImuControl(enable) {
  return buildViturePro2Frame(
    VITURE_PRO_2_IMU_CONTROL_MSG_ID,
    new Uint8Array(enable ? [0x01, VITURE_PRO_2_POSE_RATE_90_HZ] : [0x00, 0x00]),
  );
}

export function vitureEulerToQuat(rollZ, pitchX, yawY) {
  const cr = Math.cos(rollZ * 0.5), sr = Math.sin(rollZ * 0.5);
  const cp = Math.cos(pitchX * 0.5), sp = Math.sin(pitchX * 0.5);
  const cy = Math.cos(yawY * 0.5), sy = Math.sin(yawY * 0.5);
  let w = cr * cp * cy + sr * sp * sy;
  let x = cr * sp * cy + sr * cp * sy;
  let y = cr * cp * sy - sr * sp * cy;
  let z = sr * cp * cy - cr * sp * sy;
  const norm = Math.sqrt(w*w + x*x + y*y + z*z);
  if (norm > 1e-6) { w /= norm; x /= norm; y /= norm; z /= norm; }
  return [w, x, y, z];
}

export function createVitureHidAdapter({ log, onTracking }) {
  let reportCount = 0;
  let firstReport = true;
  let dropCounts = { length: 0, crc: 0, euler: 0, jump: 0 };
  let lastDropLogMs = 0;
  let previousQuat = { w: 1, x: 0, y: 0, z: 0 };
  let previousTimestampNs = 0n;
  let pro2ReportCount = 0;
  let pro2InvalidCount = 0;
  let pro2IgnoredIds = new Set();
  let pro2PreviousQuat = { w: 1, x: 0, y: 0, z: 0 };
  let pro2PreviousTimestampNs = 0n;

  function reset() {
    reportCount = 0;
    firstReport = true;
    dropCounts = { length: 0, crc: 0, euler: 0, jump: 0 };
    lastDropLogMs = 0;
    previousQuat = { w: 1, x: 0, y: 0, z: 0 };
    previousTimestampNs = 0n;
    pro2ReportCount = 0;
    pro2InvalidCount = 0;
    pro2IgnoredIds = new Set();
    pro2PreviousQuat = { w: 1, x: 0, y: 0, z: 0 };
    pro2PreviousTimestampNs = 0n;
  }

  function dropPacket(reason) {
    dropCounts[reason]++;
    const nowMs = performance.now();
    const totalDrops = Object.values(dropCounts).reduce((sum, count) => sum + count, 0);
    if (totalDrops === 1 || nowMs - lastDropLogMs >= 1000) {
      lastDropLogMs = nowMs;
      log(`VITURE: invalid packets dropped ${JSON.stringify(dropCounts)}`);
    }
  }

  function parseImuPacket(view) {
    const payloadLength = view.getUint16(4, true);
    const packetLength = 6 + payloadLength;
    if (payloadLength < 24 || packetLength > view.byteLength) {
      dropPacket('length');
      return false;
    }

    const expectedCrc = view.getUint16(2, true);
    const bytes = new Uint8Array(view.buffer, view.byteOffset, packetLength);
    const actualCrc = crc16(bytes, 4, packetLength - 4, 0x0000);
    if (actualCrc !== expectedCrc) {
      dropPacket('crc');
      return false;
    }

    const raw0 = view.getFloat32(18, false);
    const raw1 = view.getFloat32(22, false);
    const raw2 = view.getFloat32(26, false);
    if (![raw0, raw1, raw2].every(Number.isFinite) ||
        Math.abs(raw0) > 180 || Math.abs(raw1) > 180 || Math.abs(raw2) > 180) {
      dropPacket('euler');
      return false;
    }

    const rollZ = -raw0;
    const pitchX = -raw1;
    const yawY = raw2;
    const d2r = Math.PI / 180;
    let [qw, qx, qy, qz] = vitureEulerToQuat(rollZ * d2r, pitchX * d2r, yawY * d2r);
    const nowMs = performance.now();
    const nowNs = BigInt(Math.floor(nowMs * 1e6));

    if (previousTimestampNs !== 0n) {
      const dot = qw*previousQuat.w + qx*previousQuat.x +
                  qy*previousQuat.y + qz*previousQuat.z;
      if (dot < 0) {
        qw = -qw; qx = -qx; qy = -qy; qz = -qz;
      }

      const dt = Number(nowNs - previousTimestampNs) * 1e-9;
      const continuousDot = Math.min(1, Math.abs(
        qw*previousQuat.w + qx*previousQuat.x +
        qy*previousQuat.y + qz*previousQuat.z
      ));
      const angle = 2 * Math.acos(continuousDot);
      const maxAngle = dt > 0 && dt < 0.1
        ? Math.max(20 * Math.PI / 180, 25 * dt)
        : 120 * Math.PI / 180;
      if (angle > maxAngle) {
        dropPacket('jump');
        return false;
      }
    }

    let gyrX = 0, gyrY = 0, gyrZ = 0;
    if (previousTimestampNs !== 0n) {
      const dt = Number(nowNs - previousTimestampNs) * 1e-9;
      if (dt > 0 && dt < 0.1) {
        const dqw = qw - previousQuat.w, dqx = qx - previousQuat.x;
        const dqy = qy - previousQuat.y, dqz = qz - previousQuat.z;
        const inv2dt = 2.0 / dt;
        const pw = previousQuat.w, px = previousQuat.x, py = previousQuat.y, pz = previousQuat.z;
        gyrX = inv2dt * ( dqx*pw - dqw*px - dqz*py + dqy*pz);
        gyrY = inv2dt * ( dqy*pw + dqz*px - dqw*py - dqx*pz);
        gyrZ = inv2dt * ( dqz*pw - dqy*px + dqx*py - dqw*pz);
      }
    }

    reportCount++;
    if (reportCount <= 3 || reportCount % 300 === 0) {
      const norm = Math.sqrt(qw*qw + qx*qx + qy*qy + qz*qz);
      const normOk = !isNaN(norm) && norm > 0.9 && norm < 1.1;
      log(`VITURE IMU #${reportCount}: yaw=${yawY.toFixed(2)}° roll=${rollZ.toFixed(2)}° pitch=${pitchX.toFixed(2)}°` +
          ` → qw=${qw.toFixed(4)} qx=${qx.toFixed(4)} qy=${qy.toFixed(4)} qz=${qz.toFixed(4)}` +
          ` norm=${norm.toFixed(4)} ${normOk ? 'OK' : 'WARN:bad-quat!'}`);
    }

    previousTimestampNs = nowNs;
    previousQuat = { w: qw, x: qx, y: qy, z: qz };
    onTracking({
      timestampNs: nowNs,
      qw, qx, qy, qz,
      gyrX, gyrY, gyrZ,
      accX: 0, accY: 0, accZ: 0,
    });
    return true;
  }

  function parseViturePro2Report(reportId, view) {
    const invalid = reason => {
      pro2InvalidCount++;
      if (pro2InvalidCount === 1 || pro2InvalidCount % 300 === 0) {
        log(`VITURE Pro 2: invalid V2 report #${pro2InvalidCount}: ${reason}`);
      }
      return false;
    };

    if (reportId !== 0) return invalid(`unexpected report ID ${reportId}`);
    if (view.byteLength < 8) return invalid(`short header (${view.byteLength} bytes)`);
    if (view.getUint16(0, true) !== 0x0010) return invalid('bad preamble');

    const msgId = view.getUint16(2, true);
    const payloadLength = view.getUint16(4, true);
    const frameLength = 8 + payloadLength;
    if (frameLength > view.byteLength) {
      return invalid(`truncated frame (${frameLength} > ${view.byteLength})`);
    }

    let checksum = 0;
    for (let i = 8; i < frameLength; i++) checksum = (checksum + view.getUint8(i)) & 0xFFFF;
    if (checksum !== view.getUint16(6, true)) return invalid('checksum mismatch');

    if (msgId === VITURE_PRO_2_ACK_MSG_ID) {
      if (payloadLength !== 1) return invalid(`ACK payload length ${payloadLength}`);
      const status = view.getUint8(8);
      if (status === 0) log('VITURE Pro 2: IMU control acknowledged');
      else log(`VITURE Pro 2: IMU control rejected (status=0x${status.toString(16)})`);
      return false;
    }

    if (msgId !== VITURE_PRO_2_POSE_EVENT_MSG_ID) {
      if (!pro2IgnoredIds.has(msgId)) {
        pro2IgnoredIds.add(msgId);
        const label = msgId === VITURE_PRO_2_RAW_EVENT_MSG_ID ? 'raw IMU event not requested' : 'unsupported message';
        log(`VITURE Pro 2: ignoring ${label} 0x${msgId.toString(16)}`);
      }
      return false;
    }

    if (payloadLength !== 24) return invalid(`pose payload length ${payloadLength}`);
    const qwRaw = view.getFloat32(16, true);
    const qxRaw = view.getFloat32(20, true);
    const qyRaw = view.getFloat32(24, true);
    const qzRaw = view.getFloat32(28, true);
    const norm = Math.hypot(qwRaw, qxRaw, qyRaw, qzRaw);
    if (![qwRaw, qxRaw, qyRaw, qzRaw, norm].every(Number.isFinite) ||
        norm < 0.5 || norm > 1.5) {
      return invalid(`invalid quaternion norm ${norm}`);
    }

    let qw = qwRaw / norm, qx = qxRaw / norm;
    let qy = qyRaw / norm, qz = qzRaw / norm;
    const nowNs = BigInt(Math.floor(performance.now() * 1e6));
    const dt = pro2PreviousTimestampNs === 0n
      ? 0
      : Number(nowNs - pro2PreviousTimestampNs) * 1e-9;

    if (pro2PreviousTimestampNs !== 0n) {
      const dot = qw*pro2PreviousQuat.w + qx*pro2PreviousQuat.x +
                  qy*pro2PreviousQuat.y + qz*pro2PreviousQuat.z;
      if (dot < 0) {
        qw = -qw; qx = -qx; qy = -qy; qz = -qz;
      }

      const continuousDot = Math.min(1, Math.abs(
        qw*pro2PreviousQuat.w + qx*pro2PreviousQuat.x +
        qy*pro2PreviousQuat.y + qz*pro2PreviousQuat.z
      ));
      const angle = 2 * Math.acos(continuousDot);
      const maxAngle = dt > 0 && dt < 0.1
        ? Math.max(20 * Math.PI / 180, 25 * dt)
        : 120 * Math.PI / 180;
      if (angle > maxAngle) return invalid(`pose jump ${angle.toFixed(3)} rad`);
    }

    let gyrX = 0, gyrY = 0, gyrZ = 0;
    if (dt > 0 && dt < 0.1) {
      const dqw = qw - pro2PreviousQuat.w, dqx = qx - pro2PreviousQuat.x;
      const dqy = qy - pro2PreviousQuat.y, dqz = qz - pro2PreviousQuat.z;
      const inv2dt = 2.0 / dt;
      const pw = pro2PreviousQuat.w, px = pro2PreviousQuat.x;
      const py = pro2PreviousQuat.y, pz = pro2PreviousQuat.z;
      gyrX = inv2dt * ( dqx*pw - dqw*px - dqz*py + dqy*pz);
      gyrY = inv2dt * ( dqy*pw + dqz*px - dqw*py - dqx*pz);
      gyrZ = inv2dt * ( dqz*pw - dqy*px + dqx*py - dqw*pz);
    }

    pro2ReportCount++;
    if (pro2ReportCount <= 3 || pro2ReportCount % 300 === 0) {
      log(`VITURE Pro 2 IMU #${pro2ReportCount}: q=${qw.toFixed(4)},${qx.toFixed(4)},${qy.toFixed(4)},${qz.toFixed(4)}`);
    }
    pro2PreviousTimestampNs = nowNs;
    pro2PreviousQuat = { w: qw, x: qx, y: qy, z: qz };
    onTracking({
      timestampNs: nowNs,
      qw, qx, qy, qz,
      gyrX, gyrY, gyrZ,
      accX: 0, accY: 0, accZ: 0,
    });
    return true;
  }

  function parseReport(reportId, view, productId) {
    if (productId === VITURE_PRO_2_PID) return parseViturePro2Report(reportId, view);

    if (view.byteLength < 30) {
      if (firstReport) log(`VITURE: report too short (${view.byteLength} bytes, need ≥30)`);
      return false;
    }

    const h0 = view.getUint8(0);
    const h1 = view.getUint8(1);
    if (firstReport) {
      firstReport = false;
      const hex = Array.from({ length: Math.min(view.byteLength, 32) },
        (_, i) => view.getUint8(i).toString(16).padStart(2, '0')).join(' ');
      log(`VITURE: first report — reportId=0x${reportId.toString(16)} len=${view.byteLength}` +
          ` header=0x${h0.toString(16)} 0x${h1.toString(16)}`);
      log(`VITURE: bytes[0..32]: ${hex}`);
    }

    if (h0 === 0xFF && h1 === 0xFC) return parseImuPacket(view);
    if (h0 === 0xFF && h1 === 0xFD) {
      if (reportCount < 3) log('VITURE: MCU ACK received');
    } else if (reportCount < 5) {
      const hex = Array.from({ length: Math.min(view.byteLength, 20) },
        (_, i) => view.getUint8(i).toString(16).padStart(2, '0')).join(' ');
      log(`VITURE: unknown packet header=0x${h0.toString(16)} 0x${h1.toString(16)}: ${hex}`);
    }
    return false;
  }

  async function sendImuEnable(device, enable) {
    const operation = enable ? 'enable' : 'disable';
    try {
      const isPro2 = device.productId === VITURE_PRO_2_PID;
      const cmd = isPro2
        ? buildViturePro2ImuControl(enable)
        : buildVitureCmd(0x15, new Uint8Array([enable ? 0x01 : 0x00]));
      const report = new Uint8Array(VITURE_OUTPUT_REPORT_SIZE);
      report.set(cmd);
      const hex = Array.from(cmd, b => b.toString(16).padStart(2, '0')).join(' ');
      const deviceName = isPro2 ? 'VITURE Pro 2 IMU' : 'VITURE IMU';
      log(`${deviceName} ${operation} cmd (${cmd.length}B logical, ${report.length}B report): ${hex}`);
      await device.sendReport(0x00, report);
      log(`${deviceName} ${enable ? 'enabled' : 'disabled'}`);
      return true;
    } catch (err) {
      log(`VITURE ${device.productId === VITURE_PRO_2_PID ? 'Pro 2 ' : ''}IMU ${operation} error: ${err.message}`);
      return false;
    }
  }

  return { parseReport, reset, sendImuEnable };
}
