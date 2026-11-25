// 第 4 板块（模型算力路由、自定义路由下拉框与目标耗尽回退状态渲染）视图模块

let isOtherRoutingModelsExpanded = false;

function stripModelVariantSuffixUi(rawLabel) {
  return String(rawLabel || "")
    .replace(/\s*\((Low|Medium|High|XHigh|Extra\s*High|Extra|Max)\)\s*$/i, "")
    .replace(/\s+(Low|Medium|High|XHigh|Extra\s*High|Max)\s*$/i, "")
    .trim();
}

function isOrchestratorUiModel(rawLabelOrId) {
  return /^orchestrator\b|orchestrator[-_]|^model_placeholder_m(537|667|668)$/i.test(
    String(rawLabelOrId || "").trim()
  );
}

function getActiveAccountModelKeySet(isGcpScope = false) {
  const keys = new Set();
  const collect = (list) => {
    for (const m of (Array.isArray(list) ? list : [])) {
      if (!m) continue;
      const raw = String(m.label || m.modelId || "").trim();
      if (!raw || isOrchestratorUiModel(raw)) continue;
      const base = stripModelVariantSuffixUi(raw);
      if (base && !isOrchestratorUiModel(base)) {
        keys.add(base.toLowerCase());
      }
    }
  };
  if (isGcpScope) {
    if (state.activeAccount?.gcpProjectId && Array.isArray(state.availableModels) && state.availableModels.length > 0) {
      collect(state.availableModels);
      return keys;
    }
    const activeGcpAcc = (state.accounts || []).find(
      (a) => (a.channelType === "gcp" || Boolean(a.gcpProjectId)) &&
        (a.id === state.activeChannelId ||
          (state.activeAccount?.email && a.email === state.activeAccount.email && a.gcpProjectId === state.activeAccount.gcpProjectId))
    );
    collect(activeGcpAcc?.cachedQuota?.availableModels);
    return keys;
  }
  if (!state.activeAccount?.gcpProjectId && Array.isArray(state.availableModels) && state.availableModels.length > 0) {
    collect(state.availableModels);
    return keys;
  }
  const activePersonalAcc = (state.accounts || []).find(
    (a) => !(a.channelType === "gcp" || Boolean(a.gcpProjectId)) &&
      (a.id === state.activeChannelId || (state.activeAccount?.email && a.email === state.activeAccount.email))
  );
  collect(activePersonalAcc?.cachedQuotaByPool?.daily?.availableModels || activePersonalAcc?.cachedQuota?.availableModels);
  return keys;
}

