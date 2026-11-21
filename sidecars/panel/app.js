// 全局状态管理、主题与多语言同步、第 4 板块（模型算力路由）与 API / SSE 通信主控制器

let savedLang = null;
try { savedLang = localStorage.getItem("agy_relay_lang"); } catch (e) {}
const defaultBrowserLang = (typeof navigator !== "undefined" && typeof navigator.language === "string" && /^zh\b/i.test(navigator.language)) ? "zh" : "en";
let currentLang = (savedLang === "en" || savedLang === "zh") ? savedLang : defaultBrowserLang;

let state = {
  lsOnline: false,
  activeAccount: { email: "", tierName: "", gcpProjectId: "", channelId: "" },
  availableModels: [],
  quotaGroups: [],
  accounts: [],
  gcpProjects: [],
  routing: { models: {}, subagentDefaultTarget: "follow_current" },
  oauthPending: false
};

// 顶部「账户模型额度」当前选中的查看通道 ID（空字符串表示跟随当前激活通道）
let selectedQuotaChannelId = "";
// 第 2 板块「当前会话统计」当前选中的查看会话 ID（空字符串表示跟随当前活跃会话）与「项目汇总 vs 会话统计」切换模式
let selectedTelemetryConvId = "";
let isTelemetryProjectTotalMode = false;
// 当前处于待二次确认删除状态的通道 ID
let pendingDeleteAccountId = "";
let pendingDeleteTimer = null;
// 当前处于跨通道切换待确认是否清除签名的通道 ID
let pendingCrossSwitchAccountId = "";
// 当前处于「切换中...」过渡态的目标通道 ID（等待底层完成切换与界面刷新后才变为「使用中」）
let switchingAccountId = "";
// 顶部手动清除签名确认抽屉与多开实例抽屉开关状态
let isScrubSigsDrawerOpen = false;
let isMultiInstanceDrawerOpen = false;
let selectedMultiInstanceTargetId = "";
// 当前展开编辑设置的 GCP 通道卡片 ID 集合、展开查看异常详情的账号 ID 集合与重探中的账号 ID 集合
let expandedGcpConfigIds = new Set();
let expandedAccountErrorIds = new Set();
let probingChannelIds = new Set();
let isAddGcpDrawerOpen = false;
let addGcpDraft = {
  sourceMode: "new_oauth",
  channelType: "personal",
  email: "",
  gcpBillingMode: "agent_platform",
  gcpLocation: "global",
  projectId: "",
  scannedProjects: []
};

function showToast(msg) {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = msg;
  el.style.display = "block";
  clearTimeout(window.__toastTimer);
  window.__toastTimer = setTimeout(() => {
    el.style.display = "none";
  }, 2600);
}

// 自动跟随 Antigravity 宿主与系统深浅色主题（无手动按钮）
window.addEventListener("message", (event) => {
  if (event.data && event.data.type === "theme-change") {
    const vars = event.data.payload?.cssVariables || {};
    let bg = (vars["--background"] || vars["--bg-base"] || vars["--vscode-editor-background"] || "").trim().toLowerCase();
    if (bg) {
      const isLight = bg.startsWith("#f") || bg.startsWith("#e") || bg.startsWith("#d") || bg === "white" || bg.startsWith("rgb(25") || bg.startsWith("rgb(24");
      const mode = isLight ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", mode);
      try { localStorage.setItem("antigravity_theme_mode", mode); } catch (e) {}
    }
  }
});

if (window.matchMedia) {
  try {
    window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", (e) => {
      const mode = e.matches ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", mode);
    });
  } catch (e) {}
}

let hasDeferredRender = false;

function hasOpenCustomDropdown() {
  return Boolean(document.querySelector(".custom-dropdown.open"));
}

function closeCustomDropdowns(exceptWrapper = null) {
  document.querySelectorAll(".custom-dropdown.open").forEach((el) => {
    if (!exceptWrapper || el !== exceptWrapper) {
      el.classList.remove("open");
    }
  });
}

function toggleCustomDropdownWrapper(wrapper, opts = {}) {
  if (!wrapper) return;
  const isOpen = wrapper.classList.contains("open");
  closeCustomDropdowns();
  if (!isOpen) {
    if (opts.allowDropUp) {
      const rect = wrapper.getBoundingClientRect();
      if (window.innerHeight - rect.bottom < 190) {
        wrapper.classList.add("drop-up");
      } else {
        wrapper.classList.remove("drop-up");
      }
    }
    wrapper.classList.add("open");
  } else {
    flushDeferredRender();
  }
}

function flushDeferredRender() {
  if (hasDeferredRender && !hasOpenCustomDropdown()) {
    hasDeferredRender = false;
    renderAll();
  }
}

function safeRenderAll() {
  if (hasOpenCustomDropdown()) {
    hasDeferredRender = true;
    return;
  }
  hasDeferredRender = false;
  renderAll();
}

// 点击空白处或按 Escape 收起所有悬浮下拉框并冲刷挂起的后台刷新
document.addEventListener("click", (e) => {
  if (!e.target.closest(".custom-dropdown") && hasOpenCustomDropdown()) {
    closeCustomDropdowns();
    flushDeferredRender();
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && hasOpenCustomDropdown()) {
    closeCustomDropdowns();
    flushDeferredRender();
  }
});

function toggleLanguage() {
  currentLang = currentLang === "zh" ? "en" : "zh";
  try { localStorage.setItem("agy_relay_lang", currentLang); } catch (e) {}
  applyI18n();
  fetch("/api/set-language", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ lang: currentLang })
  }).catch(() => {});
}

function applyI18n() {
  const t = I18N[currentLang];
  document.getElementById("uiAppTitle").textContent = t.appTitle;
  document.getElementById("langToggleBtn").textContent = t.langBtn;
  document.getElementById("refreshBtn").textContent = t.refreshBtn;
  document.getElementById("secCurrentTitle").textContent = t.secCurrentTitle;
  const telTitleEl = document.getElementById("secTelemetryTitle");
  if (telTitleEl && t.secTelemetryTitle) {
    telTitleEl.textContent = t.secTelemetryTitle;
  }
  document.getElementById("secAccountsTitle").textContent = t.secAccountsTitle;
  const scrubBtn = document.getElementById("btnScrubSignatures");
  if (scrubBtn) scrubBtn.textContent = t.btnScrubSignatures;
  const multiDrawerBtn = document.getElementById("btnToggleMultiInstance");
  if (multiDrawerBtn) multiDrawerBtn.textContent = t.btnOpenMultiDrawer;
  const addGcpBtn = document.getElementById("btnToggleAddGcp");
  if (addGcpBtn) addGcpBtn.textContent = t.btnAddGcpChannel;
  document.getElementById("btnCaptureCurrent").textContent = t.btnCaptureCurrent;
  document.getElementById("btnAddOAuthAccount").textContent = t.btnAddOAuth;
  document.getElementById("oauthBannerText").textContent = t.oauthBannerText;
  document.getElementById("btnCancelOAuth").textContent = t.btnCancelOAuth;
  document.getElementById("secRoutingTitle").textContent = t.secRoutingTitle;
  document.getElementById("secRoutingHint").textContent = t.secRoutingHint;
  renderAll();
}

