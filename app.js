/* ==========================================================================
   头像直传 - 前端逻辑
   纯静态：无框架、无构建、无第三方依赖。所有请求由浏览器直接发往社区接口。
   ========================================================================== */
'use strict';

/* ----------------------------- 常量与工具 ------------------------------- */

const DEFAULT_ORIGIN = '';
const DEFAULT_API_ORIGIN = 'https://cdsq.dao3.fun';
const API_PREFIX = '/api/v1';
const CONFIG_KEY = 'pickcat-avatar-tool/config';
const CRED_KEY = 'pickcat-avatar-tool/credentials';
const THEME_KEY = 'pickcat-avatar-tool/theme';
const MAX_FILE_BYTES = 9 * 1024 * 1024;      // 服务端上限 10MiB，留出余量
const IDEM_KEY_RE = /^[\x21-\x7e]{1,128}$/;  // 服务端要求可见 ASCII，1-128 字符

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fmtBytes(n) {
  if (!Number.isFinite(n)) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function fmtTime(d = new Date()) {
  return d.toLocaleTimeString('zh-CN', { hour12: false });
}

function fmtDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString('zh-CN', { hour12: false });
}

function relTime(iso) {
  if (!iso) return '';
  const ms = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(ms)) return '';
  if (ms <= 0) return '已可再次更换';
  const mins = Math.ceil(ms / 60000);
  if (mins < 60) return `约 ${mins} 分钟后`;
  return `约 ${Math.ceil(mins / 60)} 小时后`;
}

function newIdempotencyKey() {
  if (window.crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  (window.crypto || { getRandomValues: (a) => a.forEach((_, i) => (a[i] = Math.floor(Math.random() * 256))) })
    .getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** 非 ASCII / 特殊字符的安全文件名（服务端只关心 RIFF 内容，这里只求稳妥） */
function safeFileName(name, fallback = 'avatar') {
  const base = String(name || '')
    .replace(/\.[^.]+$/, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return `${base || fallback}.webp`;
}

/* ------------------------------- 日志 ---------------------------------- */

const logList = $('#log');

function log(kind, message, detail) {
  const li = document.createElement('li');
  li.dataset.kind = kind;
  const time = document.createElement('time');
  time.textContent = fmtTime();
  const msg = document.createElement('div');
  msg.className = 'msg';
  const tag = document.createElement('span');
  tag.className = 'tag';
  tag.textContent = { ok: 'OK', err: 'ERR', api: 'API', info: 'INFO' }[kind] || kind.toUpperCase();
  msg.append(tag, document.createTextNode(message));
  if (detail) {
    const small = document.createElement('div');
    small.style.color = 'var(--md-sys-color-on-surface-variant)';
    small.style.marginTop = '2px';
    small.textContent = detail;
    msg.append(small);
  }
  li.append(time, msg);
  logList.prepend(li);
  while (logList.children.length > 120) logList.lastElementChild.remove();
}

$('#btn-clear-log').addEventListener('click', () => {
  logList.innerHTML = '';
  log('info', '日志已清空');
});

/* ------------------------------ Snackbar ------------------------------- */

const snackbarHost = document.createElement('div');
snackbarHost.className = 'm3-snackbar-host';
document.body.append(snackbarHost);

function toast(message, isError = false, ms = 4200) {
  const el = document.createElement('div');
  el.className = `m3-snackbar${isError ? ' m3-snackbar--err' : ''}`;
  el.textContent = message;
  snackbarHost.append(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity .2s';
    setTimeout(() => el.remove(), 220);
  }, ms);
}

/* ------------------------------- 主题 ---------------------------------- */

function applyTheme(theme) {
  const t = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.classList.toggle('dark', t === 'dark');
  document.documentElement.classList.toggle('light', t === 'light');
  localStorage.setItem(THEME_KEY, t);
}

applyTheme(localStorage.getItem(THEME_KEY)
  || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));

$('#btn-theme').addEventListener('click', () => {
  applyTheme(document.documentElement.classList.contains('dark') ? 'light' : 'dark');
});

/* ------------------------------ 配置项 --------------------------------- */

const cfg = {
  origin: DEFAULT_ORIGIN,
  proxy: '',
  quality: 0.92,
  touched: false,   // 用户是否已手动修改过接口设置
};

function loadConfig() {
  try {
    const saved = JSON.parse(localStorage.getItem(CONFIG_KEY) || '{}');
    if (typeof saved.origin === 'string') cfg.origin = saved.origin.trim();
    if (typeof saved.proxy === 'string') cfg.proxy = saved.proxy.trim();
    if (Number.isFinite(saved.quality)) cfg.quality = Math.min(1, Math.max(0.4, saved.quality));
    cfg.touched = Boolean(saved.touched);
  } catch { /* 忽略损坏的配置 */ }
}

function saveConfig() {
  localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg));
}

/** 接口所在 Origin（去尾部斜杠）。未填写时回落到当前站点 */
function apiOrigin() {
  return (cfg.origin || window.location.origin).replace(/\/+$/, '');
}

/** 页面与接口是否同源 */
function isSameOrigin() {
  try {
    return new URL(apiOrigin()).origin === window.location.origin;
  } catch {
    return false;
  }
}

