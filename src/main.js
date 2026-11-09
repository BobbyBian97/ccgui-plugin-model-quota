// 模型额度胶囊 —— CC GUI 插件（Tier-1，单文件 ESM，无 import / JSX）
//
// 在输入框状态栏（分支切换器之后）用胶囊显示当前会话所用服务的余量：
//   - 智谱 GLM Coding Plan：5 小时 / 周 / 月（工具调用）
//     GET https://open.bigmodel.cn/api/monitor/usage/quota/limit   （国内）
//     GET https://api.z.ai/api/monitor/usage/quota/limit           （海外）
//   - OpenCode Go / Zen：rolling（5 小时）/ 周 / 月（账号级，Zen/Go 共用）
//     GET https://opencode.ai/zen/go/v1/usage
// API Key 只保存在本机插件存储里，仅发往上述官方域名。

const STORAGE_CONFIG = "model-quota/config";
const STORAGE_CACHE = "model-quota/last-good";

const REGIONS = {
  cn: { label: "国内（open.bigmodel.cn）", origin: "https://open.bigmodel.cn", path: "/api/monitor/usage/quota/limit" },
  intl: { label: "海外（api.z.ai）", origin: "https://api.z.ai", path: "/api/monitor/usage/quota/limit" },
};

const OPENCODE_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
// opencode.ai 在 Cloudflare 后面，非浏览器 UA 会被 403（error 1010）拦掉。
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const POLL_INTERVAL_MS = 2 * 60 * 1000; // 正常轮询间隔
const MIN_FETCH_GAP_MS = 30 * 1000; // 两次请求最小间隔
const BACKOFF_MS = 5 * 60 * 1000; // 429 / 鉴权失败退避
const STALE_AFTER_MS = 10 * 60 * 1000; // 超过此时间未成功刷新视为陈旧

const PROVIDER_IDS = ["glm", "opencode"];
const PROVIDERS = {
  glm: { label: "GLM", fullName: "智谱 GLM Coding Plan" },
  opencode: { label: "OpenCode", fullName: "OpenCode Go" },
};

const WINDOW_ORDER = ["session", "weekly", "monthly"];
const WINDOW_LABELS = { session: "5h", weekly: "周", monthly: "月" };
const WINDOW_NAMES = {
  glm: { session: "5 小时窗口", weekly: "周窗口", monthly: "月度额度（工具调用）" },
  opencode: { session: "5 小时窗口", weekly: "周窗口", monthly: "月度额度" },
};

const ERROR_SHORT = {
  nokey: "未配置",
  auth: "Key 无效",
  rateLimited: "限流",
  network: "离线",
  api: "查询失败",
  http: "查询失败",
  parse: "响应异常",
};
const AUTH_CODES = [401, 403, 1001, 1002, 1003, 1004];

// ---- 基础工具 ----

function toFiniteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function clampPercent(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(100, Math.max(0, n));
}

function parseTimestamp(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || !value.trim()) return null;
  const ms = Date.parse(value.trim());
  return Number.isNaN(ms) ? null : ms;
}

// ---- 智谱 GLM 额度解析 ----

// TOKENS_LIMIT unit=3 → 5 小时；unit=6 → 周；TIME_LIMIT → 月
function classifyLimit(limit) {
  if (!limit || typeof limit !== "object") return null;
  const type = typeof limit.type === "string" ? limit.type.toUpperCase() : "";
  const unit = Number(limit.unit);
  if (type === "TOKENS_LIMIT") {
    if (unit === 3) return "session";
    if (unit === 6) return "weekly";
    return null;
  }
  if (type === "TIME_LIMIT") return "monthly";
  return null;
}

function readUsedPercent(limit) {
  const direct = clampPercent(limit.percentage);
  if (direct !== null) return direct;
  const usage = toFiniteNumber(limit.usage);
  const current = toFiniteNumber(limit.currentValue);
  if (usage !== null && usage > 0 && current !== null) return clampPercent((current / usage) * 100);
  return null;
}

function parseQuotaResponse(payload) {
  if (!payload || typeof payload !== "object") return { ok: false, error: "响应不是 JSON 对象" };
  const code = toFiniteNumber(payload.code);
  if (payload.success === false || (code !== null && code !== 200)) {
    return {
      ok: false,
      error: String(payload.msg || payload.message || ("接口错误 " + (payload.code === undefined ? "未知" : payload.code))),
      code: code,
    };
  }
  const data = payload.data && typeof payload.data === "object" ? payload.data : null;
  if (!data) return { ok: false, error: "响应缺少 data 字段", code: code };
  const limits = Array.isArray(data.limits) ? data.limits : [];
  const windows = {};
  for (const limit of limits) {
    const kind = classifyLimit(limit);
    if (!kind || windows[kind]) continue;
    const used = readUsedPercent(limit);
    if (used === null) continue;
    windows[kind] = {
      kind: kind,
      usedPercent: used,
      remainingPercent: Math.max(0, 100 - used),
      usage: toFiniteNumber(limit.usage),
      currentValue: toFiniteNumber(limit.currentValue),
      nextResetTime: toFiniteNumber(limit.nextResetTime),
    };
  }
  if (!windows.session && !windows.weekly && !windows.monthly) {
    return { ok: false, error: "响应里没有可识别的额度窗口" };
  }
  return {
    ok: true,
    level: typeof data.level === "string" && data.level ? data.level : null,
    windows: windows,
    fetchedAt: Date.now(),
  };
}