function renderAll() {
  hasDeferredRender = false;
  const t = I18N[currentLang];
  const lsBadge = document.getElementById("uiLsBadge");
  if (state.lsOnline) {
    lsBadge.textContent = t.online;
    lsBadge.classList.remove("offline");
  } else {
    lsBadge.textContent = t.offline;
    lsBadge.classList.add("offline");
  }

  const oauthBanner = document.getElementById("oauthPendingBanner");
  oauthBanner.style.display = state.oauthPending ? "flex" : "none";

  renderSessionSelector();
  renderQuotaGroups();
  renderSessionTelemetry();
  renderScrubSignaturesDrawer();
  renderMultiInstanceDrawer();
  renderAddGcpDrawer();
  renderAccountList();
  renderRoutingList();
}

function getPoolModelsForScope(isGcpScope = false) {
  const modelMap = new Map();
  const addModelEntry = (m, isFromGcp) => {
    if (!m) return;
    const rawLabel = String(m.label || m.modelId || "").trim();
    if (!rawLabel) return;
    const baseLabel = rawLabel.replace(/\s*\((Low|Medium|High|XHigh|Extra|Max)\)\s*$/i, "").trim();
    const vars = Array.isArray(m.variantIds) ? m.variantIds : [baseLabel, rawLabel];
    if (!modelMap.has(baseLabel)) {
      modelMap.set(baseLabel, {
        label: baseLabel,
        modelId: baseLabel,
        variantIds: Array.from(new Set([baseLabel, rawLabel, ...vars])),
        remainingPct: isFromGcp ? 100 : (m.remainingPct ?? 100),
        resetTime: isFromGcp ? "" : (m.resetTime || ""),
        unlimited: Boolean(isFromGcp || m.unlimited)
      });
    } else {
      const existing = modelMap.get(baseLabel);
      for (const v of [rawLabel, ...vars]) {
        if (v && !existing.variantIds.includes(v)) {
          existing.variantIds.push(v);
        }
      }
    }
  };

  if (isGcpScope) {
    // 优先引用当前活跃 GCP 会话的 Antigravity 原生模型顺序，再补充其余已收录 GCP 通道模型
    if (state.activeAccount?.gcpProjectId) {
      for (const m of (state.availableModels || [])) {
        addModelEntry(m, true);
      }
    }
    for (const acc of (state.accounts || [])) {
      const isGcp = acc.channelType === "gcp" || Boolean(acc.gcpProjectId);
      if (!isGcp) continue;
      for (const m of (acc.cachedQuota?.availableModels || [])) {
        addModelEntry(m, true);
      }
    }
  } else {
    // 优先引用当前活跃个人会话的 Antigravity 原生模型顺序，再补充其余已收录个人通道模型
    if (!state.activeAccount?.gcpProjectId) {
      for (const m of (state.availableModels || [])) {
        addModelEntry(m, false);
      }
    }
    for (const acc of (state.accounts || [])) {
      const isGcp = acc.channelType === "gcp" || Boolean(acc.gcpProjectId);
      if (isGcp) continue;
      for (const m of (acc.cachedQuotaByPool?.daily?.availableModels || [])) {
        addModelEntry(m, false);
      }
      for (const m of (acc.cachedQuota?.availableModels || [])) {
        addModelEntry(m, false);
      }
      for (const m of (acc.cachedQuotaByPool?.prod?.availableModels || [])) {
        addModelEntry(m, false);
      }
    }
  }

  return Array.from(modelMap.values());
}

function buildRouteOptionsList(modelObj = null, isGcpScope = false) {
  const t = I18N[currentLang];
  if (isGcpScope) {
    // GCP 通道专属路由表：无自动轮询，不混入任何个人账号，仅提供「跟随当前 GCP 通道」与手选其他已收录 GCP 通道
    const gcpOptions = [
      { value: "follow_current", label: t.routeFollowCurrentGcp || t.routeFollowCurrent, badgeType: "", badgeText: "" }
    ];
    const seenGcp = new Set(["follow_current"]);
    for (const acc of (state.accounts || [])) {
      const isGcp = acc.channelType === "gcp" || Boolean(acc.gcpProjectId);
      if (!isGcp) continue;
      if (modelObj && acc.cachedQuota?.availableModels?.length && !findModelInChannel(acc, modelObj)) {
        continue;
      }
      const val = `account:${acc.id}`;
      if (seenGcp.has(val)) continue;
      seenGcp.add(val);
      const badgeInfo = getChannelBadgeInfo(acc);
      gcpOptions.push({
        value: val,
        label: acc.gcpProjectId ? `${acc.email} · ${acc.gcpProjectId}` : acc.email,
        badgeType: badgeInfo.badgeType,
        badgeText: badgeInfo.badgeText
      });
    }
    return gcpOptions;
  }

  const options = [
    { value: "follow_current", label: t.routeFollowCurrent, badgeType: "", badgeText: "" },
    { value: "auto_poll", label: t.routeAutoPoll, badgeType: "", badgeText: "" }
  ];

  const seenValues = new Set(["follow_current", "auto_poll"]);

  for (const acc of (state.accounts || [])) {
    const isGcp = acc.channelType === "gcp" || Boolean(acc.gcpProjectId);
    // 个人通道路由表仅列出个人账号（Free / Plus / Pro / Ultra），绝不混入 GCP 通道
    if (isGcp) continue;
    if (modelObj && !findModelInChannel(acc, modelObj)) {
      continue;
    }
    const val = `account:${acc.id}`;
    if (seenValues.has(val)) continue;
    seenValues.add(val);
    const badgeInfo = getChannelBadgeInfo(acc);
    options.push({
      value: val,
      label: acc.email,
      badgeType: badgeInfo.badgeType,
      badgeText: badgeInfo.badgeText
    });
  }

  return options;
}

function createCustomDropdown(selectedValue, onSelect, modelObj = null, isGcpScope = false) {
  const options = buildRouteOptionsList(modelObj, isGcpScope);
  const activeOpt = options.find((o) => o.value === selectedValue) || options[0];

  const wrapper = document.createElement("div");
  wrapper.className = "custom-dropdown";

  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "dropdown-trigger";

  const triggerLeft = document.createElement("div");
  triggerLeft.className = "active-email-wrap";

  if (activeOpt.badgeText) {
    const trigBadge = document.createElement("span");
    trigBadge.className = "channel-type-badge " + activeOpt.badgeType;
    trigBadge.textContent = activeOpt.badgeText;
    triggerLeft.appendChild(trigBadge);
  }

  const triggerText = document.createElement("span");
  triggerText.className = "dropdown-trigger-text";
  triggerText.textContent = activeOpt.label;
  triggerLeft.appendChild(triggerText);

  const arrowSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  arrowSvg.setAttribute("class", "dropdown-arrow");
  arrowSvg.setAttribute("viewBox", "0 0 16 16");
  arrowSvg.setAttribute("fill", "none");
  arrowSvg.innerHTML = `<path d="M4 6L8 10L12 6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>`;

  trigger.appendChild(triggerLeft);
  trigger.appendChild(arrowSvg);

  const menu = document.createElement("div");
  menu.className = "dropdown-menu";

  for (const opt of options) {
    const item = document.createElement("div");
    item.className = "dropdown-option" + (opt.value === activeOpt.value ? " active" : "");

    const itemLeft = document.createElement("div");
    itemLeft.className = "active-email-wrap";

    if (opt.badgeText) {
      const optBadge = document.createElement("span");
      optBadge.className = "channel-type-badge " + opt.badgeType;
      optBadge.textContent = opt.badgeText;
      itemLeft.appendChild(optBadge);
    }

    const itemLabel = document.createElement("span");
    itemLabel.className = "dropdown-option-label";
    itemLabel.textContent = opt.label;
    itemLeft.appendChild(itemLabel);

    const checkSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    checkSvg.setAttribute("class", "check-icon");
    checkSvg.setAttribute("viewBox", "0 0 16 16");
    checkSvg.setAttribute("fill", "none");
    checkSvg.innerHTML = `<path d="M3.5 8.5L6.5 11.5L12.5 4.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`;

    item.appendChild(itemLeft);
    item.appendChild(checkSvg);

    item.onclick = (ev) => {
      ev.stopPropagation();
      wrapper.classList.remove("open");
      if (opt.value !== activeOpt.value) {
        onSelect(opt.value);
      }
      flushDeferredRender();
    };

    menu.appendChild(item);
  }

  trigger.onclick = (ev) => {
    ev.stopPropagation();
    toggleCustomDropdownWrapper(wrapper, { allowDropUp: true });
  };

  wrapper.appendChild(trigger);
  wrapper.appendChild(menu);
  return wrapper;
}

