export const SONY_VID = 0x054C;
const DS_PID = 0x0CE6;
const DS_EDGE_PID = 0x0DF2;

export const DS_HID_FILTERS = [
  { vendorId: SONY_VID, productId: DS_PID },
  { vendorId: SONY_VID, productId: DS_EDGE_PID },
];

const DS_USB_REPORT_SIZE = 63;
const DS_BT_REPORT_SIZE = 77;
const DS_IMU_OFFSET = { gyroPitch: 15, gyroYaw: 17, gyroRoll: 19, motionTimeStamp: 27 };
const DS_GYRO_DEFAULT_SCALE = (2000 / 32768) * Math.PI / 180;

const crc32Table = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let crc = i;
    for (let j = 0; j < 8; j++) crc = (crc & 1) ? (0xEDB88320 ^ (crc >>> 1)) : (crc >>> 1);
    table[i] = crc >>> 0;
  }
  return table;
})();

function dsCrc32(prefix, data) {
  let crc = 0xFFFFFFFF;
  for (const b of prefix) crc = (crc >>> 8) ^ crc32Table[(crc ^ b) & 0xFF];
  for (let i = 0; i < data.length; i++) crc = (crc >>> 8) ^ crc32Table[(crc ^ data[i]) & 0xFF];
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function parseDsGyroCalibration(data) {
  if (!data || data.byteLength < 23 || data.getUint8(0) !== 0x05) return null;
  const s16 = offset => data.getInt16(offset, true);
  const bias = [s16(1), s16(3), s16(5)];
  const plus = [s16(7), s16(11), s16(15)];
  const minus = [s16(9), s16(13), s16(17)];
  const speed2x = s16(19) + s16(21);
  const scale = [];
  for (let i = 0; i < 3; i++) {
    const denom = Math.abs(plus[i] - bias[i]) + Math.abs(minus[i] - bias[i]);
    if (denom === 0 || speed2x <= 0) return null;
    const degPerLsb = speed2x / denom;
    if (!(degPerLsb > 0.01 && degPerLsb < 0.5) || Math.abs(bias[i]) > 2000) return null;
    scale.push(degPerLsb * Math.PI / 180);
  }
  return { bias, scale };
}

function detectDsConnectionType(device) {
  for (const collection of device.collections) {
    if (collection.usagePage !== 0x0001 || collection.usage !== 0x0005) continue;
    const maxBits = collection.inputReports.reduce((max, report) =>
      Math.max(max, report.items.reduce((sum, item) => sum + item.reportSize * item.reportCount, 0)), 0);
    if (maxBits === 504) return 'usb';
    if (maxBits === 616) return 'bluetooth';
  }
  return 'usb';
}

function parseDsImu(data, shift) {
  return {
    gx: data.getInt16(DS_IMU_OFFSET.gyroPitch + shift, true),
    gy: data.getInt16(DS_IMU_OFFSET.gyroYaw + shift, true),
    gz: data.getInt16(DS_IMU_OFFSET.gyroRoll + shift, true),
    ts: data.getUint32(DS_IMU_OFFSET.motionTimeStamp + shift, true),
  };
}

function parseDsTouchPoints(data, offset) {
  function parseOne(position) {
    const b0 = data.getUint8(position);
    const b1 = data.getUint8(position + 1);
    const b2 = data.getUint8(position + 2);
    const b3 = data.getUint8(position + 3);
    return {
      active: !(b0 & 0x80),
      id: b0 & 0x7F,
      x: ((b2 & 0x0F) << 8) | b1,
      y: (b3 << 4) | ((b2 & 0xF0) >> 4),
    };
  }
  return { t0: parseOne(offset), t1: parseOne(offset + 4) };
}

export function createDualSenseHid({
  isNativeApp,
  log,
  logDebug,
  onInput,
  onConnectionChange,
  onCalibration,
  onDisconnected,
  showDsStatus,
}) {
  let device = null;
  let connectionType = null;
  let outputSeq = 0;
  let outputTimer = null;
  let outputReportCount = 0;
  const seenReports = new Set();

  async function sendBtOutputReport() {
    if (!device || connectionType !== 'bluetooth') return;
    try {
      const data = new Uint8Array(77);
      data[0] = (outputSeq & 0xF) << 4;
      outputSeq = (outputSeq + 1) & 0xF;
      data[1] = 0x10;
      data[2] = 0xFF;
      data[3] = 0xF7;
      const crc = dsCrc32([0xa2, 0x31], data.subarray(0, 73));
      data[73] = crc & 0xFF;
      data[74] = (crc >>> 8) & 0xFF;
      data[75] = (crc >>> 16) & 0xFF;
      data[76] = (crc >>> 24) & 0xFF;
      await device.sendReport(0x31, data);
      outputReportCount++;
      if (outputReportCount === 1 || outputReportCount === 4) {
        logDebug(`[DS diag] BT output report sent OK (count=${outputReportCount}) crc=0x${crc.toString(16).padStart(8, '0')}`);
      }
    } catch (err) {
      logDebug(`[DS diag] BT output report FAILED: ${err.message}`);
    }
  }

  async function loadGyroCalibration(controller) {
    let calibration = null;
    try {
      calibration = parseDsGyroCalibration(await controller.receiveFeatureReport(0x05));
    } catch (err) {
      logDebug(`[DS gyro] receiveFeatureReport(0x05) failed: ${err.message}`);
    }
    if (!calibration) {
      log('[DualSense] Gyro calibration unavailable – using default scale');
      return { bias: [0, 0, 0], scale: [DS_GYRO_DEFAULT_SCALE, DS_GYRO_DEFAULT_SCALE, DS_GYRO_DEFAULT_SCALE] };
    }
    logDebug(`[DS gyro] calibration bias=${calibration.bias.join(',')} ` +
             `scale(°/s/LSB)=${calibration.scale.map(v => (v * 180 / Math.PI).toFixed(4)).join(',')}`);
    return calibration;
  }

  function emitInput(data, shift) {
    const stickOffset = shift;
    const btnOffset = shift;
    const touchOffset = 32 + shift;
    onInput({
      stickLX: data.getUint8(stickOffset),
      stickLY: data.getUint8(stickOffset + 1),
      stickRX: data.getUint8(stickOffset + 2),
      stickRY: data.getUint8(stickOffset + 3),
      trigL: data.getUint8(stickOffset + 4),
      trigR: data.getUint8(stickOffset + 5),
      btn0: data.getUint8(7 + btnOffset),
      btn1: data.getUint8(8 + btnOffset),
      btn2: data.getUint8(9 + btnOffset),
      touchPoints: parseDsTouchPoints(data, touchOffset),
      imu: parseDsImu(data, shift),
    });
  }

  function onInputReport(event) {
    const { reportId, data } = event;
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const key = `${reportId}:${view.byteLength}`;
    if (!seenReports.has(key)) {
      seenReports.add(key);
      const raw = Array.from({ length: Math.min(16, view.byteLength) },
        (_, i) => view.getUint8(i).toString(16).padStart(2, '0')).join(' ');
      logDebug(`[DS diag] NEW report id=0x${reportId.toString(16).padStart(2, '0')} size=${view.byteLength}` +
          ` connType=${connectionType} outputSent=${outputReportCount} raw[0..15]: ${raw}`);
    }

    if (connectionType === 'usb' && reportId === 0x01) {
      if (view.byteLength < DS_USB_REPORT_SIZE) {
        logDebug(`[DS diag] USB report too short: ${view.byteLength} < ${DS_USB_REPORT_SIZE}`);
        return;
      }
      emitInput(view, 0);
    } else if (connectionType === 'bluetooth' && reportId === 0x31) {
      if (view.byteLength < DS_BT_REPORT_SIZE) {
        logDebug(`[DS diag] BT full report too short: ${view.byteLength} < ${DS_BT_REPORT_SIZE}`);
        return;
      }
      emitInput(view, 1);
    } else {
      logDebug(`[DS diag] unhandled report id=0x${reportId.toString(16).padStart(2, '0')} size=${view.byteLength} connType=${connectionType}`);
    }
  }

  async function tryConnect() {
    if (isNativeApp) return false;
    if (device) return true;
    try {
      const devices = await navigator.hid.getDevices();
      const controller = devices.find(candidate =>
        candidate.vendorId === SONY_VID &&
        (candidate.productId === DS_PID || candidate.productId === DS_EDGE_PID)
      );
      if (!controller) return false;

      await controller.open();
      device = controller;
      connectionType = detectDsConnectionType(controller);
      log(`DualSense HID opened: ${controller.productName} (${connectionType})`);
      showDsStatus(`Connected (${connectionType})`);
      onConnectionChange(connectionType);

      const calibration = await loadGyroCalibration(controller);
      onCalibration(calibration);

      if (connectionType === 'bluetooth') {
        await sendBtOutputReport();
        outputTimer = setInterval(sendBtOutputReport, 250);
      }

      controller.addEventListener('inputreport', onInputReport);
      onConnectionChange(connectionType);
      return true;
    } catch (err) {
      log(`DualSense HID error: ${err.message}`);
      return false;
    }
  }

  async function requestDevice() {
    try {
      const devices = await navigator.hid.requestDevice({ filters: DS_HID_FILTERS });
      if (devices.length > 0) await tryConnect();
    } catch (err) {
      log(`DualSense request failed: ${err.message}`);
    }
  }

  async function close() {
    if (isNativeApp || !device) return;
    if (outputTimer !== null) { clearInterval(outputTimer); outputTimer = null; }
    device.removeEventListener('inputreport', onInputReport);
    await device.close().catch(() => {});
    device = null;
    connectionType = null;
    outputSeq = 0;
    outputReportCount = 0;
    onCalibration(null);
    onConnectionChange(null);
    onDisconnected();
    log('DualSense HID closed');
    showDsStatus('–');
  }

  return {
    tryConnect,
    requestDevice,
    close,
    isConnected: () => device !== null,
  };
}
