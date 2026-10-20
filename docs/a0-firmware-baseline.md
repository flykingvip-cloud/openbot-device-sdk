# A0 固件与硬件核验

这份笔记从 2026-10-20 的 A0 核验记录原样收回。后续适配器以这里的 SHA 和队列行为为准。



核对日期：2026-10-20。只读来源：

- 手册站点 https://metalio.world/manual （前端包内的使用说明与开发者文档）
- 固件 https://github.com/CloudZao/MetalioClaw4 ，MIT
- 本机浅克隆标签 `latest`，`git rev-parse HEAD` 为下面的 SHA

未把模拟或文档说法写成真机测量。

## 固定基线

| 项 | 值 |
|---|---|
| 仓库 | https://github.com/CloudZao/MetalioClaw4 |
| 分支 `main` 当时的 tip | `ca3aa3fa027ff7dad2adf0c2d03c4f24aa838950` |
| 标签 `latest` | 同一 SHA |
| 提交时间 | 2026-08-18T12:45:18Z（作者日期显示为 +08:00 的 20:45:18） |
| 说明 | Merge pull request #22 from vaemc/main：设置页 C5 升级入口；coredump 64KB；触摸 GPIO33 中断 |
| 更旧标签 | `v2.0.5.1` = `406f1fe03b14afb6c25ec05dbe4eb5504db9b1ca`；`v2.0.5` = `107b1531135b8b5f7ff64d168da4adeeb0e858ca`。不要用它们代替 `main` |
| 板级 | `main/boards/metalio-claw-4/`，`config.json` target `esp32p4` |
| 上游 | README 指向 https://github.com/78/xiaozhi-esp32 |
| ESP-IDF | README 要求 v5.5.4。本环境没有用该工具链编译 |

手册页面没有写这个 git SHA。

2026-10-20 再次请求 GitHub `commits/main`：SHA 与提交时间没有变化。本地浅克隆 `HEAD` 也是这个 SHA。后续 Agent A 只读这一棵树。标签 `latest` 仍指向它；`v2.0.5` / `v2.0.5.1` 更旧，不能当作基线。

## 显示与 RGB565

手册规格：Metalio Claw4，3.95 英寸，**720×720**。不是 1280×720。Wi-Fi / 4G 按 SKU。相机使用说明只写打开相机、拍照、从 TF 卡导出。固件维护写的是网站「在线烧录」，并警告烧录中不要断电。营销站没有公开的设备 OTA JSON 协议。

算术：

| 缓冲 | 字节 |
|---|---|
| 720×720 RGB565 纯像素 | 1,036,800 |
| 720×720 RGB888 / 24 bpp 纯像素 | 1,555,200 |
| 三帧 24 bpp | 4,665,600 |
| 1280×720 RGB565 纯像素 | 1,843,200 |
| 1920×1080 RGB565 纯像素 | 4,147,200 |

`4.1 MB`（4,100,000）与上表任何一项都不相等。

该 SHA 上的量产屏初始化 `InitializeNV3051FLCD()`（`main/boards/metalio-claw-4/metalio-claw-4.cc`）设置：

- `dpi_config.pixel_format = LCD_COLOR_PIXEL_FORMAT_RGB888`
- `in_color_format` / `out_color_format` = `LCD_COLOR_FMT_RGB888`
- `bits_per_pixel = 24`
- `num_fbs = 3`
- 可见区域 720×720
- `sdkconfig`：`CONFIG_LV_COLOR_DEPTH=24`

因此 **不能把 1,036,800 字节当成这块屏的实际帧缓冲**。那是 RGB565 的纯像素算术。`main/display/lv_adapter_display.cc` 的注释仍写「720x720 RGB565」和「3×720×720×2 ≈ 3MB」。这段注释和上面的 RGB888 初始化冲突，视为过期注释，不是测量值。

`sdkconfig` 里还有 `CONFIG_BSP_LCD_COLOR_FORMAT_RGB565=y`。板级初始化函数没有走这个 BSP 选项。谁在运行时真正分配缓冲，要等 A2 看启动日志。

## 摄像头

README 与 `camera_screen.h` 写 OV2710、MIPI-CSI、1920×1080 @ 25 fps、XCLK 24 MHz、SCCB 0x36。`configure_camera_format()` **优先 `VIDIOC_S_FMT` 为 `V4L2_PIX_FMT_RGB565`**，失败则保留驱动默认格式（RGB565 / YUYV / UYVY 按 2 字节，RGB24 按 3 字节）。代码没有在 ioctl 里写死 1920×1080，分辨率来自驱动当前格式。