function findModelInQuotaSnapshot(quotaSnap, modelObj) {
  const list = quotaSnap?.availableModels || [];
  const targetId = (modelObj.modelId || modelObj.label || "").toLowerCase();
  const direct = list.find((item) => {
    const id = (item.modelId || item.label || "").toLowerCase();
    return id === targetId;
  });
  if (direct) return direct;
  return null;
}

function findModelInChannel(acc, modelObj, explicitPool = "") {
  if (!acc) return null;
  const isGcp = acc.channelType === "gcp" || Boolean(acc.gcpProjectId);
  if (isGcp) {
    return findModelInQuotaSnapshot(acc.cachedQuota, modelObj);
  }
  const activePool = explicitPool || getActivePersonalPoolUi();
  const primarySnap = acc.cachedQuotaByPool?.[activePool] || acc.cachedQuota;
  const matchedPrimary = findModelInQuotaSnapshot(primarySnap, modelObj);
  if (matchedPrimary) return matchedPrimary;
  const altPool = activePool === "prod" ? "daily" : "prod";
  return findModelInQuotaSnapshot(acc.cachedQuotaByPool?.[altPool], modelObj);
}

const WEEK_PENALTY_MS = 7 * 24 * 3600 * 1000;

function extractOrchestratorTargetUi(str) {
  const s = String(str || "").trim();
  if (!s) return "";
  const pm = /^orchestrator\s*\(([^)]+)\)$/i.exec(s);
  if (pm) return pm[1].trim().toLowerCase();
  if (/orchestrator.*g1-pro|^orchestrator-argon$/i.test(s)) return "argon";
  const sm = /orchestrator[-_]([a-z0-9][a-z0-9._-]*)$/i.exec(s);
  if (sm) {
    const raw = sm[1].toLowerCase().replace(/^g\d+[-_](?=[a-z])/i, "").replace(/[-_]+/g, " ").trim();
    return raw === "pro" ? "argon" : raw;
  }
  return "";
}

