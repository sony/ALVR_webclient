import { createMahonyState, mahonyUpdate } from './mahony.js';

export const XREAL_VID = 0x3318;

export const XREAL_HID_FILTERS = [
  { vendorId: XREAL_VID, usagePage: 0x0041 },
  { vendorId: XREAL_VID, productId: 0x0424 },
  { vendorId: XREAL_VID, productId: 0x0426 },
  { vendorId: XREAL_VID, productId: 0x0428 },
  { vendorId: XREAL_VID, productId: 0x0432 },
  { vendorId: XREAL_VID, productId: 0x0436 },
];

export function pickXrealImuDevice(candidates, log) {
  const matches = candidates.filter(device =>
    device.vendorId === XREAL_VID &&
    device.collections.some(collection => collection.usagePage === 0x0041)
  );
  if (matches.length === 0) return null;
  const picked = matches[matches.length - 1];
  log(`XREAL: ${matches.length} page=0x41 collection(s) found; picking last (index ${candidates.indexOf(picked)}) as IMU interface`);
  return picked;
}

function crc32(bytes) {
  let crc = 0xFFFFFFFF;
  for (const b of bytes) {
    crc ^= b;
    for (let i = 0; i < 8; i++) {
      crc = (crc & 1) ? ((crc >>> 1) ^ 0xEDB88320) : (crc >>> 1);
    }
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

export function buildXrealCmd(msgid, data) {
  const packetLen = 3 + data.length;
  const payloadLen = 5 + packetLen;
  const crcInput = new Uint8Array(packetLen);
  crcInput[0] = packetLen & 0xFF;
  crcInput[1] = (packetLen >> 8) & 0xFF;
  crcInput[2] = msgid;
  crcInput.set(data, 3);

  const checksum = crc32(crcInput);
  const cmd = new Uint8Array(payloadLen);
  cmd[0] = 0xAA;
  cmd[1] = checksum & 0xFF;
  cmd[2] = (checksum >>> 8) & 0xFF;
  cmd[3] = (checksum >>> 16) & 0xFF;
  cmd[4] = (checksum >>> 24) & 0xFF;
  cmd[5] = crcInput[0];
  cmd[6] = crcInput[1];
  cmd[7] = msgid;
  cmd.set(data, 8);
  return cmd;
}

export async function sendXrealImuStart(device, log) {
  try {
    const cmd = buildXrealCmd(0x19, new Uint8Array([0x01]));
    const hex = Array.from(cmd, b => b.toString(16).padStart(2, '0')).join(' ');
    log(`XREAL IMU START cmd (${cmd.length} bytes): ${hex}`);
    await device.sendReport(0x00, cmd);
    log('XREAL IMU START command sent – waiting for inputreport events');
  } catch (err) {
    log(`XREAL IMU START error: ${err.message}`);
  }
}

export async function sendXrealImuStop(device, log) {
  try {
    const cmd = buildXrealCmd(0x19, new Uint8Array([0x00]));
    await device.sendReport(0x00, cmd);
    log('XREAL IMU STOP command sent');
  } catch (err) {
    log(`XREAL IMU STOP error: ${err.message}`);
  }
}

function int24LE(view, offset) {
  const lo = view.getUint8(offset);
  const mi = view.getUint8(offset + 1);
  const hi = view.getUint8(offset + 2);
  return ((lo | (mi << 8) | (hi << 16)) << 8) >> 8;
}

export function createXrealHidAdapter({ log, onTracking }) {
  const ahrs = createMahonyState();
  ahrs.lastTsNs = 0n;
  ahrs.initialized = false;
  let firstDumpDone = false;
  let reportCount = 0;

  function resetAhrs() {
    ahrs.q0 = 1; ahrs.q1 = 0; ahrs.q2 = 0; ahrs.q3 = 0;
    ahrs.integralFBx = 0; ahrs.integralFBy = 0; ahrs.integralFBz = 0;
    ahrs.lastTsNs = 0n; ahrs.initialized = false;
  }

  function reset() {
    resetAhrs();
    firstDumpDone = false;
    reportCount = 0;
  }

  function parseReport(reportId, view) {
    if (reportId !== 0) {
      log(`XREAL: unexpected reportId=${reportId} – dropping`);
      return;
    }
    if (view.byteLength < 42) {
      log(`XREAL: report too short (${view.byteLength} bytes, need ≥42)`);
      return;
    }

    if (!firstDumpDone) {
      firstDumpDone = true;
      const end = Math.min(view.byteLength, 64);
      const hex = Array.from({ length: end }, (_, i) =>
        view.getUint8(i).toString(16).padStart(2, '0')).join(' ');
      log(`XREAL IMU first report: len=${view.byteLength} reportId=${reportId}`);
      log(`XREAL IMU dump[0..${end}): ${hex}`);
    }

    const sig0 = view.getUint8(0);
    const sig1 = view.getUint8(1);
    if (sig0 === 0xAA && sig1 === 0x53) {
      log('XREAL IMU: INIT packet (0xAA 0x53) received – resetting AHRS');
      resetAhrs();
      return;
    }
    if (sig0 !== 0x01 || sig1 !== 0x02) return;

    const tsLo = view.getUint32(4, true);
    const tsHi = view.getUint32(8, true);
    const timestampNs = (BigInt(tsHi) << 32n) | BigInt(tsLo);

    const velM = view.getInt16(12, true);
    const velD = view.getInt32(14, true);
    const velX = int24LE(view, 18);
    const velY = int24LE(view, 21);
    const velZ = int24LE(view, 24);
    const gyrX_dps = (velD !== 0) ? (velX * velM / velD) : 0;
    const gyrY_dps = (velD !== 0) ? (velY * velM / velD) : 0;
    const gyrZ_dps = (velD !== 0) ? (velZ * velM / velD) : 0;
    const gyrX = gyrX_dps * (Math.PI / 180);
    const gyrY = gyrY_dps * (Math.PI / 180);
    const gyrZ = gyrZ_dps * (Math.PI / 180);

    const accM = view.getInt16(27, true);
    const accD = view.getInt32(29, true);
    const accXr = int24LE(view, 33);
    const accYr = int24LE(view, 36);
    const accZr = int24LE(view, 39);
    const accX = (accD !== 0) ? (accXr * accM / accD) : 0;
    const accY = (accD !== 0) ? (accYr * accM / accD) : 0;
    const accZ = (accD !== 0) ? (accZr * accM / accD) : 0;

    let dt = 0.001;
    if (ahrs.initialized && timestampNs > ahrs.lastTsNs) {
      const dtRaw = Number(timestampNs - ahrs.lastTsNs) / 1e9;
      dt = (dtRaw > 0 && dtRaw < 0.1) ? dtRaw : 0.001;
    }
    ahrs.lastTsNs = timestampNs;
    ahrs.initialized = true;
    mahonyUpdate(ahrs, gyrX, gyrY, gyrZ, accX, accY, accZ, dt);

    const { q0, q1, q2, q3 } = ahrs;
    const qw = q0;
    const qx = -q1;
    const qy = q3;
    const qz = q2;
    const wVR_x = gyrX;
    const wVR_y = gyrZ;
    const wVR_z = -gyrY;

    reportCount++;
    if (reportCount <= 3 || reportCount % 300 === 0) {
      const norm = Math.sqrt(qw*qw + qx*qx + qy*qy + qz*qz);
      log(`XREAL IMU #${reportCount}: quat=(${qw.toFixed(4)},${qx.toFixed(4)},${qy.toFixed(4)},${qz.toFixed(4)}) norm=${norm.toFixed(4)}` +
          ` gyr_dps=(${gyrX_dps.toFixed(2)},${gyrY_dps.toFixed(2)},${gyrZ_dps.toFixed(2)})` +
          ` acc=(${accX.toFixed(3)},${accY.toFixed(3)},${accZ.toFixed(3)})` +
          ` dt=${dt.toFixed(4)}s`);
    }

    const nowMs = performance.now();
    onTracking({
      timestampNs: BigInt(Math.floor(nowMs * 1e6)),
      qw, qx, qy, qz,
      gyrX: wVR_x, gyrY: wVR_y, gyrZ: wVR_z,
      accX, accY, accZ,
    });
  }

  return { parseReport, reset };
}