/** 目标绝对地址（含可选代理前缀） */
function toFetchUrl(path, { origin = apiOrigin(), proxy = cfg.proxy } = {}) {
  const absolute = /^https?:\/\//i.test(path) ? path : `${origin.replace(/\/+$/, '')}${path}`;
  const p = String(proxy || '').trim().replace(/\/+$/, '');
  if (!p) return absolute;
  return p.includes('{url}')
    ? p.replace('{url}', encodeURIComponent(absolute))
    : `${p}${absolute}`;
}

function absoluteUrl(path, origin = apiOrigin()) {
  if (!path) return '';
  return /^https?:\/\//i.test(path) ? path : `${origin.replace(/\/+$/, '')}${path}`;
}

/* ------------------------------ 接口层 --------------------------------- */

class ApiError extends Error {
  constructor(status, payload, op) {
    super(`${op} 失败（HTTP ${status}）`);
    this.name = 'ApiError';
    this.status = status;
    this.payload = payload || {};
    this.op = op;
  }
  get code() { return this.payload.code || this.payload.statusCode || ''; }
  get details() { return this.payload.details || null; }
}

const NETWORK_HINT =
  '请求未到达服务端。常见原因为页面与接口不同源而被浏览器 CORS 拦截、网络不可用或代理不可用。' +
  '可在右上角设置中填写接口地址或 CORS 代理。';

async function request(op, path, { method = 'GET', json, form, headers = {}, timeout = 30000 } = {}) {
  const url = toFetchUrl(path);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  const init = {
    method,
    credentials: 'include',
    cache: 'no-store',
    redirect: 'follow',
    signal: ctrl.signal,
    headers: { accept: 'application/json', ...headers },
  };
  if (json !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(json);
  } else if (form) {
    init.body = form; // 交给浏览器设置 multipart 边界
  }

  let res;
  try {
    res = await fetch(url, init);
  } catch (err) {
    clearTimeout(timer);
    const e = new ApiError(0, { code: 'NETWORK_ERROR', message: err && err.message }, op);
    e.network = true;
    log('err', `${op}：网络层失败`, String(err && err.message));
    throw e;
  }
  clearTimeout(timer);

  const text = await res.text();
  let payload = null;
  if (text) {
    try { payload = JSON.parse(text); } catch { payload = { raw: text.slice(0, 400) }; }
  }

  log(
    res.ok ? 'api' : 'err',
    `${method} ${path} -> ${res.status}`,
    res.ok ? '' : (payload && (payload.code || payload.message)) || '',
  );

  if (!res.ok) throw new ApiError(res.status, payload, op);
  return payload;
}

/** 服务端错误码到中文提示的映射 */
function describeError(err) {
  if (!(err instanceof ApiError)) return String((err && err.message) || err);
  if (err.network) return NETWORK_HINT;

  const code = err.code;
  const map = {
    UNAUTHENTICATED: '未登录或会话已过期，请重新登录。',
    AUTHENTICATION_REQUIRED: '该接口需要登录。',
    VALIDATION_FAILED: '请求参数不合法（服务端校验失败）。',
    IDEMPOTENCY_KEY_REUSED: '上传身份与图片不一致，请重试。',
    FILE_TOO_LARGE: '文件超过服务端大小限制（10 MiB）。',
    FILE_IMAGE_INVALID: '图片不符合要求，必须是容器干净的静态 WebP。',
    METADATA_PRESENT: '图片包含元数据块（EXIF、XMP、ICC），需重新导出为容器干净的静态 WebP。',
    UNSUPPORTED_MEDIA_TYPE: '上传内容类型不被接受，必须是静态 WebP。',
    FILE_PERSONAL_UPLOAD_NOT_ALLOWED: '当前账号等级尚未开放个人图片上传。',
    PERSONAL_UPLOAD_NOT_ALLOWED: '当前账号等级尚未开放个人图片上传。',
    FILE_STORAGE_QUOTA_EXCEEDED: '图盘容量不足，请先清理旧图片。',
    FILE_UPLOAD_BUSY: '图片上传正在处理中，请稍后重试。',
    FILE_UPLOAD_IN_PROGRESS: '图片上传正在处理中，请稍后重试。',
    FILE_UPLOAD_RESULT_UNAVAILABLE: '暂时无法确认上传结果，请重试原上传。',
    IMAGE_MODERATION_REJECTED: '图片未通过内容审核，请更换图片。',
    IMAGE_MODERATION_UNAVAILABLE: '图片审核服务暂不可用，请稍后重试。',
    FILE_STORAGE_UNAVAILABLE: '图片存储服务暂不可用，请稍后重试。',
    CUSTOM_AVATAR_NOT_AVAILABLE: '当前账号没有可恢复的自定义头像，请先用 DERIVE 派生一张。',
    FORBIDDEN: '当前账号无权执行该操作。',
    PERMISSION_DENIED: '权限不足。',
    ROUTE_NOT_FOUND: '接口路径不存在，请检查「接口地址」设置。',
  };

  let msg = map[code] || err.payload.message || err.message;

  if (code === 'VALIDATION_FAILED' && err.details && typeof err.details === 'object') {
    const parts = [];
    for (const [field, list] of Object.entries(err.details)) {
      if (Array.isArray(list) && list.length) parts.push(`${field}: ${list.join('；')}`);
      else if (typeof list === 'string') parts.push(`${field}: ${list}`);
    }
    if (parts.length) msg += `（${parts.join(' / ')}）`;
  }
  if (code === 'FILE_IMAGE_INVALID' && err.details && err.details.reason) {
    const reason = err.details.reason;
    const tips = {
      METADATA_PRESENT: '（图片包含 EXIF、XMP、ICC 元数据块，服务端仅接受容器干净的 WebP）',
      NOT_WEBP: '（内容不是 WebP）',
      ANIMATED: '（动图不被接受）',
      TOO_LARGE: '（尺寸或体积超出限制）',
    };
    msg += tips[reason] || `（原因：${reason}）`;
  }
  if (err.status === 403 && !map[code]) {
    msg += ' —— 若页面与接口不同源，服务端可能直接拒绝该 Origin。';
  }
  return msg;
}