function matchesTargetTokensUi(text, target) {
  const tokens = String(target || "").trim().toLowerCase().split(/[^a-z0-9.]+/i).filter(Boolean);
  if (tokens.length === 0) return false;
  const hay = String(text || "");
  return tokens.every((tok) => {
    const escaped = tok.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^a-z0-9.])${escaped}([^a-z0-9.]|$)`, "i").test(hay);
  });
}

function extractModelDualQuotaUi(accOrQuota, matched, m) {
  const now = Date.now();
  const defaultWeeklyMs = now + WEEK_PENALTY_MS;
  const groups = Array.isArray(accOrQuota?.quotaGroups)
    ? accOrQuota.quotaGroups
    : (accOrQuota?.cachedQuota?.quotaGroups || []);
  const clean = String(m?.label || m?.modelId || matched?.label || matched?.modelId || "").toLowerCase();
  const geminiGroup = groups.find((g) => /gemini\s*models/i.test(g.id || g.displayName || ""));
  const claudeGroup = groups.find((g) => /claude|gpt/i.test(g.id || g.displayName || ""));
  const argonGroup = groups.find((g) => /\bargon\b/i.test(g.id || g.displayName || ""));

  let grp = null;
  // 1. Exact official group description or name match
  for (const g of groups) {
    const desc = String(g.description || "").toLowerCase();
    const gName = String(g.displayName || g.id || "").toLowerCase();
    if ((clean && desc.includes(clean)) || (clean && gName === clean)) {
      grp = g;
      break;
    }
  }
  // 2. Dynamic parenthetical / orchestrator target token match (group title first, then description)
  if (!grp && clean) {
    const target = extractOrchestratorTargetUi(clean);
    if (target) {
      grp = groups.find((g) => matchesTargetTokensUi(g.displayName || g.id || "", target)) ||
            groups.find((g) => matchesTargetTokensUi(g.description || "", target)) ||
            null;
    }
  }
  // 3. Bucket resetTime fingerprint fallback
  const itemReset = String(matched?.resetTime || m?.resetTime || "").trim();
  if (!grp && itemReset) {
    const targetPct = matched?.remainingPct ?? m?.remainingPct;
    grp = groups.find((g) =>
      (g.buckets || []).some((b) => b.resetTime && b.resetTime === itemReset && (targetPct === undefined || b.remainingPct === targetPct))
    ) || null;
    if (!grp) {
      const resetHits = groups.filter((g) => (g.buckets || []).some((b) => b.resetTime && b.resetTime === itemReset));
      if (resetHits.length === 1) grp = resetHits[0];
    }
  }
  // 4. Keyword fallback (Argon-only -> Argon/Gemini; generic orchestrator -> Gemini)
  if (!grp && clean) {
    if (/\bargon\b|g1-pro|m668/i.test(clean)) {
      grp = argonGroup || geminiGroup || null;
    } else if (/gemini/i.test(clean)) {
      grp = geminiGroup || null;
    } else if (/claude|gpt/i.test(clean)) {
      grp = claudeGroup || null;
    } else if (/orchestrator/i.test(clean)) {
      grp = geminiGroup || null;
    }
  }

  const bks = grp?.buckets || [];
  const bWk = bks.find((b) => /weekly|7d/i.test(b.window || b.bucketId || ""));
  const b5h = bks.find((b) => /5h/i.test(b.window || b.bucketId || ""));

  const weeklyPct = Number(
    matched?.weeklyPct ?? bWk?.remainingPct ?? matched?.remainingPct ?? 100
  );
  const weeklyResetTime = matched?.weeklyResetTime || bWk?.resetTime || matched?.resetTime || "";
  const parsedWkMs = weeklyResetTime ? new Date(weeklyResetTime).getTime() : defaultWeeklyMs;
  const weeklyResetMs = Number.isFinite(parsedWkMs) && parsedWkMs > 0 ? parsedWkMs : defaultWeeklyMs;

  const fiveHourPct = Number(
    matched?.fiveHourPct ?? b5h?.remainingPct ?? weeklyPct
  );
  const fiveHourResetTime = matched?.fiveHourResetTime || b5h?.resetTime || weeklyResetTime;
  const parsed5hMs = fiveHourResetTime ? new Date(fiveHourResetTime).getTime() : weeklyResetMs;
  const fiveHourResetMs = Number.isFinite(parsed5hMs) && parsed5hMs > 0 ? parsed5hMs : weeklyResetMs;

  return {
    weeklyPct,
    weeklyResetTime,
    weeklyResetMs,
    fiveHourPct,
    fiveHourResetTime,
    fiveHourResetMs,
    hasDistinct5h: Boolean(b5h || (matched?.fiveHourResetTime && matched.fiveHourResetTime !== matched.weeklyResetTime))
  };
}

function isChannelTemporarilyBlockedUi(acc) {
  if (!acc || acc.authExpired) return true;
  const nowMs = Date.now();
  const blockedUntil = Number(acc.routeBlockedUntil || 0);
  if (blockedUntil > nowMs) return true;
  const errAt = Number(acc.lastProbeError?.at || 0);
  const errMsg = String(acc.lastProbeError?.message || "");
  return errAt > 0 && (nowMs - errAt) < 600000 && /#3501|valid license|\b401\b|\b403\b/i.test(errMsg);
}

function selectAutoPollChannel(accounts, m, activeChannelId, thresholdPct = 5) {
  const preferredPool = "daily";
  const poolOrder = ["daily"];
  const candidates = [];
  for (const acc of accounts) {
    const isGcp = acc.channelType === "gcp" || Boolean(acc.gcpProjectId);
    if (isGcp || isChannelTemporarilyBlockedUi(acc)) continue;
    for (const pool of poolOrder) {
      const poolSnap = acc.cachedQuotaByPool?.[pool] || (pool === preferredPool ? acc.cachedQuota : null);
      if (!poolSnap) continue;
      const matched = findModelInQuotaSnapshot(poolSnap, m);
      if (!matched) continue;
      const dual = extractModelDualQuotaUi(poolSnap, matched, m);
      if (dual.weeklyPct <= 0 || dual.fiveHourPct <= 0) continue;

      const weeklyLow = dual.weeklyPct <= thresholdPct;
      const effectiveWeeklyResetMs = dual.weeklyResetMs + (weeklyLow ? WEEK_PENALTY_MS : 0);
      const fiveHourAboveThreshold = dual.fiveHourPct > thresholdPct;

      candidates.push({
        acc,
        pool,
        matched,
        dual,
        isGcp: false,
        weeklyPct: dual.weeklyPct,
        fiveHourPct: dual.fiveHourPct,
        fiveHourAboveThreshold,
        effectiveWeeklyResetMs,
        fiveHourResetMs: dual.fiveHourResetMs,
        isPreferredPool: pool === preferredPool,
        isCurrent: acc.id === activeChannelId
      });
    }
  }
  if (candidates.length === 0) return null;

  candidates.sort((a, b) => {
    if (a.fiveHourAboveThreshold !== b.fiveHourAboveThreshold) {
      return a.fiveHourAboveThreshold ? -1 : 1;
    }
    // 第一层：先周额度重置时间升序
    if (Math.abs(a.effectiveWeeklyResetMs - b.effectiveWeeklyResetMs) > 120000) {
      return a.effectiveWeeklyResetMs - b.effectiveWeeklyResetMs;
    }
    // 第二层：再 5 小时额度重置时间升序
    if (Math.abs(a.fiveHourResetMs - b.fiveHourResetMs) > 60000) {
      return a.fiveHourResetMs - b.fiveHourResetMs;
    }
    if (a.isPreferredPool !== b.isPreferredPool) return a.isPreferredPool ? -1 : 1;
    if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
    if (b.weeklyPct !== a.weeklyPct) return b.weeklyPct - a.weeklyPct;
    if (b.fiveHourPct !== a.fiveHourPct) return b.fiveHourPct - a.fiveHourPct;
    return 0;
  });

  return candidates[0];
}

function parseRouteAccountRef(spec) {
  if (!spec || typeof spec !== "string") return null;
  const trimmed = spec.trim();
  const match = trimmed.match(/^(?:account|channel):(.+)$/);
  if (!match) return null;
  const rawRef = match[1].trim();
  if (!rawRef) return null;
  const hashIdx = rawRef.indexOf("#");
  const poolAtIdx = hashIdx >= 0 ? rawRef.indexOf("@", hashIdx) : -1;
  const accId = poolAtIdx >= 0 ? rawRef.slice(0, poolAtIdx) : rawRef;
  const explicitPool = poolAtIdx >= 0 ? rawRef.slice(poolAtIdx + 1) : "";
  return { accId, explicitPool };
}

function formatModelQuotaSubText(m, selectedRoute) {
  const t = I18N[currentLang];
  const accounts = state.accounts || [];
  const activeChannelId = state.activeAccount?.channelId || "";
  const thresholdPct = Number(state.routing?.lowQuotaThresholdPct ?? 5);
  const activePool = getActivePersonalPoolUi();

  if (selectedRoute === "auto_poll") {
    const picked = selectAutoPollChannel(accounts, m, activeChannelId, thresholdPct);
    if (picked) {
      const { acc: bestAcc, matched: bestModel, dual, isGcp } = picked;
      const shortName = isGcp
        ? `${t.channelGcpBadge}·${bestAcc.gcpProjectId.slice(0, 12)}`
        : bestAcc.email.split("@")[0];
      if (isGcp) {
        return `${t.autoPollSubPrefix}${shortName} · ${t.gcpRouteSubUnlimited}`;
      }
      const wkCountdown = formatResetCountdown(dual?.weeklyResetTime || bestModel.resetTime);
      if (dual?.hasDistinct5h) {
        const wkLabel = currentLang === "zh" ? "周" : "Wk";
        return wkCountdown
          ? `${t.autoPollSubPrefix}${shortName} · ${wkLabel} ${dual.weeklyPct}% (${wkCountdown}) · 5h ${dual.fiveHourPct}%`
          : `${t.autoPollSubPrefix}${shortName} · ${wkLabel} ${dual.weeklyPct}% · 5h ${dual.fiveHourPct}%`;
      }
      return wkCountdown
        ? `${t.autoPollSubPrefix}${shortName} · ${t.remainingLabel} ${dual ? dual.weeklyPct : bestModel.remainingPct}% · ${t.resetsInPrefix}${wkCountdown}${t.resetsInSuffix}`
        : `${t.autoPollSubPrefix}${shortName} · ${t.remainingLabel} ${dual ? dual.weeklyPct : bestModel.remainingPct}%`;
    }
    return `${t.autoPollSubPrefix}${currentLang === "zh" ? "当前无可用额度账号" : "No quota available"}`;
  }

  const formatPersonalAccountModelSub = (targetAcc, explicitPool = "") => {
    const chosenPool = explicitPool || activePool;
    const snap = targetAcc.cachedQuotaByPool?.[chosenPool] || targetAcc.cachedQuota;
    const matched = findModelInQuotaSnapshot(snap, m);
    const dual = matched ? extractModelDualQuotaUi(snap, matched, m) : null;
    if (matched && dual) {
      const countdown = formatResetCountdown(dual.weeklyResetTime || matched.resetTime);
      if (dual.hasDistinct5h) {
        const wkLabel = currentLang === "zh" ? "周" : "Wk";
        return countdown
          ? `${wkLabel} ${dual.weeklyPct}% (${countdown}) · 5h ${dual.fiveHourPct}%`
          : `${wkLabel} ${dual.weeklyPct}% · 5h ${dual.fiveHourPct}%`;
      }
      return countdown
        ? `${t.remainingLabel} ${dual.weeklyPct}% · ${t.resetsInPrefix}${countdown}${t.resetsInSuffix}`
        : `${t.remainingLabel} ${dual.weeklyPct}%`;
    }
    return t.gcpRouteSubUnsupported;
  };

  const parsedRouteRef = parseRouteAccountRef(selectedRoute);
  if (parsedRouteRef) {
    const { accId, explicitPool } = parsedRouteRef;
    const targetAcc = accounts.find(
      (a) => a.id === accId || (!accId.includes("#") && a.id === `${accId}#personal`)
    );
    if (targetAcc) {
      const isGcp = targetAcc.channelType === "gcp" || Boolean(targetAcc.gcpProjectId);
      if (isGcp) {
        const matched = findModelInChannel(targetAcc, m);
        return matched ? t.gcpRouteSubUnlimited : t.gcpRouteSubUnsupported;
      }
      return formatPersonalAccountModelSub(targetAcc, explicitPool || "");
    }
  }

  const activeAcc = accounts.find((a) => a.id === activeChannelId);
  if (activeAcc) {
    const isGcp = activeAcc.channelType === "gcp" || Boolean(activeAcc.gcpProjectId);
    if (isGcp) {
      const matched = findModelInChannel(activeAcc, m);
      return matched ? t.gcpRouteSubUnlimited : t.gcpRouteSubUnsupported;
    }
    return formatPersonalAccountModelSub(activeAcc);
  }

  if (state.activeAccount?.gcpProjectId || m.unlimited) {
    return t.gcpRouteSubUnlimited;
  }
  const countdown = formatResetCountdown(m.resetTime);
  return countdown
    ? `${t.remainingLabel} ${m.remainingPct}% · ${t.resetsInPrefix}${countdown}${t.resetsInSuffix}`
    : `${t.remainingLabel} ${m.remainingPct}%`;
}

