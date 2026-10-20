# 已入库的 OpenAPI

文件：`device-digital-human.openapi.yaml`

当前针：`feeac51863d6d88ba83c7e16029b2911209bb0d0`（PR #15 squash）

对齐 URL：

`https://raw.githubusercontent.com/flykingvip-cloud/openbot-vp/feeac51863d6d88ba83c7e16029b2911209bb0d0/docs/integrations/device-digital-human/openapi.yaml`

PR #15 没有改冻结字段名，也没有改 `/api/integrations/v1`。入库字节仍是 PR #11 那份 OpenAPI，路径和 SSE 事件名与消费者镜像一致，`routesAligned` 为 true。`fe1e2c2a81fd3814e8588a854695640ca56db64b` 已作废，不是当前 `officialMergeSha`。视觉进行中的工具结果幂等仍是：同一把键和同一份 body 是重复，不同 body 是 `IDEMPOTENCY_CONFLICT`，完成后重放最终响应。

`contracts/src/consumer-mirror.ts` 里的能力路径和 SSE 事件名与这份文件一致，因此 `routesAligned` 为 true。这只是静态对齐，不是端到端联调通过。B2–B5 仍是本地 stand-in。`GET /healthz` 仍在 stub 根上，不在 `servers.url` 的 `/api/integrations/v1` 下面，也不在这份文件里。实验 OTA 配置进程也不提供这些能力路径。

仍未实现的部分：

- B0、B2–B5 的本地 stand-in 不是 grants / conversations / runs / media
- 本仓库可以在配置了 loopback stub 时读取 run SSE，但不会自己发出这些事件
