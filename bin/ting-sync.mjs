#!/usr/bin/env node
// ting-sync: 读取每日英语听力的播放进度，按句推送双语字幕。
// 只读当前课文页（tmp 明文 HTML）和 <video>.currentTime，不碰加密缓存/音频/VIP 译文。
import { createServer } from "node:http";
import { connect as netConnect } from "node:net";
import { createHash, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdirSync, readFileSync, writeFileSync, renameSync, existsSync,
} from "node:fs";
import { stat, readFile } from "node:fs/promises";
import { watchFile, unwatchFile } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { translateLines } from "./lib/edge-translate.mjs";

const execFileAsync = promisify(execFile);
const HOME = process.env.HOME;
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const CONF_PATH = process.env.TING_SYNC_CONF || join(HOME, "English/ting-sync.conf");

function loadConfig() {
  const conf = {
    TEMP_HTML: join(HOME, "Library/Application Support/ting_en/ting/tmp/temp/index.html"),
    CDP_PORT: "9333",
    WEB_PORT: "8787",
    CACHE_DIR: join(HOME, "English/ting-cache"),
    TR_PROXY: process.env.TR_PROXY || "",
  };
  try {
    for (const line of readFileSync(CONF_PATH, "utf8").split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
      if (!m) continue;
      let value = m[2].trim();
      if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
      conf[m[1]] = value.replace(/^\$HOME\//, `${HOME}/`).replace(/^~\//, `${HOME}/`);
    }
  } catch {}
  if (process.env.TING_TEMP_HTML) conf.TEMP_HTML = process.env.TING_TEMP_HTML;
  if (process.env.TING_CDP_PORT) conf.CDP_PORT = process.env.TING_CDP_PORT;
  if (process.env.TING_WEB_PORT) conf.WEB_PORT = process.env.TING_WEB_PORT;
  if (process.env.TING_CACHE_DIR) conf.CACHE_DIR = process.env.TING_CACHE_DIR;
  if (process.env.TR_PROXY) conf.TR_PROXY = process.env.TR_PROXY;
  return conf;
}

const conf = loadConfig();
const args = process.argv.slice(2);
const MODE = args.includes("--follow") ? "follow"
  : args.includes("--probe") ? "probe"
  : args.includes("--selftest") ? "selftest"
  : "serve";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...parts) => console.error(`[ting-sync ${new Date().toLocaleTimeString("en-GB")}]`, ...parts);
