// 第 1 板块（账户模型额度）与第 2 板块（当前会话统计）视图渲染模块

function formatResetCountdown(isoStr) {
  if (!isoStr) return "";
  const diffMs = new Date(isoStr).getTime() - Date.now();
  if (!Number.isFinite(diffMs) || diffMs <= 0) return "";
  const t = I18N[currentLang];
  const totalMins = Math.floor(diffMs / 60000);
  const days = Math.floor(totalMins / 1440);
  const hours = Math.floor((totalMins % 1440) / 60);
  const mins = totalMins % 60;
  if (days > 0) return hours > 0 ? `${days}${t.unitDay} ${hours}${t.unitHour}` : `${days}${t.unitDay}`;
  if (hours > 0) return `${hours}${t.unitHour} ${mins}${t.unitMin}`;
  return `${mins}${t.unitMin}`;
}

function translateQuotaGroupName(rawName) {
  if (currentLang !== "zh") return rawName;
  const n = (rawName || "").trim();
  if (/^gemini models$/i.test(n)) return "Gemini 模型";
  if (/^claude and gpt models$/i.test(n)) return "Claude 和 GPT 模型";
  return n;
}

function getChannelBadgeInfo(ch) {
  const t = I18N[currentLang];
  if (!ch) return { badgeType: "personal", badgeText: t.channelPersonalBadge };
  const isGcp = ch.channelType === "gcp" || Boolean(ch.gcpProjectId);
  if (isGcp) {
    return { badgeType: "gcp", badgeText: t.channelGcpBadge };
  }
  const code = String(ch.tierCode || ch.cachedQuota?.tierCode || "").trim();
  const tName = String(ch.tierName || ch.cachedQuota?.tierName || "").trim();
  if (/^ultra$/i.test(code) || /ultra/i.test(tName)) {
    return { badgeType: "ultra", badgeText: "Ultra" };
  }
  if (/^pro$/i.test(code) || /\bpro\b/i.test(tName)) {
    return { badgeType: "personal", badgeText: t.channelPersonalBadge };
  }
  if (/^plus$/i.test(code) || /plus/i.test(tName)) {
    return { badgeType: "plus", badgeText: "Plus" };
  }
  if (/^free$/i.test(code) || /free|standard/i.test(tName)) {
    return { badgeType: "free", badgeText: "Free" };
  }
  return { badgeType: "personal", badgeText: t.channelPersonalBadge };
}