// ---- OpenCode Go / Zen 额度解析 ----
// 响应形如 { usage: { rolling: { percent, resetsAt }, weekly: {...}, monthly: {...} } }
function parseOpenCodeResponse(payload) {
  if (!payload || typeof payload !== "object") return { ok: false, error: "响应不是 JSON 对象" };
  const usage = payload.usage && typeof payload.usage === "object" ? payload.usage : null;
  if (!usage) return { ok: false, error: "响应缺少 usage 字段" };
  const nameToKind = { rolling: "session", weekly: "weekly", monthly: "monthly" };
  const windows = {};
  for (const name of Object.keys(nameToKind)) {
    const window = usage[name];
    if (!window || typeof window !== "object") continue;
    const used = clampPercent(window.percent);
    if (used === null) continue;
    const kind = nameToKind[name];
    windows[kind] = {
      kind: kind,
      usedPercent: used,
      remainingPercent: Math.max(0, 100 - used),
      usage: null,
      currentValue: null,
      nextResetTime: parseTimestamp(window.resetsAt),
    };
  }
  if (!windows.session && !windows.weekly && !windows.monthly) {
    return { ok: false, error: "响应里没有可识别的额度窗口" };
  }
  return { ok: true, level: null, windows: windows, fetchedAt: Date.now() };
}

// ---- HTTP 响应解析 ----

function pickApiMessage(payload) {
  if (!payload || typeof payload !== "object") return "";
  const direct = payload.msg || payload.message;
  if (typeof direct === "string" && direct) return direct;
  const nested = payload.error;
  if (typeof nested === "string") return nested;
  if (nested && typeof nested === "object" && typeof nested.message === "string") return nested.message;
  return "";
}

function readHttpResponse(res) {
  const status = res && typeof res === "object" ? toFiniteNumber(res.status) : null;
  let payload = null;
  if (res && typeof res === "object" && typeof res.body === "string" && res.body.trim()) {
    try {
      payload = JSON.parse(res.body);
    } catch (_) {
      payload = null;
    }
  }
  return { status: status, payload: payload };
}

function mapHttpError(status, payload, forbiddenHint) {
  if (status === 401) return { ok: false, kind: "auth", error: pickApiMessage(payload) || "HTTP 401" };
  if (status === 403) {
    return { ok: false, kind: "auth", error: pickApiMessage(payload) || forbiddenHint || "HTTP 403" };
  }
  if (status === 429) return { ok: false, kind: "rateLimited", error: "请求过于频繁（HTTP 429）" };
  if (status !== null && status >= 400) return { ok: false, kind: "http", error: "HTTP " + status };
  return null;
}

function parseGlmHttpResult(res) {
  const parsed = readHttpResponse(res);
  const mapped = mapHttpError(parsed.status, parsed.payload);
  if (mapped) return mapped;
  if (!parsed.payload) return { ok: false, kind: "parse", error: "响应不是有效 JSON" };
  const result = parseQuotaResponse(parsed.payload);
  if (!result.ok) {
    const authLike =
      result.code !== null && result.code !== undefined && AUTH_CODES.indexOf(result.code) >= 0;
    return { ok: false, kind: authLike ? "auth" : "api", error: result.error };
  }
  return result;
}

function parseOpenCodeHttpResult(res) {
  const parsed = readHttpResponse(res);
  const mapped = mapHttpError(parsed.status, parsed.payload, "HTTP 403（可能被 Cloudflare 拦截）");
  if (mapped) return mapped;
  if (!parsed.payload) return { ok: false, kind: "parse", error: "响应不是有效 JSON" };
  const result = parseOpenCodeResponse(parsed.payload);
  if (!result.ok) return { ok: false, kind: "parse", error: result.error };
  return result;
}

// ---- 配置 / 会话判定 ----

function normalizeConfig(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  // 兼容 v1：{ apiKey, region, showMode }
  if (source.apiKey !== undefined && source.glmKey === undefined) {
    return {
      source: source.showMode === "always" ? "glm" : "auto",
      glmKey: typeof source.apiKey === "string" ? source.apiKey.trim() : "",
      glmRegion: source.region === "intl" ? "intl" : "cn",
      opencodeKey: "",
    };
  }
  return {
    source: source.source === "glm" || source.source === "opencode" ? source.source : "auto",
    glmKey: typeof source.glmKey === "string" ? source.glmKey.trim() : "",
    glmRegion: source.glmRegion === "intl" ? "intl" : "cn",
    opencodeKey: typeof source.opencodeKey === "string" ? source.opencodeKey.trim() : "",
  };
}

function providerKey(config, id) {
  if (!config) return "";
  return id === "glm" ? config.glmKey || "" : config.opencodeKey || "";
}