/* ------------------------------ 接口封装 ------------------------------- */

const api = {
  login: (username, password) =>
    request('登录', `${API_PREFIX}/session`, { method: 'POST', json: { username, password } }),

  session: () => request('读取会话', `${API_PREFIX}/session`),

  logout: () => request('退出登录', `${API_PREFIX}/session`, { method: 'DELETE' }),

  user: (userId) => request('读取用户', `${API_PREFIX}/users/${encodeURIComponent(userId)}`),

  avatar: (userId) => request('读取头像状态', `${API_PREFIX}/users/${encodeURIComponent(userId)}/avatar`),

  storage: () => request('读取图盘用量', `${API_PREFIX}/file-storage`),

  uploadFile: (blob, filename) => {
    const key = newIdempotencyKey();
    if (!IDEM_KEY_RE.test(key)) throw new Error('无法生成合法的 Idempotency-Key');
    const form = new FormData();
    form.append('ownership', 'PERSONAL');
    form.append('file', blob, filename);
    return request('上传图片', `${API_PREFIX}/files`, {
      method: 'POST',
      form,
      headers: { 'Idempotency-Key': key },
      timeout: 60000,
    });
  },

  deriveAvatar: (userId, sourceFileId, crop) =>
    request('派生头像', `${API_PREFIX}/users/${encodeURIComponent(userId)}/avatar`, {
      method: 'PUT',
      json: { type: 'DERIVE', sourceFileId, crop },
    }),
};

/* --------------------------- 图片：读取与转码 --------------------------- */

async function decodeImage(file) {
  if (window.createImageBitmap) {
    try {
      return await createImageBitmap(file);
    } catch { /* 回退到 <img> */ }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'sync';
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error('浏览器无法解码这张图片'));
      img.src = url;
    });
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function canvasToWebpBlob(canvas, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('WebP 编码失败：当前浏览器可能不支持 WebP 导出'))),
      'image/webp',
      quality,
    );
  });
}

/**
 * 清洗 WebP 容器：去掉 ICCP / EXIF / XMP / ANIM 等块，只保留图像数据。
 * 浏览器 canvas 导出的 WebP 常常带 ICCP 色彩配置块，而服务端只接受纯净 WebP，
 * 会以 422 FILE_IMAGE_INVALID（METADATA_PRESENT）拒绝，所以这里必须清一遍。
 * @returns {{blob: Blob, removed: string[], chunks: string[]}}
 */
async function sanitizeWebp(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  const u32 = (o) => buf[o] | (buf[o + 1] << 8) | (buf[o + 2] << 16) | (buf[o + 3] << 24);
  const tag = (o) => String.fromCharCode(buf[o], buf[o + 1], buf[o + 2], buf[o + 3]);
  if (buf.length < 20 || tag(0) !== 'RIFF' || tag(8) !== 'WEBP') {
    throw new Error(`转码结果不是 WebP（magic: ${tag(0)}/${tag(8)}）`);
  }

  const kept = [];
  const removed = [];
  let offset = 12;
  while (offset + 8 <= buf.length) {
    const name = tag(offset);
    const size = u32(offset + 4);
    if (size < 0 || offset + 8 + size > buf.length) break;
    const data = buf.subarray(offset + 8, offset + 8 + size);
    if (name === 'ICCP' || name === 'EXIF' || name === 'XMP ') removed.push(name.trim());
    else if (name === 'ANIM' || name === 'ANMF') removed.push(name);
    else kept.push({ name, data });
    offset += 8 + size + (size % 2);
  }
  if (!kept.length) throw new Error('WebP 容器里没有图像数据块');

  // 允许保留的块白名单（有 ALPH 时必须重建 VP8X 承载透明标记）
  const allowed = new Set(['ALPH', 'VP8 ', 'VP8L']);
  const simple = kept.filter((c) => allowed.has(c.name));
  const hasContainer = kept.some((c) => c.name === 'VP8X');
  const hasAlpha = simple.some((c) => c.name === 'ALPH');
  const parts = [];

  if (!hasContainer && simple.length && !(simple.length === 1 && simple[0].name === 'VP8 ')) {
    // 单块 VP8 无需 VP8X；其余情况（含 ALPH）需要 10 字节 VP8X
    const head = new Uint8Array(10);
    if (hasAlpha) head[0] = 0x10; // ALPHA_FLAG
    parts.push({ name: 'VP8X', data: head });
  }
  parts.push(...simple);

  const payload = 4 + parts.reduce((n, c) => n + 8 + c.data.length + (c.data.length % 2), 0);
  const out = new Uint8Array(8 + payload);
  const view = new DataView(out.buffer);
  out[0] = 0x52; out[1] = 0x49; out[2] = 0x46; out[3] = 0x46; // RIFF
  view.setUint32(4, payload, true);
  out[8] = 0x57; out[9] = 0x45; out[10] = 0x42; out[11] = 0x50; // WEBP
  let p = 12;
  for (const c of parts) {
    for (let i = 0; i < 4; i += 1) out[p + i] = c.name.charCodeAt(i);
    view.setUint32(p + 4, c.data.length, true);
    out.set(c.data, p + 8);
    p += 8 + c.data.length + (c.data.length % 2);
  }
  return {
    blob: new Blob([out], { type: 'image/webp' }),
    removed,
    chunks: parts.map((c) => c.name.trim()),
  };
}