function formatCompactTokenCount(num) {
  const n = Number(num || 0);
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n >= 1000000) return `${(n / 1000000).toFixed(2)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(Math.round(n));
}

function getSignatureBadgeDisplay(sigStatus, t) {
  const st = sigStatus || { sigType: "none", mismatched: false };
  const sigType = st.sigType || "none";
  if (sigType === "gcp") {
    return {
      text: `${t.sigBadgeGcp || "签名: GCP"}${st.mismatched ? (t.sigMismatchSuffix || " · 不匹配") : ""}`,
      shortText: "GCP",
      className: "telemetry-sig-badge gcp" + (st.mismatched ? " mismatched" : ""),
      pillType: st.mismatched ? "mismatch" : "gcp"
    };
  }
  if (sigType === "personal") {
    return {
      text: `${t.sigBadgePersonal || "签名: 个人"}${st.mismatched ? (t.sigMismatchSuffix || " · 不匹配") : ""}`,
      shortText: currentLang === "zh" ? "个人" : "Pro",
      className: "telemetry-sig-badge personal" + (st.mismatched ? " mismatched" : ""),
      pillType: st.mismatched ? "mismatch" : "personal"
    };
  }
  if (sigType === "mixed") {
    return {
      text: `${t.sigBadgeMixed || "签名: GCP+个人"}${t.sigMismatchSuffix || " · 不匹配"}`,
      shortText: currentLang === "zh" ? "混合" : "Mixed",
      className: "telemetry-sig-badge mixed mismatched",
      pillType: "mismatch"
    };
  }
  return {
    text: t.sigBadgeNone || "无签名",
    shortText: currentLang === "zh" ? "无签名" : "Clean",
    className: "telemetry-sig-badge none",
    pillType: "none"
  };
}

function renderTelemetryConvSelector(tel, viewedItem, isProjectTotalView) {
  const mount = document.getElementById("telemetryConvSelectorMount");
  if (!mount) return;
  mount.innerHTML = "";
  const t = I18N[currentLang];
  const convList = Array.isArray(tel.projectConversations) ? tel.projectConversations : [];
  if (convList.length === 0 && !tel.conversationId) return;

  const projName = tel.projectName || tel.projectTotal?.projectName || "";

  if (isProjectTotalView) {
    const pt = tel.projectTotal || viewedItem || {};
    const projSigDisp = getSignatureBadgeDisplay(pt.signatureStatus || tel.signatureStatus, t);
    const projPrefix = projName ? `${projName} · ` : "";
    const convCount = Math.max(1, convList.length || Number(pt.conversationCount || 1));
    const tokSuffix = Number(pt.sessionTotalTokens || 0) > 0
      ? ` · ${formatCompactTokenCount(pt.sessionTotalTokens)} tok`
      : "";

    const summaryBar = document.createElement("div");
    summaryBar.className = "telemetry-project-summary-bar";

    const leftWrap = document.createElement("div");
    leftWrap.className = "active-email-wrap";

    const dot = document.createElement("span");
    dot.className = "status-dot online";
    leftWrap.appendChild(dot);

    if (projSigDisp.shortText) {
      const b = document.createElement("span");
      b.className = "channel-type-badge " + (projSigDisp.pillType || "personal");
      b.textContent = projSigDisp.shortText;
      leftWrap.appendChild(b);
    }

    const textEl = document.createElement("span");
    textEl.className = "dropdown-trigger-text";
    textEl.textContent = `${t.telemetryProjectTotalOpt || "当前项目全部会话汇总"} (${projPrefix}${convCount} ${t.telemetryConvCountSuffix || "个会话"})${tokSuffix}`;
    leftWrap.appendChild(textEl);

    summaryBar.appendChild(leftWrap);
    mount.appendChild(summaryBar);
    return;
  }

  const options = [];
  for (const c of convList) {
    const sigDisp = getSignatureBadgeDisplay(c.signatureStatus, t);
    const tokSuffix = Number(c.sessionTotalTokens || 0) > 0 ? ` · ${formatCompactTokenCount(c.sessionTotalTokens)} tok` : "";
    options.push({
      value: c.fullConversationId || c.conversationId,
      label: `${c.title || c.conversationId}${tokSuffix}`,
      badgeText: sigDisp.shortText,
      badgeType: sigDisp.pillType,
      isCurrentActive: Boolean(c.isCurrentActive)
    });
  }

  if (options.length === 0) return;

  const selectedVal = viewedItem.fullConversationId || viewedItem.conversationId || options[0].value;
  const activeOpt = options.find((o) => o.value === selectedVal) || options[0];

  const wrapper = document.createElement("div");
  wrapper.className = "custom-dropdown session-selector-dropdown telemetry-conv-dropdown";

  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "dropdown-trigger";

  const leftWrap = document.createElement("div");
  leftWrap.className = "active-email-wrap";

  const triggerDot = document.createElement("span");
  triggerDot.className = "status-dot" + (activeOpt.isCurrentActive ? " online" : "");
  leftWrap.appendChild(triggerDot);

  if (activeOpt.badgeText) {
    const b = document.createElement("span");
    b.className = "channel-type-badge " + (activeOpt.badgeType || "personal");
    b.textContent = activeOpt.badgeText;
    leftWrap.appendChild(b);
  }

  const triggerText = document.createElement("span");
  triggerText.className = "dropdown-trigger-text";
  triggerText.textContent = activeOpt.label;
  leftWrap.appendChild(triggerText);

  const arrowSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  arrowSvg.setAttribute("class", "dropdown-arrow");
  arrowSvg.setAttribute("viewBox", "0 0 16 16");
  arrowSvg.setAttribute("fill", "none");
  arrowSvg.innerHTML = `<path d="M4 6L8 10L12 6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>`;

  trigger.appendChild(leftWrap);
  trigger.appendChild(arrowSvg);

  const menu = document.createElement("div");
  menu.className = "dropdown-menu";

  for (const opt of options) {
    const item = document.createElement("div");
    item.className = "dropdown-option" + (opt.value === activeOpt.value ? " active" : "");

    const itemLeft = document.createElement("div");
    itemLeft.className = "active-email-wrap";

    const itemDot = document.createElement("span");
    itemDot.className = "status-dot" + (opt.isCurrentActive ? " online" : "");
    itemLeft.appendChild(itemDot);

    if (opt.badgeText) {
      const b = document.createElement("span");
      b.className = "channel-type-badge " + (opt.badgeType || "personal");
      b.textContent = opt.badgeText;
      itemLeft.appendChild(b);
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
      const defaultActiveId = tel.fullConversationId || tel.conversationId || "";
      selectedTelemetryConvId = (opt.value === defaultActiveId) ? "" : opt.value;
      renderSessionTelemetry();
    };

    menu.appendChild(item);
  }

  trigger.onclick = (ev) => {
    ev.stopPropagation();
    const isOpen = wrapper.classList.contains("open");
    document.querySelectorAll(".custom-dropdown.open").forEach((el) => el.classList.remove("open"));
    if (!isOpen) {
      wrapper.classList.add("open");
    }
  };

  wrapper.appendChild(trigger);
  wrapper.appendChild(menu);
  mount.appendChild(wrapper);
}

