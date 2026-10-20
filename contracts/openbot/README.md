# OpenAPI 槽

目标文件：`device-digital-human.openapi.yaml`

来源：

`https://raw.githubusercontent.com/flykingvip-cloud/openbot-vp/536a963b119f0a00675516401c52dd0f6187b196/docs/integrations/device-digital-human/openapi.yaml`

这是 openbot-vp `main` 上 PR #8 的 squash merge（`536a963b119f0a00675516401c52dd0f6187b196`，真实 Agent/vision）。本环境对该 URL、仓库 API 和 git tree 的请求都返回 HTTP 404，所以槽里只有未拉取标记，不是合成的 OpenAPI。

在槽被真实文件替换、并且消费者路径和 SSE 事件名与文件字节一致之前，`routesAligned` 保持 false。

已经按 Agent B 的消息抄进 `contracts/src/consumer-mirror.ts` 的内容（不是从树里读到的）：

- 能力路由前缀 `/api/integrations/v1`
- stub 的 `servers.url`：`http://127.0.0.1:8787/api/integrations/v1`
- `GET /healthz` 在 stub 根上，不在该前缀下
- grants、conversations、runs、device-tool-requests、media 上传路径
- Run 与 Device 的 SSE 事件名

缺口：

- OpenAPI 字节没有入库
- B1 的 live GET 使用 `/api/integrations/v1/digital-humans/{digitalHumanId}`；未设置 `OPENBOT_DEVICE_DH_STUB_URL` 时仍读本地控制面
- B0、B2–B5 的 stand-in 仍是实验室路径，不是 grants / conversations / runs / media
- 事件名只作记录，没有 run 管道发出它们

作废、不能当作 `officialMergeSha` 的提交：`8abdc7f9a0ae49c340de712fbba235b1064f6c7d`、`554910d835f3baadb1d753532ad510b1b477be09`、`dd6c85cae086d90c519ff1be7ad08e20d4644bba`。短针 `68e062e` @ `upbeyond/openbot` 仍然作废。
