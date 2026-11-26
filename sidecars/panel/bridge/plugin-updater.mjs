// 插件版本检查与 Git Fast-Forward / Release ZIP 双通道安全更新器

import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readRelayConfig, writeRelayConfig } from "../store.mjs";
import { createProxiedHttpsAgent, detectSystemHttpsProxy } from "./net-proxy.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PLUGIN_ROOT = path.resolve(__dirname, "..", "..", "..");
const PLUGIN_JSON_PATH = path.join(PLUGIN_ROOT, "plugin.json");
const DEFAULT_REPO = "ToruOlenyeva/antigravity-relay";

const TRUSTED_GITHUB_HOSTS = new Set([
  "raw.githubusercontent.com",
  "api.github.com",
  "github.com",
  "codeload.github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com"
]);

let checkInFlight = null;
let updateInFlight = null;

export function parseSemver(raw) {
  const clean = String(raw || "").trim().replace(/^v/i, "");
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(clean);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    pre: m[4] || "",
    raw: `${m[1]}.${m[2]}.${m[3]}${m[4] ? `-${m[4]}` : ""}`
  };
}

export function isValidSemver(raw) {
  return Boolean(parseSemver(raw));
}

export function compareSemver(aRaw, bRaw) {
  const a = parseSemver(aRaw);
  const b = parseSemver(bRaw);
  if (!a || !b) return 0;
  if (a.major !== b.major) return a.major > b.major ? 1 : -1;
  if (a.minor !== b.minor) return a.minor > b.minor ? 1 : -1;
  if (a.patch !== b.patch) return a.patch > b.patch ? 1 : -1;
  if (a.pre === b.pre) return 0;
  if (!a.pre) return 1;
  if (!b.pre) return -1;
  return a.pre > b.pre ? 1 : -1;
}

function parseRepoSlug(rawRepo) {
  const s = String(rawRepo || "").trim();
  const m = /github\.com[/:]([^/\s]+\/[^/\s#?]+?)(?:\.git)?\/?$/i.exec(s) || /^([^/\s]+\/[^/\s]+)$/.exec(s);
  return m ? m[1] : DEFAULT_REPO;
}

export function readInstalledPluginMeta() {
  try {
    const pj = JSON.parse(fs.readFileSync(PLUGIN_JSON_PATH, "utf8"));
    const repoUrl = typeof pj?.repository === "string"
      ? pj.repository
      : (pj?.repository?.url || `https://github.com/${DEFAULT_REPO}`);
    const repoSlug = parseRepoSlug(repoUrl);
    return {
      version: parseSemver(pj?.version)?.raw || String(pj?.version || "0.0.0"),
      repoSlug,
      repoUrl: `https://github.com/${repoSlug}`
    };
  } catch {
    return {
      version: "0.0.0",
      repoSlug: DEFAULT_REPO,
      repoUrl: `https://github.com/${DEFAULT_REPO}`
    };
  }
}

export function detectInstallMode() {
  return fs.existsSync(path.join(PLUGIN_ROOT, ".git")) ? "git" : "zip";
}

function runExecFile(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { windowsHide: true, timeout: 25000, maxBuffer: 8 * 1024 * 1024, ...opts },
      (err, stdout, stderr) => {
        if (err) {
          const detail = String(stderr || stdout || err.message || "").trim();
          reject(new Error(detail || err.message));
          return;
        }
        resolve({ stdout: String(stdout || ""), stderr: String(stderr || "") });
      }
    );
  });
}

async function runGit(args, { withProxy = false, timeoutMs = 20000 } = {}) {
  const extraEnv = {};
  if (withProxy) {
    const proxyUrl = await detectSystemHttpsProxy("github.com").catch(() => "");
    if (proxyUrl) {
      extraEnv.HTTPS_PROXY = proxyUrl;
      extraEnv.https_proxy = proxyUrl;
      extraEnv.HTTP_PROXY = proxyUrl;
      extraEnv.http_proxy = proxyUrl;
    }
  }
  return runExecFile("git", args, {
    cwd: PLUGIN_ROOT,
    timeout: timeoutMs,
    env: { ...process.env, ...extraEnv }
  });
}

async function inspectGitStatus() {
  if (detectInstallMode() !== "git") {
    return { branch: "", worktreeClean: true, dirtyCount: 0 };
  }
  try {
    const [{ stdout: branchOut }, { stdout: statusOut }] = await Promise.all([
      runGit(["rev-parse", "--abbrev-ref", "HEAD"], { timeoutMs: 4000 }),
      runGit(["status", "--porcelain"], { timeoutMs: 4000 })
    ]);
    const dirtyLines = statusOut.split(/\r?\n/).filter((line) => line.trim().length > 0);
    return {
      branch: branchOut.trim(),
      worktreeClean: dirtyLines.length === 0,
      dirtyCount: dirtyLines.length
    };
  } catch {
    return { branch: "", worktreeClean: false, dirtyCount: 0 };
  }
}

