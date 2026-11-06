import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import { discoverLanguageServer } from "./wincred-ls.mjs";

// Vertex AI (GCP 通道) 与 CloudCode PA (个人通道) 的 Tink 密钥签名头特征：
// 1. GCP 通道 (Vertex AI aiplatform.googleapis.com): 01 8f 3d 6b 5f (Base64: AY89a18 / IDxACGAIqQ / CA8QAhgCKk)
// 2. 个人通道 (CloudCode PA cloudcode-pa.googleapis.com): 01 69 14 7d 13 / 01 11 4d 32 0f (Base64: AWkUfR / FpFH0T / AEFNM)
export const GCP_BIN_MAGICS = [
  Buffer.from([0x01, 0x8f, 0x3d, 0x6b, 0x5f])
];

export const PERSONAL_BIN_MAGICS = [
  Buffer.from([0x01, 0x69, 0x14, 0x7d, 0x13]),
  Buffer.from([0x01, 0x11, 0x4d, 0x32, 0x0f])
];

export const GCP_SIG_MAGICS = [
  ...GCP_BIN_MAGICS,
  Buffer.from("AY89a18", "utf8"),
  Buffer.from("IDxACGAIqQ", "utf8"),
  Buffer.from("CA8QAhgCKk", "utf8")
];

export const PERSONAL_SIG_MAGICS = [
  ...PERSONAL_BIN_MAGICS,
  Buffer.from("AWkUfR", "utf8"),
  Buffer.from("FpFH0T", "utf8"),
  Buffer.from("AEFNM", "utf8")
];

export const THOUGHT_SIG_MAGICS = [
  ...PERSONAL_SIG_MAGICS,
  ...GCP_SIG_MAGICS
];

const sigStatusCache = new Map();

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

export function hasThoughtSignatureMagic(buf, magics = THOUGHT_SIG_MAGICS) {
  if (!buf || buf.length < 5) return false;
  for (let i = 0; i < magics.length; i++) {
    if (buf.includes(magics[i])) return true;
  }
  return false;
}