/**
 * 把任意图片转成服务端要求的「静态 WebP」。
 * @returns {{blob: Blob, width: number, height: number, quality: number, removed: string[]}}
 */
async function toStaticWebp(file, { quality, square, maxEdge }) {
  const src = await decodeImage(file);
  const sw = src.width || src.naturalWidth;
  const sh = src.height || src.naturalHeight;
  if (!sw || !sh) throw new Error('无法读取图片尺寸');

  let targetW = sw;
  let targetH = sh;
  if (maxEdge) {
    const longest = Math.max(sw, sh);
    if (longest > maxEdge) {
      const k = maxEdge / longest;
      targetW = Math.round(sw * k);
      targetH = Math.round(sh * k);
    }
  }

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(targetW));
  canvas.height = Math.max(1, Math.round(targetH));
  const ctx = canvas.getContext('2d', { alpha: true });
  if (!ctx) throw new Error('无法创建 canvas 2D 上下文');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  // 居中裁成正方形：先按短边裁切，再绘制到方形画布
  if (square && sw !== sh) {
    const side = Math.min(sw, sh);
    const sx = (sw - side) / 2;
    const sy = (sh - side) / 2;
    canvas.width = canvas.height = Math.max(1, Math.round(Math.min(targetW, targetH)));
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, sx, sy, side, side, 0, 0, canvas.width, canvas.height);
  } else {
    ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
  }

  if (typeof src.close === 'function') src.close();

  let q = quality;
  let blob = await canvasToWebpBlob(canvas, q);
  while (blob.size > MAX_FILE_BYTES && q > 0.45) {
    q = Math.max(0.45, q - 0.12);
    blob = await canvasToWebpBlob(canvas, q);
  }
  if (blob.size > MAX_FILE_BYTES) {
    throw new Error(`转换后仍有 ${fmtBytes(blob.size)}，超过 ${fmtBytes(MAX_FILE_BYTES)} 上限`);
  }

  // 容器清洗：移除 ICCP / EXIF / XMP / ANIM 等块
  const clean = await sanitizeWebp(blob);
  const meta = await inspectWebp(clean.blob);
  return {
    blob: clean.blob,
    width: canvas.width,
    height: canvas.height,
    quality: q,
    removed: clean.removed,
    chunks: meta.chunks,
  };
}

/** 读取 RIFF 块清单，用于确认上传前的容器内容 */
async function inspectWebp(blob) {
  const buf = new Uint8Array(await blob.slice(0, 256).arrayBuffer());
  const tag = (o) => String.fromCharCode(buf[o], buf[o + 1], buf[o + 2], buf[o + 3]);
  if (tag(0) !== 'RIFF' || tag(8) !== 'WEBP') {
    throw new Error(`转码结果不是 WebP（magic: ${tag(0)}/${tag(8)}）`);
  }
  const chunks = new Set();
  let offset = 12;
  while (offset + 8 <= buf.length) {
    const name = tag(offset);
    const size = buf[offset + 4] | (buf[offset + 5] << 8) | (buf[offset + 6] << 16) | (buf[offset + 7] << 24);
    chunks.add(name);
    if (size <= 0) break;
    offset += 8 + size + (size % 2);
  }
  const meta = ['EXIF', 'XMP ', 'ICCP'].filter((c) => chunks.has(c));
  return {
    chunks: [...chunks],
    animated: chunks.has('ANIM') || chunks.has('ANMF'),
    metadata: meta,
  };
}

/* ------------------------------ UI 状态 -------------------------------- */

const ui = {
  session: null,     // { user, expiresAt }
  user: null,        // 最近一次读取到的用户对象
  file: null,        // 用户选择的原始文件
  converted: null,   // 转码结果 { blob, width, height, quality, name }
  busy: false,
};

function setBusy(btn, busy, labelWhenBusy) {
  const label = $('.m3-button__label', btn);
  const spinner = $('.m3-button__spinner', btn);
  if (busy) {
    btn.dataset.idleLabel = btn.dataset.idleLabel || (label ? label.textContent : '');
    if (label && labelWhenBusy) label.textContent = labelWhenBusy;
    if (spinner) spinner.hidden = false;
    btn.disabled = true;
  } else {
    if (label && btn.dataset.idleLabel) label.textContent = btn.dataset.idleLabel;
    if (spinner) spinner.hidden = true;
    btn.disabled = false;
  }
}