function getPoolModelsForScope(isGcpScope = false) {
  const modelMap = new Map();
  const addModelEntry = (m, isFromGcp) => {
    if (!m) return;
    const rawLabel = String(m.label || m.modelId || "").trim();
    if (!rawLabel || isOrchestratorUiModel(rawLabel)) return;
    const baseLabel = stripModelVariantSuffixUi(rawLabel);
    if (!baseLabel || isOrchestratorUiModel(baseLabel)) return;
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

const PERSONAL_TIER_KEYS_UI = ["free", "plus", "pro_lite", "pro", "ultra"];

function parseTierRouteSpecUi(spec) {
  const s = String(spec || "").trim().toLowerCase();
  if (!s.startsWith("tier:")) return "";
  const key = s.slice(5).trim();
  return PERSONAL_TIER_KEYS_UI.includes(key) ? key : "";
}

function getTierBadgeMetaUi(tierKey) {
  const t = I18N[currentLang];
  if (tierKey === "ultra") {
    return { badgeType: "ultra", badgeText: "Ultra", badgeSubText: "", tierLabel: t.tierLabelUltra || "Ultra" };
  }
  if (tierKey === "pro_lite") {
    return {
      badgeType: "pro-lite",
      badgeText: "Pro",
      badgeSubText: "Trial",
      tierLabel: t.tierLabelProLite || "Trial Pro"
    };
  }
  if (tierKey === "pro") {
    return {
      badgeType: "personal",
      badgeText: t.channelPersonalBadge || "Pro",
      badgeSubText: "Paid",
      tierLabel: t.tierLabelPro || "Paid Pro"
    };
  }
  if (tierKey === "plus") {
    return { badgeType: "plus", badgeText: "Plus", badgeSubText: "", tierLabel: t.tierLabelPlus || "Plus" };
  }
  if (tierKey === "free") {
    return { badgeType: "free", badgeText: "Free", badgeSubText: "", tierLabel: t.tierLabelFree || "Free" };
  }
  return { badgeType: "unknown", badgeText: t.channelUnknownBadge || "", badgeSubText: "", tierLabel: tierKey };
}

function buildRouteOptionsList(modelObj = null, isGcpScope = false, currentSelectedRoute = "") {
  const t = I18N[currentLang];
  if (isGcpScope) {
    // GCP 通道专属路由表：无自动轮询，不混入任何个人账号，仅提供「跟随当前 GCP 通道」与手选其他已收录 GCP 通道
    const gcpOptions = [
      { value: "follow_current", label: t.routeFollowCurrentGcp || t.routeFollowCurrent, badgeType: "", badgeText: "", badgeSubText: "" }
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
        badgeText: badgeInfo.badgeText,
        badgeSubText: badgeInfo.badgeSubText || ""
      });
    }
    return gcpOptions;
  }

  const options = [
    { value: "follow_current", label: t.routeFollowCurrent, badgeType: "", badgeText: "", badgeSubText: "" },
    { value: "auto_poll", label: t.routeAutoPoll, badgeType: "", badgeText: "", badgeSubText: "" }
  ];

  const seenValues = new Set(["follow_current", "auto_poll"]);
  const eligiblePersonalAccounts = [];
  const tierSet = new Set();

  for (const acc of (state.accounts || [])) {
    const isGcp = acc.channelType === "gcp" || Boolean(acc.gcpProjectId);
    // 个人通道路由表仅列出个人账号（Free / Plus / Trial Pro / Paid Pro / Ultra），绝不混入 GCP 通道
    if (isGcp) continue;
    if (modelObj && !findModelInChannel(acc, modelObj)) {
      continue;
    }
    eligiblePersonalAccounts.push(acc);
    const tKey = typeof getPersonalAccountTierKeyUi === "function" ? getPersonalAccountTierKeyUi(acc) : "";
    if (tKey) tierSet.add(tKey);
  }

  const currentTierKey = parseTierRouteSpecUi(currentSelectedRoute);
  const allowFallback = state.routing?.tierFallbackToAny !== false;
  if (tierSet.size >= 2 || (currentTierKey && tierSet.has(currentTierKey))) {
    const prefix = allowFallback
      ? (t.routeTierPriorityPrefix || "优先轮询 ·")
      : (t.routeTierStrictPrefix || "仅轮询 ·");
    for (const tKey of PERSONAL_TIER_KEYS_UI) {
      if (!tierSet.has(tKey)) continue;
      const val = `tier:${tKey}`;
      if (seenValues.has(val)) continue;
      seenValues.add(val);
      const meta = getTierBadgeMetaUi(tKey);
      options.push({
        value: val,
        label: prefix,
        badgeType: meta.badgeType,
        badgeText: meta.badgeText,
        badgeSubText: meta.badgeSubText,
        badgeAfterLabel: true
      });
    }
  }

  for (const acc of eligiblePersonalAccounts) {
    const val = `account:${acc.id}`;
    if (seenValues.has(val)) continue;
    seenValues.add(val);
    const badgeInfo = getChannelBadgeInfo(acc);
    const st = modelObj && typeof getPersonalAccountModelQuotaStatusUi === "function"
      ? getPersonalAccountModelQuotaStatusUi(acc, modelObj)
      : null;
    options.push({
      value: val,
      label: acc.email,
      badgeType: badgeInfo.badgeType,
      badgeText: badgeInfo.badgeText,
      badgeSubText: badgeInfo.badgeSubText || "",
      statusTag: (st && (st.exhausted || st.blocked)) ? (t.dropdownExhaustedTag || "已耗尽") : ""
    });
  }

  return options;
}

function appendDropdownOptionContent(containerEl, opt, textClassName) {
  if (opt.badgeAfterLabel) {
    const lblEl = document.createElement("span");
    lblEl.className = "dropdown-tier-prefix";
    lblEl.textContent = opt.label;
    containerEl.appendChild(lblEl);
    if (opt.badgeText) {
      containerEl.appendChild(createChannelBadgeNode(opt.badgeType, opt.badgeText, opt.badgeSubText));
    }
    return;
  }
  if (opt.badgeText) {
    containerEl.appendChild(createChannelBadgeNode(opt.badgeType, opt.badgeText, opt.badgeSubText));
  }
  const lblEl = document.createElement("span");
  lblEl.className = textClassName;
  lblEl.textContent = opt.label;
  containerEl.appendChild(lblEl);
}

