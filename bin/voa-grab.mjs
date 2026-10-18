#!/usr/bin/env node
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { basename } from "node:path";

const PROXY = process.env.VOA_PROXY || "http://127.0.0.1:7890";

function curlGet(url, proxy, binary) {
  const args = ["-sL", "--max-time", binary ? "180" : "30"];
  if (proxy) args.push("-x", proxy);
  args.push(url);
  return execFileSync("curl", args, {
    maxBuffer: 64 * 1024 * 1024,
    encoding: binary ? "buffer" : "utf8",
  });
}

const usage = `用法: node voa-grab.mjs <VOA 课文 URL> [选项]

  -o, --out <目录>   输出目录，默认 ~/English/voa
      --no-audio     只抽文本，不下音频
      --no-proxy     不走代理（默认走 ${PROXY}，可用 VOA_PROXY 覆盖）
      --sent <n>     每句一行（默认）；--para 改为每段一行
`;

function parseArgs(argv) {
  const o = { out: `${process.env.HOME}/English/voa`, audio: true, mode: "sent" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") {
      console.log(usage);
      process.exit(0);
    } else if (a === "-o" || a === "--out") o.out = argv[++i];
    else if (a === "--no-audio") o.audio = false;
    else if (a === "--no-proxy") o.noProxy = true;
    else if (a === "--para") o.mode = "para";
    else if (!a.startsWith("-") && !o.url) o.url = a;
    else throw new Error(`未知参数 ${a}`);
  }
  if (!o.url) throw new Error(`缺少 URL\n${usage}`);
  return o;
}

function slugOf(url) {
  const file = basename(new URL(url).pathname).replace(/\.html?$/, "");
  return file.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 60) || "lesson";
}

function decode(s) {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<");
}

function strip(html) {
  return decode(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " "),
  ).trim();
}

const NOISE = [/^no media source currently available$/i, /^download$/i, /^share$/i, /^embed$/i, /^related words$/i];

function isNoise(text) {
  const t = text.replace(/^["”“\s]+|["”“\s.!?]+$/g, "");
  return NOISE.some((re) => re.test(t.trim()));
}

function paragraphs(html) {
  const start = html.search(/class="[^"]*\bwsw\b/);
  const scope = start >= 0 ? html.slice(start, start + 200000) : html;
  const out = [];
  for (const m of scope.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)) {
    const text = strip(m[1]);
    if (text.length > 20 && !isNoise(text)) out.push(text);
  }
  return out;
}

function sentences(paras) {
  const out = [];
  for (const p of paras) {
    const parts = p.match(/[^.!?]+[.!?]+(?:\s|$)|[^.!?]+$/g) ?? [p];
    for (const s of parts) {
      const t = s.trim();
      if (t.split(" ").length >= 3) out.push(t);
    }
  }
  return out;
}

function audioUrls(html) {
  const found = [...new Set([...html.matchAll(/https:\/\/[^"'\\\s]+?\.mp3/gi)].map((m) => m[0]))];
  const byStem = new Map();
  for (const url of found) {
    const name = url.split("/").pop().replace(/\.mp3$/i, "");
    const stem = name.replace(/[_-](hq|mobile|low|med|audio)\b/i, "").replace(/[_-]\d+$/, "");
    const prev = byStem.get(stem);
    if (!prev || /_hq/i.test(name)) byStem.set(stem, url);
  }
  return [...byStem.values()];
}

const opts = parseArgs(process.argv.slice(2));
if (!/^https?:\/\//.test(opts.url)) throw new Error("URL 必须以 http(s):// 开头");
const proxy = opts.noProxy ? "" : PROXY;

let html;
try {
  html = curlGet(opts.url, proxy, false);
} catch (error) {
  throw new Error(
    `页面抓取失败${proxy ? `（代理 ${proxy}）` : ""}：${error.message}\n` +
      `代理不通就加 --no-proxy，或用 VOA_PROXY=http://127.0.0.1:端口 覆盖`,
  );
}

const title = strip((html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) ?? [])[1] ?? "") || slugOf(opts.url);
const paras = paragraphs(html);
if (paras.length === 0)
  throw new Error("没抽到正文，这个页面可能不是 VOA 课文页");

const lines = opts.mode === "sent" ? sentences(paras) : paras;
const slug = slugOf(opts.url);
await mkdir(opts.out, { recursive: true });

const txtPath = `${opts.out}/${slug}.txt`;
await writeFile(txtPath, `${lines.join("\n")}\n`, "utf8");
console.log(`课文: ${title}`);
console.log(`  ${paras.length} 段 / ${lines.length} 行 → ${txtPath}`);

if (opts.audio) {
  const urls = audioUrls(html);
  if (urls.length === 0) console.log("  页面里没有 MP3 直链，跳过下载");
  for (const [i, u] of urls.slice(0, 2).entries()) {
    let buf;
    try {
      buf = Buffer.from(curlGet(u, proxy, true));
    } catch (error) {
      console.log(`  音频下载失败: ${error.message}`);
      continue;
    }
    if (buf.length < 1024) {
      console.log(`  音频太小(${buf.length}B)，跳过: ${u}`);
      continue;
    }
    const mp3Path = `${opts.out}/${slug}${urls.length > 1 ? `-${i + 1}` : ""}.mp3`;
    await writeFile(mp3Path, buf);
    console.log(`  音频 ${(buf.length / 1024 / 1024).toFixed(1)} MB → ${mp3Path}`);
  }
}

console.log(`\n下一步: node ~/scripts/bilingual-subtitle.mjs ${txtPath} --md --title "${title}"`);
