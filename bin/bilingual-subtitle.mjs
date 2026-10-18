#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { basename, extname } from "node:path";

const ENDPOINT = "https://edge.microsoft.com/translate/translatetext";
const MAX_LINES_PER_REQUEST = 25;
const MAX_CHARS_PER_REQUEST = 5000;
const GAP_MS = 250;

const usage = `用法: node bilingual-subtitle.mjs <文件> [选项]

  输入: .lrc .srt .vtt .txt
  -o, --out <路径>   输出前缀（默认同名）
  -t, --to <语言>    目标语言，默认 zh-Hans
      --md           只出 Markdown 对照（默认会同时尝试）
      --lrc          只出双语 LRC
      --title <文本>  写在对照表标题上（配合 voa-grab 使用）
      --dry-run      只解析并显示会发多少次请求，不联网
`;

function parseArgs(argv) {
  const opts = { to: "zh-Hans", formats: ["md", "lrc"], dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") {
      console.log(usage);
      process.exit(0);
    } else if (a === "-t" || a === "--to") opts.to = argv[++i];
    else if (a === "--title") opts.title = argv[++i];
    else if (a === "-o" || a === "--out") opts.out = argv[++i];
    else if (a === "--md") opts.formats = ["md"];
    else if (a === "--lrc") opts.formats = ["lrc"];
    else if (a === "--dry-run") opts.dryRun = true;
    else if (!a.startsWith("-") && !opts.input) opts.input = a;
    else throw new Error(`未知参数: ${a}`);
  }
  if (!opts.input) throw new Error(`缺少输入文件\n${usage}`);
  return opts;
}

const toSeconds = (m, s, f) =>
  Number(m) * 60 + Number(s) + Number("0." + (f || "0"));

function stamp(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${String(m).padStart(2, "0")}:${s.toFixed(2).padStart(5, "0")}`;
}

function parseLrc(raw) {
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    const tags = [...line.matchAll(/\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g)];
    if (tags.length === 0) continue;
    const text = line.replace(/\[[^\]]*\]/g, "").trim();
    if (!text) continue;
    for (const t of tags)
      out.push({ time: toSeconds(t[1], t[2], t[3]), text });
  }
  return out;
}

function parseCues(raw) {
  const out = [];
  const blocks = raw.replace(/\r\n?/g, "\n").split("\n\n");
  for (const block of blocks) {
    const lines = block.split("\n").filter((l) => l.trim() !== "");
    const idx = lines.findIndex((l) => l.includes("-->"));
    if (idx === -1) continue;
    const start = lines[idx].split("-->")[0].trim().split(",")[0];
    const parts = start.split(":").map(Number);
    const seconds =
      parts.length === 3
        ? parts[0] * 3600 + parts[1] * 60 + parts[2]
        : parts[0] * 60 + parts[1];
    const text = lines
      .slice(idx + 1)
      .join(" ")
      .replace(/<[^>]*>/g, "")
      .trim();
    if (text) out.push({ time: seconds, text });
  }
  return out;
}

function parseSegments(segments) {
  return segments.filter((s) => /\S/.test(s.text));
}

function chunk(segments) {
  const batches = [];
  let cur = [];
  let chars = 0;
  for (const s of segments) {
    const over =
      cur.length >= MAX_LINES_PER_REQUEST ||
      chars + s.text.length > MAX_CHARS_PER_REQUEST;
    if (cur.length > 0 && over) {
      batches.push(cur);
      cur = [];
      chars = 0;
    }
    cur.push(s);
    chars += s.text.length;
  }
  if (cur.length) batches.push(cur);
  return batches;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function translateBatch(lines, to) {
  const body = JSON.stringify(lines.map((text) => text));
  const url = `${ENDPOINT}?to=${encodeURIComponent(to)}&api-version=3.0`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  if (!Array.isArray(json) || json.length !== lines.length)
    throw new Error(`返回条数 ${json?.length} 与请求 ${lines.length} 不符`);
  return json.map((item) => item?.translations?.[0]?.text ?? null);
}

async function translate(segments, to) {
  const batches = chunk(segments);
  const translated = new Array(segments.length).fill(null);
  let offset = 0;
  let failed = 0;
  for (const batch of batches) {
    const texts = batch.map((s) => s.text);
    process.stderr.write(
      `  第 ${offset + 1}-${offset + texts.length} 段 (${batches.indexOf(batch) + 1}/${batches.length})\n`,
    );
    let result = null;
    for (let attempt = 1; attempt <= 2 && result === null; attempt++) {
      try {
        result = await translateBatch(texts, to);
      } catch (error) {
        if (attempt === 2) {
          failed += texts.length;
          process.stderr.write(`  失败: ${error.message}\n`);
          result = texts.map(() => null);
        } else await sleep(1200);
      }
    }
    result.forEach((value, i) => (translated[offset + i] = value));
    offset += texts.length;
    if (offset < segments.length) await sleep(GAP_MS);
  }
  return { translated, batches: batches.length, failed };
}

function renderMarkdown(segments, translated, to, title) {
  const head = [
    `# ${title ?? "双语对照"}`,
    ``,
    `- 目标语言: ${to}`,
    `- 段数: ${segments.length}`,
    `- 未译出: ${translated.filter((t) => t === null).length}`,
    ``,
    `| # | 时间点 | 原文 | 译文 |`,
    `| --- | --- | --- | --- |`,
  ];
  const rows = segments.map((s, i) => {
    const time = s.time === undefined ? "" : stamp(s.time);
    const esc = (v) => (v ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
    return `| ${i + 1} | ${esc(time)} | ${esc(s.text)} | ${esc(translated[i])} |`;
  });
  return [...head, ...rows, ""].join("\n");
}