function setStep(n) {
  $$('#stepper li').forEach((li) => {
    const idx = Number(li.dataset.step);
    li.classList.toggle('is-active', idx === n);
    li.classList.toggle('is-done', idx < n);
  });
}

function showBanner(sel, html, tone = 'info') {
  const el = $(sel);
  el.className = `m3-banner m3-banner--${tone}`;
  $('.m3-banner__text', el).innerHTML = html;
  el.hidden = false;
}

function hideBanner(sel) { $(sel).hidden = true; }

function setProgress(pct, text) {
  $('#progress-wrap').hidden = false;
  $('#progress-bar').style.width = `${Math.max(0, Math.min(100, pct))}%`;
  if (text) $('#progress-text').textContent = text;
}

/* --------------------- 浮动标签（MD3 filled field） -------------------- */

function bindFloatingFields(root = document) {
  $$('.m3-field input', root).forEach((input) => {
    const field = input.closest('.m3-field');
    const sync = () => { field.dataset.filled = input.value ? 'true' : 'false'; };
    input.addEventListener('input', sync);
    input.addEventListener('change', sync);
    sync();
  });
}

/* ------------------------------ 设置抽屉 ------------------------------- */

function openSettings() {
  // 未手动配置过时，把默认值填进输入框，便于直接修改
  $('#cfg-api-origin').value = cfg.origin || (cfg.touched ? '' : DEFAULT_API_ORIGIN);
  $('#cfg-proxy').value = cfg.proxy;
  $('#cfg-quality').value = String(cfg.quality);
  $('#settings-scrim').hidden = false;
  $('#settings-drawer').hidden = false;
  renderOriginHint();
  $('#cfg-api-origin').focus();
}

function closeSettings() {
  cfg.origin = $('#cfg-api-origin').value.trim();
  cfg.proxy = $('#cfg-proxy').value.trim();
  const q = Number($('#cfg-quality').value);
  cfg.quality = Number.isFinite(q) ? Math.min(1, Math.max(0.4, q)) : cfg.quality;
  cfg.touched = true;
  saveConfig();
  $('#settings-scrim').hidden = true;
  $('#settings-drawer').hidden = true;
  renderOriginHint();
  log('info', '接口设置已保存', `origin=${cfg.origin || '(当前站点)'} proxy=${cfg.proxy || '(无)'} quality=${cfg.quality}`);
}

$('#btn-settings').addEventListener('click', openSettings);
$('#btn-close-settings').addEventListener('click', closeSettings);
$('#settings-scrim').addEventListener('click', closeSettings);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#settings-drawer').hidden) closeSettings();
});

function renderOriginHint() {
  const el = $('#origin-hint');
  if (cfg.proxy) {
    el.innerHTML = '<strong>代理模式</strong>：请求地址为代理前缀加目标地址。' +
      '代理需转发 Cookie，并在响应中返回 <code>Access-Control-Allow-Credentials: true</code>，否则登录态无法保持。';
  } else if (isSameOrigin()) {
    el.innerHTML = '<strong>同源模式</strong>：页面与接口同域，浏览器会正常携带会话 Cookie。' +
      '将本目录放在站点同域下，或用开发服务器把 <code>/api</code> 反向代理到站点，即可使用此模式。';
  } else {
    el.innerHTML = `<strong>跨域模式</strong>：请求直接发往 <code>${apiOrigin()}${API_PREFIX}</code>。` +
      '该接口的 CORS 白名单仅放行站点自身域名，跨域请求会返回 403，' +
      '且 <code>SameSite=Lax</code> 的会话 Cookie 在跨站场景下不会发送。' +
      '如需在 GitHub Pages 等静态托管上使用，请填写中转地址。';
  }
}

/* ------------------------------ 登录流程 ------------------------------- */

function loadCredentials() {
  try {
    const saved = JSON.parse(localStorage.getItem(CRED_KEY) || 'null');
    if (saved && saved.username) {
      $('#in-username').value = saved.username;
      $('#in-password').value = saved.password || '';
      $('#cfg-remember').checked = true;
    }
  } catch { /* 忽略 */ }
}

function persistCredentials() {
  if ($('#cfg-remember').checked) {
    localStorage.setItem(CRED_KEY, JSON.stringify({
      username: $('#in-username').value.trim(),
      password: $('#in-password').value,
    }));
  } else {
    localStorage.removeItem(CRED_KEY);
  }
}

async function login() {
  if (ui.busy) return;
  const username = $('#in-username').value.trim();
  const password = $('#in-password').value;
  if (!username || !password) {
    toast('请填写用户名与密码', true);
    showBanner('#session-banner', '请先填写用户名与密码。', 'error');
    return;
  }

  ui.busy = true;
  const btn = $('#btn-login');
  setBusy(btn, true, '登录中…');
  hideBanner('#session-banner');
  hideBanner('#error-banner');

  try {
    setProgress(6, '正在登录…');
    const res = await api.login(username, password);
    ui.session = res;
    persistCredentials();
    log('ok', `登录成功：${res.user.username}`, `会话到期 ${fmtDateTime(res.expiresAt)}`);
    toast(`登录成功：${res.user.username}`);
    await afterLogin(res.user);
  } catch (err) {
    const msg = describeError(err);
    log('err', '登录失败', msg);
    showBanner('#session-banner', `<strong>登录失败</strong>${msg}`, 'error');
    toast('登录失败，见下方提示', true);
    setStep(1);
  } finally {
    ui.busy = false;
    setBusy(btn, false);
    $('#progress-wrap').hidden = true;
  }
}