预览把中心 **720×600** 裁剪、旋转 180°，转成 RGB888（BGR 字节序）画到 LVGL。保存 JPEG 默认质量 55，缩到 **360×300**，写到 `/sdcard` 根目录。无卡则只显示不保存。V4L2 缓冲个数为 2。stride、ISP 是否接受 RGB565、内存峰值：**未在真机测量**。

若驱动默认就是 1920×1080 且 RGB565 被接受，单帧纯像素是 4,147,200 字节。这可以解释「大约 4.1 MB」的口误，但不能当成已测量的缓冲大小。

## OTA 与分区

`sdkconfig`：`CONFIG_PARTITION_TABLE_CUSTOM_FILENAME="partitions/v1/32m_dual.csv"`，表偏移 `0x9000`。

`partitions/v1/32m_dual.csv`：

| 名 | 大小 | 备注 |
|---|---|---|
| nvsfactory | 200K @ 0xA000 | |
| nvs | 840K | |
| otadata | 8K | |
| phy_init | 4K | |
| model | 956K SPIFFS | |
| ota_0 | 9M @ 0x200000 | 主固件 |
| ota_1 | 4M | README：ESPClaw `edge_agent` |
| resources | 4M SPIFFS | |
| factory_test | 600K | |
| emote | 4M | |
| system | 1M FAT | |
| storage | 7M FAT | |
| coredump | 64K | 与提交说明一致 |

`Application` 启动：NVS 命名空间 `wifi` 的 `ota_url` 为空才写入 `https://api.tenclass.net/xiaozhi/ota/`，非空则保留。`Ota::GetCheckVersionUrl()` 用同一默认值。

`Ota::CheckVersion()`：有系统信息 JSON 则 POST，否则 GET。头：`Activation-Version`（有 eFuse 序列号为 2，否则 1）、`Device-Id`（MAC）、`Client-Id`（板级 UUID）、可选 `Serial-Number`。解析响应：

- `activation.message/code/challenge/timeout_ms`（默认 30000）
- `mqtt`、`websocket`：字符串和数字按键写入对应 NVS；响应里没有的键不会被删掉
- `server_time.timestamp` 毫秒，加上 `timezone_offset` 分钟
- `firmware.version/url`；`force == 1` 强制升级

升级：GET 固件，要求 Content-Length，`esp_ota` 写下一分区，`esp_ota_end` 校验镜像，再设置启动分区。`PENDING_VERIFY` 时 `esp_ota_mark_app_valid_cancel_rollback`。激活 POST `{ota_url}/activate`，序列号路径带 `hmac-sha256`。源码注释指向飞书文档，正文未打开。

协议选择：OTA 里有 `mqtt` 用 MQTT，否则有 `websocket` 用 WebSocket，都没有则默认 MQTT。

这是小智云 OTA，不是本设备平台将来下发的配置。设备平台不得把 `api.tenclass.net` 当成自己的生产入口，也不得改线上地址。

## 语音

WebSocket（`websocket_protocol.cc`）从 NVS `websocket` 读 `url`、`token`、`version`。头：`Authorization`（token 不含空格则加 `Bearer `）、`Protocol-Version`、`Device-Id`、`Client-Id`。客户端 hello：`transport=websocket`，`features.mcp=true`，音频 opus、16000 Hz、1 通道、`frame_duration=60`（`OPUS_FRAME_DURATION_MS`）。服务端 hello 的 `transport` 必须是 websocket。等 hello 10 秒。二进制 v1 裸 Opus；v2/v3 见 `protocol.h` 的 `BinaryProtocol2` / `BinaryProtocol3`。

MQTT hello 固定 version 3、`transport=udp`，音频参数同上。UDP 负载经 AES-CTR。MQTT ping 90 秒，重连间隔 60 秒。通道空闲超时 120 秒（`Protocol::IsTimeout`）。

