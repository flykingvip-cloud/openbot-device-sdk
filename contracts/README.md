# 合约针

`OPENBOT_CONTRACT_SHA` = `554910d835f3baadb1d753532ad510b1b477be09`

这是 <https://github.com/flykingvip-cloud/openbot-vp/pull/7> 的**合并前 tip**，不是 `main` 上的正式合并提交。Agent B 说明 B0–B5 已经在这个 tip 上。本环境请求该仓库返回 404，没有读到路由，因此 `stand-in/b0-b5.json` 仍是本地 mock（`routeSource=local-mock-access-limited`，`routesAligned=false`）。路径没有按 PR tip 改写。

上一枚针 `dd6c85cae086d90c519ff1be7ad08e20d4644bba` 是没有父提交的恢复快照，当时读不到 B0–B5。它保留在 stand-in 的 `previousSha` 里，不再当作当前针。

Agent B 把 PR 合并进 `main` 之后会给出正式 SHA。收到那个 SHA 之前，不要把 `554910d8…` 写成已发布的 main 针，也不要把它换成别的提交。

作废指针：`68e062e`，仓库 `upbeyond/openbot`。不要再读它，也不要读已暂停的 `upbeyond/openbot-device-sdk`。

只有设置了 `OPENBOT_DEVICE_DH_STUB_URL` 时才访问数字人 live stub；未设置时测试跳过，不失败。

冻结字段名保持不变：`authorizationRef`、`bindingVersion`、`digitalHumanId`、`deviceId`，以及 `assistant.*`。别名（例如 `device_id`、`assistantProfile`）会被拒绝。