/** 登录后：拉用户信息、图盘用量，并解锁后续步骤 */
async function afterLogin(userFromLogin) {
  const userId = userFromLogin.id;
  $('#card-image').setAttribute('aria-disabled', 'false');
  setStep(2);

  let user = userFromLogin;
  try {
    user = await api.user(userId);
  } catch (err) {
    log('err', '读取用户资料失败', describeError(err));
  }
  applyUser(user);

  try {
    const st = await api.storage();
    renderStorage(st);
  } catch (err) {
    log('err', '读取图盘用量失败', describeError(err));
  }

  await refreshAvatarState(userId);
}

function applyUser(user) {
  ui.user = user;
  const banner = $('#session-banner');
  showBanner(
    '#session-banner',
    `<strong>已登录：${user.username}</strong>` +
    `用户 ID <span class="mono">${user.id}</span> - 身份 ${user.avatar ? user.avatar.type : '—'}` +
    (ui.session ? ` - 会话到期 ${fmtDateTime(ui.session.expiresAt)}` : ''),
    'info',
  );
  banner.className = 'm3-banner m3-banner--ok';

  $('#acct-name').textContent = user.username;
  $('#acct-id').textContent = user.id;
  const img = $('#acct-avatar');
  if (user.avatar && user.avatar.url) {
    img.src = absoluteUrl(user.avatar.url);
    img.hidden = false;
  } else {
    img.hidden = true;
  }
  $('#acct-sub').textContent = `Lv.${(user.level && user.level.current) ?? '?'} - 头像 ${user.avatar ? user.avatar.type : '—'}`;
  $('#btn-logout').hidden = false;

  $('#kv-user').textContent = user.username;
  $('#kv-uid').textContent = user.id;
  $('#kv-type').textContent = user.avatar ? user.avatar.type : '—';
}

function renderStorage(st) {
  if (!st || !Number.isFinite(st.limitBytes)) return;
  const used = st.usedBytes || 0;
  const pct = st.limitBytes ? (used / st.limitBytes) * 100 : 0;
  $('#storage-meter').hidden = false;
  $('#storage-fill').style.width = `${Math.min(100, pct).toFixed(1)}%`;
  $('#storage-text').textContent = `图盘用量 ${fmtBytes(used)} / ${fmtBytes(st.limitBytes)} - 剩余 ${fmtBytes(st.remainingBytes)}`;
  if (st.remainingBytes < MAX_FILE_BYTES) {
    log('info', '图盘剩余空间偏小', `剩余 ${fmtBytes(st.remainingBytes)}`);
  }
}

async function refreshAvatarState(userId) {
  try {
    const state = await api.avatar(userId);
    if (state.derivationAvailableAt) {
      const future = new Date(state.derivationAvailableAt).getTime() > Date.now();
      if (future) {
        log('info', '派生冷却中', `可再次更换时间：${fmtDateTime(state.derivationAvailableAt)}（${relTime(state.derivationAvailableAt)}）`);
        toast(`派生处于冷却期，${relTime(state.derivationAvailableAt)}可再次更换`, false, 5200);
      }
    }
    $('#kv-cooldown').textContent = state.derivationAvailableAt
      ? `${fmtDateTime(state.derivationAvailableAt)}（${relTime(state.derivationAvailableAt)}）`
      : '—';
    return state;
  } catch (err) {
    log('err', '读取头像状态失败', describeError(err));
    return null;
  }
}

$('#btn-login').addEventListener('click', login);
$('#in-password').addEventListener('keydown', (e) => { if (e.key === 'Enter') login(); });
$('#in-username').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#in-password').focus(); });

$('#btn-peek').addEventListener('click', () => {
  const input = $('#in-password');
  input.type = input.type === 'password' ? 'text' : 'password';
  input.focus();
});

/* 连通性探测：只发一次 OPTIONS，不涉及账号 */
$('#btn-probe').addEventListener('click', async () => {
  const btn = $('#btn-probe');
  setBusy(btn, true, '检测中…');
  try {
    const url = toFetchUrl(`${API_PREFIX}/session`);
    const res = await fetch(url, { method: 'OPTIONS', credentials: 'include' });
    log('api', `OPTIONS ${API_PREFIX}/session -> ${res.status}`, cfg.proxy ? `经代理 ${cfg.proxy}` : '');
    const allowCred = res.headers.get('access-control-allow-credentials');
    const allowOrigin = res.headers.get('access-control-allow-origin');
    if (res.status === 403) {
      toast('接口可达，但当前 Origin 被拒绝（403），需改用同源部署或代理', true, 6000);
    } else if (!allowOrigin && apiOrigin() !== window.location.origin.replace(/\/+$/, '')) {
      toast('接口可达，但未返回 CORS 允许头，跨域场景下无法读取响应', true, 6000);
    } else {
      toast(`接口可达（${res.status}）${allowCred ? '，允许携带凭据' : ''}`);
    }
  } catch (err) {
    log('err', '连通性检测失败', String(err && err.message));
    toast(NETWORK_HINT, true, 8000);
  } finally {
    setBusy(btn, false);
  }
});

