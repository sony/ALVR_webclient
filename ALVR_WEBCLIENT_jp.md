# ALVR Web Client

## 1. 概要

このリポジトリは [ALVR](https://github.com/alvr-org/ALVR) の fork です。SteamVR 対応 PCVR アプリの画面や音声を Desktop PC から Laptop PC や Android デバイスにストリーミングするための Web アプリケーションを提供します。SteamVR 対応 PCVR アプリを XR Glasses と DualSense コントローラーを使用して遠隔操作する事が可能です。QUIC（HTTP/3）プロトコルを使用してモバイル回線でも低遅延な通信を実現しました。

## 2. システム要件

### 2.1 ALVR Streamer

- Desktop PC
  - Windows 11
  - NVIDIA RTX 3060 以上の GPU を推奨

### 2.2 ALVR Web Client

- Laptop PC
  - Windows 11, macOS, Linux
  - Chrome ブラウザ
- Android デバイス
  - Android 13 以降
  - Android アプリ（後述）

### 2.3 XR Glasses

| ブランド | 機種 |
|---|---|
| VITURE | VITURE One, VITURE PRO, VITURE PRO 2 |
| XREAL | XREAL Air 2, XREAL Air 2 Pro, XREAL Air 2 Ultra |
| RayNeo | RayNeo Air 3s, RayNeo Air 4 Pro |

### 2.4 コントローラー

- DualSense コントローラー（DualShock 4 コントローラー互換）

### 2.5 ネットワーク

- インターネット経由で使用する場合は VPN で通信を保護してください（Tailscale 推奨）

## 3. 使用方法

### 3.1 ALVR Streamer

#### 事前準備

- ALVR 公式の手順に従って Virtual Audio Cable（VAC）をインストールしてください。
  - [Windows でのマイク設定](https://github.com/alvr-org/ALVR/wiki/Installation-guide#microphone-setup-on-windows)

#### 起動と設定

1. `alvr_streamer_windows.zip` を解凍します。
2. ALVR Dashboard を起動し、初回セットアップを完了します。
3. Settings で次の項目を設定します。
   - Presets > Codec preset: `H264` または `HEVC`
   - Presets > Headset microphone: `Virtual Audio Cable`
   - Video > Bitrate: `Adaptive`
4. ALVR Dashboard の **Launch SteamVR** ボタンを押して SteamVR を起動します。

### 3.2 ALVR Web Client

#### 事前準備

1. XR Glasses を ALVR Web Client を実行するデバイスに USB 接続します。
2. XR Glasses を 3D モード（SBS 表示）に切り替えます。

| XR Glasses | 操作方法 |
|---|---|
| VITURE | Mode ボタンを長押し |
| XREAL | 明るさ + ボタンを長押し |
| RayNeo | 明るさ + ボタンと音量 + ボタンを同時に押す |

3. DualSense を ALVR Web Client を実行するデバイスに USB または Bluetooth で接続します。

#### Chrome での接続

1. Chrome で `https://{SERVER_ADDRESS}:8083/` を開きます。`{SERVER_ADDRESS}` は ALVR Streamer のホスト名または IP アドレスに置き換えてください。
2. **Connect** を押してサーバーに接続します。
3. **Connect XR Glasses** を押し、WebHID 接続を許可します。
4. **Connect DualSense** を押し、WebHID 接続を許可します。
5. **Stream to XR Glasses** を押してストリーミングを開始します。
6. XR Glasses のディスプレイに Receiver ウィンドウが表示されます。マウスでクリックするとフルスクリーン表示になります。

#### Android アプリでの接続

1. `alvr_webclient_android.apk` をインストールします。
2. ALVR Web Client を起動します。
3. 初回起動時に表示される権限確認ダイアログで、必要な権限をすべて許可します。
4. **Server address** に ALVR Streamer のホスト名または IP アドレスを入力します。
5. **Connect** を押してサーバーに接続します。
6. **Stream to XR Glasses** を押してストリーミングを開始します。
7. XR Glasses のディスプレイに Receiver ウィンドウが表示されます。

#### 終了方法

- **Disconnect** を押してサーバーとの接続を解除します。

#### FAQ

- ヘッドトラッキングが有効にならない場合は、ALVR Web Client を終了し、XR Glasses の USB ケーブルを抜いてから再接続して、もう一度起動してください。

## 4. 操作方法

### 4.1 キーマップ

| DualSense | 操作 |
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
| D-pad | カメラ移動（上下左右） |
| Option | 長押し : カメラリセット、短押し : 仮想 6DoF モード On/Off の切り替え |

### 4.2 仮想コントローラー

| DualSense | 操作 |
|---|---|
| Touchpad（タッチ） | 位置を操作（最大 2 個まで） |
| Touchpad（クリック） | 上下方向と奥行き方向を切り替え |
| Touchpad（ダブルクリック） | 位置と角度をリセット |
| Gyro | 角度を調節 |

### 4.3 仮想 6DoF モード

| DualSense | 操作 |
|---|---|
| L-Stick | カメラ移動（前後左右） |
| R-Stick | カメラ移動（上下）とカメラ回転（左右） |

## 5. ビルド手順

### 5.1 ALVR Streamer

- [ALVR 公式のビルド手順](https://github.com/alvr-org/ALVR/wiki/Building-From-Source)を参照してください。

### 5.2 ALVR Web Client（Android アプリ）

1. Android Studio で `ALVR_webclient/android/alvr_webclient` フォルダーを開きます。
2. Build を実行します。

## 6. References

- [dualsense-tester](https://github.com/daidr/dualsense-tester)
- [viture-webxr-extension](https://github.com/bfvogel/viture-webxr-extension)
- [viture-v2](https://github.com/elasticjava/viture-v2)
- [nrealAirLinuxDriver](https://gitlab.com/TheJackiMonster/nrealAirLinuxDriver)
- [RayNeo-Air-3S-Pro-OpenVR](https://github.com/verncat/RayNeo-Air-3S-Pro-OpenVR)

## 7. ライセンス

- MIT License