function renderRoutingList() {
  const container = document.getElementById("modelRoutingContainer");
  container.innerHTML = "";
  const t = I18N[currentLang];
  const isGcpScope = Boolean(state.activeAccount?.gcpProjectId);

  const routingTitleEl = document.getElementById("secRoutingTitle");
  const routingHintEl = document.getElementById("secRoutingHint");
  if (routingTitleEl) {
    routingTitleEl.textContent = isGcpScope
      ? (t.secRoutingTitleGcp || t.secRoutingTitle)
      : (t.secRoutingTitlePersonal || t.secRoutingTitle);
  }
  if (routingHintEl) {
    routingHintEl.textContent = isGcpScope
      ? (t.secRoutingHintGcp || t.secRoutingHint)
      : (t.secRoutingHintPersonal || t.secRoutingHint);
  }

  const models = getPoolModelsForScope(isGcpScope);
  const routeMap = isGcpScope
    ? (state.routing?.gcpModels || {})
    : (state.routing?.models || {});
  const routeScope = isGcpScope ? "gcp" : "personal";

  for (const m of models) {
    let selectedRoute = routeMap[m.modelId] || "follow_current";
    if (isGcpScope && selectedRoute === "auto_poll") {
      selectedRoute = "follow_current";
    }
    const parsedSelRef = parseRouteAccountRef(selectedRoute);
    if (parsedSelRef) {
      const targetAcc = (state.accounts || []).find(
        (a) => a.id === parsedSelRef.accId || (!parsedSelRef.accId.includes("#") && a.id === `${parsedSelRef.accId}#personal`)
      );
      const targetAccIsGcp = targetAcc ? (targetAcc.channelType === "gcp" || Boolean(targetAcc.gcpProjectId)) : false;
      if (!targetAcc || targetAccIsGcp !== isGcpScope || (!isGcpScope && !findModelInChannel(targetAcc, m))) {
        selectedRoute = "follow_current";
      }
    }
    const row = document.createElement("div");
    row.className = "routing-row";

    const info = document.createElement("div");
    info.className = "routing-model-info";

    const title = document.createElement("span");
    title.className = "routing-model-name";
    title.textContent = m.label;

    const sub = document.createElement("span");
    sub.className = "routing-model-sub";
    sub.textContent = formatModelQuotaSubText(m, selectedRoute);

    info.appendChild(title);
    info.appendChild(sub);

    const dropdown = createCustomDropdown(selectedRoute, (newVal) => {
      saveRoutingRule({
        modelId: m.modelId,
        variantIds: m.variantIds || [],
        targetSpec: newVal,
        routeScope
      });
      if (newVal.startsWith("account:")) {
        probeChannelQuotaInBackground(newVal.slice(8));
      } else if (newVal === "auto_poll") {
        loadSystemStatus(true, true);
      }
    }, m, isGcpScope);

    row.appendChild(info);
    row.appendChild(dropdown);
    container.appendChild(row);
  }
}

let currentFrontendVersion = "";
let manualRefreshInFlight = null;

function setRefreshButtonLoading(isLoading) {
  const btn = document.getElementById("refreshBtn");
  if (!btn) return;
  const t = I18N[currentLang];
  btn.disabled = Boolean(isLoading);
  btn.textContent = isLoading
    ? (t.refreshingBtn || (currentLang === "zh" ? "刷新中..." : "Refreshing..."))
    : t.refreshBtn;
}

function reconcileSwitchingState(nextSnap, prevActive) {
  if (!nextSnap || typeof nextSnap !== "object") return nextSnap;
  if (switchingAccountId) {
    if (nextSnap.activeAccount?.channelId === switchingAccountId) {
      switchingAccountId = "";
    } else if (prevActive?.channelId) {
      nextSnap.activeAccount = prevActive;
    }
  }
  return nextSnap;
}

let lastHandledOAuthEventKey = "";
let lastKnownStateRevision = 0;
let lastKnownConfigMtimeMs = 0;
let lastFullStatusFetchAt = 0;