function toggleTelemetryScopeMode() {
  isTelemetryProjectTotalMode = !isTelemetryProjectTotalMode;
  renderSessionTelemetry();
}

function renderSessionTelemetry() {
  const mount = document.getElementById("sessionTelemetryMount");
  if (!mount) return;
  mount.innerHTML = "";
  const t = I18N[currentLang];
  const tel = state.telemetry || {};
  const convList = Array.isArray(tel.projectConversations) ? tel.projectConversations : [];

  const isProjectTotalView = Boolean(isTelemetryProjectTotalMode && tel.projectTotal);
  let viewedItem = tel;

  if (isProjectTotalView) {
    viewedItem = tel.projectTotal;
  } else if (selectedTelemetryConvId && selectedTelemetryConvId !== "__PROJECT_TOTAL__") {
    const matched = convList.find(
      (c) => c.fullConversationId === selectedTelemetryConvId || c.conversationId === selectedTelemetryConvId
    );
    if (matched) {
      viewedItem = matched;
    } else {
      selectedTelemetryConvId = "";
      viewedItem = convList.find((c) => c.isCurrentActive) || convList[0] || tel;
    }
  } else {
    viewedItem = convList.find((c) => c.isCurrentActive) || convList[0] || tel;
  }

  const telTitleEl = document.getElementById("secTelemetryTitle");
  if (telTitleEl) {
    telTitleEl.textContent = isProjectTotalView
      ? (t.secTelemetryProjectTitle || t.secTelemetryTitle)
      : t.secTelemetryTitle;
  }
  const scopeBtn = document.getElementById("btnToggleTelemetryScope");
  if (scopeBtn) {
    scopeBtn.textContent = isProjectTotalView
      ? (t.btnSwitchToSessionStats || "会话统计")
      : (t.btnSwitchToProjectTotal || "项目汇总");
    scopeBtn.classList.toggle("active-toggle", isProjectTotalView);
  }

  // 渲染顶栏当前查看会话的签名来源徽章（GCP 签名 / 个人签名 / 混合冲突 / 无签名）
  const sigBadgeMount = document.getElementById("telemetrySigBadgeMount");
  if (sigBadgeMount) {
    sigBadgeMount.innerHTML = "";
    const sigDisp = getSignatureBadgeDisplay(viewedItem.signatureStatus || tel.signatureStatus, t);
    const sigBadgeEl = document.createElement("span");
    sigBadgeEl.className = sigDisp.className;
    sigBadgeEl.textContent = sigDisp.text;
    sigBadgeMount.appendChild(sigBadgeEl);
  }

  // 渲染项目会话细分切换下拉框
  renderTelemetryConvSelector(tel, viewedItem, isProjectTotalView);

  const card = document.createElement("div");
  card.className = "telemetry-card";

  const bar = document.createElement("div");
  bar.className = "telemetry-bar";

  const lastInTok = Number(viewedItem.lastInputTokens || 0);
  const lastOutTok = Number(viewedItem.lastOutputTokens || 0);
  const lastCtxTok = Number(viewedItem.lastContextTokens || (lastInTok + Number(viewedItem.lastCacheTokens || 0)));
  const cacheTotalTok = Number(viewedItem.sessionCacheTokens || 0);
  const totalTok = Number(viewedItem.sessionTotalTokens || 0);
  const cacheHitPct = Number(viewedItem.cacheHitPct || 0);
  const turnCount = Number(viewedItem.turnCount || 0);
  const checkpointCount = Number(viewedItem.checkpointCount || 0);

  // 1. 本轮用词 (官方 input_tokens / output_tokens + 当前实时上下文窗口长度)
  const col1 = document.createElement("div");
  col1.className = "telemetry-metric";
  const lbl1 = document.createElement("span");
  lbl1.className = "telemetry-metric-label";
  lbl1.textContent = t.telemetryLastTurnLabel;
  const val1 = document.createElement("span");
  val1.className = "telemetry-metric-val";
  if (lastOutTok > 0 || lastInTok > 0) {
    val1.textContent = `↑${formatCompactTokenCount(lastInTok)} ↓${formatCompactTokenCount(lastOutTok)}`;
    if (lastCtxTok > 0) {
      const ctxTag = document.createElement("span");
      ctxTag.className = "telemetry-sub-tag";
      ctxTag.textContent = `(${t.telemetryContextPrefix} ${formatCompactTokenCount(lastCtxTok)})`;
      val1.appendChild(ctxTag);
    }
  } else {
    val1.textContent = "0";
  }
  col1.appendChild(lbl1);
  col1.appendChild(val1);

  // 2. 前缀缓存命中 (官方 cache_read_tokens 累计总量 + 缓存命中率)
  const col2 = document.createElement("div");
  col2.className = "telemetry-metric";
  const lbl2 = document.createElement("span");
  lbl2.className = "telemetry-metric-label";
  lbl2.textContent = t.telemetryCacheTotalLabel;
  const val2 = document.createElement("span");
  val2.className = "telemetry-metric-val" + (cacheTotalTok > 0 ? " highlight" : "");
  val2.textContent = `${formatCompactTokenCount(cacheTotalTok)} tok`;
  if (cacheHitPct > 0) {
    const pctTag = document.createElement("span");
    pctTag.className = "telemetry-sub-tag";
    pctTag.textContent = `(${cacheHitPct}%)`;
    val2.appendChild(pctTag);
  }
  col2.appendChild(lbl2);
  col2.appendChild(val2);

  // 3. 当前会话累计 / 项目全部会话累计 (官方累计 input + output + 对话轮数 + CHECKPOINT 自动压缩次数)
  const col3 = document.createElement("div");
  col3.className = "telemetry-metric";
  const lbl3 = document.createElement("span");
  lbl3.className = "telemetry-metric-label";
  lbl3.textContent = isProjectTotalView
    ? (t.telemetryProjectTotalLabel || t.telemetrySessionTotalLabel)
    : t.telemetrySessionTotalLabel;
  const val3 = document.createElement("span");
  val3.className = "telemetry-metric-val";
  val3.textContent = `${formatCompactTokenCount(totalTok)} tok`;
  if (turnCount > 0 || checkpointCount > 0) {
    const turnTag = document.createElement("span");
    turnTag.className = "telemetry-sub-tag";
    const compressSuffix = checkpointCount > 0
      ? ` · ${t.telemetryCompressPrefix}${checkpointCount}${t.telemetryCompressUnit}`
      : "";
    turnTag.textContent = `(${turnCount}${t.telemetryTurnUnit || "T"}${compressSuffix})`;
    val3.appendChild(turnTag);
  }
  col3.appendChild(lbl3);
  col3.appendChild(val3);

  bar.appendChild(col1);
  bar.appendChild(col2);
  bar.appendChild(col3);
  card.appendChild(bar);

  // 4. 下半部分：本会话（或当前项目）内按官方可用模型细分列表
  const byModel = Array.isArray(viewedItem.byModel) ? viewedItem.byModel : [];
  if (byModel.length > 0) {
    const modelsList = document.createElement("div");
    modelsList.className = "telemetry-models-list";

    for (const m of byModel) {
      const mRow = document.createElement("div");
      mRow.className = "telemetry-model-row";

      const mLeft = document.createElement("span");
      mLeft.className = "telemetry-model-name";
      mLeft.textContent = m.modelName;
      if (Number(m.turns || 0) > 0) {
        const mTurn = document.createElement("span");
        mTurn.className = "telemetry-sub-tag";
        mTurn.textContent = `(${m.turns}${t.telemetryTurnUnit || "T"})`;
        mLeft.appendChild(mTurn);
      }

      const mRight = document.createElement("div");
      mRight.className = "telemetry-model-stats";

      if (Number(m.cacheTokens || 0) > 0) {
        const mCache = document.createElement("span");
        mCache.className = "telemetry-model-cache";
        mCache.textContent = `${t.telemetryCacheTag} ${formatCompactTokenCount(m.cacheTokens)} (${m.cacheHitPct || 0}%)`;
        mRight.appendChild(mCache);
      }

      const mTok = document.createElement("span");
      mTok.className = "telemetry-model-tokens";
      mTok.textContent = `↑${formatCompactTokenCount(m.inputTokens)} ↓${formatCompactTokenCount(m.outputTokens)}`;
      mRight.appendChild(mTok);

      mRow.appendChild(mLeft);
      mRow.appendChild(mRight);
      modelsList.appendChild(mRow);
    }

    card.appendChild(modelsList);
  }

  mount.appendChild(card);
}

