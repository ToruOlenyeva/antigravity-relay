// 偏好设置页、外观风格/主题/字号/语言控制与插件更新交互模块

let activeMainTab = "dashboard";
let updaterState = null;
let updaterLoading = false;
let updaterApplying = false;

function readStorageSafe(key, fallback = "") {
  try {
    const val = localStorage.getItem(key);
    return val !== null && val !== undefined ? val : fallback;
  } catch {
    return fallback;
  }
}

function writeStorageSafe(key, val) {
  try {
    localStorage.setItem(key, String(val));
  } catch {}
}

function getUiStylePref() {
  const v = readStorageSafe("agy_relay_ui_style", "modern");
  return v === "classic" ? "classic" : "modern";
}

function getThemePref() {
  const v = readStorageSafe("agy_relay_theme_pref", "auto");
  return v === "light" || v === "dark" ? v : "auto";
}

const FONT_SCALE_PRESETS = { sm: 0.88, md: 1, lg: 1.15 };
const HOST_BASE_FONT_PX = 14;
let detectedHostAppearance = {
  fontSizePx: null,
  fontFamily: "",
  source: ""
};

function clampFontScaleRatio(num) {
  return Math.round(Math.min(1.45, Math.max(0.82, num)) * 1000) / 1000;
}

function parseFontSizePx(raw) {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw === "number") {
    return Number.isFinite(raw) && raw >= 9 && raw <= 36 ? raw : null;
  }
  const str = String(raw).trim();
  if (!str) return null;
  const pxMatch = str.match(/^(\d+(?:\.\d+)?)\s*px$/i);
  if (pxMatch) {
    const n = parseFloat(pxMatch[1]);
    return Number.isFinite(n) && n >= 9 && n <= 36 ? n : null;
  }
  const remMatch = str.match(/^(\d+(?:\.\d+)?)\s*(?:rem|em)$/i);
  if (remMatch) {
    const n = parseFloat(remMatch[1]) * 16;
    return Number.isFinite(n) && n >= 9 && n <= 36 ? Math.round(n * 10) / 10 : null;
  }
  if (/^\d+(?:\.\d+)?$/.test(str)) {
    const n = parseFloat(str);
    return Number.isFinite(n) && n >= 9 && n <= 36 ? n : null;
  }
  return null;
}

function getFontScalePref() {
  const v = readStorageSafe("agy_relay_font_scale", "auto");
  return v === "auto" || v === "sm" || v === "md" || v === "lg" ? v : "auto";
}

function getLangPref() {
  const v = readStorageSafe("agy_relay_lang_pref", "");
  if (v === "zh" || v === "en" || v === "auto") return v;
  const legacy = readStorageSafe("agy_relay_lang", "");
  if (legacy === "zh" || legacy === "en") return legacy;
  return "auto";
}

function resolveEffectiveLang(pref = getLangPref()) {
  if (pref === "zh" || pref === "en") return pref;
  return (typeof navigator !== "undefined" && typeof navigator.language === "string" && /^zh\b/i.test(navigator.language))
    ? "zh"
    : "en";
}

function resolveAutoThemeMode() {
  const hostSaved = readStorageSafe("antigravity_theme_mode", "");
  if (hostSaved === "light" || hostSaved === "dark") return hostSaved;
  if (typeof window !== "undefined" && window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches) {
    return "light";
  }
  return "dark";
}