function applyIncomingSnapshot(nextSnap, opts = {}) {
  if (!nextSnap || nextSnap.error) return false;
  if (nextSnap.frontendVersion) {
    if (currentFrontendVersion && currentFrontendVersion !== dataFrontendVer(nextSnap)) {
      window.location.reload();
      return false;
    }
    currentFrontendVersion = nextSnap.frontendVersion;
  }
  if (nextSnap.stateRevision !== undefined) {
    lastKnownStateRevision = Math.max(lastKnownStateRevision, Number(nextSnap.stateRevision || 0));
  }
  if (nextSnap.configMtimeMs !== undefined && Number(nextSnap.configMtimeMs) > 0) {
    lastKnownConfigMtimeMs = Math.max(lastKnownConfigMtimeMs, Number(nextSnap.configMtimeMs));
  }
  lastFullStatusFetchAt = Date.now();

  const prevOAuthEvent = nextSnap.lastOAuthEvent;
  const prevActive = state.activeAccount;
  state = reconcileSwitchingState(nextSnap, prevActive);

  if (prevOAuthEvent?.success && prevOAuthEvent.email) {
    const eventKey = prevOAuthEvent.eventId || `${prevOAuthEvent.email}|${prevOAuthEvent.autoScanGcp ? "gcp" : "personal"}`;
    const isNewOAuthEvent = eventKey !== lastHandledOAuthEventKey;
    if (isNewOAuthEvent) {
      lastHandledOAuthEventKey = eventKey;
      if (prevOAuthEvent.autoScanGcp) {
        isAddGcpDrawerOpen = true;
        addGcpDraft.sourceMode = "existing";
        addGcpDraft.email = prevOAuthEvent.email;
        addGcpDraft.channelType = "gcp";
        addGcpDraft.scannedProjects = [];
      }
    }
    if (opts.forceRender) {
      renderAll();
    } else {
      safeRenderAll();
    }
    if (isNewOAuthEvent && opts.allowOAuthToast !== false) {
      showToast(`${I18N[currentLang].toastOAuthSuccess}${prevOAuthEvent.email}`);
    }
    return true;
  }

  if (opts.forceRender) {
    renderAll();
  } else {
    safeRenderAll();
  }
  return true;
}

async function loadSystemStatus(force = false, silent = false, opts = {}) {
  if (force && manualRefreshInFlight) {
    return manualRefreshInFlight;
  }
  const run = (async () => {
    if (force) setRefreshButtonLoading(true);
    try {
      const qs = force ? "?force=1" : (opts?.light ? "?light=1" : "");
      const res = await fetch(`/api/status${qs}`, { cache: "no-store" });
      const data = await res.json();
      if (applyIncomingSnapshot(data, { forceRender: force, allowOAuthToast: true })) {
        if (!silent) showToast(I18N[currentLang].toastRefreshed);
      }
    } catch (e) {} finally {
      if (force) setRefreshButtonLoading(false);
    }
  })();
  if (force) {
    manualRefreshInFlight = run.finally(() => {
      manualRefreshInFlight = null;
    });
  }
  return run;
}

function handleManualRefresh() {
  loadSystemStatus(true, false);
}

async function handleDiscoverGcpProjects(targetEmail = "") {
  try {
    const email = targetEmail || state.activeAccount?.email || "";
    const res = await fetch("/api/discover-gcp-projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email })
    });
    const data = await res.json();
    const list = Array.isArray(data.discovered) ? data.discovered : [];
    const t = I18N[currentLang];
    if (list.length === 1) {
      addGcpDraft.scannedProjects = [];
      addGcpDraft.projectId = list[0].projectId || "";
      renderAddGcpDrawer();
      showToast(`${t.toastGcpSingleFilled}${addGcpDraft.projectId}`);
    } else if (list.length > 1) {
      addGcpDraft.scannedProjects = list;
      addGcpDraft.projectId = list[0].projectId || "";
      renderAddGcpDrawer();
      showToast(`${t.toastGcpMultiFound}${list.length}`);
    } else {
      addGcpDraft.scannedProjects = [];
      if (/^(aicode-consumers|rising-fact-|gen-lang-client-)/i.test(addGcpDraft.projectId || "")) {
        addGcpDraft.projectId = "";
      }
      renderAddGcpDrawer();
    }
  } catch (e) {}
}

async function addPersonalChannelForEmail(email) {
  try {
    const cleanEmail = (email || "").trim();
    if (!cleanEmail) return;
    const res = await fetch("/api/add-gcp-channel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: cleanEmail,
        projectId: "__PERSONAL__",
        channelType: "personal"
      })
    });
    const data = await res.json();
    if (data.snapshot) {
      state = data.snapshot;
      renderAll();
    }
    fetch("/api/probe-channel-quota", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channelId: `${cleanEmail}#personal` })
    })
      .then((r) => r.json())
      .then((d) => {
        if (d?.snapshot) {
          state = d.snapshot;
          renderAll();
        }
      })
      .catch(() => {});
    showToast(`${I18N[currentLang].toastPersonalAdded}${cleanEmail}`);
  } catch (e) {}
}

async function addGcpChannelForEmail(email, projectId, gcpBillingMode = "agent_platform", gcpLocation = "global") {
  try {
    const cleanPid = (projectId || "").trim();
    const packedPid = `${cleanPid}|${gcpBillingMode}|${gcpLocation}`;
    const res = await fetch("/api/add-gcp-channel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, projectId: packedPid, gcpBillingMode, gcpLocation })
    });
    const data = await res.json();
    if (data.snapshot) {
      state = data.snapshot;
      renderAll();
    }
    showToast(`${I18N[currentLang].toastGcpAdded}${cleanPid}`);
  } catch (e) {}
}

async function updateAccountGcpConfig(accountId, gcpProjectId, gcpBillingMode, gcpLocation) {
  try {
    const targetAcc = (state.accounts || []).find((a) => a.id === accountId);
    const email = targetAcc?.email || "";
    const oldPid = (targetAcc?.gcpProjectId || "").trim();
    const cleanPid = (gcpProjectId || "").trim();
    const packedPid = `${cleanPid}|${gcpBillingMode}|${gcpLocation}|${oldPid}`;
    const res = await fetch("/api/add-gcp-channel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email,
        projectId: packedPid,
        gcpBillingMode,
        gcpLocation
      })
    });
    const data = await res.json();
    if (!data.success && data.error) {
      showToast(data.error, true);
      return;
    }
    if (data.snapshot) {
      state = data.snapshot;
      renderAll();
    }
    showToast(I18N[currentLang].toastGcpUpdated);
  } catch (e) {
    showToast(e?.message || "Update GCP config failed", true);
  }
}

async function captureCurrentAccount() {
  try {
    const res = await fetch("/api/save-current-account", { method: "POST" });
    const data = await res.json();
    if (data.snapshot) {
      state = data.snapshot;
      renderAll();
    }
    showToast(`${I18N[currentLang].toastCaptured}${data.email || ""}`);
  } catch (e) {}
}

async function startIsolatedBrowserLogin(opts = {}) {
  try {
    const res = await fetch("/api/start-oauth-login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(opts || {})
    });
    const data = await res.json();
    if (data.snapshot) {
      state = data.snapshot;
      renderAll();
    }
    showToast(I18N[currentLang].toastOAuthStarted);
  } catch (e) {}
}

async function openExternalVerificationUrl(url) {
  try {
    const cleanUrl = String(url || "").trim();
    if (!cleanUrl) return;
    const t = I18N[currentLang];
    const res = await fetch("/api/open-external-url", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: cleanUrl })
    });
    const data = await res.json();
    if (data?.success) {
      showToast(t.toastOpeningExternalUrl || "已在浏览器打开 Google 页面");
    } else {
      showToast(`${t.toastOpenExternalFailed || "无法打开链接："}${data?.error || "error"}`);
    }
  } catch (e) {
    const t = I18N[currentLang];
    showToast(`${t.toastOpenExternalFailed || "无法打开链接："}${e.message}`);
  }
}