function isDirectThoughtSigLeaf(sub, magics = THOUGHT_SIG_MAGICS) {
  if (!sub || sub.length < 5) return false;
  const head = sub.subarray(0, 28);
  for (let i = 0; i < magics.length; i++) {
    if (head.includes(magics[i])) return true;
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

export function scrubThoughtSignaturesFromProto(buf, magicsToScrub = THOUGHT_SIG_MAGICS) {
  if (!buf || !hasThoughtSignatureMagic(buf, magicsToScrub)) return { buf, changed: false };
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
      if (hasThoughtSignatureMagic(sub, magicsToScrub)) {
        if (!isDirectThoughtSigLeaf(sub, magicsToScrub) && isValidProtoSubMessage(sub)) {
          const res = scrubThoughtSignaturesFromProto(sub, magicsToScrub);
          if (res.changed) {
            changed = true;
            if (res.buf.length > 0) {
              out.push(buf.subarray(start, tag.next), encodeProtoVarint(res.buf.length), res.buf);
            }
            continue;
          }
        } else if (isDirectThoughtSigLeaf(sub, magicsToScrub)) {
          changed = true;
          continue;
        }
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

function resolveConversationDbPath(convIdOrPrefix) {
  const clean = String(convIdOrPrefix || "").trim();
  if (!clean) return "";
  const convDir = path.join(os.homedir(), ".gemini", "antigravity", "conversations");
  if (!fs.existsSync(convDir)) return "";
  const exact = path.join(convDir, clean.endsWith(".db") ? clean : `${clean}.db`);
  if (fs.existsSync(exact)) return exact;
  try {
    const match = fs.readdirSync(convDir).find((f) => f.endsWith(".db") && f.startsWith(clean));
    if (match) return path.join(convDir, match);
  } catch {}
  return "";
}

export function inspectConversationSignatureStatus(convIdOrPrefix, activeIsGcp = false) {
  const fullPath = resolveConversationDbPath(convIdOrPrefix);
  const convId = fullPath ? path.basename(fullPath, ".db") : String(convIdOrPrefix || "").trim();
  if (!fullPath || !fs.existsSync(fullPath)) {
    return {
      convId,
      sigType: "none",
      hasGcpSig: false,
      hasPersonalSig: false,
      lastSigType: "none",
      mismatched: false
    };
  }

  let st = null;
  try {
    st = fs.statSync(fullPath);
  } catch {
    return {
      convId,
      sigType: "none",
      hasGcpSig: false,
      hasPersonalSig: false,
      lastSigType: "none",
      mismatched: false
    };
  }

  const cached = sigStatusCache.get(convId);
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
    const mismatched =
      cached.sigType === "mixed" ||
      (cached.sigType === "gcp" && !activeIsGcp) ||
      (cached.sigType === "personal" && Boolean(activeIsGcp));
    return {
      ...cached,
      mismatched
    };
  }

  let hasGcpSig = false;
  let hasPersonalSig = false;
  let lastSigType = "none";

  try {
    const rawBytes = fs.readFileSync(fullPath);
    const rawHasBin = hasThoughtSignatureMagic(rawBytes, [...GCP_BIN_MAGICS, ...PERSONAL_BIN_MAGICS]);
    if (rawHasBin) {
      const db = new DatabaseSync(fullPath);
      try {
        const steps = db.prepare("SELECT idx, metadata, step_payload FROM steps ORDER BY idx ASC").all();
        for (const r of steps) {
          const m = r.metadata ? Buffer.from(r.metadata) : null;
          const p = r.step_payload ? Buffer.from(r.step_payload) : null;
          const stepHasGcp =
            (m && hasThoughtSignatureMagic(m, GCP_BIN_MAGICS)) ||
            (p && hasThoughtSignatureMagic(p, GCP_BIN_MAGICS));
          const stepHasPers =
            (m && hasThoughtSignatureMagic(m, PERSONAL_BIN_MAGICS)) ||
            (p && hasThoughtSignatureMagic(p, PERSONAL_BIN_MAGICS));
          if (stepHasGcp) {
            hasGcpSig = true;
            lastSigType = "gcp";
          }
          if (stepHasPers) {
            hasPersonalSig = true;
            lastSigType = "personal";
          }
        }
        if (!hasGcpSig && !hasPersonalSig) {
          try {
            const gens = db.prepare("SELECT idx, data FROM gen_metadata ORDER BY idx ASC").all();
            for (const g of gens) {
              const d = g.data ? Buffer.from(g.data) : null;
              if (!d) continue;
              if (hasThoughtSignatureMagic(d, GCP_BIN_MAGICS)) {
                hasGcpSig = true;
                lastSigType = "gcp";
              }
              if (hasThoughtSignatureMagic(d, PERSONAL_BIN_MAGICS)) {
                hasPersonalSig = true;
                lastSigType = "personal";
              }
            }
          } catch {}
        }
      } finally {
        db.close();
      }
    }
  } catch {}

  let sigType = "none";
  if (hasGcpSig && hasPersonalSig) {
    sigType = "mixed";
  } else if (hasGcpSig) {
    sigType = "gcp";
  } else if (hasPersonalSig) {
    sigType = "personal";
  }

  const entry = {
    convId,
    mtimeMs: st.mtimeMs,
    size: st.size,
    sigType,
    hasGcpSig,
    hasPersonalSig,
    lastSigType
  };
  sigStatusCache.set(convId, entry);

  const mismatched =
    sigType === "mixed" ||
    (sigType === "gcp" && !activeIsGcp) ||
    (sigType === "personal" && Boolean(activeIsGcp));

  return {
    ...entry,
    mismatched
  };
}

function scrubConversationDbFile(fullPath, magicsToScrub = THOUGHT_SIG_MAGICS, binPrecheckMagics = [...GCP_BIN_MAGICS, ...PERSONAL_BIN_MAGICS]) {
  if (!fullPath || !fs.existsSync(fullPath)) return false;
  let modified = false;
  const convId = path.basename(fullPath, ".db");
  try {
    const rawBytes = fs.readFileSync(fullPath);
    if (!hasThoughtSignatureMagic(rawBytes, binPrecheckMagics) && !hasThoughtSignatureMagic(rawBytes, magicsToScrub)) {
      return false;
    }
    const db = new DatabaseSync(fullPath);
    try {
      const steps = db.prepare("SELECT idx, metadata, step_payload FROM steps").all();
      const updStep = db.prepare("UPDATE steps SET metadata = ?, step_payload = ? WHERE idx = ?");
      db.exec("BEGIN");
      for (const r of steps) {
        const m = r.metadata ? Buffer.from(r.metadata) : null;
        const p = r.step_payload ? Buffer.from(r.step_payload) : null;
        const rm = m ? scrubThoughtSignaturesFromProto(m, magicsToScrub) : { buf: m, changed: false };
        const rp = p ? scrubThoughtSignaturesFromProto(p, magicsToScrub) : { buf: p, changed: false };
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
          const rd = d ? scrubThoughtSignaturesFromProto(d, magicsToScrub) : { buf: d, changed: false };
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
  sigStatusCache.delete(convId);
  return modified;
}

export async function scrubConversationsByMode(opts = {}) {
  const mode = opts.mode === "current" ? "current" : (opts.mode === "all" ? "all" : "mismatched");
  const activeIsGcp = Boolean(opts.activeIsGcp);
  const targetConvId = String(opts.conversationId || "").trim();
  const convDir = path.join(os.homedir(), ".gemini", "antigravity", "conversations");
  if (!fs.existsSync(convDir)) {
    return { mode, scrubbedCount: 0, scrubbedIds: [] };
  }

  const scrubbedIds = [];

  if (mode === "current") {
    const mainDbPath = resolveConversationDbPath(targetConvId);
    const fullConvId = mainDbPath ? path.basename(mainDbPath, ".db") : targetConvId;
    const candidateDbPaths = new Set();
    if (mainDbPath) candidateDbPaths.add(mainDbPath);

    // 同步包含当前会话派生的子智能体对话库
    try {
      const sumDbPath = path.join(os.homedir(), ".gemini", "antigravity", "conversation_summaries.db");
      if (fullConvId && fs.existsSync(sumDbPath)) {
        const sumDb = new DatabaseSync(sumDbPath);
        try {
          const children = sumDb
            .prepare("SELECT conversation_id FROM conversation_summaries WHERE parent_conversation_id = ?")
            .all(fullConvId);
          for (const ch of children) {
            const chPath = resolveConversationDbPath(ch.conversation_id);
            if (chPath) candidateDbPaths.add(chPath);
          }
        } finally {
          sumDb.close();
        }
      }
    } catch {}

    for (const dbP of candidateDbPaths) {
      if (scrubConversationDbFile(dbP, THOUGHT_SIG_MAGICS)) {
        scrubbedIds.push(path.basename(dbP, ".db"));
      }
    }
    return {
      mode: "current",
      scrubbedCount: scrubbedIds.length,
      scrubbedIds
    };
  }

  // mode === "mismatched" 或 "all"
  // 当 mode === "mismatched" 时：
  // - 当前处于 GCP 通道 (activeIsGcp = true)：仅清除遗留的个人通道签名 (PERSONAL_SIG_MAGICS)
  // - 当前处于个人通道 (activeIsGcp = false)：仅清除遗留的 GCP 通道签名 (GCP_SIG_MAGICS)
  const magicsToScrub = mode === "all"
    ? THOUGHT_SIG_MAGICS
    : (activeIsGcp ? PERSONAL_SIG_MAGICS : GCP_SIG_MAGICS);
  const binPrecheck = mode === "all"
    ? [...GCP_BIN_MAGICS, ...PERSONAL_BIN_MAGICS]
    : (activeIsGcp ? PERSONAL_BIN_MAGICS : GCP_BIN_MAGICS);

  try {
    const entries = fs
      .readdirSync(convDir)
      .filter((f) => f.endsWith(".db"))
      .map((f) => ({ cascadeId: f.slice(0, -3), fullPath: path.join(convDir, f) }));

    for (const item of entries) {
      if (scrubConversationDbFile(item.fullPath, magicsToScrub, binPrecheck)) {
        scrubbedIds.push(item.cascadeId);
      }
    }
  } catch {}

  return {
    mode,
    scrubbedCount: scrubbedIds.length,
    scrubbedIds
  };
}

export async function scrubRecentConversationsSignatures(_ls = null, opts = {}) {
  const res = await scrubConversationsByMode({
    mode: opts.mode || "all",
    activeIsGcp: opts.activeIsGcp,
    conversationId: opts.conversationId
  });
  return res.scrubbedIds || [];
}

export async function manualScrubAllSignatures(opts = {}) {
  discoverLanguageServer(false);
  return scrubConversationsByMode({
    mode: opts.mode || "mismatched",
    activeIsGcp: opts.activeIsGcp,
    conversationId: opts.conversationId
  });
}
