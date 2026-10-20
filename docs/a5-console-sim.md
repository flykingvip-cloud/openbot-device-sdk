# A5 控制台、模拟器与重连

不需要工程机，也不重新落地 Agent B 的 B0–B5。控制台和模拟器都在本机状态文件里走完认领、绑定、实验 OTA、短时凭证和吊销。

## 合约针

| 项 | 值 |
|---|---|
| `OPENBOT_CONTRACT_SHA` | `490a69669c0cf9e68173ceb25cfa89c99438dfb9` |
| 来源 | openbot-vp `main`，<https://github.com/flykingvip-cloud/openbot-vp/pull/16> 的 squash merge |
| `previousSha` | `feeac51863d6d88ba83c7e16029b2911209bb0d0`，PR #15 squash，**已作废** |
| 更早作废 | `fe1e2c2a81fd3814e8588a854695640ca56db64b`、`92826116a9b00a596ae2360d8a643d6148050e3c`、`d22db4755311a1a0df9fb5e3d5da60554f8ef6a5`、`bc3d9fda20f1806b6f47be4607ed4fdcc2fa4c9a`、`41b7561222775e4ad00b056e2a535c7f950bcbe9`、`536a963b119f0a00675516401c52dd0f6187b196`、`8abdc7f9a0ae49c340de712fbba235b1064f6c7d`、`554910d835f3baadb1d753532ad510b1b477be09`、`dd6c85cae086d90c519ff1be7ad08e20d4644bba` |
| OpenAPI | 已入库，`routesAligned` 为 true。这是静态路径对齐，不是端到端联调通过。B2–B5 仍是 stand-in |

B1 live 路径是 `/api/integrations/v1/digital-humans/{digitalHumanId}`。B0 与 B2–B5 仍是本地 mock。冻结字段名不变。`feeac518…` 不是当前 `officialMergeSha`。

## 怎么跑

```bash
npm install
npm test
npm run typecheck
npm run console
npm run sim
```

控制台默认把状态写到 `var/device-console.sqlite`。模拟器默认写到 `var/device-sim.sqlite`。这两个路径已在 `.gitignore` 里。文件里有认领码和短时 token，不要提交。

```bash
npm run console -- --state var/device-console.sqlite
npm run console -- --state var/device-console.sqlite --resume
npm run sim -- --state var/device-sim.sqlite
npm run console -- --help
npm run sim -- --help
```

`--state` 以 `.json` 结尾时用 JSON 文件，否则用 sqlite。每次 `npm run console`（不带 `--resume`）和 `npm run sim` 都会清空自己的状态文件再跑一遍。跑完控制台后，`--resume` 重新打开同一文件，确认绑定、吊销和不可执行的 OTA 记录还在。

不监听端口，不打开串口或摄像头，不下载固件。

## 控制台在做什么

1. 发出 6 位认领码并核销。
2. 绑定，再 `rebind`。`authorizationRef` 轮换，`bindingVersion` 加 1，`assistant.*` 原样保留。
3. 给这一台设备记一条实验 OTA：`firmwareUrl` 为 null，`force` 为 0，`executable` 为 false。
4. `flash()` 失败，码 `ota_disabled`。`massFlash()` 失败，码 `mass_flash`。
5. 签发短时连接凭证，再用本地 refresh stub 轮换。stub 不调用 `fetch`。旧 token 不能再交摄像头结果。
6. `revoke` 清掉短时 token，冻结绑定还在。吊销之后交上来的摄像头结果，即使拍摄时间更早，也是 `camera_revoked`。
7. 关掉数据库再打开，上述绑定、吊销和 OTA 记录仍在。

## 模拟器在做什么

在控制台那条线之外，再用同一份状态文件检查 B1–B3 本地 stand-in：

- B1：相同 `idempotencyKey` 返回第一次的资料。资料里的 `assistant.*` 不裁剪。
- B2：相同幂等键返回同一会话；另一把键得到 `SESSION_BUSY`。重复 `eventId` 不新增事件。游标到期得到 `CURSOR_EXPIRED`。
- B3：`assistant.tts` 只念 `assistant.visible.speech`。`assistant` 里其余字段不会进报文。`ota.flash`、`ota.massFlash`、`system.reboot` 仍然失败。

这些行为写在 stand-in 的 `consumerChecks` 里。正式 SHA 已经是 main 上的 squash merge，但本环境 404，这些路径不是从该提交抄来的路由表。