const hashText = (text) => createHash("sha1").update(text).digest("hex").slice(0, 16);
const fmtTime = (sec) => {
  const s = Math.max(0, Number(sec) || 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = Math.floor(s % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`
    : `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
};

// ---------- 课文 HTML 解析 ----------

function decodeEntities(text) {
  const map = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (all, ent) => {
    if (ent[0] === "#") {
      const hex = ent[1]?.toLowerCase() === "x";
      const code = hex ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : all;
    }
    return map[ent.toLowerCase()] ?? all;
  });
}

function cleanSentenceText(inner) {
  return decodeEntities(inner.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
}

function attr(tag, name) {
  const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i").exec(tag);
  return m ? (m[2] ?? m[3]) : null;
}

function parseTimestamp(value) {
  if (!value) return NaN;
  const parts = value.trim().split(":").map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return NaN;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return NaN;
}

function extractSentenceSpans(html) {
  const out = [];
  const openRe = /<span\b[^>]*>/gi;
  let m;
  while ((m = openRe.exec(html))) {
    const tag = m[0];
    if (!/\bclass\s*=\s*(["'])[^"']*\bsentence\b[^"']*\1/i.test(tag)) continue;
    const innerStart = openRe.lastIndex;
    const scanRe = /<span\b[^>]*>|<\/span\s*>/gi;
    scanRe.lastIndex = innerStart;
    let depth = 1;
    let end = -1;
    let t;
    while ((t = scanRe.exec(html))) {
      if (t[0][1] === "/") {
        depth -= 1;
        if (depth === 0) {
          end = t.index;
          break;
        }
      } else depth += 1;
    }
    if (end === -1) break;
    out.push({ tag, inner: html.slice(innerStart, end) });
    openRe.lastIndex = end + 7;
  }
  return out;
}

function parseArticle(html) {
  const h1 = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
  let title = h1 ? cleanSentenceText(h1[1]) : "";
  if (!title) {
    const t = /<title>([\s\S]*?)<\/title>/i.exec(html);
    title = t ? cleanSentenceText(t[1]).replace(/^English Listening\s*-\s*/i, "") : "";
  }

  const cues = [];
  for (const { tag, inner } of extractSentenceSpans(html)) {
    const start = parseTimestamp(attr(tag, "data-startTime"));
    const end = parseTimestamp(attr(tag, "data-endTime"));
    const text = cleanSentenceText(inner);
    if (!text || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    cues.push({ start, end, text });
  }
  cues.sort((a, b) => a.start - b.start);
  cues.forEach((cue, i) => {
    cue.i = i;
    cue.hash = hashText(cue.text);
  });

  const summaryMatch = /<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/i.exec(html);
  const summary = summaryMatch ? cleanSentenceText(summaryMatch[1]) : "";

  return {
    title,
    summary,
    cues,
    signature: hashText(cues.map((c) => `${c.start}:${c.end}:${c.text}`).join("\n") + title),
  };
}

async function readStableArticle(file) {
  try {
    const before = await stat(file);
    if (!before.size) return null;
    const text = await readFile(file, "utf8");
    if (!text.includes("</html>")) return null;
    const after = await stat(file);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) return null;
    return { text, mtimeMs: after.mtimeMs, size: after.size };
  } catch {
    return null;
  }
}

function cueIndexAt(cues, t) {
  if (!cues.length) return -1;
  let lo = 0;
  let hi = cues.length - 1;
  let answer = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cues[mid].start <= t) {
      answer = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return answer;
}

function uuidFromSrc(src) {
  if (!src) return "";
  const m = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(src);
  return m ? m[1] : "";
}

function cuesFitDuration(cues, duration) {
  if (!cues.length) return false;
  if (!duration || duration < 1) return true;
  const maxEnd = cues[cues.length - 1].end;
  const minReasonable = duration * 0.65;
  const lateTolerance = Math.max(20, duration * 0.12);
  const earlyTolerance = Math.max(5, duration * 0.02);
  return maxEnd >= minReasonable && maxEnd <= duration + earlyTolerance && duration - maxEnd <= lateTolerance;
}

function loadCache(file) {
  try {
    const json = JSON.parse(readFileSync(file, "utf8"));
    return new Map(Object.entries(json.entries || {}));
  } catch {
    return new Map();
  }
}

const WORD_RE = /[A-Za-z]+(?:['’\-][A-Za-z]+)*/g;
const wordKey = (word) => word.toLowerCase().replace(/’/g, "'");
const tokenizeWords = (text) => String(text || "").match(WORD_RE) || [];

function loadWordCache(file) {
  try {
    const json = JSON.parse(readFileSync(file, "utf8"));
    const entries = json?.entries && typeof json.entries === "object" ? json.entries : {};
    return new Map(
      Object.entries(entries).filter(([, value]) => typeof value === "string" && value),
    );
  } catch {
    return new Map();
  }
}

function loadDictCache(file) {
  try {
    const json = JSON.parse(readFileSync(file, "utf8"));
    const entries = json?.entries && typeof json.entries === "object" ? json.entries : {};
    const map = new Map();
    for (const [word, value] of Object.entries(entries)) {
      if (!value || !Array.isArray(value.defs)) continue;
      map.set(word, {
        zh: typeof value.zh === "string" ? value.zh : "",
        defs: value.defs
          .filter((item) => item && typeof item.text === "string" && item.text)
          .slice(0, 2)
          .map((item) => ({
            pos: typeof item.pos === "string" ? item.pos : "",
            text: item.text,
          })),
      });
    }
    return map;
  } catch {
    return new Map();
  }
}

function parseYoudaoDefs(json) {
  const trs = json?.ec?.word?.[0]?.trs;
  if (!Array.isArray(trs)) return [];
  const defs = [];
  for (const entry of trs) {
    const items = Array.isArray(entry?.tr) ? entry.tr : [];
    let text = items
      .map((item) => (Array.isArray(item?.l?.i) ? item.l.i.join("") : ""))
      .join("；")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) continue;
    const m = /^([a-z]{1,5}\.)\s*/i.exec(text);
    const pos = m ? m[1].toLowerCase() : "";
    if (m) text = text.slice(m[0].length);
    const clipped = text.length > 90
      ? `${text.slice(0, 90).replace(/[，,；;：:、\s]+$/, "")}…`
      : text;
    defs.push({ pos, text: clipped });
    if (defs.length >= 2) break;
  }
  return defs;
}

function tokenizeWithIndices(text) {
  const tokens = [];
  WORD_RE.lastIndex = 0;
  let match;
  while ((match = WORD_RE.exec(text))) {
    tokens.push({
      index: tokens.length,
      word: match[0],
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  return tokens;
}

function buildTaggedChunks(text, maxTokens = 12) {
  const tokens = tokenizeWithIndices(text);
  if (!tokens.length) return [];
  const chunks = [];
  let current = [];
  let start = 0;
  const flush = (end) => {
    if (!current.length) return;
    const raw = text.slice(start, end);
    let offset = 0;
    const tagged = raw.replace(WORD_RE, (word) => {
      const token = current[offset];
      offset += 1;
      if (!token) return word;
      return `<t${token.index}>${word}</t${token.index}>`;
    });
    chunks.push(tagged);
    current = [];
    start = end;
  };
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    current.push(token);
    const nextStart = tokens[i + 1]?.start ?? text.length;
    const gap = text.slice(token.end, nextStart);
    if (current.length >= maxTokens || /[.!?;:]/.test(gap)) flush(nextStart);
  }
  if (current.length) flush(text.length);
  return chunks;
}

function parseAlignedTranslation(text, count) {
  const parts = Array(count).fill("");
  const segments = [];
  if (!text || !count) return { parts, segments };
  const tagRe = /<t(\d+)>([\s\S]*?)<\/t\1>/g;
  let last = 0;
  let match;
  const pushNeutral = (raw) => {
    const value = String(raw || "").replace(/\s+/g, " ").trim();
    if (value) segments.push({ i: null, text: value });
  };
  while ((match = tagRe.exec(text))) {
    pushNeutral(text.slice(last, match.index));
    const index = Number(match[1]);
    const value = String(match[2] || "").replace(/\s+/g, " ").trim();
    if (Number.isInteger(index) && index >= 0 && index < count) {
      parts[index] = parts[index] ? `${parts[index]} ${value}`.trim() : value;
      if (value) segments.push({ i: index, text: value });
    } else if (value) {
      pushNeutral(value);
    }
    last = tagRe.lastIndex;
  }
  pushNeutral(text.slice(last));
  return { parts, segments };
}

function normalizeAlignEntry(value) {
  if (Array.isArray(value)) {
    const parts = value.slice(0, 120).map((item) => (typeof item === "string" ? item.replace(/\s+/g, " ").trim() : ""));
    const segments = parts.map((text, i) => ({ i, text })).filter((item) => item.text);
    return { parts, segments };
  }
  if (!value || typeof value !== "object") return null;
  const parts = Array.isArray(value.parts)
    ? value.parts.slice(0, 120).map((item) => (typeof item === "string" ? item.replace(/\s+/g, " ").trim() : ""))
    : [];
  const segments = Array.isArray(value.segments)
    ? value.segments
      .filter((item) => item && typeof item.text === "string" && item.text.trim())
      .map((item) => ({
        i: Number.isInteger(item.i) && item.i >= 0 && item.i < parts.length ? item.i : null,
        text: item.text.replace(/\s+/g, " ").trim(),
      }))
    : [];
  if (!parts.some(Boolean) && !segments.length) return null;
  return { parts, segments };
}

function loadAlignCache(file) {
  try {
    const json = JSON.parse(readFileSync(file, "utf8"));
    const entries = json?.entries && typeof json.entries === "object" ? json.entries : {};
    const map = new Map();
    for (const [hash, value] of Object.entries(entries)) {
      const normalized = normalizeAlignEntry(value);
      if (normalized) map.set(hash, normalized);
    }
    return map;
  } catch {
    return new Map();
  }
}

// ---------- 最小 WebSocket 客户端（避免依赖 npm / Node 22） ----------

class MiniWebSocket extends EventEmitter {
  constructor(url) {
    super();
    this.url = url;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.fragment = null;
    this.closed = false;
  }

  connect(timeoutMs = 5000) {
    return new Promise((resolvePromise, rejectPromise) => {
      const url = new URL(this.url);
      const socket = netConnect({ host: url.hostname, port: Number(url.port) });
      this.socket = socket;
      socket.setNoDelay(true);
      let handshake = Buffer.alloc(0);
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        socket.destroy();
        rejectPromise(new Error(`WebSocket 握手超时: ${this.url}`));
      }, timeoutMs);

      socket.on("connect", () => {
        const key = randomBytes(16).toString("base64");
        socket.write(
          `GET ${url.pathname}${url.search} HTTP/1.1\r\n` +
            `Host: ${url.host}\r\n` +
            "Upgrade: websocket\r\n" +
            "Connection: Upgrade\r\n" +
            `Sec-WebSocket-Key: ${key}\r\n` +
            "Sec-WebSocket-Version: 13\r\n\r\n",
        );
      });

      socket.on("data", (chunk) => {
        if (!settled) {
          handshake = Buffer.concat([handshake, chunk]);
          const end = handshake.indexOf("\r\n\r\n");
          if (end === -1) return;
          const head = handshake.subarray(0, end).toString("latin1");
          if (!/^HTTP\/1\.1 101/i.test(head)) {
            settled = true;
            clearTimeout(timer);
            socket.destroy();
            rejectPromise(new Error(`WebSocket 握手失败: ${head.split("\r\n")[0]}`));
            return;
          }
          settled = true;
          clearTimeout(timer);
          resolvePromise(this);
          this.emit("open");
          const rest = handshake.subarray(end + 4);
          if (rest.length) this.feed(rest);
        } else {
          this.feed(chunk);
        }
      });

      socket.on("error", (error) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          rejectPromise(error);
        }
        this.finish();
      });
      socket.on("close", () => this.finish());
    });
  }

  finish() {
    if (this.closed) return;
    this.closed = true;
    this.emit("close");
  }

  send(text) {
    if (this.closed || !this.socket) return;
    this.writeFrame(0x1, Buffer.from(text));
  }

  writeFrame(opcode, payload) {
    const length = payload.length;
    let header;
    if (length < 126) {
      header = Buffer.from([0x80 | opcode, 0x80 | length]);
    } else if (length < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(length), 2);
    }
    const mask = randomBytes(4);
    const masked = Buffer.alloc(length);
    for (let i = 0; i < length; i++) masked[i] = payload[i] ^ mask[i % 4];
    try {
      this.socket.write(Buffer.concat([header, mask, masked]));
    } catch {
      this.finish();
    }
  }

  feed(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const buf = this.buffer;
      if (buf.length < 2) return;
      const first = buf[0];
      const second = buf[1];
      const fin = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buf.length < 4) return;
        length = buf.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buf.length < 10) return;
        length = Number(buf.readBigUInt64BE(2));
        offset = 10;
      }
      let mask = null;
      if (masked) {
        if (buf.length < offset + 4) return;
        mask = buf.subarray(offset, offset + 4);
        offset += 4;
      }
      if (buf.length < offset + length) return;
      let payload = Buffer.from(buf.subarray(offset, offset + length));
      if (mask) for (let i = 0; i < length; i++) payload[i] ^= mask[i % 4];
      this.buffer = buf.subarray(offset + length);

      if (opcode === 0x8) {
        this.finish();
        try {
          this.socket.end();
        } catch {}
        return;
      }
      if (opcode === 0x9) {
        this.writeFrame(0xa, payload);
        continue;
      }
      if (opcode === 0xa) continue;
      if (opcode === 0x1 || opcode === 0x0) {
        this.fragment = this.fragment ? Buffer.concat([this.fragment, payload]) : payload;
        if (fin) {
          const text = this.fragment.toString("utf8");
          this.fragment = null;
          this.emit("message", text);
        }
      }
    }
  }

  close() {
    this.finish();
    try {
      this.socket?.end();
    } catch {}
  }
}