打断：`SendAbortSpeaking` 发送 `{"type":"abort","session_id",...}`，唤醒词原因是 `wake_word_detected`。`OnWakeWordDetected` 在 `Speaking` 时只调用它，并置 `aborted_=true`。全树只有这两处读写 `aborted_`：TTS `start` 时清掉。它不驱动清队列。`ResetDecoder()` 清空 Opus 解码器状态以及 decode / playback / testing 队列，调用点是进入 `Speaking`，以及压力测试停止。唤醒词打断路径本身不调用它。因此「打断后立即丢掉本地播放队列」在这个提交里没有实现。迟到音频只要状态仍是 `Speaking` 就会继续入解码队列。

解码队列上限 `2400/60=40` 包，播放队列上限 2。编码队列上限 2。数据流是麦克风 → 处理器 → 编码队列 → Opus → 发送队列；服务器 → 解码队列 → Opus → 播放队列 → 扬声器。

JSON 控制：`tts.state` 为 `start` 进入 Speaking（从 Idle 或 Listening），`stop` 在手动模式回 Idle、否则回 Listening，`sentence_start.text` 显示助手文本。`stt.text` 显示用户文本。`llm.emotion` 调用 `SetEmotion`。`system.command=reboot` 重启。`mcp.payload` 交给设备端 MCP。

聊天菜单「打断」切换的是 AEC 模式开关（`GetAecMode() != kAecOff`），不是一次立即打断。唤醒词只在聊天页和数字人页 `SetVoiceUiDesired(true)` 时启用。AEC 偏好先记下，等语音处理器创建后再 `EnableDeviceAec`。空闲时不创建带 AEC 的通信 AFE。

MQTT 服务端 hello 还必须带 `udp.server`、`udp.port`、`udp.key`、`udp.nonce`（十六进制）。密钥按 128 bit 设置 AES。`encryption` 字段被注释掉，未使用。

状态枚举：Unknown、Starting、WifiConfiguring、Idle、Connecting、Listening、Speaking、Upgrading、Activating、AudioTesting、FatalError。Listening 时表情设为 `neutral`，不是单独的 listen 动画。

## 动画

`SetEmotion` 把服务器表情名收成 6 类：happy、loving、crying、surprised、thinking、neutral。触发来自 JSON `type=llm` 的 `emotion` 字符串，不是 Listening/Speaking 状态。进入 Idle、Connecting、Listening 时固件把表情设成 `neutral`。数字人用 6 类文件，路径 `system/emotion/{category}`。聊天表情模式用原始名字，路径 `system/chat/{emotion}.eaf`。屏幕不在前台时只改缓存。缺文件回 neutral。设备状态机没有 thinking 状态。

## C5 与主固件升级（同一 SHA）

设置页 C5 升级（`settings_upgrade_tab.cc`，仅 `CONFIG_ESP_HOSTED_ENABLED`）：目标版本写死 **2.12.12**，URL 写死 `https://cloudzaoai.oss-rg-china-mainland.aliyuncs.com/c5_hosted_2.12.12.bin`。GET 该 URL，要求 HTTP 200 和非零长度，1400 字节分片写入 `esp_hosted_slave_ota_*`，然后 `activate`，成功后约 1.5 秒调用 `Application::Reboot()`。源码里没有 SHA256/签名校验，失败只提示「更新失败」。没有看到 C5 固件回滚槽。

主应用升级仍是 `Ota::Upgrade`：下一 OTA 分区、`esp_ota_end` 镜像校验、设置启动分区、下次启动 `PENDING_VERIFY` 时 `esp_ota_mark_app_valid_cancel_rollback`。下载 URL 来自 OTA JSON 的 `firmware.url`，代码路径没有额外证书钉扎。`ota_1` 被 ESPClaw 占用，不能把它理解成主固件的备用槽。

## 仍未知（A2 之前要真机或该提交的启动日志）

- 量产机里的 `app desc` 版本字符串是否等于这个 SHA
- ISP 是否接受 RGB565，以及 `VIDIOC_G_FMT` 的真实宽高和 stride
- 三帧 RGB888 是否都分配成功，PSRAM 峰值
- eFuse 序列号是否烧录；只持有 MAC 时 OTA 检查是否被服务端拒绝
- Wi-Fi 与 4G 断线后的重连时序差异
- C5 协处理器升级包的校验和回滚（设置页入口在提交说明里，本次未逐行读完升级实现）
- 证书钉扎：升级 URL 由 OTA JSON 给出，代码路径未见额外的固件包证书校验，除 `esp_ota_end` 的镜像校验
