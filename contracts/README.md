# 合约针

`OPENBOT_CONTRACT_SHA` = `536a963b119f0a00675516401c52dd0f6187b196`

这是 <https://github.com/flykingvip-cloud/openbot-vp/pull/8> squash merge 到 `main` 之后的正式提交（真实 Agent/vision）。冻结字段名和能力路由前缀 `/api/integrations/v1` 没有改。本环境请求该仓库的 OpenAPI 仍然返回 404，所以 `contracts/openbot/device-digital-human.openapi.yaml` 只是未拉取槽，`routesAligned=false`，`routeSource=local-mock-access-limited`。

`previousSha` = `8abdc7f9a0ae49c340de712fbba235b1064f6c7d`，状态 `invalidated`。那是 PR #7 的 squash merge，不能再当作 `officialMergeSha`。

同样作废、写在 `invalidatedShas` 里的还有 PR #7 合并前 tip `554910d835f3baadb1d753532ad510b1b477be09`，以及更早的 `dd6c85cae086d90c519ff1be7ad08e20d4644bba`。

作废短针：`68e062e`，仓库 `upbeyond/openbot`。不要再读它，也不要读已暂停的 `upbeyond/openbot-device-sdk`。

消费者路径和 SSE 事件名记在 `src/consumer-mirror.ts`，来源是 Agent B 的消息，不是 OpenAPI 字节。B1 live GET 使用 `/api/integrations/v1/digital-humans/{digitalHumanId}`。B0 与 B2–B5 仍是 `stand-in/b0-b5.json` 里的本地 mock。

只有设置了 `OPENBOT_DEVICE_DH_STUB_URL` 时才访问数字人 live stub；未设置时测试跳过，不失败。Stub 根上的 `GET /healthz` 不在 `/api/integrations/v1` 下面。

冻结字段名保持不变：`authorizationRef`、`bindingVersion`、`digitalHumanId`、`deviceId`，以及 `assistant.*`。别名（例如 `device_id`、`assistantProfile`）会被拒绝。