function resolveEffectiveFontScaleInfo() {
  const pref = getFontScalePref();
  if (pref !== "auto" && Object.prototype.hasOwnProperty.call(FONT_SCALE_PRESETS, pref)) {
    return {
      pref,
      scale: FONT_SCALE_PRESETS[pref],
      source: "manual",
      hostPx: null
    };
  }
  const savedHostPx = parseFontSizePx(readStorageSafe("antigravity_host_font_px", ""));
  const hostPx = parseFontSizePx(detectedHostAppearance.fontSizePx) ?? savedHostPx;
  if (hostPx !== null) {
    return {
      pref: "auto",
      scale: clampFontScaleRatio(hostPx / HOST_BASE_FONT_PX),
      source: detectedHostAppearance.source || "host",
      hostPx
    };
  }
  try {
    const rootEl = typeof document !== "undefined" ? document.documentElement : null;
    if (rootEl && typeof window !== "undefined" && typeof window.getComputedStyle === "function") {
      const rootPx = parseFloat(window.getComputedStyle(rootEl).fontSize || "");
      if (Number.isFinite(rootPx) && Math.abs(rootPx - 16) >= 0.5) {
        const sysScale = Math.round(Math.min(1.35, Math.max(0.85, rootPx / 16)) * 1000) / 1000;
        const equivPx = Math.round(sysScale * HOST_BASE_FONT_PX * 10) / 10;
        return {
          pref: "auto",
          scale: sysScale,
          source: "system",
          hostPx: equivPx
        };
      }
    }
  } catch {}
  return {
    pref: "auto",
    scale: 1,
    source: "default",
    hostPx: HOST_BASE_FONT_PX
  };
}

function formatHostFontFamilyCss(rawFamily) {
  const clean = String(rawFamily || "").trim();
  if (!clean || /^(inherit|initial|unset|default|auto)$/i.test(clean)) return "";
  if (clean.includes(",") || /var\(/i.test(clean)) return clean;
  const quoted = (clean.startsWith("\"") || clean.startsWith("'")) ? clean : `"${clean.replace(/"/g, "")}"`;
  return `${quoted}, var(--font-sans)`;
}

function handleHostThemeFontVars(vars) {
  if (!vars || typeof vars !== "object") return false;
  let changed = false;
  const sizeKeys = ["--font-size", "--base-font-size", "--ui-font-size", "--text-base", "--vscode-font-size", "--body-font-size"];
  for (const key of sizeKeys) {
    const px = parseFontSizePx(vars[key]);
    if (px !== null) {
      if (detectedHostAppearance.fontSizePx !== px || detectedHostAppearance.source !== "theme-change") {
        detectedHostAppearance.fontSizePx = px;
        detectedHostAppearance.source = "theme-change";
        writeStorageSafe("antigravity_host_font_px", String(px));
        changed = true;
      }
      break;
    }
  }
  const familyKeys = ["--font-sans", "--ui-font-family", "--font-family", "--vscode-font-family"];
  for (const key of familyKeys) {
    const formatted = formatHostFontFamilyCss(vars[key]);
    if (formatted) {
      if (detectedHostAppearance.fontFamily !== formatted) {
        detectedHostAppearance.fontFamily = formatted;
        writeStorageSafe("antigravity_host_font_family", formatted);
        changed = true;
      }
      break;
    }
  }
  if (changed) {
    applyAppearancePreferences();
    if (typeof activeMainTab !== "undefined" && activeMainTab === "preferences" && typeof renderPreferencesView === "function") {
      renderPreferencesView();
    }
  }
  return changed;
}

function syncHostAppearanceFromSnapshot(hostApp) {
  if (!hostApp || typeof hostApp !== "object") return false;
  let changed = false;
  if (detectedHostAppearance.source !== "theme-change") {
    const cfgPx = parseFontSizePx(hostApp.fontSizePx);
    if (cfgPx !== null) {
      if (detectedHostAppearance.fontSizePx !== cfgPx || detectedHostAppearance.source !== "config") {
        detectedHostAppearance.fontSizePx = cfgPx;
        detectedHostAppearance.source = "config";
        writeStorageSafe("antigravity_host_font_px", String(cfgPx));
        changed = true;
      }
    } else if (detectedHostAppearance.source === "config" && detectedHostAppearance.fontSizePx !== null) {
      detectedHostAppearance.fontSizePx = null;
      detectedHostAppearance.source = "";
      try { localStorage.removeItem("antigravity_host_font_px"); } catch {}
      changed = true;
    }
    const cfgFamily = formatHostFontFamilyCss(hostApp.fontFamily);
    if (cfgFamily) {
      if (detectedHostAppearance.fontFamily !== cfgFamily) {
        detectedHostAppearance.fontFamily = cfgFamily;
        writeStorageSafe("antigravity_host_font_family", cfgFamily);
        changed = true;
      }
    } else if (detectedHostAppearance.source === "config" && detectedHostAppearance.fontFamily) {
      detectedHostAppearance.fontFamily = "";
      try { localStorage.removeItem("antigravity_host_font_family"); } catch {}
      changed = true;
    }
  }
  if (changed) {
    applyAppearancePreferences();
    if (typeof activeMainTab !== "undefined" && activeMainTab === "preferences" && typeof renderPreferencesView === "function") {
      renderPreferencesView();
    }
  }
  return changed;
}

function applyAppearancePreferences() {
  const style = getUiStylePref();
  const themePref = getThemePref();
  const fontScale = getFontScalePref();
  const fsInfo = resolveEffectiveFontScaleInfo();
  const resolvedTheme = themePref === "auto" ? resolveAutoThemeMode() : themePref;
  const root = document.documentElement;
  if (root) {
    root.setAttribute("data-ui-style", style);
    root.setAttribute("data-font-scale", fontScale);
    root.setAttribute("data-theme", resolvedTheme);
    if (root.style && typeof root.style.setProperty === "function") {
      root.style.setProperty("--ui-font-scale", String(fsInfo.scale));
      const hostFam = detectedHostAppearance.fontFamily || formatHostFontFamilyCss(readStorageSafe("antigravity_host_font_family", ""));
      if (hostFam) {
        root.style.setProperty("--ui-font-family", hostFam);
      } else if (typeof root.style.removeProperty === "function") {
        root.style.removeProperty("--ui-font-family");
      }
    }
  }
}

function setUiStylePref(style) {
  const next = style === "classic" ? "classic" : "modern";
  writeStorageSafe("agy_relay_ui_style", next);
  applyAppearancePreferences();
  renderPreferencesView();
}

function setThemePref(pref) {
  const next = pref === "light" || pref === "dark" ? pref : "auto";
  writeStorageSafe("agy_relay_theme_pref", next);
  applyAppearancePreferences();
  renderPreferencesView();
}

function setFontScalePref(scale) {
  const next = scale === "auto" || scale === "sm" || scale === "md" || scale === "lg" ? scale : "auto";
  writeStorageSafe("agy_relay_font_scale", next);
  applyAppearancePreferences();
  renderPreferencesView();
}

function setLangPref(pref) {
  const next = pref === "zh" || pref === "en" ? pref : "auto";
  writeStorageSafe("agy_relay_lang_pref", next);
  if (next === "auto") {
    try { localStorage.removeItem("agy_relay_lang"); } catch {}
  } else {
    writeStorageSafe("agy_relay_lang", next);
  }
  const effective = resolveEffectiveLang(next);
  if (typeof currentLang !== "undefined") {
    currentLang = effective;
  }
  if (typeof applyI18n === "function") {
    applyI18n();
  }
  fetch("/api/set-language", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ lang: effective })
  }).catch(() => {});
  renderPreferencesView();
}