async function httpsGetBuffer(rawUrl, { timeoutMs = 10000, maxRedirects = 4, headers = {} } = {}) {
  let currentUrl = String(rawUrl || "").trim();
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const parsed = new URL(currentUrl);
    if (parsed.protocol !== "https:" || !TRUSTED_GITHUB_HOSTS.has(parsed.hostname.toLowerCase())) {
      throw new Error(`Untrusted host blocked: ${parsed.hostname}`);
    }
    const proxyCtx = await createProxiedHttpsAgent(parsed.hostname, Number(parsed.port || 443), { timeoutMs: 4500 });
    const resp = await new Promise((resolve, reject) => {
      let settled = false;
      let hardTimer = null;
      const finish = (err, val) => {
        if (settled) return;
        settled = true;
        clearTimeout(hardTimer);
        proxyCtx.cleanup();
        if (err) reject(err);
        else resolve(val);
      };
      const req = https.request(
        {
          hostname: parsed.hostname,
          port: Number(parsed.port || 443),
          path: `${parsed.pathname}${parsed.search}`,
          method: "GET",
          ...(proxyCtx.agent ? { agent: proxyCtx.agent } : {}),
          headers: {
            "User-Agent": "antigravity-relay-updater",
            Accept: "application/json, application/zip, */*",
            ...headers
          },
          timeout: timeoutMs
        },
        (res) => {
          const chunks = [];
          let totalBytes = 0;
          res.on("data", (c) => {
            totalBytes += c.length;
            if (totalBytes > 32 * 1024 * 1024) {
              req.destroy();
              return finish(new Error("Download exceeds 32MB limit"));
            }
            chunks.push(c);
          });
          res.on("end", () => {
            finish(null, {
              status: res.statusCode || 0,
              headers: res.headers || {},
              buffer: Buffer.concat(chunks),
              finalUrl: currentUrl
            });
          });
        }
      );
      hardTimer = setTimeout(() => {
        req.destroy();
        finish(new Error("HTTPS request timeout"));
      }, timeoutMs);
      req.on("error", (err) => finish(err));
      req.on("timeout", () => {
        req.destroy();
        finish(new Error("HTTPS request timeout"));
      });
      req.end();
    });

    if ([301, 302, 307, 308].includes(resp.status) && resp.headers.location) {
      currentUrl = new URL(String(resp.headers.location), currentUrl).toString();
      continue;
    }
    return resp;
  }
  throw new Error("Too many HTTP redirects");
}

function normalizeUpdateMode(raw) {
  const s = String(raw || "").trim().toLowerCase();
  return s === "auto" || s === "off" ? s : "manual";
}

export async function getUpdaterStatus() {
  const meta = readInstalledPluginMeta();
  const installMode = detectInstallMode();
  const cfg = readRelayConfig();
  const saved = (cfg.__meta__?.updater && typeof cfg.__meta__.updater === "object")
    ? cfg.__meta__.updater
    : {};
  const gitInfo = await inspectGitStatus();
  const latestVersion = parseSemver(saved.latestVersion)?.raw || "";
  const hasUpdate = Boolean(latestVersion && compareSemver(latestVersion, meta.version) > 0);
  return {
    currentVersion: meta.version,
    installMode,
    repoSlug: meta.repoSlug,
    repoUrl: meta.repoUrl,
    updateMode: normalizeUpdateMode(saved.updateMode),
    latestVersion,
    hasUpdate,
    lastCheckedAt: Number(saved.lastCheckedAt || 0),
    lastError: String(saved.lastError || ""),
    releaseUrl: String(saved.releaseUrl || `${meta.repoUrl}/releases`),
    gitBranch: gitInfo.branch,
    worktreeClean: gitInfo.worktreeClean,
    dirtyCount: gitInfo.dirtyCount,
    checking: Boolean(checkInFlight),
    updating: Boolean(updateInFlight)
  };
}

export async function setUpdaterConfig({ updateMode } = {}) {
  const nextMode = normalizeUpdateMode(updateMode);
  const cfg = readRelayConfig();
  if (!cfg.__meta__ || typeof cfg.__meta__ !== "object") cfg.__meta__ = {};
  if (!cfg.__meta__.updater || typeof cfg.__meta__.updater !== "object") cfg.__meta__.updater = {};
  if (cfg.__meta__.updater.updateMode !== nextMode) {
    cfg.__meta__.updater.updateMode = nextMode;
    writeRelayConfig(cfg);
  }
  return getUpdaterStatus();
}