function renderSessionSelector() {
  const mount = document.getElementById("sessionChannelSelectorMount");
  if (!mount) return;
  mount.innerHTML = "";
  const active = state.activeAccount || {};
  const activeChannelId = active.channelId || (active.email ? `${active.email}#personal` : "");
  const accounts = state.accounts || [];

  // 构建可查看余额的通道列表
  const channelOptions = [];
  const seen = new Set();

  if (active.email && activeChannelId) {
    const existingActive = accounts.find((a) => a.id === activeChannelId);
    seen.add(activeChannelId);
    channelOptions.push(existingActive || {
      id: activeChannelId,
      email: active.email,
      channelType: active.gcpProjectId ? "gcp" : "personal",
      gcpProjectId: active.gcpProjectId || ""
    });
  }

  for (const acc of accounts) {
    if (!seen.has(acc.id)) {
      seen.add(acc.id);
      channelOptions.push(acc);
    }
  }

  const targetId = (selectedQuotaChannelId && seen.has(selectedQuotaChannelId))
    ? selectedQuotaChannelId
    : activeChannelId;
  const currentViewed = channelOptions.find((c) => c.id === targetId) || {
    id: activeChannelId,
    email: active.email || "-",
    channelType: active.gcpProjectId ? "gcp" : "personal",
    gcpProjectId: active.gcpProjectId || ""
  };

  const isViewingActive = !selectedQuotaChannelId || currentViewed.id === activeChannelId;
  const isGcp = currentViewed.channelType === "gcp" || Boolean(currentViewed.gcpProjectId);

  const wrapper = document.createElement("div");
  wrapper.className = "custom-dropdown session-selector-dropdown";

  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "dropdown-trigger";

  const leftWrap = document.createElement("div");
  leftWrap.className = "active-email-wrap";

  const dot = document.createElement("span");
  dot.className = "status-dot" + (state.lsOnline && isViewingActive ? " online" : "");
  leftWrap.appendChild(dot);

  const curBadge = getChannelBadgeInfo(currentViewed);
  const prefixBadge = document.createElement("span");
  prefixBadge.className = "channel-type-badge " + curBadge.badgeType;
  prefixBadge.textContent = curBadge.badgeText;
  leftWrap.appendChild(prefixBadge);

  const emailText = document.createElement("span");
  emailText.className = "active-email";
  emailText.textContent = isGcp && currentViewed.gcpProjectId
    ? `${currentViewed.email} · ${currentViewed.gcpProjectId}`
    : (currentViewed.email || "-");
  leftWrap.appendChild(emailText);

  const rightWrap = document.createElement("div");
  rightWrap.className = "session-trigger-right";

  const arrowSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  arrowSvg.setAttribute("class", "dropdown-arrow");
  arrowSvg.setAttribute("viewBox", "0 0 16 16");
  arrowSvg.setAttribute("fill", "none");
  arrowSvg.innerHTML = `<path d="M4 6L8 10L12 6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>`;
  rightWrap.appendChild(arrowSvg);

  trigger.appendChild(leftWrap);
  trigger.appendChild(rightWrap);

  const menu = document.createElement("div");
  menu.className = "dropdown-menu";

  for (const ch of channelOptions) {
    const chIsGcp = ch.channelType === "gcp" || Boolean(ch.gcpProjectId);
    const chIsActive = ch.id === currentViewed.id;
    const item = document.createElement("div");
    item.className = "dropdown-option" + (chIsActive ? " active" : "");

    const itemLeft = document.createElement("div");
    itemLeft.className = "active-email-wrap";

    const itemDot = document.createElement("span");
    itemDot.className = "status-dot" + (ch.id === activeChannelId && state.lsOnline ? " online" : "");
    itemLeft.appendChild(itemDot);

    const chBadge = getChannelBadgeInfo(ch);
    const itemBadge = document.createElement("span");
    itemBadge.className = "channel-type-badge " + chBadge.badgeType;
    itemBadge.textContent = chBadge.badgeText;
    itemLeft.appendChild(itemBadge);

    const itemLabel = document.createElement("span");
    itemLabel.className = "dropdown-option-label";
    itemLabel.textContent = chIsGcp && ch.gcpProjectId
      ? `${ch.email} · ${ch.gcpProjectId}`
      : ch.email;
    itemLeft.appendChild(itemLabel);

    const itemRight = document.createElement("div");
    itemRight.className = "session-trigger-right";

    const checkSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    checkSvg.setAttribute("class", "check-icon");
    checkSvg.setAttribute("viewBox", "0 0 16 16");
    checkSvg.setAttribute("fill", "none");
    checkSvg.innerHTML = `<path d="M3.5 8.5L6.5 11.5L12.5 4.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`;
    itemRight.appendChild(checkSvg);

    item.appendChild(itemLeft);
    item.appendChild(itemRight);

    item.onclick = (ev) => {
      ev.stopPropagation();
      wrapper.classList.remove("open");
      selectedQuotaChannelId = ch.id === activeChannelId ? "" : ch.id;
      renderSessionSelector();
      renderQuotaGroups();
      if (ch.id !== activeChannelId) {
        probeChannelQuotaInBackground(ch.id);
      }
    };

    menu.appendChild(item);
  }

  trigger.onclick = (ev) => {
    ev.stopPropagation();
    const isOpen = wrapper.classList.contains("open");
    document.querySelectorAll(".custom-dropdown.open").forEach((el) => el.classList.remove("open"));
    if (!isOpen) {
      wrapper.classList.add("open");
    }
  };

  wrapper.appendChild(trigger);
  wrapper.appendChild(menu);
  mount.appendChild(wrapper);
}