function switchMainTab(tab) {
  activeMainTab = tab === "preferences" ? "preferences" : "dashboard";
  const dashEl = document.getElementById("dashboardView");
  const prefsEl = document.getElementById("preferencesView");
  const tabDash = document.getElementById("tabDashboardBtn");
  const tabPrefs = document.getElementById("tabPrefsBtn");
  const isPrefs = activeMainTab === "preferences";
  if (dashEl) dashEl.style.display = isPrefs ? "none" : "";
  if (prefsEl) prefsEl.style.display = isPrefs ? "" : "none";
  if (tabDash) tabDash.classList.toggle("active", !isPrefs);
  if (tabPrefs) tabPrefs.classList.toggle("active", isPrefs);
  if (isPrefs) {
    renderPreferencesView();
    if (!updaterState && !updaterLoading) {
      loadUpdaterStatus();
    }
  }
}

function syncHeaderUpdatePill() {
  const pill = document.getElementById("headerUpdatePill");
  if (!pill) return;
  if (updaterState?.hasUpdate && updaterState.latestVersion) {
    pill.style.display = "inline-flex";
    pill.textContent = `↑ v${updaterState.latestVersion}`;
    pill.title = (I18N[currentLang]?.updateNewAvailable || "发现新版本") + ` v${updaterState.latestVersion}`;
  } else {
    pill.style.display = "none";
  }
}