export async function checkForPluginUpdate({ force = false } = {}) {
  if (checkInFlight) return checkInFlight;
  checkInFlight = (async () => {
    const meta = readInstalledPluginMeta();
    let latestVersion = "";
    let releaseUrl = `${meta.repoUrl}/releases`;
    let lastError = "";

    try {
      const rawResp = await httpsGetBuffer(
        `https://raw.githubusercontent.com/${meta.repoSlug}/main/plugin.json`,
        { timeoutMs: 8000 }
      );
      if (rawResp.status === 200) {
        const remotePkg = JSON.parse(rawResp.buffer.toString("utf8"));
        const parsed = parseSemver(remotePkg?.version);
        if (parsed) latestVersion = parsed.raw;
      } else {
        lastError = `HTTP ${rawResp.status}`;
      }
    } catch (err) {
      lastError = err?.message || "network_error";
    }

    if (!latestVersion) {
      try {
        const relResp = await httpsGetBuffer(
          `https://api.github.com/repos/${meta.repoSlug}/releases/latest`,
          { timeoutMs: 8000 }
        );
        if (relResp.status === 200) {
          const relJson = JSON.parse(relResp.buffer.toString("utf8"));
          const parsed = parseSemver(relJson?.tag_name || relJson?.name);
          if (parsed) {
            latestVersion = parsed.raw;
            lastError = "";
          }
          if (relJson?.html_url) releaseUrl = String(relJson.html_url);
        }
      } catch {}
    }

    const cfg = readRelayConfig();
    if (!cfg.__meta__ || typeof cfg.__meta__ !== "object") cfg.__meta__ = {};
    if (!cfg.__meta__.updater || typeof cfg.__meta__.updater !== "object") cfg.__meta__.updater = {};
    const prev = cfg.__meta__.updater;
    const now = Date.now();
    const shouldWrite =
      force ||
      (latestVersion && prev.latestVersion !== latestVersion) ||
      String(prev.lastError || "") !== String(lastError || "") ||
      now - Number(prev.lastCheckedAt || 0) > 300000;

    if (shouldWrite) {
      if (latestVersion) prev.latestVersion = latestVersion;
      prev.lastCheckedAt = now;
      prev.lastError = lastError;
      prev.releaseUrl = releaseUrl;
      writeRelayConfig(cfg);
    }

    const status = await getUpdaterStatus();
    return {
      success: !lastError,
      ...status
    };
  })().finally(() => {
    checkInFlight = null;
  });
  return checkInFlight;
}

function isSafeCopyPath(srcPath) {
  const name = path.basename(String(srcPath || "")).toLowerCase();
  if (
    name === ".git" ||
    name === "data" ||
    name === "node_modules" ||
    name === "plan" ||
    name.startsWith(".update-staging-")
  ) {
    return false;
  }
  return true;
}

function locateExtractedPluginRoot(extractDir) {
  if (fs.existsSync(path.join(extractDir, "plugin.json"))) return extractDir;
  try {
    for (const name of fs.readdirSync(extractDir)) {
      const sub = path.join(extractDir, name);
      if (fs.existsSync(path.join(sub, "plugin.json"))) {
        return sub;
      }
    }
  } catch {}
  return null;
}

