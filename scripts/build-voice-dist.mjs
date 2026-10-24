#!/usr/bin/env node
/**
 * P1-6: transpile adapters/voice (+ metalio Opus helpers) to dist/ for npm publish.
 * Source keeps .ts imports for strip-types; staging rewrites to .js for tsc emit.
 *
 * Does NOT run npm publish. Safe for pack / publish --dry-run.
 */
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const staging = join(root, ".build-voice-src");
const outDir = join(root, "dist");
const tsconfigBuild = join(root, "tsconfig.voice-publish.json");

const METALIO_FILES = ["constants.ts", "opus-boundary.ts", "opus-encoder.ts"];

function walkTs(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walkTs(p, acc);
    else if (name.endsWith(".ts")) acc.push(p);
  }
  return acc;
}

function rewriteImports(content, filePath) {
  const relFromVoiceRoot = relative(join(staging, "voice"), filePath);
  const depth = relFromVoiceRoot.split(/[/\\]/).length - 1; // 0 for voice/*.ts
  // Map adapters/voice/src → staging/voice, adapters/metalio/src → staging/metalio
  let out = content;
  // metalio cross-imports: ../../metalio/src/X.ts or ../../../metalio/src/X.ts
  out = out.replace(
    /from\s+(["'])((?:\.\.\/)+)metalio\/src\/([^"']+)\.ts\1/g,
    (_m, q, _dots, mod) => {
      const up = "../".repeat(depth + 1);
      return `from ${q}${up}metalio/${mod}.js${q}`;
    },
  );
  // same-package .ts extensions → .js
  out = out.replace(
    /from\s+(["'])(\.[^"']+)\.ts\1/g,
    (_m, q, spec) => `from ${q}${spec}.js${q}`,
  );
  out = out.replace(
    /export\s+(\*|type\s+\{[^}]*\}|\{[^}]*\})\s+from\s+(["'])(\.[^"']+)\.ts\2/g,
    (m) => m.replace(/\.ts(["'])/, ".js$1"),
  );
  // catch remaining export ... from "./x.ts"
  out = out.replace(
    /from\s+(["'])(\.[^"']+)\.ts\1/g,
    (_m, q, spec) => `from ${q}${spec}.js${q}`,
  );
  return out;
}

function ensureDir(p) {
  mkdirSync(p, { recursive: true });
}

rmSync(staging, { recursive: true, force: true });
rmSync(outDir, { recursive: true, force: true });
ensureDir(join(staging, "voice"));
ensureDir(join(staging, "metalio"));

// Copy voice tree
cpSync(join(root, "adapters/voice/src"), join(staging, "voice"), { recursive: true });

// Copy metalio subset
for (const f of METALIO_FILES) {
  cpSync(join(root, "adapters/metalio/src", f), join(staging, "metalio", f));
}

// Rewrite all staged .ts
for (const file of walkTs(staging)) {
  const raw = readFileSync(file, "utf8");
  writeFileSync(file, rewriteImports(raw, file));
}

writeFileSync(
  tsconfigBuild,
  JSON.stringify(
    {
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        skipLibCheck: true,
        verbatimModuleSyntax: true,
        exactOptionalPropertyTypes: true,
        noUncheckedIndexedAccess: true,
        noImplicitOverride: true,
        forceConsistentCasingInFileNames: true,
        declaration: true,
        declarationMap: true,
        sourceMap: true,
        rootDir: ".build-voice-src",
        outDir: "dist",
        types: ["node"],
      },
      include: [".build-voice-src/**/*.ts"],
    },
    null,
    2,
  ) + "\n",
);

const tsc = spawnSync(
  process.execPath,
  [join(root, "node_modules/typescript/bin/tsc"), "-p", tsconfigBuild],
  { cwd: root, stdio: "inherit" },
);
if (tsc.status !== 0) {
  console.error("[build-voice-dist] tsc failed");
  process.exit(tsc.status ?? 1);
}

// Package entry convenience: dist/index.* → re-export voice (optional flat entry)
writeFileSync(
  join(outDir, "index.js"),
  'export * from "./voice/index.js";\n',
);
writeFileSync(
  join(outDir, "index.d.ts"),
  'export * from "./voice/index.js";\n',
);

console.log("[build-voice-dist] wrote", relative(root, outDir));
if (!existsSync(join(outDir, "voice/index.js"))) {
  console.error("[build-voice-dist] missing dist/voice/index.js");
  process.exit(1);
}
