#!/usr/bin/env node
// 验证 monitor.js 改后的路径推导：在真实目录上算 APP_NAME 和 manifest 候选，
// 看它读的是自己的版本还是邻居的。这是本次「版本号显示 0.21.149」的根因。
import { basename, dirname, join } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

// ── 与 monitor.js 改后同构的推导 ─────────────────────
const APP_DIR = process.env.APP_DIR || process.env.TRIM_APPDEST || dirname(dirname(here));
const APP_NAME = basename(APP_DIR);
const MANIFEST_FILE = `${APP_DIR}/manifest`;

const candidates = [
  "/vol3/@appdata/chates/app_version",
  MANIFEST_FILE,
  `/var/apps/${APP_NAME}/manifest`,
  `${process.cwd()}/manifest`,
];

function parseVersion(file) {
  try {
    const m = readFileSync(file, "utf8").match(/^version\s*=\s*(\S+)/m);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

function readAppVersion() {
  for (const f of candidates) {
    const v = parseVersion(f);
    if (v) return { version: v, from: f };
  }
  return { version: "unknown", from: null };
}

console.log(`APP_DIR  = ${APP_DIR}`);
console.log(`APP_NAME = ${APP_NAME}`);
console.log(`候选清单 = ${JSON.stringify(candidates, null, 0)}`);
const got = readAppVersion();
console.log(`解析结果 = ${got.version}  来源 ${got.from}`);

// ── 断言 ─────────────────────────────────────────────
const checks = [];
const add = (name, ok, detail) => checks.push({ name, ok, detail });

add("APP_NAME 是本应用", APP_NAME === basename(APP_DIR), APP_NAME);
add(
  "候选里不含兄弟应用 hermes-agent",
  !candidates.some((c) => c.includes("/var/apps/hermes-agent")),
  candidates.join(" | "),
);
add("候选含自己 /var/apps/<APP_NAME>/manifest", candidates.includes(`/var/apps/${APP_NAME}/manifest`), "");
add("读到的是本应用 manifest", got.from === MANIFEST_FILE || got.from === `/var/apps/${APP_NAME}/manifest`, got.from || "null");
add("版本不是邻居的 0.21.149", got.version !== "0.21.149", got.version);

let fail = 0;
for (const c of checks) {
  console.log(`  ${c.ok ? "PASS" : "FAIL"}  ${c.name}${c.detail ? `  (${c.detail})` : ""}`);
  if (!c.ok) fail++;
}
console.log(fail === 0 ? "\nRESULT=OK" : `\nRESULT=FAIL(${fail})`);
process.exit(fail === 0 ? 0 : 1);