/* 退出登录 */
$('#btn-logout').addEventListener('click', async () => {
  const btn = $('#btn-logout');
  setBusy(btn, true, '注销中…');
  try {
    await api.logout();
    log('ok', '会话已注销');
    toast('已退出登录');
  } catch (err) {
    log('err', '注销失败', describeError(err));
  } finally {
    setBusy(btn, false);
    ui.session = null;
    ui.user = null;
    $('#session-banner').hidden = true;
    $('#acct-name').textContent = '—';
    $('#acct-id').textContent = '—';
    $('#acct-sub').textContent = '未登录';
    $('#acct-avatar').hidden = true;
    $('#storage-meter').hidden = true;
    $('#btn-logout').hidden = true;
    $('#card-image').setAttribute('aria-disabled', 'true');
    $('#card-run').setAttribute('aria-disabled', 'true');
    $('#btn-run').disabled = true;
    setStep(1);
  }
});

/* ------------------------------ 选图流程 ------------------------------- */

const dropzone = $('#dropzone');
const fileInput = $('#in-file');

dropzone.addEventListener('click', () => fileInput.click());
dropzone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
});
['dragenter', 'dragover'].forEach((ev) => dropzone.addEventListener(ev, (e) => {
  e.preventDefault();
  dropzone.classList.add('is-over');
}));
['dragleave', 'drop'].forEach((ev) => dropzone.addEventListener(ev, () => dropzone.classList.remove('is-over')));
dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (file) selectFile(file);
});
fileInput.addEventListener('change', () => {
  const file = fileInput.files && fileInput.files[0];
  if (file) selectFile(file);
});

async function selectFile(file) {
  if (!file.type.startsWith('image/')) {
    toast('请选择图片文件', true);
    return;
  }
  ui.file = file;
  ui.converted = null;
  $('#picker-empty').hidden = true;
  $('#picker-preview').hidden = false;
  $('#btn-clear').hidden = false;

  const previewUrl = URL.createObjectURL(file);
  $('#preview-img').src = previewUrl;
  $('#preview-img').onload = () => URL.revokeObjectURL(previewUrl);

  $('#meta-name').textContent = file.name || '(剪贴板图片)';
  $('#meta-info').textContent = `${fmtBytes(file.size)} - 正在转码…`;
  log('info', `已选择图片 ${file.name || '(未命名)'}`, `${fmtBytes(file.size)} - ${file.type || '未知类型'}`);

  try {
    const maxEdge = $('#opt-max').checked ? 1024 : 0;
    const square = $('#opt-square').checked;
    const out = await toStaticWebp(file, { quality: cfg.quality, square, maxEdge });
    ui.converted = {
      ...out,
      name: safeFileName(file.name),
      animated: out.chunks.includes('ANIM') || out.chunks.includes('ANMF'),
    };
    if (out.removed.length) {
      log('info', `已移除容器块 ${out.removed.join(', ')}`);
    }
    $('#meta-info').textContent =
      `${fmtBytes(file.size)} -> WebP ${fmtBytes(out.blob.size)} - ${out.width}×${out.height} - q=${out.quality.toFixed(2)}`;
    log('ok', '转码完成',
      `WebP ${out.width}×${out.height} - ${fmtBytes(out.blob.size)} - q=${out.quality.toFixed(2)}` +
      ` - 块 ${out.chunks.join(',')}`);
    updateRunButton();
  } catch (err) {
    ui.converted = null;
    $('#meta-info').textContent = '转码失败';
    log('err', '图片转码失败', String(err && err.message));
    toast(`图片转码失败：${err.message}`, true, 6000);
    updateRunButton();
  }
}

$('#opt-square').addEventListener('change', () => { if (ui.file) selectFile(ui.file); });
$('#opt-max').addEventListener('change', () => { if (ui.file) selectFile(ui.file); });

$('#btn-clear').addEventListener('click', () => {
  ui.file = null;
  ui.converted = null;
  fileInput.value = '';
  $('#picker-empty').hidden = false;
  $('#picker-preview').hidden = true;
  $('#btn-clear').hidden = true;
  updateRunButton();
});

function updateRunButton() {
  const ready = Boolean(ui.session && ui.converted);
  $('#btn-run').disabled = !ready;
  $('#card-run').setAttribute('aria-disabled', ready ? 'false' : 'true');
}

/* ------------------------------ 主流程 --------------------------------- */

$('#btn-run').addEventListener('click', run);