async function retryProbeSingleChannel(channelId) {
  if (!channelId || probingChannelIds.has(channelId)) return;
  const t = I18N[currentLang];
  probingChannelIds.add(channelId);
  renderAccountList();
  try {
    const res = await fetch("/api/probe-channel-quota", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channelId })
    });
    const data = await res.json();
    probingChannelIds.delete(channelId);
    if (data?.snapshot) {
      state = data.snapshot;
    }
    const updatedAcc = (state.accounts || []).find((a) => a.id === channelId);
    const hasStillError = Boolean(updatedAcc?.authExpired || updatedAcc?.lastProbeError?.message);
    if (!hasStillError && data?.cachedQuota) {
      expandedAccountErrorIds.delete(channelId);
      showToast(t.toastRetriedProbeOk || "探测成功，已刷新账号等级与配额");
    } else {
      const errMsg = updatedAcc?.lastProbeError?.message || data?.error || "";
      if (errMsg) showToast(`${t.toastRetriedProbeFail || "探测仍异常："}${errMsg}`);
    }
    renderAll();
  } catch (e) {
    probingChannelIds.delete(channelId);
    renderAccountList();
    showToast(`${t.toastRetriedProbeFail || "探测仍异常："}${e.message}`);
  }
}

async function cancelBrowserLogin() {
  try {
    const res = await fetch("/api/cancel-oauth-login", { method: "POST" });
    const data = await res.json();
    if (data.snapshot) {
      state = data.snapshot;
      renderAll();
    }
    showToast(I18N[currentLang].toastOAuthCanceled);
  } catch (e) {}
}

async function switchBillingProject(projectId) {
  try {
    const res = await fetch("/api/switch-project", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId })
    });
    const data = await res.json();
    if (data.snapshot) {
      state = data.snapshot;
      renderAll();
    }
    showToast(I18N[currentLang].toastProjectSwitched);
  } catch (e) {}
}

function applyGcpInputProject() {
  const val = (document.getElementById("gcpProjectInput")?.value || "").trim();
  switchBillingProject(val);
}

async function handleManualScrubSignatures(mode = "mismatched") {
  try {
    const tel = state.telemetry || {};
    const targetConvId =
      (selectedTelemetryConvId && selectedTelemetryConvId !== "__PROJECT_TOTAL__")
        ? selectedTelemetryConvId
        : (tel.fullConversationId || tel.conversationId || "");
    const res = await fetch("/api/scrub-signatures", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: mode === "current" ? "current" : "mismatched",
        conversationId: targetConvId,
        activeIsGcp: Boolean(state.activeAccount?.gcpProjectId)
      })
    });
    const data = await res.json();
    if (data.snapshot) {
      state = data.snapshot;
      renderAll();
    } else {
      await loadSystemStatus(true, true);
    }
    const t = I18N[currentLang];
    const toastPrefix = mode === "current"
      ? (t.toastScrubbedCurrent || t.toastSignaturesScrubbed)
      : (t.toastScrubbedMismatched || t.toastSignaturesScrubbed);
    showToast(`${toastPrefix}${data.scrubbedCount ?? 0}`);
  } catch (e) {}
}

let switchingFallbackTimer = null;

async function switchGoogleAccount(accountId, scrubSignatures = false) {
  if (switchingAccountId) return;
  const t = I18N[currentLang];
  clearTimeout(switchingFallbackTimer);
  try {
    selectedQuotaChannelId = "";
    switchingAccountId = accountId;
    renderAccountList();
    showToast(t.toastAccountSwitching);
    const tel = state.telemetry || {};
    const currentConvId = tel.fullConversationId || tel.conversationId || "";
    const res = await fetch("/api/switch-account", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        accountId,
        scrubSignatures: Boolean(scrubSignatures),
        conversationId: currentConvId
      })
    });
    let data = null;
    try { data = await res.json(); } catch {}
    if (!res.ok || data?.error || data?.success === false) {
      switchingAccountId = "";
      if (data?.snapshot) state = data.snapshot;
      renderAll();
      showToast(data?.error || `${t.toastAccountSwitchFailed || "切换失败："}${res.status}`);
      return;
    }
    if (data?.restarting) {
      // 保持「重启中...」状态等待宿主重拉；若为独立浏览器页面或宿主异常未重载，则在恢复连通后兜底校验并刷新
      switchingFallbackTimer = setTimeout(async () => {
        if (switchingAccountId !== accountId) return;
        await loadSystemStatus(true, true);
        if (switchingAccountId === accountId) {
          switchingAccountId = "";
          renderAll();
        }
      }, 12000);
      return;
    }
    switchingAccountId = "";
    if (data?.snapshot) state = data.snapshot;
    renderAll();
    showToast(t.toastRefreshed);
    loadSystemStatus(true, true);
  } catch (e) {
    // 若在 Antigravity 关闭或代理断连瞬间请求被中止，延迟探测是否已完成重启切换
    switchingFallbackTimer = setTimeout(async () => {
      await loadSystemStatus(true, true);
      if (switchingAccountId === accountId) {
        switchingAccountId = "";
        renderAccountList();
        showToast(`${t.toastAccountSwitchFailed || "切换失败："}${e?.message || "ERR_ABORTED"}`);
      }
    }, 3000);
  }
}

async function launchIsolatedInstance(accountId) {
  try {
    let res = await fetch("/api/launch-instance", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountId })
    });
    if (res.status === 404) {
      res = await fetch("/api/switch-account", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: `launch_instance:${accountId}` })
      });
    }
    const data = await res.json();
    if (data?.snapshot) {
      state = data.snapshot;
      renderAll();
    }
    if (data && (data.success || data.launched) && !data.error) {
      const label = data.gcpProjectId ? `${data.email} (${data.gcpProjectId})` : (data.email || accountId);
      showToast(`${I18N[currentLang].toastInstanceLaunched}${label}`);
      setTimeout(() => loadSystemStatus(false, true), 2500);
    } else if (data?.error) {
      showToast(data.error);
    }
  } catch (e) {}
}

async function deleteAccountProfile(accountId) {
  try {
    const res = await fetch("/api/delete-account", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountId })
    });
    const data = await res.json();
    if (data.snapshot) {
      state = data.snapshot;
      renderAll();
    }
    showToast(I18N[currentLang].toastDeleted);
  } catch (e) {}
}

async function saveRoutingRule(payload) {
  try {
    const res = await fetch("/api/save-routing", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (data.snapshot) {
      state = data.snapshot;
      renderAll();
    }
    showToast(I18N[currentLang].toastRoutingSaved);
  } catch (e) {}
}

async function switchPersonalQuotaPool(pool) {
  try {
    const targetPool = String(pool || "").toLowerCase() === "daily" ? "daily" : "prod";
    state.personalQuotaPool = targetPool;
    if (state.routing) state.routing.personalQuotaPool = targetPool;
    renderAll();
    const res = await fetch("/api/switch-quota-pool", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pool: targetPool })
    });
    const data = await res.json();
    if (data?.snapshot) {
      state = data.snapshot;
      renderAll();
    }
    const t = I18N[currentLang];
    showToast(targetPool === "daily" ? t.toastPoolSwitchedDaily : t.toastPoolSwitchedProd);
  } catch (e) {}
}

