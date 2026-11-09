// Antigravity Relay · Protobuf Wire-Format 跨通道思考签名 (thought_signature) 剥离与全盘数据库清洗引擎
const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");

// 完整覆盖所有账号与模型变体的 thought_signature 魔数特征：
// 1. 01 69 14 7d 13 (Gemini 4 Argon / CloudCode 原始签名)
// 2. 01 11 4d 32 0f (Gemini 3.x / Pro 原始签名，如 fox-server大体框架 会话中的 661 条签名)
// 3. 01 8f 3d 6b 5f (Claude / 混合思考原始签名)
// 4. Base64 编码的 thought_signature 变体 (AWkUfR / FpFH0T / AEFNM / IDxACGAIqQ / CA8QAhgCKk)
const THOUGHT_SIG_MAGICS = [
  Buffer.from([0x01, 0x69, 0x14, 0x7d, 0x13]),
  Buffer.from([0x01, 0x11, 0x4d, 0x32, 0x0f]),
  Buffer.from([0x01, 0x8f, 0x3d, 0x6b, 0x5f]),
  Buffer.from("AY89a18", "utf8"),
  Buffer.from("AWkUfR", "utf8"),
  Buffer.from("FpFH0T", "utf8"),
  Buffer.from("AEFNM", "utf8"),
  Buffer.from("IDxACGAIqQ", "utf8"),
  Buffer.from("CA8QAhgCKk", "utf8")
];

const THOUGHT_SIG_MAGIC_RAW = THOUGHT_SIG_MAGICS[0];
const THOUGHT_SIG_MAGIC_B64_1 = THOUGHT_SIG_MAGICS[3];
const THOUGHT_SIG_MAGIC_B64_2 = THOUGHT_SIG_MAGICS[4];

function readProtoVarint(buf, offset) {
  let res = 0n;
  let shift = 0n;
  let pos = offset;
  while (pos < buf.length) {
    const b = buf[pos++];
    res |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) return { val: res, next: pos };
    shift += 7n;
    if (shift > 63n) return null;
  }
  return null;
}

function encodeProtoVarint(val) {
  let v = BigInt(val);
  const bytes = [];
  while (v >= 0x80n) {
    bytes.push(Number((v & 0x7fn) | 0x80n));
    v >>= 7n;
  }
  bytes.push(Number(v));
  return Buffer.from(bytes);
}

function hasThoughtSignatureMagic(buf) {
  if (!buf || buf.length < 5) return false;
  for (let i = 0; i < THOUGHT_SIG_MAGICS.length; i++) {
    if (buf.includes(THOUGHT_SIG_MAGICS[i])) return true;
  }
  return false;
}

function isDirectThoughtSigLeaf(sub) {
  if (!sub || sub.length < 5) return false;
  const head = sub.subarray(0, 28);
  for (let i = 0; i < THOUGHT_SIG_MAGICS.length; i++) {
    if (head.includes(THOUGHT_SIG_MAGICS[i])) return true;
  }
  return false;
}

function isValidProtoSubMessage(buf) {
  if (!buf || buf.length === 0) return false;
  let pos = 0;
  let count = 0;
  while (pos < buf.length) {
    const tag = readProtoVarint(buf, pos);
    if (!tag || tag.val === 0n) return false;
    const wire = Number(tag.val & 7n);
    const field = Number(tag.val >> 3n);
    if (field <= 0 || field > 5000) return false;
    pos = tag.next;
    if (wire === 0) {
      const v = readProtoVarint(buf, pos);
      if (!v) return false;
      pos = v.next;
    } else if (wire === 1) {
      pos += 8;
    } else if (wire === 2) {
      const l = readProtoVarint(buf, pos);
      if (!l || l.val < 0n || l.next + Number(l.val) > buf.length) return false;
      pos = l.next + Number(l.val);
    } else if (wire === 5) {
      pos += 4;
    } else {
      return false;
    }
    count++;
  }
  return pos === buf.length && count > 0;
}

function scrubThoughtSignaturesFromProto(buf) {
  if (!buf || !hasThoughtSignatureMagic(buf)) return { buf, changed: false };
  let pos = 0;
  let changed = false;
  const out = [];
  while (pos < buf.length) {
    const start = pos;
    const tag = readProtoVarint(buf, pos);
    if (!tag || tag.val === 0n) return { buf, changed: false };
    const wire = Number(tag.val & 7n);
    pos = tag.next;
    if (wire === 0) {
      const v = readProtoVarint(buf, pos);
      if (!v) return { buf, changed: false };
      pos = v.next;
      out.push(buf.subarray(start, pos));
    } else if (wire === 1) {
      if (pos + 8 > buf.length) return { buf, changed: false };
      pos += 8;
      out.push(buf.subarray(start, pos));
    } else if (wire === 2) {
      const l = readProtoVarint(buf, pos);
      if (!l || l.val < 0n || l.next + Number(l.val) > buf.length) return { buf, changed: false };
      const valStart = l.next;
      const valEnd = valStart + Number(l.val);
      const sub = buf.subarray(valStart, valEnd);
      pos = valEnd;
      if (hasThoughtSignatureMagic(sub)) {
        if (!isDirectThoughtSigLeaf(sub) && isValidProtoSubMessage(sub)) {
          const res = scrubThoughtSignaturesFromProto(sub);
          if (res.changed && !hasThoughtSignatureMagic(res.buf)) {
            changed = true;
            if (res.buf.length > 0) {
              out.push(buf.subarray(start, tag.next), encodeProtoVarint(res.buf.length), res.buf);
            }
            continue;
          }
        }
        changed = true;
        continue;
      }
      out.push(buf.subarray(start, pos));
    } else if (wire === 5) {
      if (pos + 4 > buf.length) return { buf, changed: false };
      pos += 4;
      out.push(buf.subarray(start, pos));
    } else {
      return { buf, changed: false };
    }
  }
  return changed ? { buf: Buffer.concat(out), changed: true } : { buf, changed: false };
}