// 当前会话用哪个数据源：provider 名称/ID 优先，其次模型名；null = 会话信息未知
function detectProvider(selection) {
  if (!selection || typeof selection !== "object") return null;
  const provider = typeof selection.provider === "string" ? selection.provider.toLowerCase() : "";
  const model = typeof selection.model === "string" ? selection.model.toLowerCase() : "";
  if (!provider && !model) return null;
  if (provider.indexOf("opencode") >= 0) return "opencode";
  if (
    provider.indexOf("glm") >= 0 ||
    provider.indexOf("zhipu") >= 0 ||
    provider.indexOf("bigmodel") >= 0 ||
    provider.indexOf("智谱") >= 0 ||
    provider.indexOf("z.ai") >= 0
  ) {
    return "glm";
  }
  // provider 是 UUID / 不认识时看模型（用户渠道的模型字符串）
  if (model.indexOf("glm") >= 0) return "glm";
  if (model.indexOf("deepseek") >= 0 || model.indexOf("mimo") >= 0) return "opencode";
  return "other";
}

function configuredProviders(config) {
  const out = [];
  if (!config) return out;
  if (config.glmKey) out.push("glm");
  if (config.opencodeKey) out.push("opencode");
  return out;
}

function resolveActiveProvider(config, session) {
  if (!config) return "glm";
  if (config.source === "glm") return "glm";
  if (config.source === "opencode") return "opencode";
  const detected = detectProvider(session);
  const configured = configuredProviders(config);
  if (detected === "glm" || detected === "opencode") return detected;
  if (detected === "other") {
    if (configured.length === 1) return configured[0];
    return configured.length === 0 ? "glm" : null;
  }
  // 会话信息未知：显示已配置的源（GLM 优先）
  return configured.length ? configured[0] : "glm";
}

// ---- 展示格式化 ----

