# ALVR Web Client

## 1. Overview

This repository is a fork of [ALVR](https://github.com/alvr-org/ALVR), with the extenstion to provide a web application for streaming video and audio from SteamVR-compatible PC VR applications to a laptop PC or Android device. You can remotely control SteamVR-compatible PC VR applications using XR Glasses and a DualSense controller. The QUIC (HTTP/3) protocol enables low-latency communication, even over mobile networks.

## 2. Requirements

### 2.1 ALVR Streamer

- Desktop PC
  - Windows 11
  - NVIDIA RTX 3060 GPU or higher recommended

### 2.2 ALVR Web Client

- Laptop PC
  - Windows 11, macOS, or Linux
  - Chrome browser
- Android device
  - Android 13 or later
  - Android app (see below)

### 2.3 XR Glasses

| Brand | Models |
|---|---|
| VITURE | VITURE One, VITURE PRO, VITURE PRO 2 |
| XREAL | XREAL Air 2, XREAL Air 2 Pro, XREAL Air 2 Ultra |
| RayNeo | RayNeo Air 3s, RayNeo Air 4 Pro |

### 2.4 Controller

- DualSense controller (compatible with DualShock 4 controller)

### 2.5 Network

- If using the client over the internet, protect your connection with a VPN (Tailscale recommended).

## 3. Usage

### 3.1 ALVR Streamer

#### Prerequisites

- Install Virtual Audio Cable (VAC) by following the official ALVR instructions:
  - [Microphone setup on Windows](https://github.com/alvr-org/ALVR/wiki/Installation-guide#microphone-setup-on-windows)

#### Startup and Configuration

1. Unzip `alvr_streamer_windows.zip`.
2. Launch ALVR Dashboard and complete the initial setup.
3. Configure the following settings:
   - Presets > Codec preset: `H264` or `HEVC`
   - Presets > Headset microphone: `Virtual Audio Cable`
   - Video > Bitrate: `Adaptive`
4. Click **Launch SteamVR** in ALVR Dashboard to start SteamVR.

### 3.2 ALVR Web Client

#### Preparation

1. Connect the XR Glasses to the device running ALVR Web Client via USB.
2. Switch the XR Glasses to 3D mode (SBS display).

| XR Glasses | How to switch modes |
|---|---|
| VITURE | Press and hold the Mode button |
| XREAL | Press and hold the Brightness + button |
| RayNeo | Press the Brightness + and Volume + buttons simultaneously |

3. Connect the DualSense to the device running ALVR Web Client via USB or Bluetooth.

#### Connecting with Chrome

1. Open `https://{SERVER_ADDRESS}:8083/` in Chrome. Replace `{SERVER_ADDRESS}` with the ALVR Streamer hostname or IP address.
2. Click **Connect** to connect to the server.
3. Click **Connect XR Glasses** and grant permission for the WebHID connection.
4. Click **Connect DualSense** and grant permission for the WebHID connection.
5. Click **Stream to XR Glasses** to start streaming.
6. A Receiver window will appear on the XR Glasses display. Click the window with the mouse will change it to full screen mode.

#### Connecting with Android app

1. Install `alvr_webclient_android.apk`.
2. Launch ALVR Web Client.
3. On the first launch, grant all permissions requested in the permission dialogs.
4. Enter the ALVR Streamer hostname or IP address in **Server address**.
5. Click **Connect** to connect to the server.
6. Click **Stream to XR Glasses** to start streaming.
7. A Receiver window will appear on the XR Glasses display.

#### Disconnecting

- Click **Disconnect** to disconnect from the server.

#### FAQ

- If head tracking does not work, exit ALVR Web Client, unplug and reconnect the XR Glasses USB cable, and then try again.

## 4. Controls

### 4.1 Key mappings

| DualSense | Action |
|---|---|
| × | `right/input/a/click` |
| ○ | `right/input/b/click` |
| □ | `left/input/x/click` |
| △ | `left/input/y/click` |
| L-Stick | `left/thumbstick/value` |
| R-Stick | `right/thumbstick/value` |
| L1 | `left/squeeze/click`, `left/squeeze/value` |
| R1 | `right/squeeze/click`, `right/squeeze/value` |
| L2 | `left/trigger/click`, `left/trigger/value` |
| R2 | `right/trigger/click`, `right/trigger/value` |
| L3 | `left/thumbstick/click` |
| R3 | `right/thumbstick/click` |
| PS | `left/input/menu/click` |
| D-pad | Move the camera (up, down, left, and right) |
| Option | Long press : Reset the camera; Short press : Toggle Virtual 6DoF mode On/Off |

### 4.2 Virtual Controller

| DualSense | Action |
|---|---|
| Touchpad (touch) | Move position (up to 2 points) |
| Touchpad (click) | Switch between vertical and depth movement |
| Touchpad (double-click) | Reset position and orientation |
| Gyro | Adjust orientation |

### 4.3 Virtual 6DoF mode

| DualSense | Action |
|---|---|
| L-Stick | Move the camera (forward, backward, left, and right) |
| R-Stick | Move the camera (up and down) and rotate it (left and right) |

## 5. Build Instructions

### 5.1 ALVR Streamer

- See the [official ALVR build instructions](https://github.com/alvr-org/ALVR/wiki/Building-From-Source).

### 5.2 ALVR Web Client (Android native app)

1. Open the `ALVR_webclient/android/alvr_webclient` folder in Android Studio.
2. Run the build.

## 6. References

- [dualsense-tester](https://github.com/daidr/dualsense-tester)
- [viture-webxr-extension](https://github.com/bfvogel/viture-webxr-extension)
- [viture-v2](https://github.com/elasticjava/viture-v2)
- [nrealAirLinuxDriver](https://gitlab.com/TheJackiMonster/nrealAirLinuxDriver)
- [RayNeo-Air-3S-Pro-OpenVR](https://github.com/verncat/RayNeo-Air-3S-Pro-OpenVR)

## 7. License

- MIT License