const isPluginCustomScheme = typeof window !== "undefined" && window.location?.protocol === "plugin:";
let sseSource = null;
let embeddedPollTimer = null;
let embeddedPollInFlight = false;
let isViewportIntersecting = true;
let lastVisibleRefreshAt = 0;

function isEmbeddedSidecarWindow() {
  if (typeof window === "undefined") return false;
  if (window.location.port === "8089") return false;
  return Boolean(isPluginCustomScheme || window.sidecar || new URLSearchParams(window.location.search).get("token"));
}

function isPanelActuallyVisible() {
  if (typeof document === "undefined") return false;
  if (document.hidden) return false;
  if (!isEmbeddedSidecarWindow()) return true;
  if (!isViewportIntersecting) return false;
  if (window.innerWidth <= 10 || window.innerHeight <= 10) return false;
  if (!document.body || document.body.offsetWidth <= 10 || document.body.offsetHeight <= 10) return false;
  return true;
}

function stopEmbeddedPollTimer() {
  if (embeddedPollTimer) {
    clearTimeout(embeddedPollTimer);
    embeddedPollTimer = null;
  }
}

function closeSseConnection() {
  stopEmbeddedPollTimer();
  if (sseSource) {
    try {
      sseSource.close();
    } catch (e) {}
    sseSource = null;
  }
}

function scheduleEmbeddedPoll() {
  if (!isPluginCustomScheme || !isPanelActuallyVisible()) {
    stopEmbeddedPollTimer();
    return;
  }
  if (embeddedPollTimer) return;
  const delayMs = (state.oauthPending || probingChannelIds.size > 0 || switchingAccountId) ? 750 : 2500;
  embeddedPollTimer = setTimeout(async () => {
    embeddedPollTimer = null;
    if (!isPluginCustomScheme || !isPanelActuallyVisible()) return;
    if (!hasOpenCustomDropdown() && !embeddedPollInFlight) {
      embeddedPollInFlight = true;
      try {
        const res = await fetch("/api/state-version", { cache: "no-store" });
        if (res.ok) {
          const ver = await res.json();
          if (ver?.frontendVersion && currentFrontendVersion && currentFrontendVersion !== ver.frontendVersion) {
            window.location.reload();
            return;
          }
          const nextRev = Number(ver?.revision || 0);
          const nextMtime = Number(ver?.configMtimeMs || 0);
          const nextOAuthId = String(ver?.lastOAuthEventId || "");
          const needsRefresh =
            (nextRev > 0 && nextRev !== lastKnownStateRevision) ||
            (nextMtime > 0 && nextMtime !== lastKnownConfigMtimeMs) ||
            (nextOAuthId && nextOAuthId !== lastHandledOAuthEventKey) ||
            (Date.now() - lastFullStatusFetchAt >= 30000);
          if (needsRefresh) {
            if (nextRev > 0) lastKnownStateRevision = nextRev;
            if (nextMtime > 0) lastKnownConfigMtimeMs = nextMtime;
            await loadSystemStatus(false, true, { light: true });
          }
        }
      } catch (e) {} finally {
        embeddedPollInFlight = false;
      }
    }
    scheduleEmbeddedPoll();
  }, delayMs);
}

// 启动实时同步与按需可见门控：Standalone 页面维持 0ms SSE，plugin:// 嵌套面板改用可见态轻量版本轮询，彻底避免 Chromium/Electron 同源 6 连接池被 SSE 耗尽
function ensureSseConnected() {
  if (!isPanelActuallyVisible()) {
    closeSseConnection();
    return;
  }
  if (isPluginCustomScheme) {
    if (sseSource) {
      try { sseSource.close(); } catch (e) {}
      sseSource = null;
    }
    scheduleEmbeddedPoll();
    return;
  }
  if (sseSource && sseSource.readyState !== 2) return;
  closeSseConnection();
  if (typeof window.EventSource !== "function") return;
  try {
    const es = new EventSource("/api/events");
    sseSource = es;
    es.onmessage = (ev) => {
      if (!isPanelActuallyVisible()) return;
      try {
        const snap = JSON.parse(ev.data);
        applyIncomingSnapshot(snap, { forceRender: false, allowOAuthToast: true });
      } catch (e) {}
    };
  } catch (e) {}
}

function syncSseLifecycleForVisibility(forceStatusRefresh = false) {
  const visibleNow = isPanelActuallyVisible();
  if (!visibleNow) {
    closeSseConnection();
    return false;
  }
  const hadLiveSync = isPluginCustomScheme
    ? Boolean(embeddedPollTimer || embeddedPollInFlight)
    : Boolean(sseSource && sseSource.readyState === 1);
  ensureSseConnected();
  // 若任意下拉菜单正在展开中，切勿由 pointerenter / pointerdown / focus 触发状态重绘把菜单收起
  if (hasOpenCustomDropdown()) {
    return true;
  }
  const now = Date.now();
  // 仅在隐藏恢复可见强刷或同步通道刚恢复且距上次刷新 >10s 时补拉一次 /api/status
  if (forceStatusRefresh || (!hadLiveSync && now - lastVisibleRefreshAt > 10000)) {
    lastVisibleRefreshAt = now;
    loadSystemStatus(false, true, { light: true });
  }
  return true;
}

function bindPanelVisibilityListeners() {
  if (window.__agyRelayVisibilityBound) return;
  window.__agyRelayVisibilityBound = true;
  let wasVisible = isPanelActuallyVisible();

  const onVisibilityTransition = () => {
    const nowVisible = isPanelActuallyVisible();
    if (nowVisible && !wasVisible) {
      wasVisible = true;
      syncSseLifecycleForVisibility(true);
    } else if (!nowVisible && wasVisible) {
      wasVisible = false;
      closeSseConnection();
    } else {
      wasVisible = nowVisible;
      if (!nowVisible) closeSseConnection();
    }
  };

  window.addEventListener("focus", () => syncSseLifecycleForVisibility(false));
  window.addEventListener("pagehide", closeSseConnection);
  window.addEventListener("beforeunload", closeSseConnection);
  document.addEventListener("visibilitychange", onVisibilityTransition);
  document.addEventListener("pointerenter", () => syncSseLifecycleForVisibility(false));
  document.addEventListener("pointerdown", () => syncSseLifecycleForVisibility(false));

  if (window.ResizeObserver && document.documentElement) {
    try {
      new ResizeObserver(onVisibilityTransition).observe(document.documentElement);
    } catch (e) {}
  }
  if (window.IntersectionObserver) {
    try {
      const io = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            isViewportIntersecting = Boolean(entry.isIntersecting && entry.intersectionRatio > 0);
          }
          onVisibilityTransition();
        },
        { threshold: [0, 0.01, 0.1] }
      );
      io.observe(document.body || document.documentElement);
    } catch (e) {}
  }
}

function dataFrontendVer(snap) {
  return snap?.frontendVersion || "";
}

applyI18n();
bindPanelVisibilityListeners();
if (isPanelActuallyVisible()) {
  lastVisibleRefreshAt = Date.now();
  loadSystemStatus(false, true);
  ensureSseConnected();
}
// 仅按本地时钟每 60 秒刷新一次倒计时分钟数显示，不发起任何云端或状态网络轮询（零风控）
setInterval(() => {
  if (isPanelActuallyVisible() && !hasOpenCustomDropdown()) {
    renderQuotaGroups();
  }
}, 60000);