async function loadUpdaterStatus() {
  if (updaterLoading) return;
  updaterLoading = true;
  if (activeMainTab === "preferences") renderPreferencesView();
  try {
    const res = await fetch("/api/updater-status", { cache: "no-store" });
    const data = await res.json();
    if (data && data.currentVersion) {
      updaterState = data;
      syncHeaderUpdatePill();
    }
  } catch {} finally {
    updaterLoading = false;
    if (activeMainTab === "preferences") renderPreferencesView();
  }
}

async function handleCheckPluginUpdate() {
  if (updaterLoading || updaterApplying) return;
  updaterLoading = true;
  renderPreferencesView();
  const t = I18N[currentLang];
  try {
    const res = await fetch("/api/updater-check", { method: "POST" });
    const data = await res.json();
    if (data && data.currentVersion) {
      updaterState = data;
      syncHeaderUpdatePill();
    }
    if (data?.lastError) {
      showToast(`${t.toastUpdateCheckFailed || "检查更新失败："}${data.lastError}`);
    } else if (data?.hasUpdate) {
      showToast(`${t.updateNewAvailable || "发现新版本"} v${data.latestVersion}`);
    } else {
      showToast(t.toastAlreadyLatest || "当前已是最新版本");
    }
  } catch (err) {
    showToast(`${t.toastUpdateCheckFailed || "检查更新失败："}${err?.message || err}`);
  } finally {
    updaterLoading = false;
    renderPreferencesView();
  }
}

async function handleUpdateModeChange(mode) {
  try {
    const res = await fetch("/api/updater-config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ updateMode: mode })
    });
    const data = await res.json();
    if (data && data.currentVersion) {
      updaterState = data;
      syncHeaderUpdatePill();
    }
    renderPreferencesView();
    showToast(I18N[currentLang].toastUpdateModeSaved || "已保存更新策略");
  } catch {}
}

async function handleApplyPluginUpdate() {
  if (updaterApplying) return;
  const t = I18N[currentLang];
  if (updaterState?.installMode === "git" && updaterState?.worktreeClean === false) {
    showToast(t.updateDirtyHint || "本地仓库有未提交改动，已阻止覆盖");
    return;
  }
  updaterApplying = true;
  renderPreferencesView();
  try {
    const res = await fetch("/api/updater-apply", { method: "POST" });
    const data = await res.json();
    if (data && data.currentVersion) {
      updaterState = data;
      syncHeaderUpdatePill();
    }
    if (!data?.success) {
      showToast(data?.error || t.toastUpdateFailed || "更新失败");
    } else if (data?.alreadyLatest) {
      showToast(t.toastAlreadyLatest || "当前已是最新版本");
    } else {
      showToast(`${t.toastUpdateSucceeded || "已更新至"} v${data.newVersion}，正在热重载...`);
      setTimeout(() => {
        window.location.reload();
      }, 2800);
    }
  } catch (err) {
    showToast(`${t.toastUpdateFailed || "更新失败："}${err?.message || err}`);
  } finally {
    updaterApplying = false;
    renderPreferencesView();
  }
}

function buildSegmentedGroup(options, activeVal, onSelect) {
  const wrap = document.createElement("div");
  wrap.className = "prefs-seg-group";
  for (const opt of options) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "prefs-seg-btn" + (opt.value === activeVal ? " active" : "");
    btn.textContent = opt.label;
    btn.onclick = () => {
      if (opt.value !== activeVal) onSelect(opt.value);
    };
    wrap.appendChild(btn);
  }
  return wrap;
}