function renderBilingualLrc(segments, translated) {
  const lines = [];
  segments.forEach((s, i) => {
    if (s.time === undefined) return;
    const tag = `[${stamp(s.time)}]`;
    lines.push(`${tag}${s.text}`);
    if (translated[i]) lines.push(`${tag}${translated[i]}`);
  });
  return lines.join("\n") + "\n";
}

const opts = parseArgs(process.argv.slice(2));
const raw = await readFile(opts.input, "utf8");
const ext = extname(opts.input).toLowerCase().replace(".", "");
const timed = ext === "lrc" || ext === "srt" || ext === "vtt";
const segments = parseSegments(
  ext === "lrc"
    ? parseLrc(raw)
    : timed
      ? parseCues(raw)
      : raw
          .split(/\r?\n/)
          .map((line) => ({ time: undefined, text: line.trim() }))
          .filter((s) => s.text),
);

if (segments.length === 0) throw new Error("没有解析到任何可翻译的文本行");

const batches = chunk(segments);
console.log(
  `${basename(opts.input)} [${ext || "txt"}] → ${segments.length} 段 / ${batches.length} 次请求`,
);

if (opts.dryRun) {
  console.log("dry-run，未联网。前 3 段:");
  segments.slice(0, 3).forEach((s, i) => console.log(`  ${i + 1}. ${s.text}`));
  process.exit(0);
}

const { translated, failed } = await translate(segments, opts.to);
const prefix = opts.out ?? opts.input.replace(/\.([^.]+)$/, "");
const written = [];

if (opts.formats.includes("md")) {
  const path = `${prefix}.对照.md`;
  await writeFile(
    path,
    renderMarkdown(segments, translated, opts.to, opts.title),
    "utf8",
  );
  written.push(path);
}

if (opts.formats.includes("lrc")) {
  if (timed) {
    const path = `${prefix}.双语.lrc`;
    await writeFile(path, renderBilingualLrc(segments, translated), "utf8");
    written.push(path);
  } else {
    console.log("无时间轴，跳过双语 LRC");
  }
}

console.log(`译文 ${translated.filter((t) => t !== null).length}/${segments.length}${failed ? `，失败 ${failed}` : ""}`);
written.forEach((p) => console.log(`  → ${p}`));
if (failed) process.exitCode = 1;