class Cdp {
  constructor(wsUrl) {
    this.ws = new MiniWebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.closed = false;
    this.ws.on("message", (text) => {
      let message;
      try {
        message = JSON.parse(text);
      } catch {
        return;
      }
      if (!message.id || !this.pending.has(message.id)) return;
      const entry = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
      else entry.resolve(message.result);
    });
    this.ws.on("close", () => {
      this.closed = true;
      for (const entry of this.pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error("CDP 连接已关闭"));
      }
      this.pending.clear();
    });
  }

  async open() {
    await this.ws.connect();
    return this;
  }

  send(method, params = {}, timeoutMs = 6000) {
    if (this.closed) return Promise.reject(new Error("CDP 未连接"));
    const id = ++this.id;
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectPromise(new Error(`CDP 超时: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        timer,
        resolve: resolvePromise,
        reject: rejectPromise,
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression, timeoutMs = 6000) {
    const result = await this.send(
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise: true },
      timeoutMs,
    );
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text || "页面脚本执行失败");
    }
    return result.result?.value;
  }

  close() {
    this.ws.close();
  }
}

const VIDEO_PROBE = `(() => {
  const v = document.querySelector('video');
  if (!v) return null;
  return {
    t: Number(v.currentTime) || 0,
    d: Number(v.duration) || 0,
    paused: !!v.paused,
    rate: Number(v.playbackRate) || 1,
    src: v.currentSrc || v.src || '',
  };
})()`;

function targetScore(target) {
  let score = 0;
  if (target.type === "page") score += 2;
  if (/app\.asar/.test(target.url || "")) score += 2;
  if (/tmp\/temp/.test(target.url || "")) score -= 2;
  if (/background\.html/.test(target.url || "")) score -= 10;
  return score;
}

async function listTargets(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
    signal: AbortSignal.timeout(3000),
  });
  if (!response.ok) throw new Error(`CDP HTTP ${response.status}`);
  return response.json();
}

async function connectVideo(port) {
  const targets = await listTargets(port);
  const candidates = targets
    .filter((t) => t.type === "page" || t.type === "webview")
    .filter((t) => t.webSocketDebuggerUrl)
    .sort((a, b) => targetScore(b) - targetScore(a));

  for (const target of candidates) {
    let cdp = null;
    try {
      cdp = new Cdp(target.webSocketDebuggerUrl);
      await cdp.open();
      const video = await cdp.evaluate(VIDEO_PROBE, 3000);
      if (video) {
        return { cdp, targetId: target.id, target, video };
      }
      cdp.close();
    } catch {
      try {
        cdp?.close();
      } catch {}
    }
  }
  return null;
}

// ---------- 同步控制器 ----------

class Sync {
  constructor(options = {}) {
    this.options = options;
    this.cdpInfo = null;
    this.video = null;
    this.article = null;
    this.fileSignature = null;
    this.zh = new Map();
    this.cachePath = null;
    this.generation = 0;
    this.clients = new Set();
    this.translating = false;
    this.cursor = 0;
    this.failures = new Map();
    this.lastCdpAttempt = 0;
    this.lastAppCheck = 0;
    this.appRunning = false;
    this.videoProbeFailures = 0;
    this.lastBroadcastAt = 0;
    this.lastBroadcastKey = "";
    this.saveTimer = null;
    this.tickTimer = null;
    this.lastStaleLog = 0;
    this.followPrintedIdx = -1;
    this.followPrintedZh = false;
    this.words = new Map();
    this.wordCachePath = join(conf.CACHE_DIR, "words.json");
    this.wordFailures = new Map();
    this.wordTranslating = false;
    this.wordSaveTimer = null;
    this.wordVersion = 0;
    this.lastWordAttempt = 0;
    this.dicts = new Map();
    this.dictCachePath = join(conf.CACHE_DIR, "dicts.json");
    this.dictPending = new Map();
    this.dictSaveTimer = null;
    this.align = new Map();
    this.alignCachePath = join(conf.CACHE_DIR, "alignments.json");
    this.alignPending = new Map();
    this.alignSaveTimer = null;
    this.timeOffset = 0;
    this.boundDuration = 0;
    this.vocabPath = join(conf.CACHE_DIR, "vocabulary.json");
    this.state = {
      status: "booting",
      message: "启动中",
      title: "",
      summary: "",
      idx: 0,
      total: 0,
      en: "",
      zh: "",
      words: {},
      align: null,
      nextEn: "",
      nextZh: "",
      t: 0,
      mediaT: 0,
      d: 0,
      paused: true,
      rate: 1,
      timeOffset: 0,
      cueStart: 0,
      cueEnd: 0,
      cueCount: 0,
      updatedAt: Date.now(),
    };
  }

  setStatus(status, message) {
    if (this.state.status === status && this.state.message === message) return;
    this.state.status = status;
    this.state.message = message;
    this.state.updatedAt = Date.now();
    this.broadcast(true);
  }

  async init() {
    mkdirSync(conf.CACHE_DIR, { recursive: true });
    this.words = loadWordCache(this.wordCachePath);
    this.dicts = loadDictCache(this.dictCachePath);
    this.align = loadAlignCache(this.alignCachePath);
    await this.loadArticle(true);
    watchFile(conf.TEMP_HTML, { interval: 1000 }, (now, before) => {
      if (now.mtimeMs === before.mtimeMs && now.size === before.size) return;
      this.loadArticle(true).catch((error) => log("读取课文失败:", error.message));
    });
    this.tickTimer = setInterval(() => {
      this.tick().catch((error) => log("tick 失败:", error.message));
    }, 250);
    await this.tick();
    log(
      `已启动 | CDP ${conf.CDP_PORT} | 课文 ${conf.TEMP_HTML} | 缓存 ${conf.CACHE_DIR}`,
    );
  }

  async loadArticle(force = false) {
    const data = await readStableArticle(conf.TEMP_HTML);
    if (!data) {
      if (!this.article) this.setStatus("waiting-cues", "等待课文页…");
      return false;
    }
    if (
      !force &&
      this.fileSignature &&
      data.mtimeMs === this.fileSignature.mtimeMs &&
      data.size === this.fileSignature.size
    ) return false;

    this.fileSignature = { mtimeMs: data.mtimeMs, size: data.size };
    const parsed = parseArticle(data.text);
    if (!parsed.cues.length) {
      this.setStatus("waiting-cues", "课文页里没解析到带时间的句子");
      return false;
    }

    const previousKey = this.article?.key;
    this.generation += 1;
    this.article = {
      title: parsed.title,
      summary: parsed.summary,
      cues: parsed.cues,
      signature: parsed.signature,
      key: null,
      uuid: "",
    };
    this.zh = new Map();
    this.cachePath = null;
    this.cursor = 0;
    this.failures.clear();
    this.state.title = parsed.title;
    this.state.summary = parsed.summary;
    this.state.total = parsed.cues.length;
    this.state.cueCount = parsed.cues.length;
    this.state.idx = 0;
    this.state.en = "";
    this.state.zh = "";
    this.state.words = {};
    this.state.align = null;
    this.state.nextEn = "";
    this.state.nextZh = "";
    this.state.cueStart = 0;
    this.state.cueEnd = 0;
    this.followPrintedIdx = -1;
    this.followPrintedZh = false;
    this.setStatus("waiting-video", "课文已就绪，等待播放器");
    log(`课文: ${parsed.title || "(无标题)"} | ${parsed.cues.length} 句 | 缓存键 ${previousKey || "new"}`);
    return true;
  }

  bindArticleToVideo(video) {
    if (!this.article) return false;
    const uuid = uuidFromSrc(video.src);
    if (!cuesFitDuration(this.article.cues, video.d)) {
      if (Date.now() - this.lastStaleLog > 3000) {
        this.lastStaleLog = Date.now();
        const maxEnd = this.article.cues[this.article.cues.length - 1].end;
        log(
          `时间轴与音频不匹配（末句 ${maxEnd.toFixed(1)}s / 音频 ${Number(video.d).toFixed(1)}s），等待课文页更新`,
        );
      }
      this.setStatus("stale-cues", "正在切换课文…");
      return false;
    }

    const key =
      uuid ||
      hashText(
        `${this.article.title}|${Math.round(video.d || 0)}|${this.article.cues[0]?.text || ""}`,
      );
    if (this.article.key === key) return true;

    this.article.key = key;
    this.article.uuid = uuid;
    this.boundDuration = Number(video.d) || 0;
    this.cachePath = join(conf.CACHE_DIR, `${key}.json`);
    this.zh = loadCache(this.cachePath);
    this.cursor = cueIndexAt(this.article.cues, video.t);
    this.failures.clear();
    this.generation += 1;
    this.state.status = "ready";
    this.state.message = "";
    this.state.title = this.article.title;
    this.state.total = this.article.cues.length;
    this.state.cueCount = this.article.cues.length;
    const pretranslated = [...this.zh.keys()].length;
    log(
      `已绑定课文 uuid=${uuid || "(无)"} | 缓存 ${pretranslated}/${this.article.cues.length} 句 → ${this.cachePath}`,
    );
    this.startTranslation();
    this.ensureWordGlosses(true);
    return true;
  }

  async appIsRunning() {
    const now = Date.now();
    if (now - this.lastAppCheck < 3000) return this.appRunning;
    this.lastAppCheck = now;
    try {
      await execFileAsync("pgrep", ["-x", "每日英语听力"], { timeout: 2000 });
      this.appRunning = true;
    } catch {
      this.appRunning = false;
    }
    return this.appRunning;
  }

  async ensureCdp() {
    if (this.cdpInfo && !this.cdpInfo.cdp.closed) return true;
    if (Date.now() - this.lastCdpAttempt < 1500) return false;
    this.lastCdpAttempt = Date.now();
    try {
      const found = await connectVideo(conf.CDP_PORT);
      if (found) {
        this.cdpInfo = found;
        this.video = found.video;
        this.videoProbeFailures = 0;
        log(`已连接播放器目标: ${found.target.title || found.target.url}`);
        return true;
      }
      const running = await this.appIsRunning();
      if (running) {
        this.setStatus(
          "app-no-debug",
          "每日英语听力在运行，但没开同步端口；请用「每日英语听力·同步」图标启动",
        );
      } else {
        this.setStatus("waiting-app", "等待每日英语听力启动…");
      }
    } catch {
      const running = await this.appIsRunning();
      if (running) {
        this.setStatus(
          "app-no-debug",
          "每日英语听力在运行，但没开同步端口；请用「每日英语听力·同步」图标启动",
        );
      } else {
        this.setStatus("waiting-app", "等待每日英语听力启动…");
      }
    }
    return false;
  }

  async tick() {
    if (!this.article) await this.loadArticle();
    const connected = await this.ensureCdp();
    if (!connected || !this.cdpInfo) return;

    let video;
    try {
      video = await this.cdpInfo.cdp.evaluate(VIDEO_PROBE, 3000);
    } catch (error) {
      this.videoProbeFailures += 1;
      if (this.videoProbeFailures >= 3) {
        log("播放器连接失效，重新发现目标:", error.message);
        this.cdpInfo.cdp.close();
        this.cdpInfo = null;
        this.videoProbeFailures = 0;
      }
      return;
    }

    if (!video) {
      this.videoProbeFailures += 1;
      if (this.videoProbeFailures >= 8) {
        this.cdpInfo.cdp.close();
        this.cdpInfo = null;
        this.videoProbeFailures = 0;
      }
      this.setStatus("waiting-video", "等待音频开始播放…");
      return;
    }

    this.video = video;
    this.videoProbeFailures = 0;

    if (!this.article) {
      this.setStatus("waiting-cues", "等待课文页…");
      return;
    }

    const videoUuid = uuidFromSrc(video.src);
    if (this.article.key && videoUuid && this.article.uuid && videoUuid !== this.article.uuid) {
      this.article.key = null;
      this.article.uuid = "";
      this.setStatus("waiting-cues", "检测到切换课文，等待课文页更新…");
      return;
    }

    if (!this.article.key) {
      if (!this.bindArticleToVideo(video)) return;
    }

    if (this.article.key && !cuesFitDuration(this.article.cues, video.d)) {
      const maxEnd = this.article.cues[this.article.cues.length - 1]?.end || 0;
      if (Date.now() - this.lastStaleLog > 3000) {
        this.lastStaleLog = Date.now();
        log(`播放中检测到时间轴不再匹配（末句 ${maxEnd.toFixed(1)}s / 音频 ${Number(video.d).toFixed(1)}s）`);
      }
      this.article.key = null;
      this.article.uuid = "";
      this.boundDuration = 0;
      this.setStatus("stale-cues", "课文时间轴和当前音频不一致…");
      return;
    }

    this.boundDuration = Number(video.d) || this.boundDuration;

    this.updateFromVideo(video);
  }

  updateFromVideo(video) {
    const cues = this.article.cues;
    const mediaTime = Number(video.t) || 0;
    const timed = mediaTime + this.timeOffset;
    const idx = cueIndexAt(cues, timed);
    if (idx < 0) return;
    const current = cues[idx];
    const next = cues[idx + 1];
    const zh = this.zh.get(current.hash) || null;
    const previousIdx = this.state.idx;
    const previousZh = this.state.zh;

    this.state.status = "ready";
    this.state.message = "";
    this.state.idx = idx;
    this.state.en = current.text;
    this.state.zh = zh || "";
    this.state.words = this.glossMapFor(current.text);
    this.state.nextEn = next?.text || "";
    this.state.nextZh = next ? this.zh.get(next.hash) || "" : "";
    this.state.t = timed;
    this.state.mediaT = mediaTime;
    this.state.timeOffset = this.timeOffset;
    this.state.d = video.d;
    this.state.paused = video.paused;
    this.state.rate = Number(video.rate) || 1;
    this.state.cueStart = current.start;
    this.state.cueEnd = current.end;
    this.state.cueCount = cues.length;
    this.state.updatedAt = Date.now();

    const jumped = Math.abs(idx - previousIdx) > 12;
    if (jumped) {
      this.cursor = idx;
      this.startTranslation();
    }
    if (idx !== previousIdx) {
      this.followPrintedIdx = -1;
      this.followPrintedZh = false;
      if (this.options.follow) {
        console.log(`\n[${fmtTime(current.start)}] ${current.text}`);
        console.log(`  → ${zh || "（译文中…）"}`);
        this.followPrintedIdx = idx;
        this.followPrintedZh = Boolean(zh);
      }
      this.startTranslation();
    } else if (
      this.options.follow &&
      zh &&
      this.followPrintedIdx === idx &&
      !this.followPrintedZh
    ) {
      console.log(`  ↳ ${zh}`);
      this.followPrintedZh = true;
    } else if (
      this.options.follow &&
      zh &&
      this.followPrintedIdx !== idx
    ) {
      console.log(`\n[${fmtTime(current.start)}] ${current.text}`);
      console.log(`  → ${zh}`);
      this.followPrintedIdx = idx;
      this.followPrintedZh = true;
    }

    if (previousZh !== zh) this.broadcast(true);
    else this.broadcast(false);

    if (idx !== previousIdx) this.ensureWordGlosses(true);
    else this.ensureWordGlosses();
  }

  glossMapFor(text) {
    const map = {};
    for (const word of tokenizeWords(text)) {
      const key = wordKey(word);
      const zh = this.words.get(key);
      if (zh) map[key] = zh;
    }
    return map;
  }

  ensureWordGlosses(force = false) {
    if (!this.article || this.wordTranslating) return;
    const now = Date.now();
    if (!force && now - this.lastWordAttempt < 4000) return;

    const cues = this.article.cues;
    const start = Math.max(0, this.state.idx);
    const targets = [];
    const seen = new Set();
    for (const cue of [cues[start], cues[start + 1]]) {
      if (!cue) continue;
      for (const word of tokenizeWords(cue.text)) {
        const key = wordKey(word);
        if (seen.has(key) || this.words.has(key)) continue;
        const failure = this.wordFailures.get(key);
        if (failure && (failure.count >= 3 || now - failure.at < 15000)) continue;
        seen.add(key);
        targets.push({ key, text: word });
        if (targets.length >= 25) break;
      }
      if (targets.length >= 25) break;
    }
    if (!targets.length) return;

    this.lastWordAttempt = now;
    this.wordTranslating = true;
    this.translateWords(targets).catch((error) => {
      log("单词释义循环异常:", error.message);
      this.wordTranslating = false;
    });
  }

  async translateWords(targets) {
    const generation = this.generation;
    try {
      const translated = await translateLines(targets.map((item) => item.text), {
        proxy: conf.TR_PROXY,
      });
      if (generation !== this.generation) {
        this.wordTranslating = false;
        return;
      }
      let added = 0;
      const now = Date.now();
      translated.forEach((text, offset) => {
        const item = targets[offset];
        if (!item) return;
        const clean = (text || "").trim();
        if (!clean) {
          const failure = this.wordFailures.get(item.key) || { count: 0, at: 0 };
          failure.count += 1;
          failure.at = now;
          this.wordFailures.set(item.key, failure);
          return;
        }
        this.words.set(item.key, clean);
        this.wordFailures.delete(item.key);
        added += 1;
      });
      if (added) {
        this.wordVersion += 1;
        this.state.words = this.glossMapFor(this.state.en);
        this.saveWordsSoon();
        this.broadcast(true);
      }
    } catch (error) {
      if (generation === this.generation) {
        log(`单词释义失败(${targets.length} 个): ${error.message}`);
        const now = Date.now();
        for (const item of targets) {
          const failure = this.wordFailures.get(item.key) || { count: 0, at: 0 };
          failure.count += 1;
          failure.at = now;
          this.wordFailures.set(item.key, failure);
        }
      }
      this.wordTranslating = false;
      return;
    }
    this.wordTranslating = false;
    await sleep(150);
    this.ensureWordGlosses(true);
  }

  saveWordsSoon() {
    clearTimeout(this.wordSaveTimer);
    this.wordSaveTimer = setTimeout(() => this.saveWords(), 800);
  }

  saveWords() {
    try {
      const entries = {};
      for (const [word, text] of this.words) entries[word] = text;
      const payload = { v: 1, savedAt: new Date().toISOString(), entries };
      const tempPath = `${this.wordCachePath}.tmp`;
      writeFileSync(tempPath, JSON.stringify(payload));
      renameSync(tempPath, this.wordCachePath);
    } catch (error) {
      log("写单词缓存失败:", error.message);
    }
  }

  lookupWord(word) {
    const clean = String(word || "").trim();
    if (!/^[A-Za-z][A-Za-z'’\-]{0,39}$/.test(clean)) return Promise.resolve(null);
    const key = wordKey(clean);
    const cached = this.dicts.get(key);
    if (cached) return Promise.resolve({ word: clean, ...cached });
    if (this.dictPending.has(key)) return this.dictPending.get(key);
    const pending = this.fetchDict(clean, key).finally(() => this.dictPending.delete(key));
    this.dictPending.set(key, pending);
    return pending;
  }

  async fetchDict(word, key) {
    try {
      const url = `https://dict.youdao.com/jsonapi?q=${encodeURIComponent(word)}`;
      const { stdout } = await execFileAsync(
        "curl",
        ["-sS", "--max-time", "8", "-f", url],
        { maxBuffer: 8 * 1024 * 1024 },
      );
      const entry = {
        zh: this.words.get(key) || "",
        defs: parseYoudaoDefs(JSON.parse(stdout)),
      };
      this.dicts.set(key, entry);
      this.saveDictsSoon();
      return { word, ...entry };
    } catch (error) {
      log(`词典查询失败(${word}): ${error.message}`);
      return { word, zh: this.words.get(key) || "", defs: [] };
    }
  }

  saveDictsSoon() {
    clearTimeout(this.dictSaveTimer);
    this.dictSaveTimer = setTimeout(() => this.saveDicts(), 900);
  }

  saveDicts() {
    try {
      const entries = {};
      for (const [word, entry] of this.dicts) entries[word] = entry;
      const payload = { v: 1, savedAt: new Date().toISOString(), entries };
      const tempPath = `${this.dictCachePath}.tmp`;
      writeFileSync(tempPath, JSON.stringify(payload));
      renameSync(tempPath, this.dictCachePath);
    } catch (error) {
      log("写词典缓存失败:", error.message);
    }
  }

  loadVocabulary() {
    try {
      const json = JSON.parse(readFileSync(this.vocabPath, "utf8"));
      return Array.isArray(json?.items) ? json.items : [];
    } catch {
      return [];
    }
  }

  addVocabulary(payload = {}) {
    const word = String(payload.word || "").trim();
    const sentence = String(payload.sentence || this.state.en || "").trim();
    const translation = String(payload.translation || this.state.zh || "").trim();
    if (!/^[A-Za-z][A-Za-z'’\-]{0,39}$/.test(word) || !sentence) return { ok: false, error: "需要单词和句子" };
    const key = `${wordKey(word)}|${hashText(sentence)}`;
    const items = this.loadVocabulary();
    if (items.some((item) => item.key === key)) return { ok: true, duplicated: true, count: items.length };
    items.unshift({
      key,
      word: word.toLowerCase(),
      sentence,
      translation,
      uuid: this.article?.uuid || "",
      title: this.state.title || "",
      addedAt: new Date().toISOString(),
    });
    const payloadFile = { v: 1, savedAt: new Date().toISOString(), items: items.slice(0, 2000) };
    const tempPath = `${this.vocabPath}.tmp`;
    writeFileSync(tempPath, JSON.stringify(payloadFile));
    renameSync(tempPath, this.vocabPath);
    return { ok: true, count: payloadFile.items.length };
  }

  buildSubtitleExport(format = "srt") {
    const cues = this.article?.cues || [];
    if (!cues.length) return null;
    const safeTitle = (this.article.title || "ting-subtitle").replace(/[\\/:*?"<>|]+/g, "-").slice(0, 80) || "ting-subtitle";
    const srtTime = (seconds) => {
      const value = Math.max(0, Number(seconds) || 0);
      const h = String(Math.floor(value / 3600)).padStart(2, "0");
      const m = String(Math.floor((value % 3600) / 60)).padStart(2, "0");
      const s = String(Math.floor(value % 60)).padStart(2, "0");
      const ms = String(Math.round((value - Math.floor(value)) * 1000)).padStart(3, "0");
      return `${h}:${m}:${s},${ms}`;
    };
    if (format === "md") {
      const lines = [`# ${this.article.title || "双语课文"}`, ""];
      cues.forEach((cue, i) => {
        lines.push(`${i + 1}. ${cue.text}`);
        lines.push(`   ${this.zh.get(cue.hash) || "（未翻译）"}`);
        lines.push("");
      });
      return { filename: `${safeTitle}.md`, contentType: "text/markdown; charset=utf-8", body: lines.join("\n") };
    }
    const blocks = cues.map((cue, i) => [
      String(i + 1),
      `${srtTime(cue.start)} --> ${srtTime(cue.end)}`,
      cue.text,
      this.zh.get(cue.hash) || "",
    ].join("\n"));
    return { filename: `${safeTitle}.srt`, contentType: "application/x-subrip; charset=utf-8", body: `${blocks.join("\n\n")}\n` };
  }

  async getAlignment(index) {
    const cue = this.article?.cues?.[index];
    if (!cue) return null;
    if (this.align.has(cue.hash)) {
      return { idx: index, ...this.align.get(cue.hash), cached: true };
    }
    if (this.alignPending.has(cue.hash)) return this.alignPending.get(cue.hash);
    const pending = this.fetchAlignment(cue, index).finally(() => this.alignPending.delete(cue.hash));
    this.alignPending.set(cue.hash, pending);
    return pending;
  }

  async fetchAlignment(cue, index) {
    const tokens = tokenizeWords(cue.text);
    if (!tokens.length) return { idx: index, parts: [], segments: [] };
    const chunks = buildTaggedChunks(cue.text, 12);
    try {
      const translatedChunks = await translateLines(chunks, {
        proxy: conf.TR_PROXY,
        timeout: 25,
        textType: "html",
      });
      const parts = Array(tokens.length).fill("");
      const segments = [];
      for (const translated of translatedChunks) {
        const parsed = parseAlignedTranslation(translated, tokens.length);
        parsed.parts.forEach((part, i) => {
          if (part) parts[i] = parts[i] ? `${parts[i]} ${part}`.trim() : part;
        });
        segments.push(...parsed.segments);
      }
      const entry = { parts, segments };
      if (!entry.parts.some(Boolean) && !entry.segments.length) {
        entry.parts = tokens.map((word) => this.words.get(wordKey(word)) || "");
        entry.segments = entry.parts.map((text, i) => ({ i, text })).filter((item) => item.text);
      }
      this.align.set(cue.hash, entry);
      this.saveAlignSoon();
      return { idx: index, ...entry };
    } catch (error) {
      log(`逐词对照失败: ${error.message}`);
      const parts = tokens.map((word) => this.words.get(wordKey(word)) || "");
      const segments = parts.map((text, i) => ({ i, text })).filter((item) => item.text);
      return { idx: index, parts, segments, fallback: true, error: error.message };
    }
  }

  saveAlignSoon() {
    clearTimeout(this.alignSaveTimer);
    this.alignSaveTimer = setTimeout(() => this.saveAlign(), 1000);
  }

  saveAlign() {
    try {
      const entries = {};
      for (const [hash, entry] of this.align) entries[hash] = entry;
      const payload = { v: 1, savedAt: new Date().toISOString(), entries };
      const tempPath = `${this.alignCachePath}.tmp`;
      writeFileSync(tempPath, JSON.stringify(payload));
      renameSync(tempPath, this.alignCachePath);
    } catch (error) {
      log("写对照缓存失败:", error.message);
    }
  }

  flushCaches() {
    clearTimeout(this.saveTimer);
    clearTimeout(this.wordSaveTimer);
    clearTimeout(this.dictSaveTimer);
    clearTimeout(this.alignSaveTimer);
    this.saveCache();
    this.saveWords();
    this.saveDicts();
    this.saveAlign();
  }

  startTranslation() {
    if (this.translating || !this.article?.key) return;
    this.translating = true;
    this.translateLoop().catch((error) => {
      log("翻译循环异常:", error.message);
      this.translating = false;
    });
  }

  nextBatch() {
    const cues = this.article?.cues || [];
    const picked = [];
    let chars = 0;
    let scanned = 0;
    while (picked.length < 25 && scanned < cues.length) {
      const index = ((this.cursor % cues.length) + cues.length) % cues.length;
      this.cursor += 1;
      scanned += 1;
      const cue = cues[index];
      if (!cue || this.zh.has(cue.hash)) continue;
      const failure = this.failures.get(index);
      if (failure && (failure.count >= 3 || Date.now() - failure.at < 15000)) continue;
      picked.push(index);
      chars += cue.text.length;
      if (chars >= 3800) break;
    }
    return picked;
  }

  hasRetryableFailures() {
    for (const failure of this.failures.values()) {
      if (failure.count < 3) return true;
    }
    return false;
  }

  async translateLoop() {
    const generation = this.generation;
    while (generation === this.generation) {
      const batch = this.nextBatch();
      if (!batch.length) {
        if (!this.hasRetryableFailures()) break;
        await sleep(5000);
        continue;
      }
      const article = this.article;
      const cues = article.cues;
      const texts = batch.map((index) => cues[index].text);
      try {
        const translated = await translateLines(texts, { proxy: conf.TR_PROXY });
        if (generation !== this.generation || this.article !== article) break;
        translated.forEach((text, offset) => {
          if (text) this.zh.set(cues[batch[offset]].hash, text);
        });
        batch.forEach((index) => this.failures.delete(index));
        this.saveCacheSoon();
        this.broadcast(true);
      } catch (error) {
        if (generation !== this.generation || this.article !== article) break;
        log(`翻译批次失败(${batch.length} 句): ${error.message}`);
        const now = Date.now();
        for (const index of batch) {
          const failure = this.failures.get(index) || { count: 0, at: 0 };
          failure.count += 1;
          failure.at = now;
          this.failures.set(index, failure);
        }
        await sleep(1500);
      }
      await sleep(250);
    }
    this.translating = false;
  }

  saveCacheSoon() {
    if (!this.cachePath) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveCache(), 700);
  }

  saveCache() {
    if (!this.cachePath || !this.article) return;
    try {
      const entries = {};
      for (const [hash, text] of this.zh) entries[hash] = text;
      const payload = {
        v: 1,
        key: this.article.key,
        title: this.article.title,
        duration: this.video?.d || 0,
        cueSignature: this.article.signature,
        savedAt: new Date().toISOString(),
        entries,
      };
      const tempPath = `${this.cachePath}.tmp`;
      writeFileSync(tempPath, JSON.stringify(payload));
      renameSync(tempPath, this.cachePath);
    } catch (error) {
      log("写缓存失败:", error.message);
    }
  }

  broadcast(force) {
    if (!this.clients.size) return;
    const now = Date.now();
    const key = `${this.state.status}|${this.state.idx}|${this.state.zh}|${this.state.paused}|${this.wordVersion}`;
    if (!force && now - this.lastBroadcastAt < 400) return;
    if (force && now - this.lastBroadcastAt < 120 && key === this.lastBroadcastKey) return;
    this.lastBroadcastAt = now;
    this.lastBroadcastKey = key;
    for (const send of this.clients) {
      try {
        send(this.state);
      } catch {}
    }
  }

  addClient(send) {
    this.clients.add(send);
    try {
      send(this.state);
    } catch {}
  }

  removeClient(send) {
    this.clients.delete(send);
  }

  async seekTo(seconds) {
    if (!this.cdpInfo || !Number.isFinite(seconds)) return false;
    const t = Math.max(0, Number(seconds));
    const expression = `(() => {
      const v = document.querySelector('video');
      if (!v) return false;
      v.currentTime = ${JSON.stringify(t)};
      return true;
    })()`;
    try {
      const ok = await this.cdpInfo.cdp.evaluate(expression, 3000);
      if (ok) await sleep(120);
      return Boolean(ok);
    } catch (error) {
      log("跳转失败:", error.message);
      return false;
    }
  }

  async setPlayback(paused) {
    if (!this.cdpInfo) return false;
    const expression = `(() => {
      const v = document.querySelector('video');
      if (!v) return false;
      if (${JSON.stringify(Boolean(paused))}) {
        v.pause();
      } else {
        const result = v.play();
        if (result && typeof result.catch === 'function') result.catch(() => {});
      }
      return true;
    })()`;
    try {
      const ok = await this.cdpInfo.cdp.evaluate(expression, 3000);
      if (ok) {
        this.state.paused = Boolean(paused);
        this.broadcast(true);
        await sleep(80);
      }
      return Boolean(ok);
    } catch (error) {
      log("播放控制失败:", error.message);
      return false;
    }
  }

  async setRate(rate) {
    const value = Number(rate);
    if (!Number.isFinite(value) || value <= 0) return false;
    const safe = Math.min(Math.max(value, 0.25), 4);
    if (!this.cdpInfo) return false;
    const expression = `(() => {
      const v = document.querySelector('video');
      if (!v) return false;
      v.playbackRate = ${JSON.stringify(safe)};
      return Number(v.playbackRate) || ${JSON.stringify(safe)};
    })()`;
    try {
      const applied = await this.cdpInfo.cdp.evaluate(expression, 3000);
      if (applied) {
        this.state.rate = Number(applied) || safe;
        this.broadcast(true);
        return true;
      }
      return false;
    } catch (error) {
      log("倍速控制失败:", error.message);
      return false;
    }
  }

  async probe() {
    const data = await readStableArticle(conf.TEMP_HTML);
    const parsed = data ? parseArticle(data.text) : null;
    const info = {
      config: {
        tempHtml: conf.TEMP_HTML,
        cdpPort: conf.CDP_PORT,
        webPort: conf.WEB_PORT,
        cacheDir: conf.CACHE_DIR,
      },
      article: parsed
        ? {
            title: parsed.title,
            sentences: parsed.cues.length,
            firstStart: parsed.cues[0]?.start,
            lastEnd: parsed.cues[parsed.cues.length - 1]?.end,
            summary: parsed.summary.slice(0, 60),
          }
        : null,
      video: null,
      sync: null,
    };

    try {
      const found = await connectVideo(conf.CDP_PORT);
      if (found) {
        info.video = { ...found.video, target: found.target.title || found.target.url };
        if (parsed) {
          const key =
            uuidFromSrc(found.video.src) ||
            hashText(`${parsed.title}|${Math.round(found.video.d || 0)}|${parsed.cues[0]?.text || ""}`);
          const cache = loadCache(join(conf.CACHE_DIR, `${key}.json`));
          const wordCache = loadWordCache(join(conf.CACHE_DIR, "words.json"));
          const dictCache = loadDictCache(join(conf.CACHE_DIR, "dicts.json"));
          const fits = cuesFitDuration(parsed.cues, found.video.d);
          const idx = cueIndexAt(parsed.cues, found.video.t);
          const cue = parsed.cues[idx];
          const glosses = {};
          for (const word of tokenizeWords(cue?.text || "")) {
            const zh = wordCache.get(wordKey(word));
            if (zh) glosses[wordKey(word)] = zh;
          }
          info.sync = {
            fits,
            idx,
            cacheKey: key,
            cacheCount: cache.size,
            wordsCached: wordCache.size,
            dictsCached: dictCache.size,
            wordGlosses: glosses,
            cue: cue ? { start: cue.start, end: cue.end, text: cue.text } : null,
            zhCached: cue ? cache.get(cue.hash) || null : null,
          };
        }
        found.cdp.close();
      }
    } catch (error) {
      info.videoError = error.message;
    }
    return info;
  }
}

// ---------- SSE / 覆盖层 ----------

function serveOverlay(sync) {
  const overlayFile = join(REPO, "overlay/bar.html");
  const settingsFile = join(REPO, "overlay/settings.html");
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    const sendJson = (status, body) => {
      response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(body));
    };

    if (url.pathname === "/settings") {
      try {
        const html = readFileSync(settingsFile, "utf8");
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        response.end(html);
      } catch {
        response.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
        response.end("<h1>缺少 overlay/settings.html</h1>");
      }
      return;
    }

    if (url.pathname === "/" || url.pathname === "/bar") {
      try {
        const html = readFileSync(overlayFile, "utf8");
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        response.end(html);
      } catch {
        response.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
        response.end("<h1>缺少 overlay/bar.html</h1>");
      }
      return;
    }

    if (url.pathname === "/events") {
      response.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": "*",
      });
      response.write("retry: 1000\n\n");
      const send = (state) => {
        response.write(`data: ${JSON.stringify(state)}\n\n`);
      };
      sync.addClient(send);
      const heartbeat = setInterval(() => {
        try {
          response.write(": ping\n\n");
        } catch {}
      }, 15000);
      request.on("close", () => {
        clearInterval(heartbeat);
        sync.removeClient(send);
      });
      return;
    }

    if (url.pathname === "/health" || url.pathname === "/state") {
      sendJson(200, sync.state);
      return;
    }

    if (url.pathname === "/debug/article") {
      const cues = sync.article?.cues || [];
      sendJson(200, {
        ok: true,
        key: sync.article?.key || null,
        uuid: sync.article?.uuid || null,
        title: sync.article?.title || "",
        signature: sync.article?.signature || "",
        cues: cues.length,
        first: cues[0] || null,
        last: cues[cues.length - 1] || null,
        cacheCount: sync.zh?.size || 0,
        state: { idx: sync.state.idx, t: sync.state.t, d: sync.state.d, en: sync.state.en, zh: sync.state.zh },
      });
      return;
    }

    if (url.pathname === "/debug/sentences") {
      const expression = `(() => {
        const video = document.querySelector('video');
        const t = Number(video?.currentTime) || 0;
        const spans = [...document.querySelectorAll('span.sentence, span[class*="sentence"]')];
        return spans.slice(0, 80).map((el, i) => ({
          i,
          start: el.getAttribute('data-startTime') || '',
          end: el.getAttribute('data-endTime') || '',
          cls: String(el.className || '').slice(0, 120),
          style: String(el.getAttribute('style') || '').slice(0, 120),
          text: String(el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 100),
        }));
      })()`;
      try {
        const sentences = sync.cdpInfo?.cdp ? await sync.cdpInfo.cdp.evaluate(expression, 3000) : null;
        sendJson(200, { ok: Boolean(sentences), sentences: sentences || [] });
      } catch (error) {
        sendJson(500, { ok: false, error: error.message });
      }
      return;
    }

    if (url.pathname === "/debug/current") {
      const expression = `(() => {
        const video = document.querySelector('video');
        const all = [...document.querySelectorAll('*')];
        const active = all
          .filter((el) => /\\b(current|active|playing|now|on)\\b/i.test(String(el.className || '')))
          .slice(0, 30)
          .map((el) => ({
            tag: el.tagName,
            id: el.id || '',
            cls: String(el.className || '').slice(0, 160),
            text: String(el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 160),
          }));
        return { currentTime: Number(video?.currentTime) || 0, active };
      })()`;
      try {
        const result = sync.cdpInfo?.cdp ? await sync.cdpInfo.cdp.evaluate(expression, 3000) : null;
        sendJson(200, { ok: Boolean(result), result: result || null });
      } catch (error) {
        sendJson(500, { ok: false, error: error.message });
      }
      return;
    }

    if (url.pathname === "/debug/media") {
      const expression = `(() => {
        const nodes = [...document.querySelectorAll('video, audio')];
        return nodes.map((el, i) => ({
          i,
          tag: el.tagName,
          currentTime: Number(el.currentTime) || 0,
          duration: Number(el.duration) || 0,
          paused: !!el.paused,
          rate: Number(el.playbackRate) || 1,
          visible: !!el.offsetParent,
          src: String(el.currentSrc || el.src || '').slice(0, 220),
        }));
      })()`;
      try {
        const nodes = sync.cdpInfo?.cdp ? await sync.cdpInfo.cdp.evaluate(expression, 3000) : null;
        sendJson(200, { ok: Boolean(nodes), nodes: nodes || [] });
      } catch (error) {
        sendJson(500, { ok: false, error: error.message });
      }
      return;
    }

    if (url.pathname === "/word") {
      const entry = await sync.lookupWord(url.searchParams.get("w") || "");
      if (!entry) {
        sendJson(400, { ok: false, error: "需要单个英文单词" });
        return;
      }
      sendJson(200, { ok: true, ...entry });
      return;
    }

    if (url.pathname === "/seek" && request.method === "POST") {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
        if (body.length > 4096) request.destroy();
      });
      request.on("end", async () => {
        try {
          const payload = JSON.parse(body || "{}");
          let target = Number(payload.t);
          if (!Number.isFinite(target) && Number.isInteger(payload.idx)) {
            const cue = sync.article?.cues?.[payload.idx];
            if (cue) target = cue.start;
          }
          if (!Number.isFinite(target)) {
            sendJson(400, { ok: false, error: "需要数字 t 或整数 idx" });
            return;
          }
          const ok = await sync.seekTo(target);
          sendJson(200, { ok, t: target });
        } catch (error) {
          sendJson(400, { ok: false, error: error.message });
        }
      });
      return;
    }

    if (url.pathname === "/align") {
      const index = Number(url.searchParams.get("idx"));
      const result = Number.isInteger(index) ? await sync.getAlignment(index) : null;
      if (!result) {
        sendJson(400, { ok: false, error: "需要整数 idx" });
        return;
      }
      sendJson(200, { ok: true, ...result });
      return;
    }

    if (url.pathname === "/vocab" && request.method === "POST") {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
        if (body.length > 65536) request.destroy();
      });
      request.on("end", () => {
        try {
          const result = sync.addVocabulary(JSON.parse(body || "{}"));
          sendJson(result.ok ? 200 : 400, result);
        } catch (error) {
          sendJson(400, { ok: false, error: error.message });
        }
      });
      return;
    }

    if (url.pathname === "/export") {
      const format = url.searchParams.get("format") === "md" ? "md" : "srt";
      const exported = sync.buildSubtitleExport(format);
      if (!exported) {
        sendJson(400, { ok: false, error: "还没有可导出的课文" });
        return;
      }
      response.writeHead(200, {
        "Content-Type": exported.contentType,
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(exported.filename)}`,
        "Cache-Control": "no-store",
      });
      response.end(exported.body);
      return;
    }

    if (url.pathname === "/offset" && request.method === "POST") {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
        if (body.length > 4096) request.destroy();
      });
      request.on("end", () => {
        try {
          const payload = JSON.parse(body || "{}");
          const offset = Number(payload.offset);
          if (!Number.isFinite(offset)) {
            sendJson(400, { ok: false, error: "需要数字 offset" });
            return;
          }
          sync.timeOffset = Math.max(-15, Math.min(15, offset));
          sync.state.timeOffset = sync.timeOffset;
          if (sync.video) sync.updateFromVideo(sync.video);
          sync.broadcast(true);
          sendJson(200, { ok: true, offset: sync.timeOffset });
        } catch (error) {
          sendJson(400, { ok: false, error: error.message });
        }
      });
      return;
    }

    if (url.pathname === "/playback" && request.method === "POST") {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
        if (body.length > 4096) request.destroy();
      });
      request.on("end", async () => {
        try {
          const payload = JSON.parse(body || "{}");
          if (payload.rate !== undefined) {
            const ok = await sync.setRate(payload.rate);
            sendJson(200, { ok, rate: sync.state.rate });
            return;
          }
          const paused = typeof payload.paused === "boolean" ? payload.paused : !sync.state.paused;
          const ok = await sync.setPlayback(paused);
          sendJson(200, { ok, paused });
        } catch (error) {
          sendJson(400, { ok: false, error: error.message });
        }
      });
      return;
    }

    sendJson(404, { ok: false, error: "not found" });
  });

  server.on("error", (error) => {
    if (error.code === "EADDRINUSE") {
      log(`端口 ${conf.WEB_PORT} 已被占用；可能已经有一个 ting-sync 在运行`);
    } else {
      log("HTTP 服务错误:", error.message);
    }
    process.exitCode = 1;
  });

  server.listen(Number(conf.WEB_PORT), "127.0.0.1", () => {
    log(`覆盖层: http://127.0.0.1:${conf.WEB_PORT}/`);
  });
  return server;
}

