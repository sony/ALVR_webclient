package com.alvr.webclient;

import android.content.Context;
import android.hardware.usb.UsbConstants;
import android.hardware.usb.UsbDevice;
import android.hardware.usb.UsbDeviceConnection;
import android.hardware.usb.UsbEndpoint;
import android.hardware.usb.UsbInterface;
import android.hardware.usb.UsbManager;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.util.Log;
import android.webkit.WebView;

import com.google.gson.Gson;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Reads IMU data from the USB HID device and injects it directly into the
 * primary WebView's {@code window.alvrOnImu()} callback via
 * {@code evaluateJavascript()}.
 */
public class ImuRelayManager {

    private static final String TAG = "ImuRelayManager";

    private final Context       context;
    private final Handler       mainHandler = new Handler(Looper.getMainLooper());
    private final Gson          gson        = new Gson();
    private final AtomicBoolean running     = new AtomicBoolean(false);

    private WebView webView;   // Primary WebView running client.js

    private UsbDevice           usbDevice;
    private UsbDeviceConnection usbConnection;
    private XrGlassesDevice     deviceType;

    // All claimed HID interfaces (may be >1 for VITURE which has keyboard + MCU interfaces).
    // The first entry is the primary IMU interface; additional entries are for VITURE only.
    private final List<UsbInterface> claimedInterfaces = new ArrayList<>();
    // All interrupt IN endpoints collected across claimed interfaces — polled round-robin.
    private final List<UsbEndpoint>  allInEndpoints    = new ArrayList<>();
    // All interrupt OUT endpoints collected across claimed interfaces — command send targets.
    private final List<UsbEndpoint>  allOutEndpoints   = new ArrayList<>();

    // Stateful parsers (reset on each (re-)connection)
    private final XrealImuParser  xrealParser  = new XrealImuParser();
    private final VitureImuParser vitureParser = new VitureImuParser();
    private final RayneoImuParser rayneoParser = new RayneoImuParser();

    private PowerManager.WakeLock wakeLock;
    private Thread                relayThread;

    /** Guards the relay thread when streaming is paused (server disconnected). */
    private final Object  pauseLock = new Object();
    /** True while the polling loop should be suspended. Volatile for visibility. */
    private volatile boolean paused = false;

