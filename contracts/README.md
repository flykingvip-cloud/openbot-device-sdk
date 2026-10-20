# 合约针

`OPENBOT_CONTRACT_SHA` = `490a69669c0cf9e68173ceb25cfa89c99438dfb9`

这是 <https://github.com/flykingvip-cloud/openbot-vp/pull/16> squash merge 到 `main` 之后的正式提交。冻结字段名和能力路由前缀 `/api/integrations/v1` 没有改。对齐用的 OpenAPI 仍是 `contracts/openbot/device-digital-human.openapi.yaml` 里已入库的字节。消费者路径和 SSE 事件名与文件一致，所以 `routesAligned=true`。这只是静态对齐，不是端到端联调通过。B2–B5 仍是本地 stand-in。

设备控制面的草稿 OpenAPI 在 `contracts/device-platform/device-control.openapi.yaml`。前缀是 `/api/device-platform/v1`。它不是这份冻结契约。

`previousSha` = `feeac51863d6d88ba83c7e16029b2911209bb0d0`，状态 `invalidated`。那是 PR #15 的 squash merge，不能再当作 `officialMergeSha`。

同样作废、写在 `invalidatedShas` 里的还有 PR #14 squash `fe1e2c2a81fd3814e8588a854695640ca56db64b`、PR #12 squash `92826116a9b00a596ae2360d8a643d6148050e3c`、PR #11 squash `d22db4755311a1a0df9fb5e3d5da60554f8ef6a5`、PR #10 squash `bc3d9fda20f1806b6f47be4607ed4fdcc2fa4c9a`、PR #9 squash `41b7561222775e4ad00b056e2a535c7f950bcbe9`、PR #8 squash `536a963b119f0a00675516401c52dd0f6187b196`、PR #7 squash `8abdc7f9a0ae49c340de712fbba235b1064f6c7d`、PR #7 合并前 tip `554910d835f3baadb1d753532ad510b1b477be09`，以及更早的 `dd6c85cae086d90c519ff1be7ad08e20d4644bba`。

作废短针：`68e062e`，仓库 `upbeyond/openbot`。不要再读它，也不要读已暂停的 `upbeyond/openbot-device-sdk`。

B1 live GET 使用 `/api/integrations/v1/digital-humans/{digitalHumanId}`。B0 与 B2–B5 仍是 `stand-in/b0-b5.json` 里的本地 mock，没有改成 grants / conversations / runs / media 的实现。

只有设置了 `OPENBOT_DEVICE_DH_STUB_URL` 时才访问数字人 live stub；未设置时测试跳过，不失败。Stub 根上的 `GET /healthz` 不在 `/api/integrations/v1` 下面，也不在这份 OpenAPI 里。`npm run live-stub` 只探测 loopback。数字人 GET 需要 staging.md 里的 service Basic 和 grant，未设置时跳过。

冻结字段名保持不变：`authorizationRef`、`bindingVersion`、`digitalHumanId`、`deviceId`，以及 `assistant.*`。别名（例如 `device_id`、`assistantProfile`）会被拒绝。