function createCustomDropdown(selectedValue, onSelect, modelObj = null, isGcpScope = false) {
  const options = buildRouteOptionsList(modelObj, isGcpScope, selectedValue);
  const activeOpt = options.find((o) => o.value === selectedValue) || options[0];

  const wrapper = document.createElement("div");
  wrapper.className = "custom-dropdown";

  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "dropdown-trigger";

  const triggerLeft = document.createElement("div");
  triggerLeft.className = "active-email-wrap";
  appendDropdownOptionContent(triggerLeft, activeOpt, "dropdown-trigger-text");

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
    appendDropdownOptionContent(itemLeft, opt, "dropdown-option-label");

    item.appendChild(itemLeft);

    if (opt.statusTag) {
      const statusBadge = document.createElement("span");
      statusBadge.className = "dropdown-option-status-tag";
      statusBadge.textContent = opt.statusTag;
      item.appendChild(statusBadge);
    }

    const checkSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    checkSvg.setAttribute("class", "check-icon");
    checkSvg.setAttribute("viewBox", "0 0 16 16");
    checkSvg.setAttribute("fill", "none");
    checkSvg.innerHTML = `<path d="M3.5 8.5L6.5 11.5L12.5 4.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`;

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

function selectAutoPollChannel(accounts, m, activeChannelId, thresholdPct = 5, opts = null) {
  const preferredPool = "daily";
  const poolOrder = ["daily"];
  const preferredTierKey = String(opts?.preferredTierKey || "").trim().toLowerCase();
  const allowFallback = opts?.allowFallback !== false;
  const excludeAccountId = String(opts?.excludeAccountId || "").trim();

  const collectAndRank = (tierFilterKey = "") => {
    const candidates = [];
    for (const acc of accounts) {
      const isGcp = acc.channelType === "gcp" || Boolean(acc.gcpProjectId);
      if (isGcp || (excludeAccountId && acc.id === excludeAccountId) || isChannelTemporarilyBlockedUi(acc)) continue;
      if (tierFilterKey) {
        const accTier = typeof getPersonalAccountTierKeyUi === "function" ? getPersonalAccountTierKeyUi(acc) : "";
        if (accTier !== tierFilterKey) continue;
      }
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
  };

  if (preferredTierKey) {
    const tierHit = collectAndRank(preferredTierKey);
    if (tierHit) return { ...tierHit, matchedTier: true, fallbackUsed: false };
    if (!allowFallback) return null;
    const fbHit = collectAndRank("");
    return fbHit ? { ...fbHit, matchedTier: false, fallbackUsed: true } : null;
  }

  const best = collectAndRank("");
  return best ? { ...best, matchedTier: true, fallbackUsed: false } : null;
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

function getPersonalAccountModelQuotaStatusUi(acc, m, explicitPool = "") {
  if (!acc || !m || acc.channelType === "gcp" || acc.gcpProjectId) {
    return { supported: false, exhausted: false, blocked: false, dual: null, matched: null, resetCountdown: "" };
  }
  const activePool = explicitPool || getActivePersonalPoolUi();
  const snap = acc.cachedQuotaByPool?.[activePool] || acc.cachedQuota;
  const matched = findModelInQuotaSnapshot(snap, m);
  if (!matched) {
    return { supported: false, exhausted: false, blocked: false, dual: null, matched: null, resetCountdown: "" };
  }
  const dual = extractModelDualQuotaUi(snap, matched, m);
  const blocked = isChannelTemporarilyBlockedUi(acc);
  const exhausted = Boolean(dual.weeklyPct <= 0 || dual.fiveHourPct <= 0);
  const resetIso = dual.fiveHourPct <= 0 && dual.fiveHourResetTime
    ? dual.fiveHourResetTime
    : (dual.weeklyResetTime || matched.resetTime || "");
  return {
    supported: true,
    exhausted,
    blocked,
    dual,
    matched,
    resetCountdown: formatResetCountdown(resetIso)
  };
}

function formatSingleAccountQuotaMetricsUi(dual, matched) {
  const t = I18N[currentLang];
  const wkCountdown = formatResetCountdown(dual?.weeklyResetTime || matched?.resetTime);
  if (dual?.hasDistinct5h) {
    const wkLabel = currentLang === "zh" ? "周" : "Wk";
    return wkCountdown
      ? `${wkLabel} ${dual.weeklyPct}% (${wkCountdown}) · 5h ${dual.fiveHourPct}%`
      : `${wkLabel} ${dual.weeklyPct}% · 5h ${dual.fiveHourPct}%`;
  }
  return wkCountdown
    ? `${t.remainingLabel} ${dual ? dual.weeklyPct : matched.remainingPct}% · ${t.resetsInPrefix}${wkCountdown}${t.resetsInSuffix}`
    : `${t.remainingLabel} ${dual ? dual.weeklyPct : matched.remainingPct}%`;
}

function evaluateRoutingRowDisplay(m, selectedRoute) {
  const t = I18N[currentLang];
  const accounts = state.accounts || [];
  const activeChannelId = state.activeAccount?.channelId || "";
  const thresholdPct = Number(state.routing?.lowQuotaThresholdPct ?? 5);
  const activePool = getActivePersonalPoolUi();
  const allowFallback = state.routing?.tierFallbackToAny !== false;

  const targetTierKey = parseTierRouteSpecUi(selectedRoute);
  if (selectedRoute === "auto_poll" || targetTierKey) {
    const picked = selectAutoPollChannel(
      accounts,
      m,
      activeChannelId,
      thresholdPct,
      targetTierKey ? { preferredTierKey: targetTierKey, allowFallback } : null
    );
    const tierMeta = targetTierKey ? getTierBadgeMetaUi(targetTierKey) : null;
    const prefixText = targetTierKey
      ? (picked?.fallbackUsed
          ? `${tierMeta.tierLabel} ${t.tierSubFallbackTag || "已耗尽 · 回退至 "}`
          : (allowFallback
              ? `${tierMeta.tierLabel}${t.tierSubPrioritySuffix || " 优先 · "}`
              : `${t.tierSubStrictPrefix || "仅限 "}${tierMeta.tierLabel} · `))
      : t.autoPollSubPrefix;
    if (picked) {
      const { acc: bestAcc, matched: bestModel, dual, isGcp } = picked;
      const shortName = isGcp
        ? `${t.channelGcpBadge}·${bestAcc.gcpProjectId.slice(0, 12)}`
        : bestAcc.email.split("@")[0];
      if (isGcp) {
        return {
          text: `${prefixText}${shortName} · ${t.gcpRouteSubUnlimited}`,
          statusLevel: "",
          pillText: ""
        };
      }
      return {
        text: `${prefixText}${shortName} · ${formatSingleAccountQuotaMetricsUi(dual, bestModel)}`,
        statusLevel: picked.fallbackUsed ? "warn" : "",
        pillText: picked.fallbackUsed ? (t.pillTierExhaustedFallback || "所选等级已耗尽 · 已回退") : ""
      };
    }
    if (targetTierKey) {
      return {
        text: allowFallback
          ? `${tierMeta.tierLabel}${t.tierSubAllExhausted || " 全部耗尽"} · ${currentLang === "zh" ? "当前无可用额度账号" : "No quota available"}`
          : `${tierMeta.tierLabel} · ${t.tierSubStrictEmpty || "当前等级无可用额度（自动回退已关闭）"}`,
        statusLevel: "danger",
        pillText: t.pillTierExhausted || "所选等级已耗尽"
      };
    }
    return {
      text: `${prefixText}${currentLang === "zh" ? "当前无可用额度账号" : "No quota available"}`,
      statusLevel: "",
      pillText: ""
    };
  }

  const formatPersonalAccountModelSub = (targetAcc, explicitPool = "", isPinnedSelection = false) => {
    const st = getPersonalAccountModelQuotaStatusUi(targetAcc, m, explicitPool);
    if (!st.supported) {
      return { text: t.gcpRouteSubUnsupported, statusLevel: "", pillText: "" };
    }
    if (!st.exhausted && !st.blocked) {
      return { text: formatSingleAccountQuotaMetricsUi(st.dual, st.matched), statusLevel: "", pillText: "" };
    }
    if (!isPinnedSelection) {
      return { text: formatSingleAccountQuotaMetricsUi(st.dual, st.matched), statusLevel: "danger", pillText: "" };
    }
    const shortTarget = targetAcc.email.split("@")[0];
    const resetNote = st.resetCountdown
      ? ` (${t.resetsInPrefix}${st.resetCountdown}${t.resetsInSuffix})`
      : "";
    const baseExhausted = `${t.accSubExhaustedPrefix || "所选 "}${shortTarget}${t.accSubExhaustedMid || " 已耗尽"}${resetNote}`;
    if (allowFallback) {
      const fb = selectAutoPollChannel(accounts, m, activeChannelId, thresholdPct, {
        preferredTierKey: typeof getPersonalAccountTierKeyUi === "function" ? getPersonalAccountTierKeyUi(targetAcc) : "",
        allowFallback: true,
        excludeAccountId: targetAcc.id
      });
      if (fb) {
        const fbShort = fb.acc.email.split("@")[0];
        return {
          text: `${baseExhausted}${t.accSubFallbackArrow || " → 回退 "}${fbShort} · ${formatSingleAccountQuotaMetricsUi(fb.dual, fb.matched)}`,
          statusLevel: "warn",
          pillText: t.pillAccExhaustedFallback || "所选账号已耗尽 · 已回退"
        };
      }
      return {
        text: `${baseExhausted}${t.accSubPoolEmpty || " · 池内暂无其他可用额度"}`,
        statusLevel: "danger",
        pillText: t.pillAccExhausted || "所选账号已耗尽"
      };
    }
    return {
      text: `${baseExhausted}${t.accSubStrictOff || " · 自动回退已关闭"}`,
      statusLevel: "danger",
      pillText: t.pillAccExhausted || "所选账号已耗尽"
    };
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
        return { text: matched ? t.gcpRouteSubUnlimited : t.gcpRouteSubUnsupported, statusLevel: "", pillText: "" };
      }
      return formatPersonalAccountModelSub(targetAcc, explicitPool || "", true);
    }
  }

  const activeAcc = accounts.find((a) => a.id === activeChannelId);
  if (activeAcc) {
    const isGcp = activeAcc.channelType === "gcp" || Boolean(activeAcc.gcpProjectId);
    if (isGcp) {
      const matched = findModelInChannel(activeAcc, m);
      return { text: matched ? t.gcpRouteSubUnlimited : t.gcpRouteSubUnsupported, statusLevel: "", pillText: "" };
    }
    return formatPersonalAccountModelSub(activeAcc, activePool, false);
  }

  if (state.activeAccount?.gcpProjectId || m.unlimited) {
    return { text: t.gcpRouteSubUnlimited, statusLevel: "", pillText: "" };
  }
  const countdown = formatResetCountdown(m.resetTime);
  return {
    text: countdown
      ? `${t.remainingLabel} ${m.remainingPct}% · ${t.resetsInPrefix}${countdown}${t.resetsInSuffix}`
      : `${t.remainingLabel} ${m.remainingPct}%`,
    statusLevel: "",
    pillText: ""
  };
}

function formatModelQuotaSubText(m, selectedRoute) {
  return evaluateRoutingRowDisplay(m, selectedRoute).text;
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
  const allowTierFallback = state.routing?.tierFallbackToAny !== false;

  const fallbackBarEl = document.getElementById("routingFallbackBar");
  const fallbackChkEl = document.getElementById("chkTierFallback");
  const fallbackTitleEl = document.getElementById("tierFallbackTitle");
  const fallbackHintEl = document.getElementById("tierFallbackHint");
  if (fallbackBarEl) {
    let personalAccountCount = 0;
    const distinctPersonalTiers = new Set();
    for (const acc of (state.accounts || [])) {
      const isGcpAcc = acc.channelType === "gcp" || Boolean(acc.gcpProjectId);
      if (isGcpAcc) continue;
      personalAccountCount++;
      const tk = typeof getPersonalAccountTierKeyUi === "function" ? getPersonalAccountTierKeyUi(acc) : "";
      if (tk) distinctPersonalTiers.add(tk);
    }
    const hasSavedTargetRoute = !isGcpScope && models.some((m) => {
      const spec = routeMap[m.modelId];
      return Boolean(parseTierRouteSpecUi(spec) || parseRouteAccountRef(spec));
    });
    const showFallbackBar = !isGcpScope && (personalAccountCount >= 2 || distinctPersonalTiers.size >= 2 || hasSavedTargetRoute);
    fallbackBarEl.style.display = showFallbackBar ? "block" : "none";
    if (showFallbackBar) {
      if (fallbackChkEl) {
        fallbackChkEl.checked = allowTierFallback;
        if (!("switch" in HTMLInputElement.prototype)) {
          fallbackChkEl.setAttribute("aria-checked", allowTierFallback ? "true" : "false");
        }
      }
      if (fallbackTitleEl) {
        fallbackTitleEl.textContent = t.tierFallbackSwitchTitle || "目标耗尽自动回退";
      }
      if (fallbackHintEl) {
        fallbackHintEl.textContent = allowTierFallback
          ? (t.tierFallbackOnHint || "指定等级或账号耗尽 / 429 时自动回退到其他可用账号")
          : (t.tierFallbackOffHint || "严格锁定在所选等级或账号内，耗尽不跨号消耗额度");
      }
    }
  }

  const buildRoutingRow = (m) => {
    let selectedRoute = routeMap[m.modelId] || "follow_current";
    const parsedTier = parseTierRouteSpecUi(selectedRoute);
    if (isGcpScope && (selectedRoute === "auto_poll" || parsedTier)) {
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
    const disp = evaluateRoutingRowDisplay(m, selectedRoute);
    const row = document.createElement("div");
    row.className = "routing-row" +
      (disp.statusLevel === "warn" ? " is-fallback" : disp.statusLevel === "danger" ? " is-exhausted" : "");

    const info = document.createElement("div");
    info.className = "routing-model-info";

    const titleRow = document.createElement("div");
    titleRow.className = "routing-model-title-row";

    const title = document.createElement("span");
    title.className = "routing-model-name";
    title.textContent = m.label;
    titleRow.appendChild(title);

    if (disp.pillText) {
      const pill = document.createElement("span");
      pill.className = `routing-exhausted-pill ${disp.statusLevel || "warn"}`;
      pill.textContent = disp.pillText;
      titleRow.appendChild(pill);
    }

    const sub = document.createElement("span");
    sub.className = "routing-model-sub" + (disp.statusLevel ? ` ${disp.statusLevel}` : "");
    sub.textContent = disp.text;

    info.appendChild(titleRow);
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
    return row;
  };

  const activeKeys = getActiveAccountModelKeySet(isGcpScope);
  const primaryModels = activeKeys.size > 0
    ? models.filter((m) => activeKeys.has(String(m.modelId || "").toLowerCase()))
    : models;
  const otherAccountModels = activeKeys.size > 0
    ? models.filter((m) => !activeKeys.has(String(m.modelId || "").toLowerCase()))
    : [];

  for (const m of primaryModels) {
    container.appendChild(buildRoutingRow(m));
  }

  if (otherAccountModels.length > 0) {
    const details = document.createElement("details");
    details.className = "routing-other-group";
    details.open = Boolean(isOtherRoutingModelsExpanded);
    details.addEventListener("toggle", () => {
      isOtherRoutingModelsExpanded = details.open;
    });

    const summary = document.createElement("summary");
    summary.className = "routing-other-toggle";

    const titleEl = document.createElement("span");
    titleEl.className = "routing-other-title";
    titleEl.textContent = `${t.otherAccountModelsTitle || "其他账号独有模型"} (${otherAccountModels.length})`;

    const hintEl = document.createElement("span");
    hintEl.className = "routing-other-hint";
    hintEl.textContent = t.otherAccountModelsHint || "";

    summary.appendChild(titleEl);
    summary.appendChild(hintEl);

    const listEl = document.createElement("div");
    listEl.className = "routing-other-list";
    for (const m of otherAccountModels) {
      listEl.appendChild(buildRoutingRow(m));
    }

    details.appendChild(summary);
    details.appendChild(listEl);
    container.appendChild(details);
  }
}

function initTierFallbackSwitch() {
  const chk = document.getElementById("chkTierFallback");
  if (!chk || chk.dataset.boundSwitch) return;
  chk.dataset.boundSwitch = "1";
  const supportsNativeSwitch = "switch" in HTMLInputElement.prototype;
  if (!supportsNativeSwitch) {
    chk.classList.add("switch-fallback");
    chk.setAttribute("role", "switch");
    chk.setAttribute("aria-checked", chk.checked ? "true" : "false");
  }
  chk.addEventListener("change", () => {
    const enabled = Boolean(chk.checked);
    if (!state.routing || typeof state.routing !== "object") state.routing = {};
    state.routing.tierFallbackToAny = enabled;
    if (!supportsNativeSwitch) {
      chk.setAttribute("aria-checked", enabled ? "true" : "false");
    }
    renderRoutingList();
    const t = I18N[currentLang];
    saveRoutingRule({
      tierFallbackToAny: enabled,
      routeScope: "personal",
      customToast: enabled ? t.toastTierFallbackSavedOn : t.toastTierFallbackSavedOff
    });
  });
}