export async function performPluginUpdate({ onUpdatedRestart = null } = {}) {
  if (updateInFlight) return updateInFlight;
  updateInFlight = (async () => {
    const meta = readInstalledPluginMeta();
    const installMode = detectInstallMode();

    if (installMode === "git") {
      const gitInfo = await inspectGitStatus();
      if (!gitInfo.worktreeClean) {
        return {
          success: false,
          code: "dirty_worktree",
          error: `本地工作区存在 ${gitInfo.dirtyCount} 项未提交改动，已阻止自动覆盖。`,
          ...(await getUpdaterStatus())
        };
      }
      if (gitInfo.branch !== "main" && !gitInfo.branch.startsWith("release/")) {
        return {
          success: false,
          code: "not_on_main_branch",
          error: `当前分支 (${gitInfo.branch || "HEAD"}) 非发布分支，仅支持 main / release/* 快进更新。`,
          ...(await getUpdaterStatus())
        };
      }

      await runGit(["fetch", "origin", gitInfo.branch], { withProxy: true, timeoutMs: 25000 });
      const { stdout: remotePkgRaw } = await runGit(
        ["show", `origin/${gitInfo.branch}:plugin.json`],
        { timeoutMs: 5000 }
      );
      const remotePkg = JSON.parse(remotePkgRaw);
      const remoteVer = parseSemver(remotePkg?.version)?.raw || "";
      if (!remoteVer) {
        throw new Error("远端 plugin.json 版本号无效");
      }
      if (compareSemver(remoteVer, meta.version) < 0) {
        return {
          success: false,
          code: "downgrade_blocked",
          error: `远端版本 (${remoteVer}) 低于当前版本 (${meta.version})，已阻止降级。`,
          ...(await getUpdaterStatus())
        };
      }

      const [{ stdout: localSha }, { stdout: remoteSha }] = await Promise.all([
        runGit(["rev-parse", "HEAD"], { timeoutMs: 4000 }),
        runGit(["rev-parse", `origin/${gitInfo.branch}`], { timeoutMs: 4000 })
      ]);
      if (localSha.trim() === remoteSha.trim()) {
        return {
          success: true,
          alreadyLatest: true,
          updated: false,
          previousVersion: meta.version,
          newVersion: remoteVer,
          ...(await getUpdaterStatus())
        };
      }

      try {
        await runGit(["merge-base", "--is-ancestor", "HEAD", `origin/${gitInfo.branch}`], { timeoutMs: 4000 });
      } catch {
        return {
          success: false,
          code: "diverged_worktree",
          error: "本地提交与远端存在分叉，无法安全快进更新。",
          ...(await getUpdaterStatus())
        };
      }

      await runGit(["pull", "--ff-only", "origin", gitInfo.branch], { withProxy: true, timeoutMs: 25000 });
      await runExecFile("node", ["--check", "sidecars/panel/main.mjs"], { cwd: PLUGIN_ROOT, timeout: 8000 });

      const nextStatus = await getUpdaterStatus();
      if (typeof onUpdatedRestart === "function") {
        setTimeout(() => {
          try { onUpdatedRestart(); } catch {}
        }, 350);
      }
      return {
        success: true,
        updated: true,
        alreadyLatest: false,
        previousVersion: meta.version,
        newVersion: remoteVer,
        ...nextStatus
      };
    }

    // ZIP 通道（支持 Releases ZIP 与 main 分支快照回退）
    const stagingDir = path.join(PLUGIN_ROOT, `.update-staging-${Date.now()}`);
    const zipPath = path.join(stagingDir, "update.zip");
    const extractDir = path.join(stagingDir, "extracted");
    try {
      fs.mkdirSync(stagingDir, { recursive: true });
      const urls = [
        `https://github.com/${meta.repoSlug}/releases/latest/download/antigravity-relay.zip`,
        `https://codeload.github.com/${meta.repoSlug}/zip/refs/heads/main`
      ];
      let zipBuf = null;
      for (const u of urls) {
        try {
          const resp = await httpsGetBuffer(u, { timeoutMs: 25000 });
          if (resp.status === 200 && resp.buffer.length > 100 && resp.buffer[0] === 0x50 && resp.buffer[1] === 0x4b) {
            zipBuf = resp.buffer;
            break;
          }
        } catch {}
      }
      if (!zipBuf) {
        throw new Error("未能下载有效的插件 ZIP 更新包");
      }

      fs.writeFileSync(zipPath, zipBuf);
      fs.mkdirSync(extractDir, { recursive: true });
      await runExecFile(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-WindowStyle",
          "Hidden",
          "-Command",
          `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${extractDir.replace(/'/g, "''")}' -Force`
        ],
        { timeout: 25000 }
      );

      const newRoot = locateExtractedPluginRoot(extractDir);
      if (!newRoot) throw new Error("更新包内未找到 plugin.json");
      const newPkg = JSON.parse(fs.readFileSync(path.join(newRoot, "plugin.json"), "utf8"));
      const newVer = parseSemver(newPkg?.version)?.raw || "";
      if (!newVer) throw new Error("更新包 plugin.json 版本号无效");
      if (compareSemver(newVer, meta.version) < 0) {
        return {
          success: false,
          code: "downgrade_blocked",
          error: `远端版本 (${newVer}) 低于当前版本 (${meta.version})，已阻止降级。`,
          ...(await getUpdaterStatus())
        };
      }

      await runExecFile("node", ["--check", path.join(newRoot, "sidecars", "panel", "main.mjs")], { timeout: 8000 });
      fs.cpSync(newRoot, PLUGIN_ROOT, {
        recursive: true,
        force: true,
        filter: (src) => isSafeCopyPath(src)
      });

      const nextStatus = await getUpdaterStatus();
      if (typeof onUpdatedRestart === "function") {
        setTimeout(() => {
          try { onUpdatedRestart(); } catch {}
        }, 350);
      }
      return {
        success: true,
        updated: true,
        alreadyLatest: false,
        previousVersion: meta.version,
        newVersion: newVer,
        ...nextStatus
      };
    } finally {
      try {
        fs.rmSync(stagingDir, { recursive: true, force: true });
      } catch {}
    }
  })().finally(() => {
    updateInFlight = null;
  });
  return updateInFlight;
}
