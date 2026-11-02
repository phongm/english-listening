// 只给 ting-sync 用的翻译通道；保持 tr.mjs / bilingual-subtitle.mjs 原样。
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const ENDPOINT = "https://edge.microsoft.com/translate/translatetext";

export async function translateLines(lines, opts = {}) {
  const {
    to = "zh-Hans",
    proxy = process.env.TR_PROXY || "",
    timeout = 40,
    textType = "",
  } = opts;
  if (!Array.isArray(lines) || lines.length === 0) return [];

  const args = [
    "-sS",
    "--max-time",
    String(timeout),
    "-f",
    "-X",
    "POST",
    "-H",
    "Content-Type: application/json",
    "--data-binary",
    JSON.stringify(lines),
  ];
  if (proxy) args.push("-x", proxy);
  const endpoint = new URL(`${ENDPOINT}?api-version=3.0`);
  endpoint.searchParams.set("to", to);
  if (textType) endpoint.searchParams.set("textType", textType);
  args.push(endpoint.toString());

  let stdout;
  try {
    ({ stdout } = await execFileAsync("curl", args, { maxBuffer: 8 * 1024 * 1024 }));
  } catch (error) {
    const detail = (error.stderr || error.message || "").toString().trim().slice(0, 200);
    throw new Error(`翻译请求失败: ${detail}`);
  }

  let json;
  try {
    json = JSON.parse(stdout);
  } catch {
    throw new Error(`翻译返回不是 JSON: ${stdout.slice(0, 120)}`);
  }
  if (!Array.isArray(json) || json.length !== lines.length) {
    throw new Error(`翻译返回条数 ${json?.length} 与请求 ${lines.length} 不符`);
  }
  return json.map((item) => item?.translations?.[0]?.text ?? null);
}

export function batchBySize(items, maxLines = 25, maxChars = 3800) {
  const batches = [];
  let cur = [];
  let chars = 0;
  for (const item of items) {
    const len = (item.text ?? "").length;
    if (cur.length > 0 && (cur.length >= maxLines || chars + len > maxChars)) {
      batches.push(cur);
      cur = [];
      chars = 0;
    }
    cur.push(item);
    chars += len;
  }
  if (cur.length) batches.push(cur);
  return batches;
}