function trimNumber(n) {
  const rounded = Math.round(n * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function formatCompact(value) {
  const n = toFiniteNumber(value);
  if (n === null) return "?";
  if (Math.abs(n) >= 1e8) return trimNumber(n / 1e8) + "亿";
  if (Math.abs(n) >= 1e4) return trimNumber(n / 1e4) + "万";
  return String(Math.round(n));
}

function pad2(value) {
  return value < 10 ? "0" + value : String(value);
}

function formatClock(ts) {
  const n = toFiniteNumber(ts);
  if (n === null) return "";
  const d = new Date(n);
  if (Number.isNaN(d.getTime())) return "";
  return pad2(d.getHours()) + ":" + pad2(d.getMinutes());
}

function formatReset(ts) {
  const n = toFiniteNumber(ts);
  if (n === null || n <= 0) return null;
  const d = new Date(n);
  if (Number.isNaN(d.getTime())) return null;
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  const hm = pad2(d.getHours()) + ":" + pad2(d.getMinutes());
  if (sameDay) return hm;
  return pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()) + " " + hm;
}

function buildWindowTitle(win, meta) {
  const info = meta || {};
  const names = WINDOW_NAMES[info.providerId] || WINDOW_NAMES.glm;
  const prefix = info.providerName ? info.providerName + " · " : "";
  const lines = [prefix + names[win.kind]];
  lines.push("已用 " + Math.round(win.usedPercent) + "%（剩余 " + Math.round(win.remainingPercent) + "%）");
  if (win.currentValue !== null && win.usage !== null && win.usage > 0) {
    const unit = win.kind === "monthly" && info.providerId !== "opencode" ? " 次" : " tokens";
    lines.push("用量 " + formatCompact(win.currentValue) + " / " + formatCompact(win.usage) + unit);
  }
  const reset = formatReset(win.nextResetTime);
  if (reset) lines.push("重置于 " + reset);
  if (info.level) lines.push("套餐：" + info.level);
  if (info.model) lines.push("当前模型：" + info.model);
  if (info.fetchedAt) lines.push("更新于 " + formatClock(info.fetchedAt));
  if (info.error) lines.push("上次查询失败：" + info.error);
  if (info.stale) lines.push("数据已过期，正在重试");
  return lines.join("\n");
}

function toneFor(remaining) {
  if (remaining <= 10) return "danger";
  if (remaining <= 30) return "warning";
  return "success";
}

function errorText(err) {
  if (!err) return "未知错误";
  if (typeof err === "string") return err;
  if (err.message) return String(err.message);
  return String(err);
}

function createStore(initial) {
  const listeners = new Set();
  let state = initial;
  return {
    get: function () {
      return state;
    },
    set: function (patch) {
      state = Object.assign({}, state, patch);
      listeners.forEach(function (listener) {
        try {
          listener();
        } catch (_) {
          /* 单个订阅者异常不影响其它订阅者 */
        }
      });
    },
    subscribe: function (listener) {
      listeners.add(listener);
      return function () {
        listeners.delete(listener);
      };
    },
  };
}

function validQuota(quota) {
  return (
    quota &&
    typeof quota === "object" &&
    quota.ok === true &&
    quota.windows &&
    typeof quota.windows === "object" &&
    typeof quota.fetchedAt === "number"
  );
}

export default function activate(ctx) {
  const h = ctx.react.createElement;
  const useState = ctx.react.useState;
  const useEffect = ctx.react.useEffect;
  const useRef = ctx.react.useRef;

  const store = createStore({
    config: null,
    configLoaded: false,
    session: null,
    activeProvider: "glm",
    quotas: { glm: null, opencode: null },
    errors: { glm: null, opencode: null },
    lastSuccessAt: { glm: 0, opencode: 0 },
  });

  let config = normalizeConfig(null);
  let timer = null;
  let refCount = 0;

  // 每个数据源独立的请求串行链 / 退避状态
  const runtime = {
    glm: { chain: Promise.resolve(), nextAllowedAt: 0, lastAttemptAt: 0 },
    opencode: { chain: Promise.resolve(), nextAllowedAt: 0, lastAttemptAt: 0 },
  };

  // ---- 数据拉取 ----

  async function fetchProvider(id, activeConfig) {
    if (id === "glm") {
      const region = REGIONS[activeConfig.glmRegion] || REGIONS.cn;
      const res = await ctx.bridge.invoke("plugin_http_request", {
        method: "GET",
        url: region.origin + region.path,
        headers: {
          Authorization: "Bearer " + activeConfig.glmKey,
          Accept: "application/json",
        },
      });
      return parseGlmHttpResult(res);
    }
    const res = await ctx.bridge.invoke("plugin_http_request", {
      method: "GET",
      url: OPENCODE_USAGE_URL,
      headers: {
        Authorization: "Bearer " + activeConfig.opencodeKey,
        Accept: "application/json",
        "User-Agent": BROWSER_UA,
      },
    });
    return parseOpenCodeHttpResult(res);
  }

  async function doFetchProvider(id) {
    const key = providerKey(config, id);
    if (!key) return;
    const state = runtime[id];
    state.lastAttemptAt = Date.now();
    let result;
    try {
      result = await fetchProvider(id, config);
    } catch (err) {
      result = { ok: false, kind: "network", error: errorText(err) };
    }
    const snap = store.get();
    if (result.ok) {
      const quota = { ok: true, level: result.level, windows: result.windows, fetchedAt: Date.now() };
      state.nextAllowedAt = 0;
      const quotas = Object.assign({}, snap.quotas);
      quotas[id] = quota;
      const errors = Object.assign({}, snap.errors);
      errors[id] = null;
      const lastSuccessAt = Object.assign({}, snap.lastSuccessAt);
      lastSuccessAt[id] = quota.fetchedAt;
      store.set({ quotas: quotas, errors: errors, lastSuccessAt: lastSuccessAt });
      try {
        await ctx.storage.set(STORAGE_CACHE, {
          version: 2,
          glm: quotas.glm,
          opencode: quotas.opencode,
        });
      } catch (_) {
        /* 缓存写失败不影响展示 */
      }
    } else {
      const kind = result.kind || "api";
      state.nextAllowedAt = Date.now() + (kind === "rateLimited" || kind === "auth" ? BACKOFF_MS : MIN_FETCH_GAP_MS);
      const errors = Object.assign({}, snap.errors);
      errors[id] = { kind: kind, message: String(result.error || "查询失败") };
      store.set({ errors: errors });
    }
  }

  // 同一数据源的请求串行执行；manual 跳过退避与最小间隔
  function refreshProvider(id, manual) {
    const state = runtime[id];
    if (!providerKey(config, id)) return Promise.resolve();
    const run = state.chain.then(function () {
      if (!providerKey(config, id)) return;
      if (!manual) {
        const now = Date.now();
        if (now < state.nextAllowedAt) return;
        if (state.lastAttemptAt && now - state.lastAttemptAt < MIN_FETCH_GAP_MS) return;
      }
      return doFetchProvider(id);
    });
    state.chain = run.catch(function () {
      /* 链上错误不影响后续请求 */
    });
    return run;
  }

  function activeProviderNow() {
    return store.get().activeProvider;
  }

  function refreshActive(manual) {
    const active = activeProviderNow();
    return active ? refreshProvider(active, manual) : Promise.resolve();
  }

  function scheduleNext(delay) {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (refCount <= 0) return;
    timer = setTimeout(function () {
      timer = null;
      if (refCount <= 0) return;
      void refreshActive(false).finally(function () {
        scheduleNext(POLL_INTERVAL_MS);
      });
    }, Math.max(1000, delay));
  }

  function acquire() {
    refCount += 1;
    if (refCount !== 1) return;
    void ready.then(function () {
      if (refCount <= 0) return;
      void refreshActive(false).finally(function () {
        scheduleNext(POLL_INTERVAL_MS);
      });
    });
  }

  function release() {
    refCount = Math.max(0, refCount - 1);
    if (refCount === 0 && timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  // ---- 配置与缓存加载 ----

  const ready = (async function () {
    let saved = null;
    try {
      saved = await ctx.storage.get(STORAGE_CONFIG);
    } catch (_) {
      saved = null;
    }
    if (saved && typeof saved === "object") config = normalizeConfig(saved);
    let cached = null;
    try {
      cached = await ctx.storage.get(STORAGE_CACHE);
    } catch (_) {
      cached = null;
    }
    const quotas = { glm: null, opencode: null };
    if (cached && typeof cached === "object") {
      if (cached.version === 2) {
        quotas.glm = validQuota(cached.glm) ? cached.glm : null;
        quotas.opencode = validQuota(cached.opencode) ? cached.opencode : null;
      } else if (validQuota(cached)) {
        quotas.glm = cached; // v1 缓存（只有 GLM）
      }
    }
    store.set({
      config: config,
      configLoaded: true,
      quotas: quotas,
      lastSuccessAt: {
        glm: quotas.glm ? quotas.glm.fetchedAt : 0,
        opencode: quotas.opencode ? quotas.opencode.fetchedAt : 0,
      },
      activeProvider: resolveActiveProvider(config, store.get().session),
    });
  })();

  // ---- 会话选择事件（保留话题，订阅即回放当前会话） ----

  function syncActive(triggerRefresh) {
    const next = resolveActiveProvider(config, store.get().session);
    const previous = store.get().activeProvider;
    store.set({ activeProvider: next });
    if (triggerRefresh && refCount > 0 && next && next !== previous) {
      void refreshProvider(next, false).finally(function () {
        scheduleNext(POLL_INTERVAL_MS);
      });
    }
  }

  function onSession(payload) {
    if (!payload || typeof payload !== "object") return;
    store.set({
      session: {
        engine: typeof payload.engine === "string" ? payload.engine : null,
        provider: typeof payload.provider === "string" ? payload.provider : null,
        model: typeof payload.model === "string" ? payload.model : null,
      },
    });
    syncActive(true);
  }

  const offActivated = ctx.events.on("session://activated", onSession);
  const offChanged = ctx.events.on("session://selection-changed", onSession);

  function onVisibility() {
    if (typeof document === "undefined" || document.visibilityState !== "visible") return;
    if (refCount <= 0) return;
    const active = activeProviderNow();
    if (!active || !providerKey(config, active)) return;
    if (Date.now() - (store.get().lastSuccessAt[active] || 0) < POLL_INTERVAL_MS) return;
    void refreshProvider(active, false).finally(function () {
      scheduleNext(POLL_INTERVAL_MS);
    });
  }

  if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
    document.addEventListener("visibilitychange", onVisibility);
  }

  // ---- 样式 ----

  const chipRowStyle = { display: "inline-flex", alignItems: "center", gap: 6, minWidth: 0 };

  function Chip(props) {
    const tone = props.tone || "muted";
    const color =
      tone === "success"
        ? "var(--color-notification-success-foreground)"
        : tone === "warning"
          ? "var(--color-text-warning-primary)"
          : tone === "danger"
            ? "var(--color-text-error-primary)"
            : "var(--color-text-tertiary)";
    return h(
      "button",
      {
        type: "button",
        title: props.title || undefined,
        onClick: props.onClick,
        onMouseDown: function (event) {
          event.preventDefault();
        },
        style: {
          display: "inline-flex",
          alignItems: "center",
          gap: 5,
          height: 20,
          padding: "0 8px",
          borderRadius: 999,
          border: "1px solid var(--color-border-button-default)",
          background: "var(--color-background-secondary-default)",
          color: "var(--color-text-secondary)",
          fontFamily: "inherit",
          fontSize: 11,
          fontWeight: 500,
          lineHeight: 1,
          cursor: props.onClick ? "pointer" : "default",
          opacity: props.muted ? 0.55 : 1,
          whiteSpace: "nowrap",
          userSelect: "none",
        },
      },
      h("span", { style: { color: "var(--color-text-tertiary)", fontWeight: 400 } }, props.label),
      props.value ? h("span", { style: { color: color, fontVariantNumeric: "tabular-nums" } }, props.value) : null
    );
  }

  // ---- 输入框状态栏胶囊（分支切换器之后） ----

  function QuotaChips() {
    const initial = store.get();
    const [snap, setSnap] = useState(initial);
    useEffect(function () {
      const off = store.subscribe(function () {
        setSnap(store.get());
      });
      acquire();
      return function () {
        off();
        release();
      };
    }, []);

    if (!snap.configLoaded || !snap.config) return null;
    const active = snap.activeProvider;
    if (!active) return null;
    const cfg = snap.config;
    const meta = PROVIDERS[active];
    const key = providerKey(cfg, active);
    const quota = snap.quotas[active];
    const error = snap.errors[active];

    function openSettings() {
      try {
        ctx.ui.openSettings();
      } catch (_) {
        /* 忽略：设置页入口不可用时不影响展示 */
      }
    }

    if (!key) {
      return h(
        "div",
        { style: chipRowStyle },
        h(Chip, {
          label: meta.label,
          value: "未配置",
          tone: "muted",
          title: "点击配置" + meta.fullName + "的 API Key",
          onClick: openSettings,
        })
      );
    }

    if (!quota) {
      const short = error ? ERROR_SHORT[error.kind] || "查询失败" : "查询中…";
      const tone = !error ? "muted" : error.kind === "network" || error.kind === "rateLimited" ? "warning" : "danger";
      const title = error
        ? meta.fullName + " 额度查询失败：" + error.message + "\n点击打开插件设置"
        : "正在查询 " + meta.fullName + " 额度";
      return h("div", { style: chipRowStyle }, h(Chip, { label: meta.label, value: short, tone: tone, title: title, onClick: openSettings }));
    }

    const stale = Date.now() - (quota.fetchedAt || 0) > STALE_AFTER_MS;
    const titleMeta = {
      providerId: active,
      providerName: meta.fullName,
      level: quota.level,
      model: snap.session && snap.session.model ? snap.session.model : null,
      fetchedAt: quota.fetchedAt,
      error: error ? error.message : null,
      stale: stale,
    };

    const chips = [
      h(Chip, {
        key: "tag",
        label: meta.label,
        tone: "muted",
        title:
          "数据源：" + meta.fullName + (cfg.source === "auto" ? "（自动跟随当前会话）" : "（固定）") + "\n点击打开插件设置",
        onClick: openSettings,
      }),
    ];
    WINDOW_ORDER.forEach(function (kind) {
      const win = quota.windows && quota.windows[kind];
      if (!win) return;
      chips.push(
        h(Chip, {
          key: kind,
          label: WINDOW_LABELS[kind],
          value: Math.round(win.usedPercent) + "%",
          tone: toneFor(win.remainingPercent),
          title: buildWindowTitle(win, titleMeta),
          muted: stale || !!error,
          onClick: openSettings,
        })
      );
    });
    return h("div", { style: chipRowStyle }, chips);
  }

  // ---- 插件设置页 ----

  const formRowStyle = { marginBottom: 14 };
  const labelStyle = {
    display: "block",
    fontSize: 12,
    fontWeight: 600,
    color: "var(--color-text-secondary)",
    marginBottom: 6,
  };
  const hintStyle = { fontSize: 11, color: "var(--color-text-tertiary)", marginTop: 4, lineHeight: 1.5 };
  const inputStyle = {
    width: "100%",
    boxSizing: "border-box",
    height: 32,
    padding: "0 10px",
    borderRadius: 8,
    border: "1px solid var(--color-border-button-default)",
    background: "var(--color-background-primary-default)",
    color: "var(--color-text-primary)",
    fontSize: 13,
    outline: "none",
  };
  const primaryButtonStyle = {
    height: 30,
    padding: "0 14px",
    borderRadius: 8,
    border: "none",
    background: "var(--gradient-button-primary-default)",
    color: "#fff",
    fontSize: 12,
    fontWeight: 600,
    cursor: "pointer",
  };
  const secondaryButtonStyle = {
    height: 30,
    padding: "0 12px",
    borderRadius: 8,
    border: "1px solid var(--color-border-button-default)",
    background: "var(--color-background-secondary-default)",
    color: "var(--color-text-primary)",
    fontSize: 12,
    cursor: "pointer",
  };
  const sectionStyle = {
    marginBottom: 16,
    padding: "12px 14px",
    border: "1px solid var(--color-border-button-default)",
    borderRadius: 10,
    background: "var(--color-background-secondary-default)",
  };
  const sectionTitleStyle = {
    fontSize: 13,
    fontWeight: 600,
    color: "var(--color-text-primary)",
    marginBottom: 10,
  };

  function SettingsPanel() {
    const initial = store.get();
    const [snap, setSnap] = useState(initial);
    const [source, setSource] = useState("auto");
    const [glmKey, setGlmKey] = useState("");
    const [glmRegion, setGlmRegion] = useState("cn");
    const [opencodeKey, setOpencodeKey] = useState("");
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState(null);
    const initialized = useRef(false);

    useEffect(function () {
      const off = store.subscribe(function () {
        setSnap(store.get());
      });
      return off;
    }, []);

    useEffect(
      function () {
        if (!snap.configLoaded || initialized.current) return;
        initialized.current = true;
        const cfg = snap.config || config;
        setSource(cfg.source);
        setGlmKey(cfg.glmKey);
        setGlmRegion(cfg.glmRegion);
        setOpencodeKey(cfg.opencodeKey);
      },
      [snap.configLoaded]
    );

    async function handleSave() {
      const next = normalizeConfig({
        source: source,
        glmKey: glmKey,
        glmRegion: glmRegion,
        opencodeKey: opencodeKey,
      });
      setBusy(true);
      setMessage({ tone: "muted", text: "保存并验证中…" });
      try {
        await ctx.storage.set(STORAGE_CONFIG, next);
        config = next;
        PROVIDER_IDS.forEach(function (id) {
          runtime[id].nextAllowedAt = 0;
          runtime[id].lastAttemptAt = 0;
        });
        store.set({ config: next });
        syncActive(false);
        const targets = PROVIDER_IDS.filter(function (id) {
          return providerKey(next, id);
        });
        if (!targets.length) {
          setMessage({ tone: "danger", text: "已保存，但两个数据源都还没有 Key" });
          return;
        }
        await Promise.all(
          targets.map(function (id) {
            return refreshProvider(id, true);
          })
        );
        const after = store.get();
        const failed = targets.filter(function (id) {
          return after.errors[id];
        });
        if (failed.length) {
          setMessage({
            tone: "danger",
            text:
              "已保存，但 " +
              failed
                .map(function (id) {
                  return PROVIDERS[id].label + " 查询失败：" + after.errors[id].message;
                })
                .join("；"),
          });
        } else {
          setMessage({
            tone: "success",
            text:
              "已保存，" +
              targets
                .map(function (id) {
                  return PROVIDERS[id].label;
                })
                .join(" / ") +
              " 额度查询成功",
          });
        }
      } catch (err) {
        setMessage({ tone: "danger", text: "保存失败：" + errorText(err) });
      } finally {
        setBusy(false);
      }
    }

    async function handleRefresh() {
      setBusy(true);
      setMessage({ tone: "muted", text: "刷新中…" });
      const targets = PROVIDER_IDS.filter(function (id) {
        return providerKey(config, id);
      });
      await Promise.all(
        targets.map(function (id) {
          return refreshProvider(id, true);
        })
      );
      const after = store.get();
      const failed = targets.filter(function (id) {
        return after.errors[id];
      });
      if (!targets.length) {
        setMessage({ tone: "danger", text: "还没有配置任何 Key" });
      } else if (failed.length) {
        setMessage({
          tone: "danger",
          text:
            "刷新失败：" +
            failed
              .map(function (id) {
                return PROVIDERS[id].label + " " + after.errors[id].message;
              })
              .join("；"),
        });
      } else {
        setMessage({ tone: "success", text: "已刷新" });
      }
      setBusy(false);
    }

    async function handleClear() {
      const next = normalizeConfig({ source: "auto", glmKey: "", glmRegion: glmRegion, opencodeKey: "" });
      try {
        await ctx.storage.set(STORAGE_CONFIG, next);
        try {
          await ctx.storage.delete(STORAGE_CACHE);
        } catch (_) {
          /* 缓存清理失败可忽略 */
        }
      } catch (_) {
        /* 配置写失败时也把内存态清掉 */
      }
      config = next;
      PROVIDER_IDS.forEach(function (id) {
        runtime[id].nextAllowedAt = 0;
        runtime[id].lastAttemptAt = 0;
      });
      store.set({
        config: next,
        quotas: { glm: null, opencode: null },
        errors: { glm: null, opencode: null },
        lastSuccessAt: { glm: 0, opencode: 0 },
        activeProvider: resolveActiveProvider(next, store.get().session),
      });
      setSource("auto");
      setGlmKey("");
      setOpencodeKey("");
      setMessage({ tone: "muted", text: "已清除全部 Key" });
    }

    function providerStatusRows(id) {
      const meta = PROVIDERS[id];
      const hasKey = !!providerKey(snap.config || config, id);
      const quota = snap.quotas[id];
      const error = snap.errors[id];
      const rows = [];
      if (!hasKey) {
        rows.push(
          h("div", { key: "nokey", style: { fontSize: 12, color: "var(--color-text-tertiary)" } }, meta.label + "：未配置 Key")
        );
      } else if (quota) {
        const windows = quota.windows || {};
        const items = WINDOW_ORDER.filter(function (kind) {
          return windows[kind];
        }).map(function (kind) {
          return WINDOW_LABELS[kind] + " 已用 " + Math.round(windows[kind].usedPercent) + "%";
        });
        rows.push(
          h(
            "div",
            { key: "quota", style: { fontSize: 12, color: "var(--color-text-secondary)" } },
            meta.label + "：" + (items.length ? items.join(" · ") : "无数据")
          )
        );
        rows.push(
          h(
            "div",
            { key: "time", style: { fontSize: 12, color: "var(--color-text-tertiary)" } },
            "更新于 " +
              formatClock(quota.fetchedAt) +
              (quota.level ? " · 套餐 " + quota.level : "") +
              (error ? " · 最近错误：" + error.message : "")
          )
        );
      } else if (error) {
        rows.push(
          h("div", { key: "err", style: { fontSize: 12, color: "var(--color-text-error-primary)" } }, meta.label + "：" + error.message)
        );
      } else {
        rows.push(
          h("div", { key: "wait", style: { fontSize: 12, color: "var(--color-text-tertiary)" } }, meta.label + "：等待查询…")
        );
      }
      return rows;
    }

    const sessionText =
      snap.session && (snap.session.provider || snap.session.model)
        ? [snap.session.provider, snap.session.model].filter(Boolean).join(" / ")
        : "";

    return h(
      "div",
      { style: { padding: "16px 18px", maxWidth: 620, display: "flex", flexDirection: "column" } },
      h(
        "div",
        { style: { fontSize: 15, fontWeight: 700, color: "var(--color-text-primary)", marginBottom: 4 } },
        "模型额度胶囊"
      ),
      h(
        "div",
        { style: { fontSize: 12, color: "var(--color-text-tertiary)", marginBottom: 16, lineHeight: 1.6 } },
        "在输入框状态栏（分支切换器之后）显示当前会话所用渠道的 5 小时 / 周 / 月额度：胶囊显示已用百分比，悬浮查看剩余、用量与重置时间。支持智谱 GLM Coding Plan 和 OpenCode Go（账号级用量，Zen / Go 共用）。Key 只保存在本机插件存储，仅用于查询对应官方额度接口。"
      ),
      h(
        "div",
        { style: formRowStyle },
        h("label", { style: labelStyle }, "数据源"),
        h(
          "select",
          {
            value: source,
            onChange: function (event) {
              setSource(event.target.value);
            },
            style: inputStyle,
          },
          h("option", { value: "auto" }, "自动（跟随当前会话模型）"),
          h("option", { value: "glm" }, "固定：智谱 GLM Coding Plan"),
          h("option", { value: "opencode" }, "固定：OpenCode Go")
        ),
        h("div", { style: hintStyle }, "自动模式按当前会话的 provider / 模型名切换；识别不出时显示已配置的源，两个都配置则不显示。")
      ),
      h(
        "div",
        { style: sectionStyle },
        h("div", { style: sectionTitleStyle }, "智谱 GLM Coding Plan"),
        h(
          "div",
          { style: formRowStyle },
          h("label", { style: labelStyle }, "API Key"),
          h("input", {
            type: "password",
            value: glmKey,
            placeholder: "bigmodel.cn / z.ai 的 API Key",
            spellCheck: false,
            autoComplete: "off",
            onChange: function (event) {
              setGlmKey(event.target.value);
            },
            style: inputStyle,
          })
        ),
        h(
          "div",
          { style: formRowStyle },
          h("label", { style: labelStyle }, "区域"),
          h(
            "select",
            {
              value: glmRegion,
              onChange: function (event) {
                setGlmRegion(event.target.value);
              },
              style: inputStyle,
            },
            h("option", { value: "cn" }, REGIONS.cn.label),
            h("option", { value: "intl" }, REGIONS.intl.label)
          )
        ),
        h("div", { style: { display: "flex", flexDirection: "column", gap: 4 } }, providerStatusRows("glm"))
      ),
      h(
        "div",
        { style: sectionStyle },
        h("div", { style: sectionTitleStyle }, "OpenCode Go"),
        h(
          "div",
          { style: formRowStyle },
          h("label", { style: labelStyle }, "API Key"),
          h("input", {
            type: "password",
            value: opencodeKey,
            placeholder: "opencode.ai 的 API Key",
            spellCheck: false,
            autoComplete: "off",
            onChange: function (event) {
              setOpencodeKey(event.target.value);
            },
            style: inputStyle,
          }),
          h("div", { style: hintStyle }, "与桌面端「OpenCode Go」渠道里配置的 Key 相同；用量接口是账号级，Zen / Go 共用同一份额度。")
        ),
        h("div", { style: { display: "flex", flexDirection: "column", gap: 4 } }, providerStatusRows("opencode"))
      ),
      h(
        "div",
        { style: { display: "flex", gap: 8, flexWrap: "wrap", marginTop: 2 } },
        h("button", { type: "button", onClick: handleSave, disabled: busy, style: primaryButtonStyle }, "保存并测试"),
        h("button", { type: "button", onClick: handleRefresh, disabled: busy, style: secondaryButtonStyle }, "立即刷新"),
        h("button", { type: "button", onClick: handleClear, disabled: busy, style: secondaryButtonStyle }, "清除全部 Key")
      ),
      message
        ? h(
            "div",
            {
              style: {
                marginTop: 12,
                fontSize: 12,
                color:
                  message.tone === "danger"
                    ? "var(--color-text-error-primary)"
                    : message.tone === "success"
                      ? "var(--color-notification-success-foreground)"
                      : "var(--color-text-secondary)",
              },
            },
            message.text
          )
        : null,
      sessionText
        ? h(
            "div",
            { style: { marginTop: 14, fontSize: 12, color: "var(--color-text-tertiary)" } },
            "当前会话：" + sessionText
          )
        : null
    );
  }

  // ---- 注册 ----

  const disposeChips = ctx.ui.registerComposerStatusItem({ key: "model-quota", component: QuotaChips, order: 10 });
  const disposeSettings = ctx.ui.registerSettingsSection({
    key: "main",
    label: () => "模型额度胶囊",
    component: SettingsPanel,
  });

  return function dispose() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (typeof document !== "undefined" && typeof document.removeEventListener === "function") {
      document.removeEventListener("visibilitychange", onVisibility);
    }
    offActivated();
    offChanged();
    disposeChips();
    disposeSettings();
  };
}

export {
  classifyLimit,
  parseQuotaResponse,
  parseGlmHttpResult,
  parseOpenCodeResponse,
  parseOpenCodeHttpResult,
  clampPercent,
  detectProvider,
  resolveActiveProvider,
  providerKey,
  normalizeConfig,
  formatCompact,
  formatReset,
  formatClock,
  buildWindowTitle,
  toneFor,
};