async function run() {
  if (ui.busy) return;
  if (!ui.session || !ui.user) { toast('请先登录账号', true); return; }
  if (!ui.converted) { toast('请先选择图片并完成转码', true); return; }

  ui.busy = true;
  const btn = $('#btn-run');
  setBusy(btn, true, '执行中…');
  hideBanner('#error-banner');
  $('#card-result').hidden = true;
  setStep(3);

  const userId = ui.user.id;
  try {
    // 1) 容量预检
    setProgress(10, '检查图盘余量…');
    try {
      const st = await api.storage();
      renderStorage(st);
      if (Number.isFinite(st.remainingBytes) && st.remainingBytes < ui.converted.blob.size) {
        throw new Error(`图盘剩余 ${fmtBytes(st.remainingBytes)} 小于本次 ${fmtBytes(ui.converted.blob.size)}，请先清理旧图片`);
      }
    } catch (err) {
      if (err instanceof ApiError) log('info', '容量预检跳过', describeError(err));
      else throw err;
    }

    // 2) 上传静态 WebP
    setProgress(30, `上传 WebP（${fmtBytes(ui.converted.blob.size)}）…`);
    const uploaded = await api.uploadFile(ui.converted.blob, ui.converted.name);
    if (!uploaded || !uploaded.id) throw new Error('上传成功但未返回文件 ID');
    log('ok', `文件已入库：${uploaded.id}`, `ownership=${uploaded.ownership}`);

    // 3) DERIVE 派生头像（crop 为源图像素框，整图即完整尺寸）
    setProgress(66, '调用 PUT /users/{id}/avatar（DERIVE）…');
    const crop = { left: 0, top: 0, right: ui.converted.width, bottom: ui.converted.height };
    const result = await api.deriveAvatar(userId, uploaded.id, crop);
    log('ok', '头像已派生', `type=${result.current.type} id=${result.current.id}`);

    // 4) 回读校验
    setProgress(88, '回读校验…');
    const fresh = await api.user(userId);
    applyUser(fresh);
    const state = await refreshAvatarState(userId);

    if (!fresh.avatar || fresh.avatar.type !== 'CUSTOM') {
      throw new Error(`回读后头像类型仍为 ${fresh.avatar ? fresh.avatar.type : '未知'}，请到站点确认`);
    }

    setProgress(100, '完成');
    showResult(fresh, state);
    setStep(4);
    log('ok', '头像更换完成', fresh.avatar.url);
    toast('头像已更新并生效');
  } catch (err) {
    const msg = describeError(err);
    log('err', '执行失败', msg);
    showBanner('#error-banner', `<strong>失败</strong>${msg}`, 'error');
    toast('执行失败，详见请求日志', true, 6000);
    setStep(3);
  } finally {
    ui.busy = false;
    setBusy(btn, false);
    updateRunButton();
    setTimeout(() => { $('#progress-wrap').hidden = true; }, 900);
  }
}

function showResult(user, state) {
  const avatar = user.avatar || {};
  const bust = avatar.url ? `${absoluteUrl(avatar.url)}${avatar.url.includes('?') ? '&' : '?'}t=${Date.now()}` : '';
  $('#result-img').src = bust;
  $('#kv-user').textContent = user.username;
  $('#kv-uid').textContent = user.id;
  $('#kv-type').textContent = avatar.type || '—';
  const link = $('#kv-url');
  link.innerHTML = '';
  if (avatar.url) {
    const a = document.createElement('a');
    a.href = absoluteUrl(avatar.url);
    a.target = '_blank';
    a.rel = 'noreferrer noopener';
    a.textContent = absoluteUrl(avatar.url);
    link.append(a);
  } else {
    link.textContent = '—';
  }
  $('#kv-cooldown').textContent = (state && state.derivationAvailableAt)
    ? `${fmtDateTime(state.derivationAvailableAt)}（${relTime(state.derivationAvailableAt)}）`
    : '—';
  $('#result-sub').textContent = `服务端回读确认：头像类型 ${avatar.type}，ID ${avatar.id || '—'}`;
  $('#card-result').hidden = false;
  $('#card-result').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

$('#btn-open-profile').addEventListener('click', () => {
  if (!ui.user) return;
  const url = `${apiOrigin()}/profile/${encodeURIComponent(ui.user.id)}`;
  window.open(url, '_blank', 'noopener');
});

$('#btn-reset').addEventListener('click', () => {
  $('#card-result').hidden = true;
  $('#btn-clear').click();
  setStep(2);
  dropzone.scrollIntoView({ behavior: 'smooth', block: 'center' });
});

/* ------------------------------- 启动 ---------------------------------- */

loadConfig();
loadCredentials();
bindFloatingFields();
renderOriginHint();
setStep(1);
log('info', '工具已就绪', `接口 ${apiOrigin()}${API_PREFIX}${cfg.proxy ? ` - 经代理 ${cfg.proxy}` : ''}`);

// 跨域且未配置代理时，明确提示请求会被浏览器或服务端拒绝
if (!cfg.proxy && !isSameOrigin()) {
  showBanner(
    '#session-banner',
    '<strong>当前页面与接口不同源，请求无法完成</strong>' +
    '浏览器会阻止跨站会话 Cookie，服务端也会拒绝该 Origin 的跨域请求。' +
    '请在右上角设置中填写中转地址，或将本页部署到接口所在域名下。',
    'error',
  );
  log('err', '部署模式不可用', '页面与接口不同源，且未配置中转地址');
}

// 已有会话则直接进入第 2 步（Cookie 由浏览器携带）
(async function bootstrap() {
  try {
    const res = await api.session();
    if (res && res.user) {
      ui.session = res;
      await afterLogin(res.user);
      log('ok', `检测到已有会话：${res.user.username}`);
      toast(`已复用现有会话：${res.user.username}`);
      return;
    }
  } catch (err) {
    if (err instanceof ApiError && err.status !== 401 && !err.network) {
      log('info', '未检测到已有会话', describeError(err));
    } else if (err instanceof ApiError && err.network) {
      log('info', '会话检测跳过', '网络或跨域受限，登录时再试');
    }
  }
  setStep(1);
})();
