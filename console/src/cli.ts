import { existsSync } from "node:fs";

import { runConsoleDemo, runConsoleResume } from "./demo.ts";

const DEFAULT_STATE = "var/device-console.sqlite";

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${helpText()}\n`);
    return;
  }
  if (args.resume && !existsSync(args.statePath)) {
    throw new Error(`状态文件不存在: ${args.statePath}。先运行 npm run console`);
  }
  const result = args.resume ? runConsoleResume(args.statePath) : runConsoleDemo(args.statePath);
  process.stdout.write(`${result.lines.join("\n")}\n`);
}

function parseArgs(argv: string[]): { statePath: string; resume: boolean; help: boolean } {
  let statePath = DEFAULT_STATE;
  let resume = false;
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (arg === "--resume") {
      resume = true;
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
  return { statePath, resume, help };
}

function helpText(): string {
  return [
    "用法: npm run console -- [--state 路径] [--resume]",
    "  默认状态文件 var/device-console.sqlite（已 gitignore）",
    "  不带 --resume：清空该文件，走认领、绑定、实验 OTA、refresh stub、吊销，再重新打开文件",
    "  --resume：只读上次留下的绑定、吊销和不可执行 OTA 记录",
    "  flash 与 massFlash 会失败。不会下载固件，也不会访问生产 OTA",
  ].join("\n");
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
