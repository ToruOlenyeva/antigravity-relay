// Windows DPAPI (CurrentUser) 透明批处理令牌加密/解密库（带双向内存缓存）

import path from "node:path";
import { execFileSync } from "node:child_process";

export const DPAPI_PREFIX = "dpapi:v1:";

const cipherToPlain = new Map();
const plainToCipher = new Map();

export function isDpapiCiphertext(val) {
  return typeof val === "string" && val.startsWith(DPAPI_PREFIX) && val.length > DPAPI_PREFIX.length;
}

export function clearTokenVaultCache() {
  cipherToPlain.clear();
  plainToCipher.clear();
}

function getPowershellPath() {
  return path.join(
    process.env.SystemRoot || "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe"
  );
}

function runDpapiBatchSync(mode, values) {
  if (!Array.isArray(values) || values.length === 0) return [];
  if (process.platform !== "win32") {
    return mode === "protect" ? [...values] : values.map(() => null);
  }

  const uniqueVals = [];
  const valToIdx = new Map();
  const indices = values.map((v) => {
    const s = String(v);
    if (valToIdx.has(s)) return valToIdx.get(s);
    const idx = uniqueVals.length;
    uniqueVals.push(s);
    valToIdx.set(s, idx);
    return idx;
  });

  const psScript = mode === "protect"
    ? `
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Security
$raw = [Console]::In.ReadToEnd()
$payload = ConvertFrom-Json -InputObject $raw
$items = @($payload.items)
$utf8 = [Text.UTF8Encoding]::new($false)
$out = @()
foreach ($s in $items) {
  if ([string]::IsNullOrEmpty($s)) {
    $out += $null
    continue
  }
  try {
    $bytes = $utf8.GetBytes([string]$s)
    $enc = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, 'CurrentUser')
    $out += [Convert]::ToBase64String($enc)
  } catch {
    $out += $null
  }
}
[Console]::Out.Write((ConvertTo-Json -InputObject @{ items = @($out) } -Compress))
`
    : `
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Security
$raw = [Console]::In.ReadToEnd()
$payload = ConvertFrom-Json -InputObject $raw
$items = @($payload.items)
$utf8 = [Text.UTF8Encoding]::new($false)
$out = @()
foreach ($b64 in $items) {
  if ([string]::IsNullOrEmpty($b64)) {
    $out += $null
    continue
  }
  try {
    $enc = [Convert]::FromBase64String([string]$b64)
    $dec = [Security.Cryptography.ProtectedData]::Unprotect($enc, $null, 'CurrentUser')
    $out += $utf8.GetString($dec)
  } catch {
    $out += $null
  }
}
[Console]::Out.Write((ConvertTo-Json -InputObject @{ items = @($out) } -Compress))
`;

  const stdout = execFileSync(
    getPowershellPath(),
    ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", psScript],
    {
      input: JSON.stringify({ items: uniqueVals }),
      encoding: "utf8",
      windowsHide: true,
      timeout: 12000,
      maxBuffer: 16 * 1024 * 1024
    }
  );

  const parsed = JSON.parse(String(stdout || "{}").trim() || "{}");
  const rawOut = parsed?.items;
  const normalizedOut = Array.isArray(rawOut)
    ? rawOut
    : (rawOut === undefined ? [] : [rawOut]);

  return indices.map((i) => (i < normalizedOut.length ? normalizedOut[i] : null));
}

function collectSensitiveSlots(cfg) {
  const slots = [];
  if (!cfg || typeof cfg !== "object") return slots;

  const pushStoredTokenSlots = (storedToken) => {
    if (!storedToken || typeof storedToken !== "object") return;
    if (typeof storedToken.id_token === "string" && storedToken.id_token) {
      slots.push({ obj: storedToken, key: "id_token" });
    }
    const inner = storedToken.token;
    if (inner && typeof inner === "object") {
      for (const k of ["refresh_token", "access_token", "refreshedForRt"]) {
        if (typeof inner[k] === "string" && inner[k]) {
          slots.push({ obj: inner, key: k });
        }
      }
    }
  };

  if (cfg.accounts && typeof cfg.accounts === "object") {
    for (const acc of Object.values(cfg.accounts)) {
      if (acc && typeof acc === "object") {
        pushStoredTokenSlots(acc.storedToken);
      }
    }
  }

  const meta = cfg.__meta__;
  if (meta && typeof meta === "object") {
    for (const mapName of ["oauthTokensByEmail", "gcpOAuthTokensByEmail", "channelTokensById"]) {
      const m = meta[mapName];
      if (m && typeof m === "object") {
        for (const tok of Object.values(m)) {
          pushStoredTokenSlots(tok);
        }
      }
    }
    if (Array.isArray(meta.oauthClients)) {
      for (const client of meta.oauthClients) {
        if (client && typeof client === "object" && typeof client.clientSecret === "string" && client.clientSecret) {
          slots.push({ obj: client, key: "clientSecret" });
        }
      }
    }
  }
  return slots;
}

export function decryptConfigTokensInPlace(cfg) {
  const slots = collectSensitiveSlots(cfg);
  let hadPlaintextTokens = false;
  let decryptedCount = 0;
  const missing = [];

  for (const slot of slots) {
    const val = slot.obj[slot.key];
    if (isDpapiCiphertext(val)) {
      if (cipherToPlain.has(val)) {
        slot.obj[slot.key] = cipherToPlain.get(val);
        decryptedCount += 1;
      } else {
        missing.push({ slot, cipher: val, b64: val.slice(DPAPI_PREFIX.length) });
      }
    } else if (typeof val === "string" && val.length > 0) {
      hadPlaintextTokens = true;
    }
  }

  if (missing.length > 0 && process.platform === "win32") {
    try {
      const results = runDpapiBatchSync("unprotect", missing.map((m) => m.b64));
      for (let i = 0; i < missing.length; i += 1) {
        const plain = results[i];
        const { slot, cipher } = missing[i];
        if (typeof plain === "string") {
          slot.obj[slot.key] = plain;
          cipherToPlain.set(cipher, plain);
          if (!plainToCipher.has(plain)) {
            plainToCipher.set(plain, cipher);
          }
          decryptedCount += 1;
        }
      }
    } catch {}
  }

  return { hadPlaintextTokens, decryptedCount };
}

export function encryptConfigTokensInPlace(cfg) {
  if (process.platform !== "win32") {
    return { encryptedCount: 0 };
  }
  const slots = collectSensitiveSlots(cfg);
  let encryptedCount = 0;
  const missing = [];

  for (const slot of slots) {
    const val = slot.obj[slot.key];
    if (typeof val !== "string" || val.length === 0 || isDpapiCiphertext(val)) {
      continue;
    }
    if (plainToCipher.has(val)) {
      slot.obj[slot.key] = plainToCipher.get(val);
      encryptedCount += 1;
    } else {
      missing.push({ slot, plain: val });
    }
  }

  if (missing.length > 0) {
    const results = runDpapiBatchSync("protect", missing.map((m) => m.plain));
    for (let i = 0; i < missing.length; i += 1) {
      const b64 = results[i];
      if (typeof b64 !== "string" || !b64) {
        throw new Error("DPAPI CurrentUser protect failed for token payload");
      }
      const cipher = `${DPAPI_PREFIX}${b64}`;
      const { slot, plain } = missing[i];
      slot.obj[slot.key] = cipher;
      plainToCipher.set(plain, cipher);
      cipherToPlain.set(cipher, plain);
      encryptedCount += 1;
    }
  }

  return { encryptedCount };
}