function sendLsRpcMethod({ hostname, port, protocol, csrf }, method, payload) {
  return new Promise((resolve) => {
    const transport = protocol === "https" ? https : http;
    const opts = {
      hostname: hostname || "127.0.0.1",
      port: Number(port),
      path: `/exa.language_server_pb.LanguageServerService/${method}`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Connect-Protocol-Version": "1",
        "x-codeium-csrf-token": csrf,
        "Content-Length": payload.length
      },
      timeout: 1500
    };
    if (protocol === "https") {
      opts.rejectUnauthorized = false;
    }
    const req = transport.request(opts, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode === 200));
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.write(payload);
    req.end();
  });
}

function scrubSingleConversationDbSync(dbFile) {
  if (!dbFile || !fs.existsSync(dbFile)) return false;
  let modified = false;
  try {
    let hasSig = false;
    try {
      const rawBytes = fs.readFileSync(dbFile);
      if (hasThoughtSignatureMagic(rawBytes)) hasSig = true;
    } catch {}
    const walFile = `${dbFile}-wal`;
    if (!hasSig && fs.existsSync(walFile)) {
      try {
        const walBytes = fs.readFileSync(walFile);
        if (hasThoughtSignatureMagic(walBytes)) hasSig = true;
      } catch {}
    }
    if (!hasSig) return false;
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(dbFile);
    try {
      try { db.exec("PRAGMA busy_timeout = 5000;"); } catch {}
      const steps = db.prepare("SELECT idx, metadata, step_payload FROM steps").all();
      const updStep = db.prepare("UPDATE steps SET metadata = ?, step_payload = ? WHERE idx = ?");
      db.exec("BEGIN");
      for (const r of steps) {
        const m = r.metadata ? Buffer.from(r.metadata) : null;
        const p = r.step_payload ? Buffer.from(r.step_payload) : null;
        const rm = m ? scrubThoughtSignaturesFromProto(m) : { buf: m, changed: false };
        const rp = p ? scrubThoughtSignaturesFromProto(p) : { buf: p, changed: false };
        if (rm.changed || rp.changed) {
          updStep.run(rm.buf, rp.buf, r.idx);
          modified = true;
        }
      }
      try {
        const gens = db.prepare("SELECT idx, data FROM gen_metadata").all();
        const updGen = db.prepare("UPDATE gen_metadata SET data = ?, size = ? WHERE idx = ?");
        for (const g of gens) {
          const d = g.data ? Buffer.from(g.data) : null;
          const rd = d ? scrubThoughtSignaturesFromProto(d) : { buf: d, changed: false };
          if (rd.changed) {
            updGen.run(rd.buf, rd.buf.length, g.idx);
            modified = true;
          }
        }
      } catch {}
      db.exec("COMMIT");
      if (modified) {
        try {
          db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
        } catch {
          try { db.exec("PRAGMA wal_checkpoint(PASSIVE);"); } catch {}
        }
      }
    } finally {
      db.close();
    }
  } catch {}
  return modified;
}

async function scrubAndReloadCascadeIfNeeded(cascadeId, _lsTarget, convDir) {
  if (!cascadeId || !convDir) return false;
  const dbFile = path.join(convDir, `${cascadeId}.db`);
  // 注意：不再调用 LoadTrajectory RPC，因为 language_server.exe 对已加载的会话直接报 already loaded, skipping duplicate load
  return scrubSingleConversationDbSync(dbFile);
}

function scrubAllConversationDbsSync(convDir) {
  if (!convDir || !fs.existsSync(convDir)) return [];
  const scrubbedIds = [];
  try {
    const files = fs.readdirSync(convDir).filter((f) => f.endsWith(".db"));
    for (const f of files) {
      const fullPath = path.join(convDir, f);
      if (scrubSingleConversationDbSync(fullPath)) {
        scrubbedIds.push(f.slice(0, -3));
      }
    }
  } catch {}
  return scrubbedIds;
}

module.exports = {
  THOUGHT_SIG_MAGICS,
  THOUGHT_SIG_MAGIC_RAW,
  THOUGHT_SIG_MAGIC_B64_1,
  THOUGHT_SIG_MAGIC_B64_2,
  readProtoVarint,
  encodeProtoVarint,
  hasThoughtSignatureMagic,
  isDirectThoughtSigLeaf,
  isValidProtoSubMessage,
  scrubThoughtSignaturesFromProto,
  sendLsRpcMethod,
  scrubSingleConversationDbSync,
  scrubAndReloadCascadeIfNeeded,
  scrubAllConversationDbsSync
};