function formatCheckedTime(ts, t) {
  if (!ts || !Number.isFinite(ts) || ts <= 0) return t.updateNeverChecked || "尚未检查";
  try {
    const d = new Date(ts);
    const pad = (n) => String(n).padStart(2, "0");
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch {
    return t.updateNeverChecked || "尚未检查";
  }
}

function renderPreferencesView() {
  const mount = document.getElementById("preferencesView");
  if (!mount) return;
  const t = I18N[currentLang];
  mount.innerHTML = "";

  // 1. 界面与外观设置卡片
  const appCard = document.createElement("div");
  appCard.className = "section-card";
  const appHeader = document.createElement("div");
  appHeader.className = "section-header";
  const appTitle = document.createElement("span");
  appTitle.className = "section-title";
  appTitle.textContent = t.prefsAppearanceTitle || "界面与外观";
  appHeader.appendChild(appTitle);
  appCard.appendChild(appHeader);

  const addGroup = (labelText, controlEl, hintText = "") => {
    const grp = document.createElement("div");
    grp.className = "prefs-group";
    const lbl = document.createElement("div");
    lbl.className = "prefs-label";
    lbl.textContent = labelText;
    grp.appendChild(lbl);
    grp.appendChild(controlEl);
    if (hintText) {
      const hint = document.createElement("div");
      hint.className = "prefs-hint";
      hint.textContent = hintText;
      grp.appendChild(hint);
    }
    appCard.appendChild(grp);
  };

  addGroup(
    t.prefsStyleLabel || "界面风格",
    buildSegmentedGroup(
      [
        { value: "modern", label: t.prefsStyleModern || "现代无边框" },
        { value: "classic", label: t.prefsStyleClassic || "经典线框" }
      ],
      getUiStylePref(),
      setUiStylePref
    ),
    t.prefsStyleHint || "在无边框多层柔光 UI 与经典线框 UI 之间实时切换"
  );

  addGroup(
    t.prefsThemeLabel || "主题模式",
    buildSegmentedGroup(
      [
        { value: "auto", label: t.prefsThemeAuto || "跟随宿主" },
        { value: "light", label: t.prefsThemeLight || "浅色" },
        { value: "dark", label: t.prefsThemeDark || "深色" }
      ],
      getThemePref(),
      setThemePref
    )
  );

  const fsInfo = resolveEffectiveFontScaleInfo();
  const fsPct = Math.round(fsInfo.scale * 100);
  const fontHintText = fsInfo.pref === "auto"
    ? `${t.prefsFontHintAutoHost || "当前自动跟随宿主/系统字号："}${fsInfo.hostPx || HOST_BASE_FONT_PX}px（${fsPct}%）`
    : `${t.prefsFontHintManual || "当前已手动锁定字号缩放："}${fsPct}%`;

  addGroup(
    t.prefsFontLabel || "字体大小",
    buildSegmentedGroup(
      [
        { value: "auto", label: t.prefsFontAuto || "跟随系统" },
        { value: "sm", label: t.prefsFontSm || "小" },
        { value: "md", label: t.prefsFontMd || "标准" },
        { value: "lg", label: t.prefsFontLg || "大" }
      ],
      getFontScalePref(),
      setFontScalePref
    ),
    fontHintText
  );

  addGroup(
    t.prefsLangLabel || "界面语言",
    buildSegmentedGroup(
      [
        { value: "auto", label: t.prefsLangAuto || "跟随系统" },
        { value: "zh", label: "简体中文" },
        { value: "en", label: "English" }
      ],
      getLangPref(),
      setLangPref
    )
  );

  mount.appendChild(appCard);

  // 2. 版本更新卡片
  const updCard = document.createElement("div");
  updCard.className = "section-card";
  const st = updaterState || {};
  const updHeader = document.createElement("div");
  updHeader.className = "section-header";
  const updTitle = document.createElement("span");
  updTitle.className = "section-title";
  updTitle.textContent = t.prefsUpdateTitle || "版本更新";
  const updBadge = document.createElement("span");
  updBadge.className = "update-status-pill" + (st.hasUpdate ? " has-update" : "");
  updBadge.textContent = st.hasUpdate
    ? `${t.updateNewAvailable || "发现新版本"} v${st.latestVersion}`
    : (st.currentVersion ? `${t.updateAlreadyLatest || "当前已是最新"} (v${st.currentVersion})` : (t.updateCheckingShort || "..."));
  updHeader.appendChild(updTitle);
  updHeader.appendChild(updBadge);
  updCard.appendChild(updHeader);

  const modeGrp = document.createElement("div");
  modeGrp.className = "prefs-group";
  const modeLbl = document.createElement("div");
  modeLbl.className = "prefs-label";
  modeLbl.textContent = t.prefsUpdateModeLabel || "更新方式";
  modeGrp.appendChild(modeLbl);
  modeGrp.appendChild(
    buildSegmentedGroup(
      [
        { value: "manual", label: t.updateModeManual || "仅提示，手动更新" },
        { value: "auto", label: t.updateModeAuto || "自动更新" },
        { value: "off", label: t.updateModeOff || "关闭" }
      ],
      st.updateMode || "manual",
      handleUpdateModeChange
    )
  );
  updCard.appendChild(modeGrp);

  const metaGrid = document.createElement("div");
  metaGrid.className = "update-meta-grid";

  const curItem = document.createElement("div");
  curItem.className = "update-meta-item";
  const curLbl = document.createElement("div");
  curLbl.className = "prefs-label";
  curLbl.textContent = t.updateCurrentVer || "当前版本";
  const curVal = document.createElement("div");
  curVal.className = "update-meta-val";
  curVal.textContent = st.currentVersion ? `v${st.currentVersion}` : "--";
  const curSub = document.createElement("div");
  curSub.className = "prefs-hint";
  curSub.textContent = st.installMode === "git"
    ? `Git (${st.gitBranch || "main"})`
    : (st.installMode === "zip" ? "Release ZIP" : "--");
  curItem.appendChild(curLbl);
  curItem.appendChild(curVal);
  curItem.appendChild(curSub);

  const latItem = document.createElement("div");
  latItem.className = "update-meta-item";
  const latLbl = document.createElement("div");
  latLbl.className = "prefs-label";
  latLbl.textContent = t.updateLatestVer || "远端版本";
  const latVal = document.createElement("div");
  latVal.className = "update-meta-val";
  latVal.textContent = st.latestVersion ? `v${st.latestVersion}` : (st.currentVersion ? `v${st.currentVersion}` : "--");
  const latSub = document.createElement("div");
  latSub.className = "prefs-hint";
  latSub.textContent = `${t.updateLastCheckedPrefix || "检查于 "} ${formatCheckedTime(st.lastCheckedAt, t)}`;
  latItem.appendChild(latLbl);
  latItem.appendChild(latVal);
  latItem.appendChild(latSub);

  metaGrid.appendChild(curItem);
  metaGrid.appendChild(latItem);
  updCard.appendChild(metaGrid);

  if (st.installMode === "git" && st.worktreeClean === false) {
    const dirtyHint = document.createElement("div");
    dirtyHint.className = "gcp-scan-hint warn";
    dirtyHint.textContent = `${t.updateDirtyNoticePrefix || "检测到本地仓库有 "}${st.dirtyCount || ""}${t.updateDirtyNoticeSuffix || " 项未提交改动，自动/快进更新已启用安全保护。"}`;
    updCard.appendChild(dirtyHint);
  }
  if (st.lastError) {
    const errHint = document.createElement("div");
    errHint.className = "gcp-scan-hint warn";
    errHint.textContent = `${t.toastUpdateCheckFailed || "检查异常："}${st.lastError}`;
    updCard.appendChild(errHint);
  }

  const actions = document.createElement("div");
  actions.className = "btn-group";
  actions.style.justifyContent = "flex-end";

  const checkBtn = document.createElement("button");
  checkBtn.className = "secondary";
  checkBtn.disabled = updaterLoading || updaterApplying;
  checkBtn.textContent = updaterLoading ? (t.btnCheckingUpdate || "检查中...") : (t.btnCheckUpdate || "检查更新");
  checkBtn.onclick = handleCheckPluginUpdate;
  actions.appendChild(checkBtn);

  if (st.hasUpdate) {
    const applyBtn = document.createElement("button");
    applyBtn.disabled = updaterApplying || (st.installMode === "git" && st.worktreeClean === false);
    applyBtn.textContent = updaterApplying ? (t.btnUpdating || "更新中...") : (t.btnApplyUpdate || "立即更新");
    applyBtn.onclick = handleApplyPluginUpdate;
    actions.appendChild(applyBtn);
  }

  updCard.appendChild(actions);
  mount.appendChild(updCard);
}

applyAppearancePreferences();