// ---------- 入口 ----------

async function main() {
  if (MODE === "selftest") {
    const parsed = await readStableArticle(conf.TEMP_HTML).then((data) =>
      data ? parseArticle(data.text) : null,
    );
    const report = [];
    report.push(`node: ${process.version}`);
    report.push(`课文 HTML: ${existsSync(conf.TEMP_HTML) ? "存在" : "不存在"}`);
    if (parsed) {
      const last = parsed.cues[parsed.cues.length - 1];
      report.push(`解析: ${parsed.cues.length} 句, 末句 ${last?.end?.toFixed(2)}s`);
    } else {
      report.push("解析: 失败（先打开一篇课文）");
    }
    let translationOk = false;
    try {
      const [text] = await translateLines(["The train to Cambridge leaves at seven."], {
        proxy: conf.TR_PROXY,
      });
      translationOk = Boolean(text && /[\u4e00-\u9fff]/.test(text));
      report.push(`翻译: ${text || "(空)"}`);
    } catch (error) {
      report.push(`翻译: 失败 ${error.message}`);
    }
    try {
      mkdirSync(conf.CACHE_DIR, { recursive: true });
      const probe = join(conf.CACHE_DIR, ".selftest");
      writeFileSync(probe, "ok");
      report.push("缓存目录: 可写");
    } catch (error) {
      report.push(`缓存目录: 不可写 ${error.message}`);
    }
    console.log(report.join("\n"));
    if (parsed && translationOk) console.log("SELFTEST_OK");
    else {
      console.log("SELFTEST_FAILED");
      process.exitCode = 1;
    }
    return;
  }

  if (MODE === "probe") {
    const sync = new Sync();
    const report = await sync.probe();
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const follow = MODE === "follow";
  const sync = new Sync({ follow });
  if (!follow) serveOverlay(sync);
  await sync.init();
  if (follow) {
    console.log("跟随模式：播放每日英语听力，当前句和译文会打印在下面。Ctrl-C 退出。");
  }
  const shutdown = () => {
    log("退出");
    unwatchFile(conf.TEMP_HTML);
    clearInterval(sync.tickTimer);
    sync.cdpInfo?.cdp?.close();
    sync.flushCaches();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

await main();