let lastAutoProbedChannelId = "";
let lastAutoProbedAt = 0;

async function probeChannelQuotaInBackground(channelId) {
  try {
    if (!channelId) return;
    lastAutoProbedChannelId = channelId;
    lastAutoProbedAt = Date.now();
    const res = await fetch("/api/probe-channel-quota", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channelId })
    });
    const data = await res.json();
    if (data && data.snapshot) {
      state = data.snapshot;
      if (typeof renderAll === "function") {
        renderAll();
      } else {
        renderSessionSelector();
        renderQuotaGroups();
      }
    }
  } catch (e) {}
}

function createQuotaRingSvg(pct) {
  const clamped = Math.max(0, Math.min(100, Number(pct) || 0));
  const r = 5.4;
  const c = 2 * Math.PI * r;
  const offset = c * (1 - clamped / 100);
  const colorClass = clamped <= 10 ? " low" : clamped <= 30 ? " warn" : "";
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("class", "quota-ring-svg");
  svg.setAttribute("viewBox", "0 0 14 14");

  const track = document.createElementNS(ns, "circle");
  track.setAttribute("class", "quota-ring-track");
  track.setAttribute("cx", "7");
  track.setAttribute("cy", "7");
  track.setAttribute("r", String(r));

  const fill = document.createElementNS(ns, "circle");
  fill.setAttribute("class", `quota-ring-fill${colorClass}`);
  fill.setAttribute("cx", "7");
  fill.setAttribute("cy", "7");
  fill.setAttribute("r", String(r));
  fill.setAttribute("stroke-dasharray", String(c.toFixed(2)));
  fill.setAttribute("stroke-dashoffset", String(offset.toFixed(2)));

  svg.appendChild(track);
  svg.appendChild(fill);
  return svg;
}

