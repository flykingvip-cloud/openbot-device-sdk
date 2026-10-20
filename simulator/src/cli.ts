import { runSimulator } from "./sim.ts";

const DEFAULT_STATE = "var/device-sim.sqlite";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${helpText()}\n`);
    return;
  }
  const report = await runSimulator(args.statePath);
  process.stdout.write(`${report.lines.join("\n")}\n`);
}

function parseArgs(argv: string[]): { statePath: string; help: boolean } {
  let statePath = DEFAULT_STATE;
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (arg === "--state") {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new Error("--state 需要本地路径");
      }
      statePath = next;
      index += 1;
      continue;
    }
    throw new Error(`未知参数: ${arg ?? ""}`);
  }
  return { statePath, help };
}

function helpText(): string {
  return [
    "用法: npm run sim -- [--state 路径]",
    "  默认状态文件 var/device-sim.sqlite（已 gitignore）",
    "  每次运行都会清空该文件，然后走认领/绑定、B1–B3 stand-in、refresh stub、吊销和实验 OTA",
    "  不连接串口、摄像头或生产 OTA。flash 与 massFlash 会失败",
    "  合约针是 openbot-vp main 的 squash merge d7f0e1d834dc9ccece6723f6d71dea8fa0cfcb1f",
    "  已作废: 490a69669c0cf9e68173ceb25cfa89c99438dfb9、feeac51863d6d88ba83c7e16029b2911209bb0d0、fe1e2c2a81fd3814e8588a854695640ca56db64b、92826116a9b00a596ae2360d8a643d6148050e3c、d22db4755311a1a0df9fb5e3d5da60554f8ef6a5、bc3d9fda20f1806b6f47be4607ed4fdcc2fa4c9a、41b7561222775e4ad00b056e2a535c7f950bcbe9、536a963b119f0a00675516401c52dd0f6187b196、8abdc7f9a0ae49c340de712fbba235b1064f6c7d、554910d835f3baadb1d753532ad510b1b477be09 与 dd6c85cae086d90c519ff1be7ad08e20d4644bba",
    "  本环境读不到 openbot-vp（404），B0–B5 仍走本地 stand-in",
  ].join("\n");
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
