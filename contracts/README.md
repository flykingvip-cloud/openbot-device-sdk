# 合约针

`OPENBOT_CONTRACT_SHA` = `8abdc7f9a0ae49c340de712fbba235b1064f6c7d`

这是 <https://github.com/flykingvip-cloud/openbot-vp/pull/7> squash merge 到 `main` 之后的正式提交。Agent B 报告该提交包含 B0–B5 stub。本环境请求该仓库仍然返回 404，没有读到路由，因此 `stand-in/b0-b5.json` 仍是本地 mock（`routeSource=local-mock-access-limited`，`routesAligned=false`）。路径没有按该提交改写。

`previousSha` = `554910d835f3baadb1d753532ad510b1b477be09`，状态 `invalidated`。那是 PR #7 的合并前 tip，不能再当作合约针。

更早的 `dd6c85cae086d90c519ff1be7ad08e20d4644bba` 同样作废。它是没有父提交的恢复快照，写在 `invalidatedShas` 里，不是当前的 `previousSha`。

作废指针：`68e062e`，仓库 `upbeyond/openbot`。不要再读它，也不要读已暂停的 `upbeyond/openbot-device-sdk`。

只有设置了 `OPENBOT_DEVICE_DH_STUB_URL` 时才访问数字人 live stub；未设置时测试跳过，不失败。

冻结字段名保持不变：`authorizationRef`、`bindingVersion`、`digitalHumanId`、`deviceId`，以及 `assistant.*`。别名（例如 `device_id`、`assistantProfile`）会被拒绝。
