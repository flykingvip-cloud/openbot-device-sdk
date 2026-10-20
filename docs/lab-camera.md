# 实验摄像头与媒体闭环

这不是 OV2710 抓帧，也不是生产上传。图片是仓库里的 1×1 PNG 或 JPEG 夹具。`firmwareUrl` 仍是 null，`flash()` 和 `massFlash()` 仍然失败。

## 本地 stand-in

`LabCameraSession` 按已入库的 OpenAPI 路径工作：

1. 接受 `tool.request`，工具名只能是 `camera.capture`。`ota.flash`、`ota.massFlash`、`system.reboot` 直接拒绝。
2. `POST /api/integrations/v1/media/upload-tickets`
3. `PUT /api/integrations/v1/media/uploads/{ticket}`，校验 PNG/JPEG 魔数和宽高。
4. `POST /api/integrations/v1/device-tool-requests/{requestId}/result`，带 `MediaRef`：`mediaId`、`contentType`、宽高、`byteLength`、sha256 `checksum`。

`authorizationRef` 和 `bindingVersion` 必须和当前绑定一致。吊销之后，新的结果是 `camera_revoked`，协议错误码是 `LATE_RESULT`，同时标 `AUTH_REVOKED`。已经用同一把 `Idempotency-Key` 和同一份结果体接受过的提交，再次提交得到 `duplicate: true`，这不是迟到结果。同一把键配不同的结果体得到 `IDEMPOTENCY_CONFLICT`。

取消把这次请求标成 `CANCELLED`。同一台设备上还有进行中的拍摄时，后一次是 `CAMERA_BUSY`。`timeoutAtMs` 已到则是 `TIMEOUT`。

B3 的 `invokeOpenBotTool("camera.capture", …)` 要带上 `camera` 网关和当前绑定。没有这个网关时不会假装拍到了照片。

## 有 live stub 时

设置 `OPENBOT_DEVICE_DH_STUB_URL`（例如 `http://127.0.0.1:8787`）后，可以调用 `runLabCameraCapture(session, request, { baseUrl })`。它会把票据、PUT 和结果发到：

`{OPENBOT_DEVICE_DH_STUB_URL}/api/integrations/v1/...`

没设置时测试不访问网络，只走本地 stand-in。这个地址不是生产上传主机。`readUrl` 只指向 `http://127.0.0.1/lab-media/{mediaId}`，字节留在本进程里。

## 不做的事

- 不打开 OV2710，不按 360×300 或 1920×1080 出图
- 不把夹具当成固件 JPEG 质量 55 的预览
- 不向 `api.tenclass.net` 或别的生产主机上传