function getActivePersonalPoolUi() {
  const raw = state?.personalQuotaPool || state?.routing?.personalQuotaPool || "prod";
  return String(raw).toLowerCase() === "daily" ? "daily" : "prod";
}

function renderQuotaPoolSwitch(isGcpChannel) {
  const mount = document.getElementById("quotaPoolSwitchMount");
  if (!mount) return;
  mount.innerHTML = "";
  if (isGcpChannel) return;

  const t = I18N[currentLang];
  const activePool = getActivePersonalPoolUi();
  const wrap = document.createElement("div");
  wrap.className = "quota-pool-switch";

  for (const poolItem of [
    { key: "prod", label: t.poolTabProd || "正式服 Prod", host: "cloudcode-pa.googleapis.com" },
    { key: "daily", label: t.poolTabDaily || "Daily 服", host: "daily-cloudcode-pa.googleapis.com" }
  ]) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "quota-pool-btn" + (activePool === poolItem.key ? " active" : "");
    btn.title = poolItem.host;
    btn.textContent = poolItem.label;
    btn.onclick = () => {
      if (activePool !== poolItem.key && typeof switchPersonalQuotaPool === "function") {
        switchPersonalQuotaPool(poolItem.key);
      }
    };
    wrap.appendChild(btn);
  }

  mount.appendChild(wrap);
}