    public ImuRelayManager(Context context) {
        this.context = context.getApplicationContext();
        PowerManager pm = (PowerManager) this.context.getSystemService(Context.POWER_SERVICE);
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "AlvrWebClient:ImuWakeLock");
    }

    /**
     * Sets the primary WebView. IMU data will always be injected into this view.
     * May be called before or after startRelay().
     */
    public void setWebView(WebView webView) {
        this.webView = webView;
    }

    /**
     * Opens the USB device and starts IMU polling.
     * Does nothing if the relay is already running.
     */
    public void startRelay(UsbDevice device) {
        if (running.getAndSet(true)) return;
        this.usbDevice = device;
        if (!wakeLock.isHeld()) wakeLock.acquire(30 * 60 * 1000L); // max 30 min
        relayThread = new Thread(this::relayLoop, "imu-relay");
        relayThread.start();
    }

    /** Stops IMU polling and releases the USB connection. */
    public void stopRelay() {
        running.set(false);
        paused = false;  // Unblock the relay thread if it is waiting
        synchronized (pauseLock) { pauseLock.notifyAll(); }
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        // Call closeUsb() first to unblock bulkTransfer()
        // and allow the relay thread to exit promptly.
        closeUsb();
        Thread t = relayThread;
        relayThread = null;
        if (t != null) {
            t.interrupt();
            try {
                // Wait for the relay thread to exit completely.
                // closeUsb() unblocks bulkTransfer(), so the thread exits within
                // at most one polling timeout (~100 ms).
                // This prevents the old thread's finally block from incorrectly
                // disabling/closing the new thread's USB connection when
                // stopRelay() is immediately followed by startRelay().
                t.join(500);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        }
    }

    public boolean isRunning() { return running.get(); }

    /** Returns the name of the currently relayed UsbDevice, or null if disconnected. */
    public String getDeviceName() {
        UsbDevice d = usbDevice;
        return d != null ? d.getDeviceName() : null;
    }

    /**
     * Pauses HID polling until {@link #resumeStreaming()} is called.
     *
     * Called by {@code AlvrClientBridge.onServerDisconnect()} (via JavascriptInterface)
     * when the ALVR server tracking WebSocket closes.  The relay thread blocks in
     * {@code pauseLock.wait()} after the current {@code bulkTransfer()} call returns,
     * so the actual pause takes at most one poll-timeout period (≤ 100 ms).
     *
     * A device-specific stop command is sent so the HID device stops transmitting USB
     * packets, reducing USB bus traffic while paused.
     *
     * Safe to call from any thread (including the JavascriptInterface thread).
     */
    public void pauseStreaming() {
        if (!running.get() || paused) return;  // Not running or already paused
        Log.i(TAG, "Streaming paused (server disconnected)");
        paused = true;
        // Send device stop command from this thread.  bulkTransfer() on the OUT endpoint
        // and on the IN endpoint (relay thread) can proceed concurrently — they target
        // different endpoints of the same UsbDeviceConnection, which is thread-safe.
        if (deviceType != null) {
            if (deviceType.family == XrGlassesDevice.DeviceFamily.VITURE) {
                sendVitureImu(false);
            } else if (deviceType.family == XrGlassesDevice.DeviceFamily.VITURE_PRO_2) {
                sendViturePro2Imu(false);
            } else if (deviceType.family == XrGlassesDevice.DeviceFamily.XREAL) {
                sendXrealImuStop();
            } else if (deviceType.family == XrGlassesDevice.DeviceFamily.RAYNEO) {
                sendRayneoImuStop();
            }
        }
    }

    /**
     * Resumes HID polling after a previous {@link #pauseStreaming()} call.
     *
     * Called by {@code AlvrClientBridge.onServerConnect()} when the ALVR server tracking
     * WebSocket opens.  The device start command is sent first so data arrives without a
     * gap once the relay thread unblocks.
     *
     * Safe to call from any thread.
     */
    public void resumeStreaming() {
        if (!running.get() || !paused) return;  // Not running or already streaming
        Log.i(TAG, "Streaming resumed (server connected)");
        if (deviceType != null) {
            if (deviceType.family == XrGlassesDevice.DeviceFamily.VITURE) {
                sendVitureImu(true);
            } else if (deviceType.family == XrGlassesDevice.DeviceFamily.VITURE_PRO_2) {
                vitureParser.resetPro2();
                sendViturePro2Imu(true);
            } else if (deviceType.family == XrGlassesDevice.DeviceFamily.XREAL) {
                xrealParser.reset();
                sendXrealImuStart();
            } else if (deviceType.family == XrGlassesDevice.DeviceFamily.RAYNEO) {
                rayneoParser.reset();
                sendRayneoImuStart();
            }
        }
        paused = false;
        synchronized (pauseLock) { pauseLock.notifyAll(); }
    }

    // -----------------------------------------------------------------------
    // Relay loop
    // -----------------------------------------------------------------------

    private void relayLoop() {
        try {
            // 1. Identify device type
            deviceType = XrGlassesDevice.fromUsbIds(
                    usbDevice.getVendorId(), usbDevice.getProductId());
            if (deviceType == null) {
                Log.e(TAG, "Unsupported device VID=" + usbDevice.getVendorId());
                running.set(false);
                return;
            }
            Log.i(TAG, "IMU device: " + deviceType.name());

            // 2. Open USB device
            if (!openUsb()) {
                Log.e(TAG, "Failed to open USB device");
                running.set(false);
                return;
            }

            // 3. Device-specific initialisation
            if (deviceType.family == XrGlassesDevice.DeviceFamily.VITURE) {
                sendVitureImu(true);
            } else if (deviceType.family == XrGlassesDevice.DeviceFamily.VITURE_PRO_2) {
                vitureParser.resetPro2();
                sendViturePro2Imu(true);
            } else if (deviceType.family == XrGlassesDevice.DeviceFamily.XREAL) {
                xrealParser.reset();
                sendXrealImuStart();
            } else if (deviceType.family == XrGlassesDevice.DeviceFamily.RAYNEO) {
                rayneoParser.reset();
                sendRayneoImuStart();
            }

            // 4. Polling loop
            // Poll all discovered IN endpoints round-robin.
            // For XREAL there is exactly one; for VITURE there may be two (keyboard/media
            // interface + MCU interface). WebHID registers inputreport listeners on ALL
            // collections, so we mirror that by polling all claimed IN endpoints.

            // Size the shared read buffer to the largest endpoint maxPacketSize so that
            // bulkTransfer() never returns -1 due to buffer overflow.  XREAL Air 2 Ultra
            // has maxPacketSize=512 on its IMU interrupt endpoint; using a 64-byte buffer
            // against a 512-byte endpoint causes every transfer to fail with result=-1.
            int maxPktSize = 64;
            for (UsbEndpoint inEp : allInEndpoints) {
                if (inEp.getMaxPacketSize() > maxPktSize) maxPktSize = inEp.getMaxPacketSize();
            }
            byte[] buf = new byte[maxPktSize];

            // Use a short per-endpoint timeout so that cycling through multiple endpoints
            // does not introduce excessive latency. Total latency ≤ perTimeout × endpoint_count.
            int perTimeout;
            if (deviceType.family == XrGlassesDevice.DeviceFamily.XREAL) {
                perTimeout = XrGlassesDevice.XREAL_POLL_TIMEOUT_MS;
            } else if (deviceType.family == XrGlassesDevice.DeviceFamily.RAYNEO) {
                perTimeout = XrGlassesDevice.RAYNEO_POLL_TIMEOUT_MS;
            } else {
                perTimeout = XrGlassesDevice.VITURE_POLL_TIMEOUT_MS;
            }

            int epCount = allInEndpoints.size();

            long packetCount   = 0;
            long noDataCount   = 0;
            long lastLogTimeMs = System.currentTimeMillis();
            int  epIdx           = 0;  // current endpoint index for round-robin
            long pro2InvalidCount = 0;
            boolean pro2RawLogged = false;

            while (running.get()) {
                // Block here while the server is disconnected (pauseStreaming() was called).
                // The relay thread sleeps until resumeStreaming() / stopRelay() notifies it.
                if (paused) {
                    synchronized (pauseLock) {
                        try {
                            while (paused && running.get()) {
                                pauseLock.wait();
                            }
                        } catch (InterruptedException e) {
                            Thread.currentThread().interrupt();
                            break;
                        }
                    }
                    if (!running.get()) break;
                }

                UsbEndpoint ep = allInEndpoints.get(epIdx);
                epIdx = (epIdx + 1) % epCount;

                // UsbDeviceConnection has no interruptTransfer(); bulkTransfer() works
                // for both Bulk and Interrupt endpoints on Android.
                int transferred = usbConnection.bulkTransfer(ep, buf, buf.length, perTimeout);

                if (transferred <= 0) {
                    noDataCount++;
                    // Log every ~3 seconds of silence across all endpoints to aid diagnosis
                    long nowMs = System.currentTimeMillis();
                    if (noDataCount == 1 || (nowMs - lastLogTimeMs >= 3000 && packetCount == 0)) {
                        lastLogTimeMs = nowMs;
                        Log.w(TAG, "No USB data yet: bulkTransfer returned " + transferred
                                + " (noDataCount=" + noDataCount
                                + " ep=0x" + Integer.toHexString(ep.getAddress()) + ")");
                    }
                    continue;
                }
                noDataCount = 0;  // reset silence counter on successful read

                ImuPacket packet;
                if (deviceType.family == XrGlassesDevice.DeviceFamily.XREAL) {
                    packet = xrealParser.parse(buf, transferred);
                } else if (deviceType.family == XrGlassesDevice.DeviceFamily.RAYNEO) {
                    packet = rayneoParser.parse(buf, transferred);
                } else if (deviceType.family == XrGlassesDevice.DeviceFamily.VITURE_PRO_2) {
                    VitureImuParser.Pro2ParseResult result = vitureParser.parsePro2(buf, transferred);
                    if (result.type == VitureImuParser.Pro2PacketType.POSE) {
                        packet = result.packet;
                    } else if (result.type == VitureImuParser.Pro2PacketType.ACK) {
                        if (result.status == 0) {
                            Log.i(TAG, "VITURE Pro 2 IMU control ACK received");
                        } else {
                            Log.e(TAG, "VITURE Pro 2 IMU control rejected: status=0x"
                                    + Integer.toHexString(result.status));
                        }
                        continue;
                    } else if (result.type == VitureImuParser.Pro2PacketType.INVALID) {
                        pro2InvalidCount++;
                        if (pro2InvalidCount == 1 || pro2InvalidCount % 300 == 0) {
                            Log.w(TAG, "VITURE Pro 2 invalid report #" + pro2InvalidCount
                                    + ": " + result.error);
                        }
                        continue;
                    } else {
                        if (result.messageId == 0x7309 && !pro2RawLogged) {
                            pro2RawLogged = true;
                            Log.i(TAG, "VITURE Pro 2 raw IMU event ignored (pose stream requested)");
                        }
                        continue;
                    }
                } else {
                    packet = vitureParser.parse(buf, transferred);
                }

                if (packet == null) {
                    continue;
                }

                packetCount++;
                injectImuPacket(packet);
            }

        } catch (Exception e) {
            Log.e(TAG, "Relay loop error", e);
        } finally {
            if (deviceType != null) {
                if (deviceType.family == XrGlassesDevice.DeviceFamily.VITURE) {
                    sendVitureImu(false);
                } else if (deviceType.family == XrGlassesDevice.DeviceFamily.VITURE_PRO_2) {
                    sendViturePro2Imu(false);
                } else if (deviceType.family == XrGlassesDevice.DeviceFamily.XREAL) {
                    sendXrealImuStop();
                } else if (deviceType.family == XrGlassesDevice.DeviceFamily.RAYNEO) {
                    sendRayneoImuStop();
                }
            }
            closeUsb();
            running.set(false);
            Log.i(TAG, "IMU relay stopped");
        }
    }

    /**
     * Serialises an IMU packet to JSON and injects it into the primary WebView
     * via {@code window.alvrOnImu()}. Must run on the main thread, so it posts via Handler.
     */
    private void injectImuPacket(ImuPacket pkt) {
        // ImuPacket has only public final fields, so Gson can serialise it directly.
        String json = gson.toJson(pkt);
        mainHandler.post(() -> {
            WebView wv = webView;
            if (wv != null) {
                wv.evaluateJavascript(
                        "window.alvrOnImu && window.alvrOnImu(" + json + ")", null);
            }
        });
    }

    // -----------------------------------------------------------------------
    // USB helpers
    // -----------------------------------------------------------------------

    /**
     * Opens the USB device and discovers all HID interfaces to claim.
     */
    private boolean openUsb() {
        UsbManager usbManager = (UsbManager) context.getSystemService(Context.USB_SERVICE);

        // Clear state from any previous call
        claimedInterfaces.clear();
        allInEndpoints.clear();
        allOutEndpoints.clear();

        int ifCount = usbDevice.getInterfaceCount();

        // --- Find all HID-class interfaces that carry IMU-sized interrupt IN reports ---
        // USB HID class = 0x03 (UsbConstants.USB_CLASS_HID).
        //
        // Require maxPacketSize >= MIN_IMU_PKT_SIZE (64 bytes) on the IN endpoint:
        //   • IMU reports from XREAL are 64 bytes; the Consumer Control interface (pkt=3)
        //     is excluded by this threshold.
        //   • VITURE IMU reports are 64 bytes; keyboard/media interfaces (pkt<64) excluded.
        final int MIN_IMU_PKT_SIZE = 64;
        List<UsbInterface> hidCandidates = new ArrayList<>();
        for (int i = 0; i < ifCount; i++) {
            UsbInterface iface = usbDevice.getInterface(i);
            if (iface.getInterfaceClass() != UsbConstants.USB_CLASS_HID) continue;
            boolean hasLargeInterruptIn = false;
            for (int j = 0; j < iface.getEndpointCount(); j++) {
                UsbEndpoint ep = iface.getEndpoint(j);
                if (ep.getType()      == UsbConstants.USB_ENDPOINT_XFER_INT
                 && ep.getDirection() == UsbConstants.USB_DIR_IN
                 && ep.getMaxPacketSize() >= MIN_IMU_PKT_SIZE) {
                    hasLargeInterruptIn = true;
                    break;
                }
            }
            if (hasLargeInterruptIn) hidCandidates.add(iface);
        }

        if (hidCandidates.isEmpty()) {
            Log.e(TAG, "No HID interface with large interrupt IN found — cannot proceed");
            return false;
        }

        // --- Select which interfaces to use ---
        List<UsbInterface> selected = new ArrayList<>();
        if (deviceType.family == XrGlassesDevice.DeviceFamily.XREAL) {
            selected.add(hidCandidates.get(hidCandidates.size() - 1));
        } else if (deviceType.family == XrGlassesDevice.DeviceFamily.VITURE_PRO_2) {
            if (hidCandidates.size() != 1) {
                Log.e(TAG, "VITURE Pro 2 requires exactly one HID IMU interface; found "
                        + hidCandidates.size());
                return false;
            }
            selected.add(hidCandidates.get(0));
        } else {
            selected.addAll(hidCandidates);
        }

        // --- Open the USB connection ---
        UsbDeviceConnection conn = usbManager.openDevice(usbDevice);
        if (conn == null) {
            Log.e(TAG, "Failed to open USB connection (permission denied?)");
            return false;
        }
        // If stopRelay() is called concurrently, close the connection and abort.
        // stopRelay() has not set usbConnection to null yet, so detect the stop
        // through the running flag.
        if (!running.get()) {
            conn.close();
            return false;
        }
        // Store this in an instance variable so closeUsb() / stopRelay()
        // can close it externally.
        usbConnection = conn;

        // --- Claim selected interfaces and collect endpoints ---
        // Use the local variable conn to avoid an NPE if stopRelay() sets
        // usbConnection to null while the loop is running.
        for (UsbInterface iface : selected) {
            if (!conn.claimInterface(iface, /* force= */ true)) {
                Log.w(TAG, "Failed to claim interface class=0x"
                        + Integer.toHexString(iface.getInterfaceClass()));
                // Non-fatal for VITURE (we may still get data on another interface)
                continue;
            }
            claimedInterfaces.add(iface);
            Log.d(TAG, "Claimed IF class=0x" + Integer.toHexString(iface.getInterfaceClass())
                    + " ep_count=" + iface.getEndpointCount());

            for (int j = 0; j < iface.getEndpointCount(); j++) {
                UsbEndpoint ep = iface.getEndpoint(j);
                if (ep.getType() != UsbConstants.USB_ENDPOINT_XFER_INT) continue;
                if (ep.getDirection() == UsbConstants.USB_DIR_IN) {
                    allInEndpoints.add(ep);
                    Log.d(TAG, "  IN  endpoint addr=0x" + Integer.toHexString(ep.getAddress())
                            + " pkt=" + ep.getMaxPacketSize());
                } else {
                    allOutEndpoints.add(ep);
                    Log.d(TAG, "  OUT endpoint addr=0x" + Integer.toHexString(ep.getAddress())
                            + " pkt=" + ep.getMaxPacketSize());
                }
            }
        }

        if (claimedInterfaces.isEmpty()) {
            Log.e(TAG, "All interface claims failed");
            conn.close();
            if (usbConnection == conn) usbConnection = null;
            return false;
        }
        if (allInEndpoints.isEmpty()) {
            Log.e(TAG, "No interrupt IN endpoint on any claimed interface");
            closeUsb();
            return false;
        }
        if (deviceType.family == XrGlassesDevice.DeviceFamily.VITURE_PRO_2
                && (allInEndpoints.size() != 1 || allOutEndpoints.size() != 1)) {
            Log.e(TAG, "VITURE Pro 2 requires one interrupt IN and one interrupt OUT endpoint; found "
                    + allInEndpoints.size() + " IN and " + allOutEndpoints.size() + " OUT");
            closeUsb();
            return false;
        }

        Log.d(TAG, "Ready: " + claimedInterfaces.size() + " interface(s) claimed, "
                + allInEndpoints.size() + " IN endpoint(s), "
                + allOutEndpoints.size() + " OUT endpoint(s)");
        return true;
    }

    private void closeUsb() {
        if (usbConnection != null) {
            for (UsbInterface iface : claimedInterfaces) {
                usbConnection.releaseInterface(iface);
            }
            usbConnection.close();
            usbConnection = null;
        }
        claimedInterfaces.clear();
        allInEndpoints.clear();
        allOutEndpoints.clear();
    }

    /**
     * Sends the VITURE IMU enable/disable command to ALL claimed HID OUT endpoints,
     * with the HID report ID byte prepended (matching Windows HidD_SetOutputReport format).
     */
    private void sendVitureImu(boolean enable) {
        if (usbConnection == null) return;
        byte[] cmd = enable ? VitureCommandBuilder.imuEnable() : VitureCommandBuilder.imuDisable();
        String label = enable ? "enable" : "disable";

        // The HID Report Descriptor defines a 64-byte output report with NO Report ID.
        // Windows HidD_SetOutputReport strips the report ID byte before the USB transfer,
        // so the wire format is exactly 64 bytes: cmd bytes at offset 0, zero-padded.
        // Sending fewer than 64 bytes results in a short packet that the MCU firmware
        // discards (it reads a fixed 64-byte frame from the USB HID stack).
        final int VITURE_OUT_REPORT_SIZE = 64;
        byte[] wireCmd = new byte[VITURE_OUT_REPORT_SIZE];  // Java zero-initialises
        System.arraycopy(cmd, 0, wireCmd, 0, cmd.length);

        if (!allOutEndpoints.isEmpty()) {
            // Send to ALL out endpoints — Chrome calls sendReport() on BOTH the primary
            // (IF[0], ep=0x01) and secondary (IF[1], ep=0x02) HIDDevice objects.
            // IF[0] receiving the command triggers IMU streaming on ep=0x81.
            // IF[1] receiving the command generates the ACK on ep=0x82.
            for (UsbEndpoint ep : allOutEndpoints) {
                int result = usbConnection.bulkTransfer(
                        ep, wireCmd, wireCmd.length, XrGlassesDevice.USB_CTRL_TIMEOUT_MS);
                Log.d(TAG, "VITURE IMU " + label + " -> OUT 0x"
                        + Integer.toHexString(ep.getAddress()) + " result=" + result);
            }
        } else {
            // Fallback: HID SET_REPORT control transfer on the last claimed interface.
            // EP0 SET_REPORT does not require the report ID prefix (it is passed in wValue).
            if (claimedInterfaces.isEmpty()) return;
            int ifNum = claimedInterfaces.get(claimedInterfaces.size() - 1).getId();
            int bmRequestType = XrGlassesDevice.USB_DIR_OUT
                    | XrGlassesDevice.USB_TYPE_CLASS
                    | XrGlassesDevice.USB_RECIP_INTERFACE;
            int result = usbConnection.controlTransfer(
                    bmRequestType,
                    XrGlassesDevice.USB_HID_SET_REPORT,
                    XrGlassesDevice.USB_HID_REPORT_TYPE_OUTPUT,
                    ifNum,
                    wireCmd, wireCmd.length,
                    XrGlassesDevice.USB_CTRL_TIMEOUT_MS);
            Log.d(TAG, "VITURE IMU " + label + " via EP0 SET_REPORT IF" + ifNum + " result=" + result);
        }
    }

    /** Sends the short, unpadded V2 control frame to the VITURE Pro 2 interrupt OUT endpoint. */
    private void sendViturePro2Imu(boolean enable) {
        if (usbConnection == null) return;
        if (allOutEndpoints.size() != 1) {
            Log.e(TAG, "VITURE Pro 2 command unavailable: expected one interrupt OUT endpoint");
            return;
        }

        byte[] frame = enable
                ? VitureCommandBuilder.pro2ImuEnable()
                : VitureCommandBuilder.pro2ImuDisable();
        UsbEndpoint endpoint = allOutEndpoints.get(0);
        int result = usbConnection.bulkTransfer(
                endpoint, frame, frame.length, XrGlassesDevice.USB_CTRL_TIMEOUT_MS);
        if (result != frame.length) {
            Log.e(TAG, "VITURE Pro 2 IMU " + (enable ? "start" : "stop")
                    + " command failed: wrote " + result + " of " + frame.length + " bytes");
        } else {
            Log.i(TAG, "VITURE Pro 2 IMU " + (enable ? "pose stream started" : "stream stopped"));
        }
    }

    /**
     * Sends the START_IMU_DATA command (msgid=0x19, signal=0x01) to the XREAL device.
     *
     * Without this command the IMU is completely silent; it does NOT auto-stream.
     * The packet is built by XrealCommandBuilder with CRC32 authentication.
     *
     * Sent as a HID SET_REPORT control transfer to XREAL_IMU_INTERFACE (interface 3).
     * If controlTransfer() returns a negative result, the implementation also attempts
     * delivery via a bulk/interrupt OUT endpoint as a fallback (not yet wired up here;
     * add if the control transfer fails on a specific firmware version).
     */
    private void sendXrealImuStart() {
        if (usbConnection == null) return;
        byte[] cmd = XrealCommandBuilder.startImuData();
        int result = sendXrealCmd(cmd);
        Log.d(TAG, "XREAL IMU START -> result=" + result);
    }

    /**
     * Sends the STOP_IMU_DATA command (msgid=0x19, signal=0x00) to the XREAL device.
     * Called in the finally block to cleanly stop streaming on disconnect.
     */
    private void sendXrealImuStop() {
        if (usbConnection == null) return;
        byte[] cmd = XrealCommandBuilder.stopImuData();
        int result = sendXrealCmd(cmd);
        Log.d(TAG, "XREAL IMU STOP cmd -> result=" + result);
    }

    /**
     * Sends an XREAL control command via the interrupt OUT endpoint.
     * Falls back to HID SET_REPORT control transfer if no OUT endpoint was found.
     */

    private int sendXrealCmd(byte[] cmd) {
        if (!allOutEndpoints.isEmpty()) {
            return usbConnection.bulkTransfer(
                    allOutEndpoints.get(0), cmd, cmd.length,
                    XrGlassesDevice.USB_CTRL_TIMEOUT_MS);
        }
        // Fallback: HID SET_REPORT control transfer
        if (claimedInterfaces.isEmpty()) return -1;
        int bmRequestType = XrGlassesDevice.USB_DIR_OUT
                | XrGlassesDevice.USB_TYPE_CLASS
                | XrGlassesDevice.USB_RECIP_INTERFACE;
        return usbConnection.controlTransfer(
                bmRequestType,
                XrGlassesDevice.USB_HID_SET_REPORT,
                XrGlassesDevice.USB_HID_REPORT_TYPE_OUTPUT,
                claimedInterfaces.get(0).getId(),
                cmd, cmd.length,
                XrGlassesDevice.USB_CTRL_TIMEOUT_MS);
    }

    // -----------------------------------------------------------------------
    // RayNeo command helpers
    // -----------------------------------------------------------------------

    /** Sends the FXR IMU-ON command to start IMU streaming from the RayNeo device. */
    private void sendRayneoImuStart() {
        if (usbConnection == null) return;
        sendRayneoCommand(RayneoCommandBuilder.buildImuOn());
        Log.d(TAG, "RAYNEO IMU ON sent");
    }

    /** Sends the FXR IMU-OFF command to stop IMU streaming. */
    private void sendRayneoImuStop() {
        if (usbConnection == null) return;
        sendRayneoCommand(RayneoCommandBuilder.buildImuOff());
        Log.d(TAG, "RAYNEO IMU OFF sent");
    }

    /**
     * Sends a 64-byte RayNeo FXR command via the interrupt OUT endpoint.
     * Falls back to HID SET_REPORT control transfer if no OUT endpoint was found.
     */
    private void sendRayneoCommand(byte[] cmd) {
        if (usbConnection == null) return;
        if (!allOutEndpoints.isEmpty()) {
            int result = usbConnection.bulkTransfer(
                    allOutEndpoints.get(0), cmd, cmd.length,
                    XrGlassesDevice.USB_CTRL_TIMEOUT_MS);
            Log.d(TAG, "RAYNEO cmd -> OUT 0x"
                    + Integer.toHexString(allOutEndpoints.get(0).getAddress())
                    + " result=" + result);
            return;
        }
        // Fallback: HID SET_REPORT control transfer (EP0)
        if (claimedInterfaces.isEmpty()) return;
        int bmRequestType = XrGlassesDevice.USB_DIR_OUT
                | XrGlassesDevice.USB_TYPE_CLASS
                | XrGlassesDevice.USB_RECIP_INTERFACE;
        int result = usbConnection.controlTransfer(
                bmRequestType,
                XrGlassesDevice.USB_HID_SET_REPORT,
                XrGlassesDevice.USB_HID_REPORT_TYPE_OUTPUT,
                claimedInterfaces.get(0).getId(),
                cmd, cmd.length,
                XrGlassesDevice.USB_CTRL_TIMEOUT_MS);
        Log.d(TAG, "RAYNEO cmd via EP0 SET_REPORT result=" + result);
    }
}
