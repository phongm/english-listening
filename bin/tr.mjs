#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const ENDPOINT = "https://edge.microsoft.com/translate/translatetext";
const PROXY = process.env.TR_PROXY || "";

const to = process.env.TR_TO || "zh-Hans";
const args = process.argv.slice(2);
if (args.includes("-h") || args.includes("--help")) {
  console.log(`用法:
  pbpaste | node tr.mjs            翻译剪贴板
  echo "text" | node tr.mjs        翻译管道输入
  node tr.mjs "some text"          翻译参数
  TR_TO=en node tr.mjs "中文"      反向翻译
  TR_PROXY=http://127.0.0.1:7890   需要代理时
输出: 译文；原文较长时按行对应输出。`);
  process.exit(0);
}

let text = args.filter((a) => !a.startsWith("-")).join(" ");
if (!text && !process.stdin.isTTY) {
  try {
    text = readFileSync(0, "utf8");
  } catch {
    text = "";
  }
}
if (!text.trim()) {
  console.error("没有输入文本。用法: pbpaste | node tr.mjs");
  process.exit(1);
}

const lines = text
  .split(/\r?\n/)
  .map((l) => l.trim())
  .filter(Boolean);

async function translate(batch) {
  const curl = ["-sL", "--max-time", "30", "-X", "POST", "-H", "Content-Type: application/json",
    "-d", JSON.stringify(batch.map((t) => t))];
  if (PROXY) curl.push("-x", PROXY);
  curl.push(`${ENDPOINT}?to=${encodeURIComponent(to)}&api-version=3.0`);
  const raw = execFileSync("curl", curl, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error(`返回不是 JSON: ${raw.slice(0, 160)}`);
  }
  if (!Array.isArray(json)) throw new Error(`接口异常: ${raw.slice(0, 200)}`);
  return json.map((x) => x?.translations?.[0]?.text ?? "（该行未译出）");
}

const out = [];
for (let i = 0; i < lines.length; i += 25) {
  const batch = lines.slice(i, i + 25);
  try {
    out.push(...(await translate(batch)));
  } catch (error) {
    out.push(...batch.map(() => `（失败: ${error.message}）`));
  }
}

if (lines.length === 1) console.log(out[0]);
else out.forEach((t, i) => console.log(`${t}\n    └ ${lines[i]}`));
