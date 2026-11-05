import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import { discoverLanguageServer } from "./wincred-ls.mjs";

// 完整覆盖所有账号与模型变体的 thought_signature 魔数特征：
// 1. 01 69 14 7d 13 (Gemini 4 Argon / CloudCode 原始签名)
// 2. 01 11 4d 32 0f (Gemini 3.x / Pro 原始签名)
// 3. 01 8f 3d 6b 5f (Claude / 混合思考原始签名)
// 4. Base64 编码的 thought_signature 变体 (AWkUfR / FpFH0T / AEFNM / IDxACGAIqQ / CA8QAhgCKk)
export const THOUGHT_SIG_MAGICS = [
  Buffer.from([0x01, 0x69, 0x14, 0x7d, 0x13]),
  Buffer.from([0x01, 0x11, 0x4d, 0x32, 0x0f]),
  Buffer.from([0x01, 0x8f, 0x3d, 0x6b, 0x5f]),
  Buffer.from("AWkUfR", "utf8"),
  Buffer.from("FpFH0T", "utf8"),
  Buffer.from("AEFNM", "utf8"),
  Buffer.from("IDxACGAIqQ", "utf8"),
  Buffer.from("CA8QAhgCKk", "utf8")
];

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

export function hasThoughtSignatureMagic(buf) {
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

export function scrubThoughtSignaturesFromProto(buf) {
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
          if (res.changed) {
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

export async function scrubRecentConversationsSignatures(_ls = null) {
  const convDir = path.join(os.homedir(), ".gemini", "antigravity", "conversations");
  if (!fs.existsSync(convDir)) return [];
  const scrubbedIds = [];
  try {
    const entries = fs
      .readdirSync(convDir)
      .filter((f) => f.endsWith(".db"))
      .map((f) => ({ cascadeId: f.slice(0, -3), fullPath: path.join(convDir, f) }));

    for (const item of entries) {
      let modified = false;
      try {
        const rawBytes = fs.readFileSync(item.fullPath);
        if (!hasThoughtSignatureMagic(rawBytes)) continue;
        const db = new DatabaseSync(item.fullPath);
        try {
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
        } finally {
          db.close();
        }
      } catch {}

      if (modified) {
        scrubbedIds.push(item.cascadeId);
      }
    }
  } catch {}
  return scrubbedIds;
}

export async function manualScrubAllSignatures() {
  const currentLs = discoverLanguageServer(false);
  const scrubbedIds = await scrubRecentConversationsSignatures(currentLs).catch(() => []);
  return {
    scrubbedCount: Array.isArray(scrubbedIds) ? scrubbedIds.length : 0,
    scrubbedIds: Array.isArray(scrubbedIds) ? scrubbedIds : []
  };
}
