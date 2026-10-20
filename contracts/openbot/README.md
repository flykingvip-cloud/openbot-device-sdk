# 已入库的 OpenAPI

文件：`device-digital-human.openapi.yaml`

来源提交：`41b7561222775e4ad00b056e2a535c7f950bcbe9`

来源 URL：

`https://raw.githubusercontent.com/flykingvip-cloud/openbot-vp/41b7561222775e4ad00b056e2a535c7f950bcbe9/docs/integrations/device-digital-human/openapi.yaml`

这是 openbot-vp `main` 上 PR #9 的 squash merge。文件字节就是该提交的 OpenAPI，不是合成稿。`536a963b119f0a00675516401c52dd0f6187b196` 已作废，不是当前 `officialMergeSha`。

`contracts/src/consumer-mirror.ts` 里的能力路径和 SSE 事件名与这份文件一致，因此 `routesAligned` 为 true。`GET /healthz` 仍在 stub 根上，不在 `servers.url` 的 `/api/integrations/v1` 下面，也不在这份文件里。

仍未实现的部分：

- B0、B2–B5 的本地 stand-in 不是 grants / conversations / runs / media
- 没有 run 管道发出 SSE 事件
