# 已入库的 OpenAPI

文件：`device-digital-human.openapi.yaml`

来源提交：`bc3d9fda20f1806b6f47be4607ed4fdcc2fa4c9a`

来源 URL：

`https://raw.githubusercontent.com/flykingvip-cloud/openbot-vp/bc3d9fda20f1806b6f47be4607ed4fdcc2fa4c9a/docs/integrations/device-digital-human/openapi.yaml`

这是 openbot-vp `main` 上 PR #10 的 squash merge。入库字节是该针附带的 OpenAPI，路径和 SSE 事件名与消费者镜像一致，`routesAligned` 为 true。`41b7561222775e4ad00b056e2a535c7f950bcbe9` 已作废，不是当前 `officialMergeSha`。

`contracts/src/consumer-mirror.ts` 里的能力路径和 SSE 事件名与这份文件一致，因此 `routesAligned` 为 true。这只是静态对齐，不是端到端联调通过。B2–B5 仍是本地 stand-in。`GET /healthz` 仍在 stub 根上，不在 `servers.url` 的 `/api/integrations/v1` 下面，也不在这份文件里。实验 OTA 配置进程也不提供这些能力路径。

仍未实现的部分：

- B0、B2–B5 的本地 stand-in 不是 grants / conversations / runs / media
- 没有 run 管道发出 SSE 事件
