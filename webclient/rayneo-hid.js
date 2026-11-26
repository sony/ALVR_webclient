import { createMahonyState, mahonyUpdate } from './mahony.js';

export const RAYNEO_VID = 0x1BBB;

export const RAYNEO_HID_FILTERS = [
  { vendorId: RAYNEO_VID, usagePage: 0xFF00 },
  { vendorId: RAYNEO_VID, productId: 0xAF50 },
];

export function pickRayneoImuDevice(candidates) {
  return candidates.find(device =>
    device.vendorId === RAYNEO_VID &&
    device.collections.some(collection => collection.usagePage === 0xFF00)
  ) ?? null;
}

export function buildRayneoFrame(command, value = 0x00) {
  const frame = new Uint8Array(64);
  frame[0] = 0x66;
  frame[1] = command;
  frame[2] = value;
  return frame;
}

export async function sendRayneoImuOn(device, log) {
  try {
    await device.sendReport(0x00, buildRayneoFrame(0x01));
    log('RAYNEO IMU ON sent');
  } catch (err) {
    log(`RAYNEO IMU ON error: ${err.message}`);
  }
}

export async function sendRayneoImuOff(device, log) {
  try {
    await device.sendReport(0x00, buildRayneoFrame(0x02));
    log('RAYNEO IMU OFF sent');
  } catch (err) {
    log(`RAYNEO IMU OFF error: ${err.message}`);
  }
}

export function createRayneoHidAdapter({ log, onTracking }) {
  const ahrs = createMahonyState();
  ahrs.lastFrameMs = 0;
  let reportCount = 0;
  let firstReport = true;

  function reset() {
    ahrs.q0 = 1; ahrs.q1 = 0; ahrs.q2 = 0; ahrs.q3 = 0;
    ahrs.integralFBx = 0; ahrs.integralFBy = 0; ahrs.integralFBz = 0;
    ahrs.lastFrameMs = 0;
    reportCount = 0;
    firstReport = true;
  }

  function parseReport(reportId, view) {
    if (view.byteLength < 28) return;

    const magic = view.getUint8(0);
    const type = view.getUint8(1);
    if (magic !== 0x99 || type !== 0x65) return;

    if (firstReport) {
      firstReport = false;
      const end = Math.min(view.byteLength, 64);
      const hex = Array.from({ length: end }, (_, i) =>
        view.getUint8(i).toString(16).padStart(2, '0')).join(' ');
      log(`RAYNEO IMU first report: len=${view.byteLength} reportId=0x${reportId.toString(16)}`);
      log(`RAYNEO IMU dump[0..${end}): ${hex}`);
    }

    const accX = view.getFloat32(4, true);
    const accY = view.getFloat32(8, true);
    const accZ = view.getFloat32(12, true);
    const gyrXDps = view.getFloat32(16, true);
    const gyrYDps = view.getFloat32(20, true);
    const gyrZDps = view.getFloat32(24, true);

    if (!isFinite(accX) || !isFinite(accY) || !isFinite(accZ) ||
        !isFinite(gyrXDps) || !isFinite(gyrYDps) || !isFinite(gyrZDps)) return;

    const d2r = Math.PI / 180;
    const gyrX = gyrXDps * d2r;
    const gyrY = gyrYDps * d2r;
    const gyrZ = gyrZDps * d2r;
    const nowMs = performance.now();
    let dt = 1.0 / 60;
    if (ahrs.lastFrameMs !== 0) {
      const dtRaw = (nowMs - ahrs.lastFrameMs) * 1e-3;
      if (dtRaw > 0 && dtRaw < 0.1) dt = dtRaw;
    }
    ahrs.lastFrameMs = nowMs;

    mahonyUpdate(ahrs, -gyrX, gyrZ, gyrY, -accX, accZ, accY, dt);

    const { q0, q1, q2, q3 } = ahrs;
    const qw = q0;
    const qx = -q1;
    const qy = q3;
    const qz = q2;
    const wVR_x = gyrX;
    const wVR_y = gyrY;
    const wVR_z = -gyrZ;

    reportCount++;
    if (reportCount <= 3 || reportCount % 300 === 0) {
      const norm = Math.sqrt(qw*qw + qx*qx + qy*qy + qz*qz);
      log(`RAYNEO IMU #${reportCount}: quat=(${qw.toFixed(4)},${qx.toFixed(4)},${qy.toFixed(4)},${qz.toFixed(4)}) norm=${norm.toFixed(4)}` +
          ` gyr_dps=(${gyrXDps.toFixed(2)},${gyrYDps.toFixed(2)},${gyrZDps.toFixed(2)})` +
          ` acc=(${accX.toFixed(3)},${accY.toFixed(3)},${accZ.toFixed(3)})` +
          ` dt=${dt.toFixed(4)}s`);
    }

    onTracking({
      timestampNs: BigInt(Math.floor(nowMs * 1e6)),
      qw, qx, qy, qz,
      gyrX: wVR_x, gyrY: wVR_y, gyrZ: wVR_z,
      accX, accY, accZ,
    });
  }

  return { parseReport, reset };
}