// 1:1 对齐官方「使用量」弹窗：每个分组下把「周限额」和「5h limit」拆成独立行 + 右侧百分比 + SVG 圆环 + Resets in ...
function renderQuotaGroups() {
  const container = document.getElementById("quotaGroupsContainer");
  container.innerHTML = "";
  const t = I18N[currentLang];
  const activeChannelId = state.activeAccount?.channelId || "";
  const targetChannelId = selectedQuotaChannelId || activeChannelId;
  const viewedAcc = (state.accounts || []).find((a) => a.id === targetChannelId);
  const isViewingActive = !selectedQuotaChannelId || selectedQuotaChannelId === activeChannelId;
  const isGcpChannel = Boolean(
    viewedAcc
      ? (viewedAcc.channelType === "gcp" || viewedAcc.gcpProjectId)
      : state.activeAccount?.gcpProjectId
  );

  renderQuotaPoolSwitch(isGcpChannel);

  const activePool = getActivePersonalPoolUi();
  const poolSnapshot = !isGcpChannel
    ? (viewedAcc?.cachedQuotaByPool?.[activePool] || viewedAcc?.cachedQuota || null)
    : (viewedAcc?.cachedQuota || null);

  const rawSourceGroups = !isGcpChannel
    ? (Array.isArray(poolSnapshot?.quotaGroups) && poolSnapshot.quotaGroups.length > 0
        ? poolSnapshot.quotaGroups
        : (isViewingActive && Array.isArray(state.quotaGroups) ? state.quotaGroups : []))
    : [];
  let groups = rawSourceGroups.filter((g) => {
    const gName = String(g?.displayName || g?.id || "").trim();
    const bks = Array.isArray(g?.buckets) ? g.buckets : [];
    if (/^all\s*models$/i.test(gName) || bks.length > 3) return false;
    return true;
  });

  // 若查看的是 GCP 通道，顶部展示当前 GCP 计费模式（按量计费 Agent Platform / Gemini Enterprise）与可用模型芯片，绝对不显示剩余百分比
  if (isGcpChannel) {
    const gcpCard = document.createElement("div");
    gcpCard.className = "gcp-billing-card";

    const header = document.createElement("div");
    header.className = "gcp-billing-header";

    const gcpMode = viewedAcc?.gcpBillingMode || state.activeAccount?.gcpBillingMode || "agent_platform";
    const gcpLoc = viewedAcc?.gcpLocation || state.activeAccount?.gcpLocation || "global";
    const locLabel = gcpLoc === "us" ? t.gcpRegionUs : gcpLoc === "eu" ? t.gcpRegionEu : t.gcpRegionGlobal;
    const title = document.createElement("span");
    title.className = "gcp-billing-title";
    title.textContent = gcpMode === "gemini_enterprise"
      ? t.gcpBillingTitleEnterprise
      : `${t.gcpBillingTitlePayg} · ${locLabel}`;

    const pill = document.createElement("span");
    pill.className = "gcp-unlimited-pill";
    pill.textContent = gcpMode === "gemini_enterprise" ? t.gcpPillEnterprise : t.gcpPillPayg;

    header.appendChild(title);
    header.appendChild(pill);
    gcpCard.appendChild(header);

    const gcpModels = viewedAcc?.cachedQuota?.availableModels || (isViewingActive ? state.availableModels : []) || [];
    if (gcpModels.length > 0) {
      const modelsLabel = document.createElement("div");
      modelsLabel.className = "gcp-models-label";
      modelsLabel.textContent = t.gcpModelsLabel;
      gcpCard.appendChild(modelsLabel);

      const chipsWrap = document.createElement("div");
      chipsWrap.className = "gcp-model-chips";
      for (const gm of gcpModels) {
        const chip = document.createElement("span");
        chip.className = "gcp-model-chip";
        chip.textContent = gm.label || gm.modelId;
        chipsWrap.appendChild(chip);
      }
      gcpCard.appendChild(chipsWrap);
    }

    container.appendChild(gcpCard);
    return;
  }

  if (groups.length === 0 && !isGcpChannel) {
    const hint = document.createElement("div");
    hint.className = "section-hint";
    hint.style.padding = "6px 2px";
    hint.textContent = t.quotaNoCacheHint;
    container.appendChild(hint);
    if (
      targetChannelId &&
      (lastAutoProbedChannelId !== targetChannelId || Date.now() - lastAutoProbedAt > 8000)
    ) {
      probeChannelQuotaInBackground(targetChannelId);
    }
    return;
  }

  for (const g of groups) {
    const buckets = g.buckets || [];
    if (buckets.length === 0) continue;

    const groupEl = document.createElement("div");
    groupEl.className = "quota-group";

    const titleEl = document.createElement("div");
    titleEl.className = "quota-group-title";
    titleEl.textContent = translateQuotaGroupName(g.displayName);
    groupEl.appendChild(titleEl);

    for (const b of buckets) {
      const pct = b.remainingPct ?? 100;
      const countdown = formatResetCountdown(b.resetTime);
      const isWeekly = /weekly/i.test(b.window || b.bucketId || "");
      const rowLabel = isWeekly ? t.weeklyLimitLabel : t.fiveHourLimitLabel;

      const row = document.createElement("div");
      row.className = "quota-bucket-row";

      const labelEl = document.createElement("span");
      labelEl.className = "quota-bucket-label";
      labelEl.textContent = rowLabel;

      const rightCol = document.createElement("div");
      rightCol.className = "quota-bucket-right";

      const mainLine = document.createElement("div");
      mainLine.className = "quota-bucket-main";

      const pctSpan = document.createElement("span");
      pctSpan.className = "quota-bucket-pct" + (pct === 100 ? " full" : "");
      pctSpan.textContent = `${t.pctLeftPrefix}${pct}${t.pctLeftSuffix}`;

      mainLine.appendChild(pctSpan);
      mainLine.appendChild(createQuotaRingSvg(pct));
      rightCol.appendChild(mainLine);

      if (countdown) {
        const resetLine = document.createElement("div");
        resetLine.className = "quota-bucket-reset";
        resetLine.textContent = `${t.resetsInPrefix}${countdown}${t.resetsInSuffix}`;
        rightCol.appendChild(resetLine);
      }

      row.appendChild(labelEl);
      row.appendChild(rightCol);
      groupEl.appendChild(row);
    }

    container.appendChild(groupEl);
  }

  const personalModels = Array.isArray(poolSnapshot?.availableModels) && poolSnapshot.availableModels.length > 0
    ? poolSnapshot.availableModels
    : (isViewingActive && Array.isArray(state.availableModels) ? state.availableModels : []);
  if (personalModels.length > 0) {
    const modelsCard = document.createElement("div");
    modelsCard.className = "personal-pool-models-bar";

    const modelsLabel = document.createElement("div");
    modelsLabel.className = "gcp-models-label";
    modelsLabel.textContent = activePool === "daily"
      ? (t.personalModelsLabelDaily || "Daily 服已识别可用模型：")
      : (t.personalModelsLabelProd || "正式服 (Prod) 已识别可用模型：");
    modelsCard.appendChild(modelsLabel);

    const chipsWrap = document.createElement("div");
    chipsWrap.className = "gcp-model-chips";
    for (const pm of personalModels) {
      const chip = document.createElement("span");
      chip.className = "gcp-model-chip";
      chip.textContent = pm.label || pm.modelId;
      chipsWrap.appendChild(chip);
    }
    modelsCard.appendChild(chipsWrap);
    container.appendChild(modelsCard);
  }
}
