# 实验摄像头与媒体闭环

这不是 OV2710 抓帧，也不是生产上传。图片是仓库里的 1×1 PNG 或 JPEG 夹具。`firmwareUrl` 仍是 null，`flash()` 和 `massFlash()` 仍然失败。

## 本地 stand-in

`LabCameraSession` 按已入库的 OpenAPI 路径工作：

1. 接受 `tool.request`，工具名只能是 `camera.capture`。`ota.flash`、`ota.massFlash`、`system.reboot` 直接拒绝。
2. `POST /api/integrations/v1/media/upload-tickets`
3. `PUT /api/integrations/v1/media/uploads/{ticket}`，校验 PNG/JPEG 魔数和宽高。
4. `POST /api/integrations/v1/device-tool-requests/{requestId}/result`，带 `MediaRef`：`mediaId`、`contentType`、宽高、`byteLength`、sha256 `checksum`。

`authorizationRef` 和 `bindingVersion` 必须和当前绑定一致。吊销之后，新的结果是 `camera_revoked`，协议错误码是 `LATE_RESULT`，同时标 `AUTH_REVOKED`。

结果 POST 的幂等跟 PR #11 的视觉过程一致：

- 视觉还在进行时，同一把 `Idempotency-Key` 和同一份 body 返回处理中的接受（`status: processing`，`inflight: true`，`duplicate: true`）。这次重放不再拉媒体，也不再跑视觉。
- 同一把键配不同的 body 得到 `IDEMPOTENCY_CONFLICT`。
- 完成后，同一把键和同一份 body 重放最终响应（`duplicate: true`），这不是 `LATE_RESULT`。
- 视觉进行中取消或关闭，记录的不是 `status: ok`。

取消把这次请求标成 `CANCELLED`。同一台设备上还有进行中的拍摄时，后一次是 `CAMERA_BUSY`。`timeoutAtMs` 已到则是 `TIMEOUT`。

B3 的 `invokeOpenBotTool("camera.capture", …)` 要带上 `camera` 网关和当前绑定。没有这个网关时不会假装拍到了照片。

## 有 live stub 时

设置 `OPENBOT_DEVICE_DH_STUB_URL=http://127.0.0.1:8787`，以及 service Basic、`X-OpenBot-Grant-Credential`、`authorizationRef`、`bindingVersion`、`deviceId` 后：

```bash
npm run live-stub -- --camera
```

票据 POST 和结果 POST 带这些凭证。PUT 只靠票据。图片仍是 1×1 PNG 夹具。凭证或 URL 没设时不访问 stub，本地 stand-in 照旧。这个地址不是生产上传主机。细节见 [live-stub.md](live-stub.md)。

## 不做的事

- 不打开 OV2710，不按 360×300 或 1920×1080 出图
- 不把夹具当成固件 JPEG 质量 55 的预览
- 不向 `api.tenclass.net` 或别的生产主机上传
