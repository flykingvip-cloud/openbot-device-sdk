# 合约针

`OPENBOT_CONTRACT_SHA` = `dd6c85cae086d90c519ff1be7ad08e20d4644bba`

仓库：<https://github.com/flykingvip-cloud/openbot-vp>

这个提交是一次没有父提交的恢复快照，里面还没有 B0–B5 设备 API。本目录的 `stand-in/b0-b5.json` 是本地占位，不是从该提交抄出来的路由表。当前环境请求 `flykingvip-cloud/openbot-vp` 返回 404，没有把快照重新克隆一遍。

作废指针：`68e062e`，仓库 `upbeyond/openbot`。不要再读它，也不要读已暂停的 `upbeyond/openbot-device-sdk`。

Agent B 发布包含设备 API 的新 SHA 之前，调用方继续用本地 stand-in。只有设置了 `OPENBOT_DEVICE_DH_STUB_URL` 时才访问数字人 live stub；未设置时测试跳过，不失败。

冻结字段名保持不变：`authorizationRef`、`bindingVersion`、`digitalHumanId`、`deviceId`，以及 `assistant.*`。别名（例如 `device_id`、`assistantProfile`）会被拒绝。
