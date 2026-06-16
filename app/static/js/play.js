/**
 * Playground 工作台核心逻辑
 * 浅夜の梦 · 无框架 ES6+
 */

// ============================================================
// 错误码映射（通俗中文 + 操作建议）
// ============================================================
const REGISTER_URL = 'https://newapi.qianye.host/register?aff=uk7G';

const ERROR_MAP = {
    // ---- 限流 / 账号池 ----
    no_available_account:   "😴 当前太多人在用，所有账号都在忙，请等 30 秒后重试",
    rate_limited:           "🚦 请求太频繁被限流了，请等 30 秒后再试",
    rate_limit_rpm:         "🚦 你点太快啦！已触发每分钟请求上限，请稍后再试",

    // ---- 余额 / 计费 ----
    insufficient_balance:   "💰 积分余额不足，请先充值后再生成图片",
    billing_error:          "⚠️ 计费系统出了点问题，请联系管理员处理",

    // ---- 权限 / 模型 ----
    model_not_allowed:      "🔒 你的 API Key 没有权限使用该模型，请联系管理员开通",
    model_not_found:        "❌ 模型不存在或已下架，请检查模型名称是否正确",
    image_not_wired:        "🔧 该账号未开启图片生成能力，请联系管理员开通",

    // ---- 上游 / 网络 ----
    upstream_error:         "☁️ AI 服务暂时出错了，请稍后再试一次",
    poll_timeout:           "⏳ 图片生成超时，可能是图太复杂了，请重试或简化提示词",
    network_transient:      "📡 网络不太稳定，系统会自动重试，请稍等",
    auth_required:          "🔑 后台账号鉴权失败，系统正在自动换号重试",
    download_failed:        "📥 图片已生成但下载失败，请重新点击生成",
    invalid_response:       "🤖 AI 返回的数据格式异常，请重试一次",

    // ---- 请求参数 ----
    invalid_request_error:  "📝 请求参数有误，请检查提示词和设置是否正确",
    invalid_reference_image:"🖼️ 参考图片无法识别，请检查图片格式（支持 PNG/JPG）和大小",

    // ---- 内容审核 ----
    content_policy_violation:"🚫 内容审核未通过！你的提示词或参考图可能包含违规内容，请修改后重试",
    safety:                 "🚫 安全审核未通过！提示词或图片包含不当内容，请修改后重试",
    moderation:             "🚫 内容被审核系统拦截，请修改提示词中的敏感内容后重试",
    content_filter:         "🚫 内容过滤器触发，提示词或参考图含有违规内容，请调整后重试",
    responsible_ai_policy:  "🚫 AI 安全策略拦截，请修改提示词避免敏感内容",

    // ---- POW / 验证 ----
    pow_timeout:            "⏳ POW 验证超时，请重试",
    pow_failed:             "❌ POW 验证失败，请重试",
    turnstile_required:     "🔐 需要人机验证，请重试",

    // ---- 兜底 ----
    unknown:                "😥 图片生成失败，请重试。如多次失败请尝试更换节点或联系管理员",
};

// HTTP 状态码 → 通俗提示
const HTTP_ERROR_MAP = {
    400: "📝 请求参数有误，请检查提示词和设置",
    401: "🔑 API Key 无效或已过期，请重新输入",
    402: "💰 积分余额不足，请先充值",
    403: "🔒 无权限访问，请检查 API Key 或联系管理员",
    404: "❌ 请求的接口不存在，请检查节点地址是否正确",
    429: "🚦 请求太频繁，请稍后再试",
    500: "⚠️ 服务器内部错误，请稍后重试",
    502: "☁️ AI 服务暂时不可用，请稍后重试或更换节点",
    503: "😴 服务暂时过载或维护中，请等 30 秒后重试",
    504: "⏳ 服务器响应超时，可能是网络不通或图片生成时间过长。如果使用了参考图，请检查图片是否包含违规内容",
};

// ============================================================
// 状态管理
// ============================================================
const state = {
    baseUrl: '',
    apiKey: '',
    models: [],
    selectedModel: '',
    prompt: '',
    ratio: '1:1',
    resolution: '1k',
    quality: 'auto',
    outputFormat: 'png',
    outputCompression: 90,
    background: 'auto',
    moderation: 'auto',
    count: 1,
    maxConcurrency: 6,
    refImages: [],          // base64 dataURLs
    history: [],            // [{id, model, time, images:[], text:'', params:{...}}]
    queue: [],              // queued generation task snapshots
    activeTaskId: '',
    queueSeq: 0,
    isGenerating: false,
    isConnected: false,
    logs: [],
    progress: { done: 0, total: 0, elapsed: 0 },
};

const LOG_MAX_ENTRIES = 300;
const QUEUE_MAX_PENDING = 20;

// ============================================================
// DOM refs
// ============================================================
const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

const els = {
    playground:       $('.pg'),
    nodeSelect:        $('#nodeSelect'),
    qianyeLineField:   $('#qianyeLineField'),
    qianyeLineSelect:  $('#qianyeLineSelect'),
    qianyeLineHint:    $('#qianyeLineHint'),
    customBaseField:   $('#customBaseField'),
    customBaseInput:   $('#customBaseInput'),
    apiKeyInput:       $('#apiKeyInput'),
    connectBtn:        $('#connectBtn'),
    connTag:           $('#connTag'),
    balanceInfo:       $('#balanceInfo'),
    balanceBindBtn:    $('#balanceBindBtn'),
    balanceRefreshBtn: $('#balanceRefreshBtn'),
    promptInput:       $('#promptInput'),
    ratioGrid:         $('#ratioGrid'),
    ratioLabel:        $('#ratioLabel'),
    resolutionGrid:    $('#resolutionGrid'),
    resolutionLabel:   $('#resolutionLabel'),
    qualitySelect:     $('#qualitySelect'),
    formatSelect:      $('#formatSelect'),
    backgroundSelect:  $('#backgroundSelect'),
    moderationSelect:  $('#moderationSelect'),
    compressionField:  $('#compressionField'),
    compressionSlider: $('#compressionSlider'),
    compressionVal:    $('#compressionVal'),
    countSlider:       $('#countSlider'),
    countVal:          $('#countVal'),
    concurrencySlider: $('#concurrencySlider'),
    concurrencyVal:    $('#concurrencyVal'),
    refPnl:            $('#refPnl'),
    dropZone:          $('#dropZone'),
    refFileInput:      $('#refFileInput'),
    refThumbs:         $('#refThumbs'),
    dropHint:          $('#dropHint'),
    generateBtn:       $('#generateBtn'),
    modelChips:        $('#modelChips'),
    modelHint:         $('#modelHint'),
    statusDot:         $('#statusDot'),
    statusLabel:       $('#statusLabel'),
    progressWrap:      $('#progressWrap'),
    progressBar:       $('#progressBar'),
    logBody:           $('#logBody'),
    resultArea:        $('#resultArea'),
    previewOverlay:    $('#previewOverlay'),
    previewImg:        $('#previewImg'),
    previewClose:      $('#previewClose'),
    userPnl:           $('#userPnl'),
    userInfo:          $('#userInfo'),
};

// ============================================================
// 尺寸映射：UI 使用比例，发给图片 API 时必须映射为像素 size
// ============================================================
const RATIO_MAP = {
    '1:1':  { width: 1024, height: 1024 },
    '3:2':  { width: 1536, height: 1024 },
    '2:3':  { width: 1024, height: 1536 },
    '4:3':  { width: 1024, height: 768 },
    '3:4':  { width: 768, height: 1024 },
    '5:4':  { width: 1280, height: 1024 },
    '4:5':  { width: 1024, height: 1280 },
    '16:9': { width: 1536, height: 864 },
    '9:16': { width: 864, height: 1536 },
    '2:1':  { width: 2048, height: 1024 },
    '1:2':  { width: 1024, height: 2048 },
    '3:1':  { width: 1536, height: 512 },
    '1:3':  { width: 512, height: 1536 },
    '21:9': { width: 2016, height: 864 },
    '9:21': { width: 864, height: 2016 },
};

const SIZE_MAP = {
    '1k': {
        '1:1': '1024x1024',
        '3:2': '1536x1024',
        '2:3': '1024x1536',
        '4:3': '1024x768',
        '3:4': '768x1024',
        '5:4': '1280x1024',
        '4:5': '1024x1280',
        '16:9': '1536x864',
        '9:16': '864x1536',
        '2:1': '2048x1024',
        '1:2': '1024x2048',
        '3:1': '1536x512',
        '1:3': '512x1536',
        '21:9': '2016x864',
        '9:21': '864x2016',
    },
    '2k': {
        '1:1': '2048x2048',
        '3:2': '2048x1360',
        '2:3': '1360x2048',
        '4:3': '2048x1536',
        '3:4': '1536x2048',
        '5:4': '2560x2048',
        '4:5': '2048x2560',
        '16:9': '2048x1152',
        '9:16': '1152x2048',
        '2:1': '2688x1344',
        '1:2': '1344x2688',
        '3:1': '3072x1024',
        '1:3': '1024x3072',
        '21:9': '2688x1152',
        '9:21': '1152x2688',
    },
    '4k': {
        '1:1': '2880x2880',
        '3:2': '3520x2336',
        '2:3': '2336x3520',
        '4:3': '3312x2480',
        '3:4': '2480x3312',
        '5:4': '3216x2576',
        '4:5': '2576x3216',
        '16:9': '3840x2160',
        '9:16': '2160x3840',
        '2:1': '3840x1920',
        '1:2': '1920x3840',
        '3:1': '3840x1280',
        '1:3': '1280x3840',
        '21:9': '3840x1648',
        '9:21': '1648x3840',
    },
};

const CUSTOM_NODE_VALUE = '__custom_base_url__';
const PROVIDER_QIANYE = '__provider_qianye__';
const PROVIDER_LOCAL_NEWAPI = '__provider_local_newapi__';

const QIANYE_LINES = [
    {
        id: 'cf',
        label: 'CF国际线路',
        url: 'https://newapi.qianqianye.com',
        aliases: ['https://newapi-cf.qianqianye.com'],
        hint: '大宽带，有魔法推荐，不推荐直连，海外机器推荐。这个 API 使用生图模型的时候容易出现 524。',
    },
    {
        id: 'hk',
        label: '香港优化线路',
        url: 'https://newapi-hk.qianye.host',
        hint: '优化线路很贵，有魔法的请选择国际线路，把机会留给需要的人~感谢支持。选择优化线路则不要开启魔法，避免减速带效果~',
    },
    {
        id: 'us',
        label: '美国优化线路',
        url: 'https://newapi-us-la-1.qianye.host',
        hint: '优化线路很贵，有魔法的请选择国际线路，把机会留给需要的人~感谢支持。选择优化线路则不要开启魔法，避免减速带效果~',
    },
    {
        id: 'jp',
        label: '日本优化线路',
        url: 'https://newapi-jp.qianye.host',
        hint: '优化线路很贵，有魔法的请选择国际线路，把机会留给需要的人~感谢支持。选择优化线路则不要开启魔法，避免减速带效果~',
    },
];
const DEFAULT_QIANYE_LINE_ID = 'cf';
const LOCAL_NEWAPI_URL = '127.0.0.1:3000';

// ============================================================
// 工具函数
// ============================================================
function getAllowedModels() {
    const raw = els.playground.dataset.allowedModels;
    try { return JSON.parse(raw || '[]'); } catch { return []; }
}

function getModelsConfig() {
    const raw = els.playground.dataset.modelsConfig;
    try { return JSON.parse(raw || '{}'); } catch { return {}; }
}

function getModelCfg(modelName) {
    const cfg = getModelsConfig();
    return cfg[modelName] || { name: modelName, ref_image: true, endpoint: 'images' };
}

function getRequestMode() {
    return els.playground.dataset.requestMode || 'frontend';
}

function normalizeBaseUrl(url) {
    const value = String(url || '').trim().replace(/\/+$/, '');
    if (!value) return '';
    if (/^https?:\/\//i.test(value)) return value;
    return `http://${value}`;
}

function qianyeLineById(id) {
    return QIANYE_LINES.find(line => line.id === id) || QIANYE_LINES.find(line => line.id === DEFAULT_QIANYE_LINE_ID) || QIANYE_LINES[0];
}

function qianyeLineByUrl(url) {
    const normalized = normalizeBaseUrl(url);
    return QIANYE_LINES.find(line => {
        if (normalizeBaseUrl(line.url) === normalized) return true;
        return (line.aliases || []).some(alias => normalizeBaseUrl(alias) === normalized);
    }) || null;
}

function currentProvider() {
    return els.nodeSelect?.value || '';
}

function isQianyeProviderSelected() {
    return currentProvider() === PROVIDER_QIANYE;
}

function isLocalNewApiSelected() {
    return currentProvider() === PROVIDER_LOCAL_NEWAPI;
}

function getActiveBaseUrl(ctx = null) {
    if (ctx?.baseUrl) return normalizeBaseUrl(ctx.baseUrl);
    if (isQianyeProviderSelected()) {
        const line = qianyeLineById(els.qianyeLineSelect?.value || localStorage.getItem('ai_qianye_line') || DEFAULT_QIANYE_LINE_ID);
        return normalizeBaseUrl(line?.url || '');
    }
    if (isLocalNewApiSelected()) {
        return normalizeBaseUrl(LOCAL_NEWAPI_URL);
    }
    if (isCustomNodeSelected()) {
        return normalizeBaseUrl(els.customBaseInput?.value || localStorage.getItem('ai_custom_base') || state.baseUrl || '');
    }
    return '';
}

function isCustomNodeSelected() {
    return els.nodeSelect?.value === CUSTOM_NODE_VALUE;
}

function updateProviderFields() {
    if (els.qianyeLineField) els.qianyeLineField.hidden = !isQianyeProviderSelected();
    if (!els.customBaseField) return;
    els.customBaseField.hidden = !isCustomNodeSelected();
    if (els.qianyeLineHint && isQianyeProviderSelected()) {
        const line = qianyeLineById(els.qianyeLineSelect?.value || DEFAULT_QIANYE_LINE_ID);
        els.qianyeLineHint.textContent = line ? `${line.url}｜${line.hint}（有的客户端需要手动加 /v1，请注意）` : '';
    }
}

function updateCustomBaseVisibility() {
    updateProviderFields();
}

function saveActiveNode(baseUrl) {
    const normalized = normalizeBaseUrl(baseUrl);
    if (isQianyeProviderSelected()) {
        localStorage.setItem('ai_node', PROVIDER_QIANYE);
        localStorage.setItem('ai_qianye_line', els.qianyeLineSelect?.value || DEFAULT_QIANYE_LINE_ID);
    } else if (isLocalNewApiSelected()) {
        localStorage.setItem('ai_node', PROVIDER_LOCAL_NEWAPI);
    } else if (isCustomNodeSelected()) {
        localStorage.setItem('ai_node', CUSTOM_NODE_VALUE);
        localStorage.setItem('ai_custom_base', normalized);
    } else {
        localStorage.setItem('ai_node', normalized);
    }
    localStorage.setItem('ai_balance_base', normalized);
}

function isGalleryEnabled() {
    return els.playground.dataset.galleryEnabled === 'true';
}

function getPixelSize(ratio = state.ratio, resolution = state.resolution) {
    return SIZE_MAP[resolution]?.[ratio] || SIZE_MAP['1k']['1:1'];
}

function getImageOptions(ctx = state) {
    const outputFormat = ctx.outputFormat || 'png';
    const body = {
        size: getPixelSize(ctx.ratio, ctx.resolution),
        resolution: ctx.resolution || '1k',
        quality: ctx.quality || 'auto',
        background: ctx.background || 'auto',
        moderation: ctx.moderation || 'auto',
        // 优先让上游返回图片 URL，避免几 MB 的 base64 JSON 走长连接返回时更容易触发 TLS 断链。
        // 前端已有 URL 图片下载/缓存逻辑；若上游不支持该字段，通常会忽略。
        response_format: 'url',
        output_format: outputFormat,
    };
    if ((outputFormat === 'jpeg' || outputFormat === 'webp') && Number.isFinite(ctx.outputCompression)) {
        body.output_compression = ctx.outputCompression;
    }
    return body;
}

function updateResolutionLabel() {
    if (!els.resolutionLabel) return;
    els.resolutionLabel.textContent = `${(state.resolution || '1k').toUpperCase()} · ${getPixelSize()}`;
}

function _expiredSvg() {
    return 'data:image/svg+xml,' + encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200">'
        + '<rect fill="#1c1c1e" width="200" height="200" rx="8"/>'
        + '<text x="50%" y="45%" dominant-baseline="middle" text-anchor="middle" fill="#636366" font-size="28">🖼️</text>'
        + '<text x="50%" y="62%" dominant-baseline="middle" text-anchor="middle" fill="#636366" font-size="12">图片已过期</text>'
        + '</svg>'
    );
}

function getToken() {
    return localStorage.getItem('token') || '';
}

function formatElapsed(ms) {
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    return `${m}m ${s % 60}s`;
}

function ts() {
    const d = new Date();
    return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`;
}

function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

/** 安全解析 fetch 响应为 JSON，对 HTML 错误页面/非 JSON 给出清晰提示 */
async function safeJson(resp) {
    const ct = resp.headers.get('content-type') || '';
    if (!resp.ok) {
        // 尝试读取 JSON 错误体（上游返回的结构化错误）
        if (ct.includes('json')) {
            try {
                const j = await resp.json();
                if (j.error) throw new Error(parseError(j));
            } catch (e) {
                if (e instanceof SyntaxError === false) throw e;
            }
        }
        // 非 JSON 或 JSON 解析失败 → 根据 HTTP 状态码给通俗提示
        const text = ct.includes('json') ? '' : await resp.text().catch(() => '');
        // 优先使用 HTTP 状态码映射表
        if (HTTP_ERROR_MAP[resp.status]) {
            throw new Error(HTTP_ERROR_MAP[resp.status]);
        }
        if (text.includes('<!DOCTYPE') || text.includes('<html')) {
            throw new Error(`节点返回 HTTP ${resp.status} 错误（HTML页面），请检查节点是否可用或更换节点`);
        }
        throw new Error(`请求失败 HTTP ${resp.status}${text ? ': ' + text.slice(0, 120) : ''}`);
    }
    // 200 但 Content-Type 不是 JSON
    if (!ct.includes('json')) {
        const text = await resp.text().catch(() => '');
        if (text.includes('<!DOCTYPE') || text.includes('<html')) {
            throw new Error('节点返回了 HTML 页面而非 JSON，请检查节点地址是否正确');
        }
        try { return JSON.parse(text); } catch { throw new Error('节点返回非 JSON 格式数据'); }
    }
    return resp.json();
}

function parseError(data) {
    if (!data) return ERROR_MAP.unknown;
    const code = data.error?.code || data.code || data.error?.type || '';
    const msg  = data.error?.message || data.message || '';
    const status = data.error?.status || data.status || 0;
    const combined = `${code} ${msg}`.toLowerCase();

    // 1. 精确匹配错误码
    if (code && ERROR_MAP[code]) return ERROR_MAP[code];

    // 2. 内容审核 / 安全策略关键词匹配（上游返回的 message 五花八门，统一翻译）
    const safetyKeywords = [
        'content_policy', 'content policy', 'safety', 'moderation',
        'content_filter', 'content filter', 'responsible_ai',
        'violat', 'flagged', 'blocked', 'inappropriate',
        'not allowed', 'unsafe', 'harmful', 'sensitive',
        'image was rejected', 'rejected by', 'policy',
    ];
    if (safetyKeywords.some(kw => combined.includes(kw))) {
        return '🚫 内容审核未通过！你的提示词或参考图可能包含违规内容，请修改后重试';
    }

    // 3. HTTP 状态码匹配
    if (status && HTTP_ERROR_MAP[status]) return HTTP_ERROR_MAP[status];

    // 4. 有错误码但没映射到 → 附上原始 message 帮助排查
    if (msg && code) return `${ERROR_MAP.unknown}（${code}: ${msg}）`;
    if (msg) return msg;
    return ERROR_MAP.unknown;
}

function isUnsupportedResponseFormatError(err) {
    const msg = String(err?.message || err || '').toLowerCase();
    return msg.includes('response_format')
        || msg.includes('response format')
        || msg.includes('unknown parameter')
        || msg.includes('invalid parameter')
        || msg.includes('unsupported parameter')
        || msg.includes('unexpected field')
        || msg.includes('unrecognized request argument');
}

async function requestJsonWithUrlFallback(endpoint, fetchOptions, bodyOrForm, isMultipart = false) {
    const resp = await fetch(endpoint, fetchOptions);
    try {
        return await safeJson(resp);
    } catch (err) {
        if (!isUnsupportedResponseFormatError(err)) throw err;
        addLog('当前节点不支持 response_format=url，已自动降级为默认返回格式重试', 'warn');
    }

    if (isMultipart) {
        bodyOrForm.delete('response_format');
        const retryResp = await fetch(endpoint, { ...fetchOptions, body: bodyOrForm });
        return safeJson(retryResp);
    }

    const retryBody = { ...bodyOrForm };
    delete retryBody.response_format;
    const retryResp = await fetch(endpoint, {
        ...fetchOptions,
        body: JSON.stringify(retryBody),
    });
    return safeJson(retryResp);
}

function parseNativeJson(text) {
    try {
        return JSON.parse(text);
    } catch {
        throw new Error(`原生请求返回非 JSON 数据：${String(text || '').slice(0, 160)}`);
    }
}

function errorMessage(err) {
    if (err instanceof Error && err.message) return err.message;
    if (typeof err === 'string') return err;
    try {
        return JSON.stringify(err);
    } catch {
        return String(err);
    }
}

async function requestNativeImageEdit(prompt, count, imageOptions, ctx = state) {
    const invoke = _getTauriInvoke();
    if (!invoke) throw new Error('当前环境不支持原生图生图请求');
    const text = await invoke('native_image_edit', {
        baseUrl: getActiveBaseUrl(ctx),
        apiKey: ctx.apiKey || state.apiKey,
        model: ctx.model || ctx.selectedModel,
        prompt,
        count,
        optionsJson: JSON.stringify(imageOptions),
        refImages: (ctx.refImages || state.refImages).slice(0, 4),
    });
    return parseNativeJson(text);
}

async function requestNativeImageEditWithUrlFallback(prompt, count, ctx = state) {
    const imageOptions = getImageOptions(ctx);
    const data = await requestNativeImageEdit(prompt, count, imageOptions, ctx);
    if (!data?.error || !isUnsupportedResponseFormatError(parseError(data))) return data;

    addLog('当前节点不支持 response_format=url，原生请求已自动降级为默认返回格式重试', 'warn');
    const retryOptions = { ...imageOptions };
    delete retryOptions.response_format;
    return requestNativeImageEdit(prompt, count, retryOptions, ctx);
}

async function requestDirectImageEditWithUrlFallback(prompt, count, ctx = state) {
    const endpoint = `${getActiveBaseUrl(ctx)}/v1/images/edits`;
    const imageOptions = getImageOptions(ctx);
    const makeForm = (options) => {
        const form = new FormData();
        form.append('model', ctx.model || ctx.selectedModel);
        form.append('prompt', prompt);
        form.append('n', String(count));
        Object.entries(options).forEach(([key, value]) => form.append(key, String(value)));
        (ctx.refImages || state.refImages).forEach((b64, i) => {
            const blob = dataURLtoBlob(b64);
            form.append('image', blob, `ref_${i}.png`);
        });
        return form;
    };

    const resp = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${ctx.apiKey || state.apiKey}` },
        body: makeForm(imageOptions),
    });
    try {
        return await safeJson(resp);
    } catch (err) {
        if (!isUnsupportedResponseFormatError(err)) throw err;
        addLog('当前节点不支持 response_format=url，直连请求已自动降级为默认返回格式重试', 'warn');
    }

    const retryOptions = { ...imageOptions };
    delete retryOptions.response_format;
    const retryResp = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${ctx.apiKey || state.apiKey}` },
        body: makeForm(retryOptions),
    });
    return safeJson(retryResp);
}

// ============================================================
// 日志系统
// ============================================================
let logTimerInterval = null;
let logStartTime = null;

function addLog(text, type = '') {
    // 移除占位提示
    const ph = els.logBody.querySelector('.log-ph');
    if (ph) ph.remove();

    const entry = document.createElement('div');
    entry.className = `log-ln${type ? ' log-' + type : ''}`;
    entry.innerHTML = `[${ts()}] ${escHtml(text)}`;
    els.logBody.appendChild(entry);
    els.logBody.scrollTop = els.logBody.scrollHeight;
    state.logs.push({ ts: Date.now(), text, type });
    if (state.logs.length > LOG_MAX_ENTRIES) {
        state.logs.splice(0, state.logs.length - LOG_MAX_ENTRIES);
    }
    const lines = els.logBody.querySelectorAll('.log-ln');
    for (let i = 0; i < lines.length - LOG_MAX_ENTRIES; i++) {
        lines[i].remove();
    }
}

function ensureQueuePanel() {
    if (document.getElementById('queueBox') || !els.logBody?.parentElement) return;
    const box = document.createElement('div');
    box.id = 'queueBox';
    box.className = 'queue-box';
    box.hidden = true;
    box.innerHTML = '<div class="queue-head"><span>生成队列</span><small id="queueSummary">空闲</small></div><div class="queue-list" id="queueList"></div>';
    els.logBody.parentElement.appendChild(box);
}

function updateGenerateButton() {
    if (!els.generateBtn) return;
    els.generateBtn.disabled = !state.isConnected;
    els.generateBtn.textContent = state.isGenerating ? '加入队列' : '生成图片';
}

function renderQueuePanel() {
    ensureQueuePanel();
    const box = document.getElementById('queueBox');
    const list = document.getElementById('queueList');
    const summary = document.getElementById('queueSummary');
    if (!box || !list || !summary) return;

    const active = state.queue.find(t => t.status === 'running');
    const pending = state.queue.filter(t => t.status === 'queued');
    box.hidden = !active && pending.length === 0;
    summary.textContent = active
        ? `生成中 · 等待 ${pending.length}`
        : (pending.length ? `等待 ${pending.length}` : '空闲');

    list.innerHTML = '';
    state.queue.forEach(task => {
        const row = document.createElement('div');
        row.className = `queue-item ${task.status}`;
        const prompt = task.prompt.length > 46 ? `${task.prompt.slice(0, 46)}…` : task.prompt;
        row.innerHTML = `
            <div class="queue-main">
                <div class="queue-title"><span class="queue-badge">#${task.seq}</span><strong>${escHtml(task.model || '未知模型')}</strong><span>${task.count} 张</span></div>
                <div class="queue-prompt">${escHtml(prompt || '(无提示词)')}</div>
            </div>
            <div class="queue-actions">
                <span class="queue-status">${task.status === 'running' ? '生成中' : '等待中'}</span>
                ${task.status === 'queued' ? '<button class="queue-cancel" type="button">取消</button>' : ''}
            </div>`;
        row.querySelector('.queue-cancel')?.addEventListener('click', () => cancelQueuedTask(task.id));
        list.appendChild(row);
    });
}

function cancelQueuedTask(taskId) {
    const idx = state.queue.findIndex(t => t.id === taskId && t.status === 'queued');
    if (idx < 0) return;
    const [task] = state.queue.splice(idx, 1);
    addLog(`已取消队列任务 #${task.seq}`);
    renderQueuePanel();
}

function escHtml(s) {
    return String(s)
        .replace(/&/g,'&amp;')
        .replace(/</g,'&lt;')
        .replace(/>/g,'&gt;')
        .replace(/"/g,'&quot;');
}

function startLogTimer() {
    logStartTime = Date.now();
    updateLogTimer();
    logTimerInterval = setInterval(updateLogTimer, 1000);
}

function updateLogTimer() {
    if (!logStartTime) return;
    const elapsed = formatElapsed(Date.now() - logStartTime);
    els.statusLabel.textContent = `生成中 · ${elapsed}`;
}

function stopLogTimer() {
    clearInterval(logTimerInterval);
    logTimerInterval = null;
}

function setStatus(status) {
    els.statusDot.className = `dot ${status}`;
    const labels = { idle: '等待中', run: '生成中', ok: '已完成', error: '失败' };
    if (status !== 'run') els.statusLabel.textContent = labels[status] || status;
}

function updateProgress(done, total) {
    state.progress.done = done;
    state.progress.total = total;
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    els.progressBar.style.width = pct + '%';
    els.progressWrap.hidden = total === 0;
}

// ---- 连续进度动画（顶部进度条 + 骨架卡片同步） ----
let _progressTimer = null;
let _progressStartTime = 0;
let _progressDuration = 80; // 秒

function startProgressAnimation(count) {
    stopProgressAnimation();
    _progressDuration = 80 * count;
    _progressStartTime = Date.now();
    els.progressWrap.hidden = false;
    els.progressBar.style.width = '0%';

    _progressTimer = setInterval(() => {
        const elapsed = (Date.now() - _progressStartTime) / 1000;
        // 指数衰减渐近 99%，超时后停在 99% 继续等
        const pct = Math.min(99, Math.round((1 - Math.exp(-3 * elapsed / _progressDuration)) * 100));

        // 顶部进度条
        els.progressBar.style.width = pct + '%';

        // 骨架卡片进度
        els.resultArea.querySelectorAll('.skeleton-card').forEach(card => {
            const label = card.querySelector('.sk-label');
            const bar = card.querySelector('.sk-progress-bar');
            if (label) label.textContent = `生成中 ${pct}%`;
            if (bar) bar.style.width = pct + '%';
        });
    }, 500);
}

function stopProgressAnimation() {
    if (_progressTimer) { clearInterval(_progressTimer); _progressTimer = null; }
}

function finishProgress() {
    stopProgressAnimation();
    els.progressBar.style.width = '100%';
    setTimeout(() => {
        if (!state.isGenerating) els.progressWrap.hidden = true;
    }, 3000);
}

// ============================================================
// 余额显示
// ============================================================
function getBalanceToken() {
    return localStorage.getItem('ai_balance_token') || '';
}

function getBalanceUserId() {
    return localStorage.getItem('ai_balance_user_id') || '';
}

function balanceBaseUrl() {
    return localStorage.getItem('ai_balance_base') || getActiveBaseUrl();
}

function isBalancePanelEnabled() {
    const section = els.balanceInfo?.closest?.('.balance-section');
    return !!section && section.hidden !== true;
}

function formatUsd(value) {
    const n = Number(value || 0);
    return '$' + n.toFixed(4);
}

function formatDateTime(ts) {
    const n = Number(ts || 0);
    if (!n) return '';
    return new Date(n * 1000).toLocaleString('zh-CN');
}

function renderBalanceEmpty(message = '未绑定余额 token') {
    if (!els.balanceInfo) return;
    els.balanceInfo.innerHTML = `<div class="balance-empty">${escHtml(message)}</div>`;
    if (els.balanceBindBtn) els.balanceBindBtn.textContent = getBalanceToken() ? '更新' : '绑定';
}

function renderBalanceLoading() {
    if (!els.balanceInfo) return;
    els.balanceInfo.innerHTML = '<div class="balance-empty">正在查询余额…</div>';
}

function renderBalanceData(data) {
    if (!els.balanceInfo) return;
    const recent = data.recent_usd == null
        ? (data.recent_error ? `近 24 小时读取失败：${data.recent_error}` : '近 24 小时：暂无数据')
        : `近 24 小时：${formatUsd(data.recent_usd)} · ${data.recent_count || 0} 次`;
    els.balanceInfo.innerHTML = `
        <div class="balance-account">${escHtml(data.account || 'unknown')}</div>
        <div class="balance-main">${formatUsd(data.remaining_usd)}</div>
        <div class="balance-meta">历史消耗 ${formatUsd(data.used_usd)} · ${data.request_count || 0} 次</div>
        <div class="balance-meta">${escHtml(recent)}</div>
        <div class="balance-meta">${escHtml(data.site || '')}</div>
        <div class="balance-time">更新 ${escHtml(formatDateTime(data.fetched_at))}</div>`;
    if (els.balanceBindBtn) els.balanceBindBtn.textContent = '更新';
}

async function queryBalance() {
    const accessToken = getBalanceToken();
    const userId = getBalanceUserId();
    if (!accessToken || !userId) {
        renderBalanceEmpty();
        return null;
    }
    renderBalanceLoading();
    const resp = await fetch('/api/balance/overview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            access_token: accessToken,
            user_id: userId,
            base_url: balanceBaseUrl(),
        }),
    });
    const payload = await resp.json().catch(() => ({}));
    if (!resp.ok || payload.success === false) {
        throw new Error(payload.detail || payload.message || '余额查询失败');
    }
    renderBalanceData(payload.data || {});
    return payload.data;
}

async function refreshBalance() {
    if (!isBalancePanelEnabled()) return;
    try {
        await queryBalance();
        addLog('余额已刷新', 'success');
    } catch (err) {
        renderBalanceEmpty('余额查询失败：' + err.message);
        addLog('余额查询失败：' + err.message, 'err');
    }
}

function clearBalanceBinding() {
    localStorage.removeItem('ai_balance_token');
    localStorage.removeItem('ai_balance_user_id');
    localStorage.removeItem('ai_balance_base');
    renderBalanceEmpty();
    addLog('已清除余额 token');
}

function showBalanceBindDialog() {
    const overlay = document.createElement('div');
    overlay.className = 'ann-overlay';
    overlay.innerHTML = `<div class="ann-box" style="width:430px;max-width:92vw">
        <div class="ann-header"><span>绑定余额 token</span><button class="ann-close" id="bbClose">✕</button></div>
        <div class="ann-body">
            <div class="field" style="margin-bottom:12px">
                <label style="font-size:13px;color:var(--text-soft);display:block;margin-bottom:4px">余额 token</label>
                <input type="password" id="bbToken" class="pg-input" placeholder="Dashboard Access Token" style="width:100%" value="${escHtml(getBalanceToken())}">
            </div>
            <div class="field">
                <label style="font-size:13px;color:var(--text-soft);display:block;margin-bottom:4px">余额用户 ID</label>
                <input type="text" id="bbUserId" class="pg-input" inputmode="numeric" placeholder="NewAPI 数字用户 ID，例如 10" style="width:100%" value="${escHtml(getBalanceUserId())}">
            </div>
            <p id="bbErr" style="color:#ff3b30;font-size:13px;margin-top:8px" hidden></p>
        </div>
        <div style="padding:12px 24px;border-top:1px solid var(--border);display:flex;gap:8px;justify-content:space-between">
            <button class="btn" id="bbClearBtn">清除</button>
            <div style="display:flex;gap:8px">
                <button class="btn" id="bbCancelBtn">取消</button>
                <button class="btn btn-primary" id="bbSaveBtn">绑定并查询</button>
            </div>
        </div>
    </div>`;
    document.body.appendChild(overlay);

    const close = () => overlay.remove();
    overlay.querySelector('#bbClose').onclick = close;
    overlay.querySelector('#bbCancelBtn').onclick = close;
    overlay.querySelector('#bbClearBtn').onclick = () => { close(); clearBalanceBinding(); };
    overlay.querySelector('#bbSaveBtn').onclick = async () => {
        const token = overlay.querySelector('#bbToken').value.trim();
        const userId = overlay.querySelector('#bbUserId').value.trim();
        const errEl = overlay.querySelector('#bbErr');
        const saveBtn = overlay.querySelector('#bbSaveBtn');
        if (!token || !userId) {
            errEl.textContent = '请填写余额 token 和数字用户 ID';
            errEl.hidden = false;
            return;
        }
        const prevToken = getBalanceToken();
        const prevUserId = getBalanceUserId();
        const prevBase = localStorage.getItem('ai_balance_base') || '';
        localStorage.setItem('ai_balance_token', token);
        localStorage.setItem('ai_balance_user_id', userId);
        localStorage.setItem('ai_balance_base', getActiveBaseUrl());
        saveBtn.disabled = true;
        saveBtn.textContent = '查询中…';
        try {
            await queryBalance();
            close();
            addLog('余额 token 已绑定', 'success');
        } catch (err) {
            if (prevToken) localStorage.setItem('ai_balance_token', prevToken); else localStorage.removeItem('ai_balance_token');
            if (prevUserId) localStorage.setItem('ai_balance_user_id', prevUserId); else localStorage.removeItem('ai_balance_user_id');
            if (prevBase) localStorage.setItem('ai_balance_base', prevBase); else localStorage.removeItem('ai_balance_base');
            renderBalanceEmpty('余额查询失败：' + err.message);
            errEl.textContent = err.message;
            errEl.hidden = false;
            saveBtn.disabled = false;
            saveBtn.textContent = '绑定并查询';
        }
    };
}

// ============================================================
// 连接 API
// ============================================================
async function connectApi() {
    const baseUrl = getActiveBaseUrl();
    const apiKey = els.apiKeyInput.value.trim();

    if (!baseUrl) { addLog('请先选择模型供应商', 'warn'); return; }
    if (!apiKey) { addLog('请输入 API Key', 'warn'); return; }

    state.baseUrl = baseUrl;
    state.apiKey = apiKey;
    state.isConnected = false;

    els.connectBtn.disabled = true;
    els.connectBtn.textContent = '连接中…';
    setStatus('run');
    addLog(`正在连接 ${state.baseUrl} …`);

    try {
        const models = await fetchModels();
        const allowed = getAllowedModels();
        state.models = allowed.length > 0
            ? models.filter(m => allowed.some(a => m.toLowerCase().includes(a.toLowerCase()) || a.toLowerCase().includes(m.toLowerCase())))
            : models;
        state.isConnected = true;

        els.connTag.hidden = false;
        setStatus('idle');
        addLog(`连接成功，共 ${state.models.length} 个可用模型`, 'success');

        localStorage.setItem('ai_key', apiKey);
        saveActiveNode(baseUrl);
        if (getBalanceToken() && isBalancePanelEnabled()) refreshBalance();

        renderModelChips();
        updateGenerateButton();
    } catch (err) {
        els.connTag.hidden = true;
        setStatus('error');
        addLog('连接失败：' + err.message, 'err');
    } finally {
        els.connectBtn.disabled = false;
        els.connectBtn.textContent = '连接';
        updateGenerateButton();
    }
}

async function fetchModels() {
    const mode = getRequestMode();
    const baseUrl = getActiveBaseUrl();
    let url, headers;
    if (mode === 'backend') {
        url = '/api/proxy/v1/models';
        headers = { 'X-Target-Base': baseUrl, 'Authorization': `Bearer ${state.apiKey}` };
    } else {
        url = `${baseUrl}/v1/models`;
        headers = { 'Authorization': `Bearer ${state.apiKey}` };
    }
    const resp = await fetch(url, { headers });
    const data = await safeJson(resp);
    if (data.error) throw new Error(data.error.message || '获取模型列表失败');
    // 兼容不同格式
    if (Array.isArray(data.data)) return data.data.map(m => m.id);
    if (Array.isArray(data.models)) return data.models.map(m => m.id || m);
    if (Array.isArray(data)) return data.map(m => m.id || m);
    return [];
}

// ============================================================
// 模型选择
// ============================================================
function renderModelChips() {
    els.modelChips.innerHTML = '';
    if (state.models.length === 0) {
        els.modelChips.innerHTML = '<div class="hint">无可用模型</div>';
        return;
    }
    state.models.forEach(m => {
        const chip = document.createElement('button');
        chip.className = 'm-chip' + (m === state.selectedModel ? ' active' : '');
        chip.textContent = m;
        chip.dataset.model = m;
        chip.addEventListener('click', () => selectModel(m));
        els.modelChips.appendChild(chip);
    });
}

function selectModel(model) {
    state.selectedModel = model;
    $$('.m-chip').forEach(c => c.classList.toggle('active', c.dataset.model === model));
    // 根据模型配置决定是否显示参考图面板
    const cfg = getModelCfg(model);
    const canRef = cfg.ref_image !== false;
    els.refPnl.style.display = canRef ? '' : 'none';
    if (!canRef) {
        state.refImages = [];
        renderRefThumbs();
        addLog(`${model} 不支持参考图片`, 'warn');
    }
    addLog(`已选择模型：${model}（${cfg.endpoint === 'chat' ? 'Chat' : 'Images'} 模式）`);
}

// ============================================================
// 比例切换
// ============================================================
function selectRatio(ratio) {
    state.ratio = ratio;
    $$('.r-btn').forEach(b => b.classList.toggle('active', b.dataset.ratio === ratio));
    if (els.ratioLabel) els.ratioLabel.textContent = ratio;
    updateResolutionLabel();
}

function selectResolution(resolution) {
    if (!SIZE_MAP[resolution]) return;
    state.resolution = resolution;
    $$('.seg-btn').forEach(b => b.classList.toggle('active', b.dataset.resolution === resolution));
    updateResolutionLabel();
}

function captureGenerationParams(prompt = state.prompt) {
    return {
        model: state.selectedModel,
        prompt,
        ratio: state.ratio,
        resolution: state.resolution,
        quality: state.quality,
        outputFormat: state.outputFormat,
        outputCompression: state.outputCompression,
        background: state.background,
        moderation: state.moderation,
        count: state.count,
        maxConcurrency: state.maxConcurrency,
        baseUrl: getActiveBaseUrl(),
        refImageCount: state.refImages.length,
    };
}

async function _refImageToDataUrl(src) {
    if (!src) return null;
    if (src.startsWith('data:image/')) return src;
    try {
        const resp = await fetch(src);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const blob = await resp.blob();
        if (blob.type && !blob.type.startsWith('image/')) return null;
        const b64 = await _blobToBase64(blob);
        return b64 ? `data:${blob.type || 'image/png'};base64,${b64}` : null;
    } catch {
        return null;
    }
}

async function applyGenerationParams(batch) {
    const params = batch?.params || {};
    const model = params.model || batch?.model || '';
    const prompt = params.prompt ?? batch?.text ?? '';

    if (prompt !== '') {
        els.promptInput.value = prompt;
        state.prompt = prompt;
    }

    if (model) {
        if (!state.models.includes(model)) {
            state.models.unshift(model);
            renderModelChips();
        }
        selectModel(model);
    }

    selectRatio(params.ratio || state.ratio || '1:1');
    selectResolution(params.resolution || state.resolution || '1k');

    state.quality = params.quality || state.quality || 'auto';
    if (els.qualitySelect) els.qualitySelect.value = state.quality;

    state.outputFormat = params.outputFormat || state.outputFormat || 'png';
    if (els.formatSelect) els.formatSelect.value = state.outputFormat;
    if (els.compressionField) els.compressionField.hidden = !(state.outputFormat === 'jpeg' || state.outputFormat === 'webp');

    if (Number.isFinite(Number(params.outputCompression))) {
        state.outputCompression = Number(params.outputCompression);
        if (els.compressionSlider) els.compressionSlider.value = state.outputCompression;
        if (els.compressionVal) els.compressionVal.textContent = state.outputCompression;
    }

    state.background = params.background || state.background || 'auto';
    if (els.backgroundSelect) els.backgroundSelect.value = state.background;

    state.moderation = params.moderation || state.moderation || 'auto';
    if (els.moderationSelect) els.moderationSelect.value = state.moderation;

    if (Number.isFinite(Number(params.count))) {
        state.count = Number(params.count);
        if (els.countSlider) els.countSlider.value = state.count;
        if (els.countVal) els.countVal.textContent = state.count;
    }

    if (Number.isFinite(Number(params.maxConcurrency))) {
        state.maxConcurrency = Math.max(1, Math.min(16, Number(params.maxConcurrency)));
        if (els.concurrencySlider) els.concurrencySlider.value = state.maxConcurrency;
        if (els.concurrencyVal) els.concurrencyVal.textContent = state.maxConcurrency;
    }

    if (params.baseUrl && els.nodeSelect) {
        const normalized = normalizeBaseUrl(params.baseUrl);
        const qianyeLine = qianyeLineByUrl(normalized);
        if (qianyeLine) {
            els.nodeSelect.value = PROVIDER_QIANYE;
            if (els.qianyeLineSelect) els.qianyeLineSelect.value = qianyeLine.id;
        } else if (normalized === normalizeBaseUrl(LOCAL_NEWAPI_URL)) {
            els.nodeSelect.value = PROVIDER_LOCAL_NEWAPI;
        } else if (els.customBaseInput) {
            els.nodeSelect.value = CUSTOM_NODE_VALUE;
            els.customBaseInput.value = normalized;
        }
        updateProviderFields();
        state.baseUrl = normalized;
        saveActiveNode(normalized);
    }

    const canUseRefImages = !model || getModelCfg(model).ref_image !== false;
    const hasRefMeta = Array.isArray(batch?.refImages) || Number.isFinite(Number(params.refImageCount));
    if (hasRefMeta) {
        const sourceRefs = Array.isArray(batch?.refImages) ? batch.refImages.filter(Boolean).slice(0, 4) : [];
        const refs = canUseRefImages
            ? (await Promise.all(sourceRefs.map(_refImageToDataUrl))).filter(Boolean).slice(0, 4)
            : [];
        state.refImages = refs;
        renderRefThumbs();
        if (Number(params.refImageCount || 0) > 0 && refs.length === 0) {
            addLog('这条历史记录没有可恢复的参考图数据，可能是旧版本生成或本地缓存已被清理', 'warn');
        }
    }

    addLog(`已加载历史参数：${model || '未知模型'}`, 'success');
    showToast(state.refImages.length ? `已加载生成参数和 ${state.refImages.length} 张参考图` : '已加载生成参数', 'success');
    els.promptInput?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// ============================================================
// 参考图片
// ============================================================
/** 压缩图片：最大边不超过 MAX_REF_PX，JPEG quality 0.85，每张 ≤ ~1-2MB */
const MAX_REF_PX = 2048;
const REF_QUALITY = 0.85;
const HISTORY_MAX_BATCHES = 50;

function _compressImage(file) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        const objectUrl = URL.createObjectURL(file);
        img.onload = () => {
            URL.revokeObjectURL(objectUrl);
            let { width, height } = img;
            // 缩放到最大边 MAX_REF_PX
            if (width > MAX_REF_PX || height > MAX_REF_PX) {
                const scale = MAX_REF_PX / Math.max(width, height);
                width = Math.round(width * scale);
                height = Math.round(height * scale);
            }
            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, width, height);
            // 输出为 JPEG dataURL（PNG 参考图也转 JPEG 减小体积）
            const dataUrl = canvas.toDataURL('image/jpeg', REF_QUALITY);
            const sizeKB = Math.round(dataUrl.length * 3 / 4 / 1024);
            resolve({ dataUrl, sizeKB, width, height });
        };
        img.onerror = () => {
            URL.revokeObjectURL(objectUrl);
            reject(new Error('图片加载失败'));
        };
        img.src = objectUrl;
    });
}

function handleRefFiles(files) {
    const remaining = 4 - state.refImages.length;
    if (remaining <= 0) { addLog('参考图片最多 4 张', 'warn'); return; }
    const toLoad = Array.from(files).slice(0, remaining);
    toLoad.forEach(async file => {
        if (!file.type.startsWith('image/')) { addLog(`"${file.name}" 不是图片，已跳过`, 'warn'); return; }
        try {
            const origKB = Math.round(file.size / 1024);
            const { dataUrl, sizeKB, width, height } = await _compressImage(file);
            state.refImages.push(dataUrl);
            renderRefThumbs();
            addLog(`参考图已添加：${file.name}（${width}×${height}, ${origKB}KB→${sizeKB}KB, ${state.refImages.length}/4）`);
        } catch {
            addLog(`读取图片失败：${file.name}`, 'err');
        }
    });
}

function renderRefThumbs() {
    els.refThumbs.innerHTML = '';
    if (state.refImages.length === 0) {
        els.refThumbs.hidden = true;
        els.dropHint.hidden = false;
        return;
    }
    els.refThumbs.hidden = false;
    els.dropHint.hidden = true;

    state.refImages.forEach((src, i) => {
        const wrap = document.createElement('div');
        wrap.className = 'th';
        wrap.innerHTML = `<img src="${src}" alt="ref${i}">
            <button class="th-x" data-index="${i}">×</button>`;
        els.refThumbs.appendChild(wrap);
    });

    // Add button if less than 4
    if (state.refImages.length < 4) {
        const addBtn = document.createElement('div');
        addBtn.className = 'th th-add';
        addBtn.textContent = '+';
        addBtn.addEventListener('click', e => { e.stopPropagation(); els.refFileInput.click(); });
        els.refThumbs.appendChild(addBtn);
    }

    // Bind delete events
    $$('.th-x').forEach(btn => {
        btn.addEventListener('click', e => {
            e.stopPropagation();
            const idx = parseInt(btn.dataset.index);
            state.refImages.splice(idx, 1);
            renderRefThumbs();
            addLog('参考图已删除');
        });
    });
}

// ============================================================
// 生成图片
// ============================================================
async function generateImages() {
    return enqueueGenerationTask();
}

function createGenerationTask() {
    if (!state.isConnected) { addLog('请先连接 API', 'warn'); return; }
    if (!state.selectedModel) { addLog('请先选择模型', 'warn'); return; }

    const prompt = els.promptInput.value.trim();
    if (!prompt) { addLog('请输入提示词', 'warn'); return; }

    const params = captureGenerationParams(prompt);
    return {
        id: uid(),
        seq: ++state.queueSeq,
        status: 'queued',
        prompt,
        finalPrompt: '',
        model: state.selectedModel,
        ratio: state.ratio,
        resolution: state.resolution,
        quality: state.quality,
        outputFormat: state.outputFormat,
        outputCompression: state.outputCompression,
        background: state.background,
        moderation: state.moderation,
        count: state.count,
        maxConcurrency: state.maxConcurrency,
        baseUrl: getActiveBaseUrl(),
        apiKey: state.apiKey,
        refImages: state.refImages.slice(0, 4),
        params,
        createdAt: Date.now(),
    };
}

function enqueueGenerationTask() {
    const pendingCount = state.queue.filter(t => t.status === 'queued').length;
    if (pendingCount >= QUEUE_MAX_PENDING) {
        addLog(`生成队列最多保留 ${QUEUE_MAX_PENDING} 个等待任务，请先等待或取消部分任务`, 'warn');
        return;
    }
    const task = createGenerationTask();
    if (!task) return;
    state.prompt = task.prompt;
    state.queue.push(task);
    addLog(`已加入生成队列 #${task.seq}：${task.model} · ${task.count} 张`, state.isGenerating ? 'success' : '');
    renderQueuePanel();
    updateGenerateButton();
    processGenerationQueue();
}

async function processGenerationQueue() {
    if (state.isGenerating) return;
    const task = state.queue.find(t => t.status === 'queued');
    if (!task) {
        renderQueuePanel();
        updateGenerateButton();
        return;
    }

    task.status = 'running';
    state.activeTaskId = task.id;
    state.isGenerating = true;
    renderQueuePanel();
    updateGenerateButton();

    try {
        await runGenerationTask(task);
    } finally {
        state.queue = state.queue.filter(t => t.id !== task.id);
        state.activeTaskId = '';
        state.isGenerating = false;
        stopLogTimer();
        renderQueuePanel();
        updateGenerateButton();
        processGenerationQueue();
    }
}

async function runGenerationTask(task) {
    const modelCfg = getModelCfg(task.model);
    const isChat = modelCfg.endpoint === 'chat';
    const hasRef = task.refImages.length > 0;

    setStatus('run');
    startLogTimer();
    showSkeletonResults(task.count, task);
    startProgressAnimation(task.count);

    // Chat 模式：仅当模型配置 inject_ratio !== false 时才在 prompt 中注入比例描述
    // grok / 其他自带尺寸能力的模型应设 inject_ratio: false，避免污染 prompt
    let finalPrompt = task.prompt;
    if (isChat && modelCfg.inject_ratio !== false) {
        finalPrompt = `Make the aspect ratio ${task.ratio} (${getPixelSize(task.ratio, task.resolution)}), ${task.prompt}`;
    }
    task.finalPrompt = finalPrompt;

    try {
        let images = [];
        const mode = getRequestMode();
        if (isChat) {
            images = await genGemini(finalPrompt, task.count, mode, task);
        } else if (hasRef) {
            images = await genWithRefImages(finalPrompt, task.count, mode, task);
        } else {
            images = await genStandard(finalPrompt, task.count, mode, task);
        }

        // 保存到历史
        const batchId = uid();
        const refImages = hasRef ? task.refImages.slice(0, 4) : [];
        const batch = {
            id: batchId,
            model: task.model,
            time: new Date().toLocaleString('zh-CN'),
            images,
            text: task.prompt,
            params: task.params,
            refImages,
        };
        state.history.unshift(batch);
        const removedBatches = state.history.splice(HISTORY_MAX_BATCHES);
        if (removedBatches.length) {
            await deleteHistoryBatchLocalData(removedBatches);
            await Promise.all(removedBatches.map(b => _deleteLocalFileBatch(b.id)));
        }
        await saveHistory();

        renderResultBatch(batch);
        finishProgress();
        setStatus('ok');
        addLog(`队列任务 #${task.seq} 生成完成！共 ${images.length} 张图片`, 'success');

    } catch (err) {
        setStatus('error');
        addLog(`队列任务 #${task.seq} 生成失败：${err.message}`, 'err');
        removeSkeletonResults();
        stopProgressAnimation();
        els.progressWrap.hidden = true;
    }
}

async function genStandard(prompt, count, mode, ctx = state) {
    const endpoint = mode === 'backend' ? '/api/proxy/v1/images/generations' : `${getActiveBaseUrl(ctx)}/v1/images/generations`;
    const headers = buildHeaders(mode, ctx);
    const imageOptions = getImageOptions(ctx);
    const body = {
        model: ctx.model || ctx.selectedModel,
        prompt,
        n: count,
        ...imageOptions,
    };
    addLog(`请求生成 ${count} 张图片，size=${imageOptions.size}，resolution=${imageOptions.resolution}`);
    const data = await requestJsonWithUrlFallback(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
    }, body);
    if (data.error) throw new Error(parseError(data));
    return resolveImageResponse(data, count, mode, ctx);
}

async function genWithRefImages(prompt, count, mode, ctx = state) {
    if (count <= 1) {
        const images = await genWithRefImagesOnce(prompt, 1, mode, '', ctx);
        renderPartialGeneratedImages(images);
        return images.slice(0, 1);
    }

    const concurrency = getRefImageConcurrency(count, ctx);
    addLog(`图生图多张将按 ${concurrency} 路并发发送 ${count} 个单张请求，避免上游忽略 n=${count}`, 'warn');
    const images = [];
    const errors = [];

    await runLimitedConcurrency(count, concurrency, async (i) => {
        const label = `并发 ${i + 1}/${count}`;
        try {
            const result = await genWithRefImagesOnce(prompt, 1, mode, label, ctx);
            const spaceLeft = count - images.length;
            const accepted = spaceLeft > 0 ? result.slice(0, spaceLeft) : [];
            if (!accepted.length) {
                addLog(`${label} 未返回图片`, 'warn');
                return;
            }
            images.push(...accepted);
            renderPartialGeneratedImages(images);
        } catch (err) {
            errors.push(err);
            addLog(`${label} 失败：${err.message}`, 'warn');
        }
    });

    if (!images.length) throw errors[0] || new Error('图生图未返回图片');
    if (images.length < count) addLog(`并发生成完成，但只拿到 ${images.length}/${count} 张，已保留成功图片`, 'warn');
    return images.slice(0, count);
}

function getRefImageConcurrency(count, ctx = state) {
    return Math.min(count, Math.max(1, Number(ctx.maxConcurrency) || 1));
}

async function runLimitedConcurrency(total, limit, worker) {
    let next = 0;
    const workers = Array.from({ length: Math.min(total, Math.max(1, limit)) }, async () => {
        while (next < total) {
            const index = next;
            next += 1;
            await worker(index);
        }
    });
    await Promise.all(workers);
}

async function genWithRefImagesOnce(prompt, count, mode, label = '', ctx = state) {
    if (mode === 'backend' && _getTauriInvoke()) {
        const directStarted = Date.now();
        try {
            addLog(`${label ? label + '：' : ''}直连请求图生图 ${count} 张，参考图 ${(ctx.refImages || []).length} 张，size=${getPixelSize(ctx.ratio, ctx.resolution)}`);
            const directData = await requestDirectImageEditWithUrlFallback(prompt, count, ctx);
            if (directData.error) throw new Error(parseError(directData));
            return resolveImageResponse(directData, count, mode, ctx);
        } catch (err) {
            const elapsed = Date.now() - directStarted;
            if (elapsed > 10000) throw new Error(`直连图生图请求失败：${errorMessage(err)}`);
            addLog(`直连不可用，改用原生请求：${errorMessage(err)}`, 'warn');
        }

        try {
            addLog(`${label ? label + '：' : ''}原生请求图生图 ${count} 张，参考图 ${(ctx.refImages || []).length} 张，size=${getPixelSize(ctx.ratio, ctx.resolution)}`);
            const nativeData = await requestNativeImageEditWithUrlFallback(prompt, count, ctx);
            if (nativeData.error) throw new Error(parseError(nativeData));
            return resolveImageResponse(nativeData, count, mode, ctx);
        } catch (err) {
            throw new Error(errorMessage(err));
        }
    }

    const endpoint = mode === 'backend' ? '/api/proxy/v1/images/edits' : `${getActiveBaseUrl(ctx)}/v1/images/edits`;
    const headers = buildHeadersMultipart(ctx);
    const imageOptions = getImageOptions(ctx);
    const form = new FormData();
    form.append('model', ctx.model || ctx.selectedModel);
    form.append('prompt', prompt);
    form.append('n', String(count));
    Object.entries(imageOptions).forEach(([key, value]) => {
        form.append(key, String(value));
    });
    (ctx.refImages || state.refImages).forEach((b64, i) => {
        const blob = dataURLtoBlob(b64);
        form.append('image', blob, `ref_${i}.png`);
    });
    addLog(`${label ? label + '：' : ''}请求图生图 ${count} 张，参考图 ${(ctx.refImages || []).length} 张，size=${imageOptions.size}`);
    const data = await requestJsonWithUrlFallback(endpoint, { method: 'POST', headers, body: form }, form, true);
    if (data.error) throw new Error(parseError(data));
    return resolveImageResponse(data, count, mode, ctx);
}

async function resolveImageResponse(data, count, mode, ctx = state) {
    const directImages = extractImageResults(data);
    if (directImages.length > 0) {
        return cacheHttpImages(directImages.slice(0, count), ctx);
    }

    const taskIds = extractTaskIds(data);
    if (taskIds.length > 0) {
        addLog(`任务已提交，开始轮询 ${taskIds.length} 个 task_id`);
        const results = [];
        for (const taskId of taskIds) {
            const taskImages = await pollImageTask(taskId, mode, count - results.length, ctx);
            results.push(...taskImages);
            if (results.length >= count) break;
        }
        return cacheHttpImages(results.slice(0, count), ctx);
    }

    throw new Error('图片接口返回格式无法解析：未找到图片或 task_id');
}

function extractTaskIds(data) {
    const ids = [];
    const visit = (value) => {
        if (!value) return;
        if (Array.isArray(value)) {
            value.forEach(visit);
            return;
        }
        if (typeof value !== 'object') return;
        if (typeof value.task_id === 'string') ids.push(value.task_id);
        const status = String(value.status || '').toLowerCase();
        if (typeof value.id === 'string' && /submitted|queued|in_progress|processing/.test(status)) ids.push(value.id);
        ['data', 'result', 'task', 'tasks'].forEach(key => {
            if (value[key] && value[key] !== value) visit(value[key]);
        });
    };
    visit(data);
    return [...new Set(ids)];
}

function extractImageResults(data) {
    const images = [];
    const add = (item) => {
        const img = normalizeImageResult(item);
        if (img) images.push(img);
    };

    const roots = [
        data,
        data?.data,
        data?.result,
        data?.data?.result,
        data?.output,
        data?.data?.output,
    ];

    roots.forEach(root => {
        if (!root) return;
        if (Array.isArray(root)) {
            root.forEach(item => {
                add(item);
                if (item?.result?.images) item.result.images.forEach(add);
                if (item?.images) item.images.forEach(add);
            });
            return;
        }
        add(root);
        if (Array.isArray(root.data)) root.data.forEach(add);
        if (Array.isArray(root.images)) root.images.forEach(add);
        if (Array.isArray(root.result?.images)) root.result.images.forEach(add);
    });

    return images.filter((img, idx, arr) => {
        const key = img.b64_json || img.url;
        return key && arr.findIndex(x => (x.b64_json || x.url) === key) === idx;
    });
}

function normalizeImageResult(item) {
    if (!item) return null;
    if (typeof item === 'string') return normalizeImageString(item);
    if (typeof item !== 'object') return null;

    const b64 = item.b64_json || item.base64 || item.b64 || item.image_base64 || item.data?.b64_json;
    if (typeof b64 === 'string' && b64.length > 100) {
        return { b64_json: b64.replace(/^data:image\/[^;]+;base64,/, '').replace(/\s/g, ''), url: '' };
    }

    const urlValue = item.url || item.image_url || item.image?.url || item.data?.url;
    const url = Array.isArray(urlValue) ? urlValue[0] : urlValue;
    if (typeof url === 'string') return normalizeImageString(url);

    return null;
}

function normalizeImageString(value) {
    const dataUrl = _extractFromDataUrl(value);
    if (dataUrl) return dataUrl;
    if (/^https?:\/\//.test(value)) return { b64_json: '', url: value };
    const clean = value.replace(/\s/g, '');
    if (/^[A-Za-z0-9+/]+=*$/.test(clean) && clean.length > 200) return { b64_json: clean, url: '' };
    return null;
}

async function pollImageTask(taskId, mode, expectedCount = 1, ctx = state) {
    const endpoint = mode === 'backend'
        ? `/api/proxy/v1/tasks/${encodeURIComponent(taskId)}`
        : `${getActiveBaseUrl(ctx)}/v1/tasks/${encodeURIComponent(taskId)}`;
    const timeoutMs = ctx.resolution === '4k' || ctx.quality === 'high' ? 240000 : 180000;
    const started = Date.now();
    let lastProgress = -1;

    await sleep(10000);
    while (Date.now() - started < timeoutMs) {
        const resp = await fetch(endpoint, { headers: buildHeaders(mode, ctx) });
        const data = await safeJson(resp);
        if (data.error) throw new Error(parseError(data));

        const payload = data.data || data;
        const status = String(payload.status || data.status || '').toLowerCase();
        const isFailed = /failed|error|cancel/.test(status);
        const isDone = /complete|completed|succeeded|success|finished|done/.test(status);
        const progress = Number(payload.progress ?? data.progress ?? -1);
        if (Number.isFinite(progress) && progress >= 0 && progress !== lastProgress && progress % 25 === 0) {
            lastProgress = progress;
            addLog(`任务 ${taskId.slice(0, 10)}… 进度 ${progress}%`);
        }

        const images = extractImageResults(data);
        if (images.length >= expectedCount && !isFailed) {
            addLog(`任务 ${taskId.slice(0, 10)}… 已完成`);
            return images;
        }

        if (images.length > 0 && (isDone || !status) && !isFailed) {
            addLog(`任务 ${taskId.slice(0, 10)}… 已完成，返回 ${images.length}/${expectedCount} 张`, images.length < expectedCount ? 'warn' : '');
            return images;
        }

        if (isFailed) {
            const msg = payload.error?.message || payload.message || payload.error || '任务生成失败';
            throw new Error(String(msg));
        }

        await sleep(4000);
    }
    throw new Error(ERROR_MAP.poll_timeout);
}

async function cacheHttpImages(images, ctx = state) {
    const out = [];
    for (const img of images) {
        if (!img.b64_json && img.url && img.url.startsWith('http')) {
            const b64 = await _urlToBase64(img.url, ctx.apiKey || state.apiKey);
            if (b64) {
                out.push({ b64_json: b64, url: '' });
                continue;
            }
        }
        out.push(img);
    }
    return out;
}

async function genGemini(prompt, count, mode, ctx = state) {
    const images = [];
    const modelId = ctx.model || ctx.selectedModel;
    const hasRef = (ctx.refImages || []).length > 0;
    if (hasRef) addLog(`Chat 图生图模式，参考图 ${(ctx.refImages || []).length} 张`);
    for (let i = 0; i < count; i++) {
        let attempt = 0;
        let lastErr;
        while (attempt < 3) {
            attempt++;
            try {
                addLog(`Chat 生成第 ${i + 1}/${count} 张（尝试 ${attempt}/3）…`);
                const img = await genOneGemini(prompt, modelId, mode, ctx);
                // HTTP URL 的图片（如 Gemini CDN 临时链接）立即下载转 base64，防止过期丢失
                if (!img.b64_json && img.url && img.url.startsWith('http')) {
                    try {
                        const b64 = await _urlToBase64(img.url, ctx.apiKey || state.apiKey);
                        if (b64) { img.b64_json = b64; img.url = ''; }
                    } catch {}
                }
                images.push(img);
                break;
            } catch (err) {
                lastErr = err;
                addLog(`第 ${i + 1} 张生成失败（${attempt}/3）：${err.message}`, 'warn');
                if (attempt < 3) await sleep(1500);
            }
        }
        if (images.length === i) {
            throw lastErr || new Error('Chat 生成失败');
        }
    }
    return images;
}

async function genOneGemini(prompt, modelId, mode, ctx = state) {
    const endpoint = mode === 'backend' ? '/api/proxy/v1/chat/completions' : `${getActiveBaseUrl(ctx)}/v1/chat/completions`;
    const headers = buildHeaders(mode, ctx);
    const modelCfg = getModelCfg(modelId);
    const plainContent = modelCfg.plain_content === true;

    // 构建 content：
    //   plain_content=true  → 纯字符串（兼容 grok 等只接受 string 的模型）
    //   plain_content=false → 数组格式（支持多模态参考图的模型，如 Gemini）
    let msgContent;
    if (plainContent && (ctx.refImages || []).length === 0) {
        // 纯字符串，无参考图
        msgContent = prompt;
    } else {
        // 数组格式，支持图文混合
        const parts = [];
        (ctx.refImages || []).forEach(dataUrl => {
            parts.push({ type: 'image_url', image_url: { url: dataUrl } });
        });
        parts.push({ type: 'text', text: prompt });
        msgContent = parts;
    }

    const body = {
        model: modelId,
        messages: [{ role: 'user', content: msgContent }],
        stream: false,
    };
    const resp = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body) });
    const data = await safeJson(resp);
    if (data.error) throw new Error(parseError(data));

    // ---- 路径1：标准 OpenAI choices 格式 ----
    const msg = data.choices?.[0]?.message;
    if (msg) {
        // 优先从 message.images 提取（NewAPI/OneAPI 格式）
        if (Array.isArray(msg.images) && msg.images.length > 0) {
            const result = _parseChatImage(msg.images);
            if (result) return result;
        }
        // 其次从 message.content 提取（标准 OpenAI 格式）
        if (msg.content) {
            const result = _parseChatImage(msg.content);
            if (result) return result;
        }
    }

    // ---- 路径2：顶层 content 字段（部分中间件/代理层格式）----
    // 形如：{ "type":"main_text","status":"success","content":"![image](http://...)" }
    if (data.content) {
        const result = _parseChatImage(data.content);
        if (result) return result;
    }

    // ---- 路径3：顶层 choices 里 delta 格式（部分流式兼容格式）----
    const delta = data.choices?.[0]?.delta;
    if (delta) {
        if (delta.content) {
            const result = _parseChatImage(delta.content);
            if (result) return result;
        }
    }

    // ---- 路径4：顶层直接含有图片字段 ----
    if (data.url && typeof data.url === 'string') {
        const result = _parseChatImage(data.url);
        if (result) return result;
    }
    if (data.image_url) {
        const result = _parseChatImage(data.image_url);
        if (result) return result;
    }

    throw new Error('Chat 返回格式无法解析');
}

/** 从 chat/completions 的 content 中提取图片，兼容多种返回格式 */
function _parseChatImage(content) {
    if (!content) return null;

    // 格式1: content 是数组（multipart content parts）
    if (Array.isArray(content)) {
        for (const part of content) {
            // {type:"image_url", image_url:{url:"data:image/...;base64,xxxx"}}
            if (part.type === 'image_url' || part.image_url) {
                const url = part.image_url?.url || '';
                const r = _extractFromDataUrl(url);
                if (r) return r;
                if (url.startsWith('http')) return { b64_json: '', url };
            }
            // {type:"image", data:"base64..."} 或 {type:"image", url:"http..."}
            if (part.type === 'image') {
                if (part.data) {
                    const d = part.data.replace(/^data:image\/[^;]+;base64,/, '');
                    return { b64_json: d, url: '' };
                }
                if (part.url && part.url.startsWith('http')) return { b64_json: '', url: part.url };
            }
            // {type:"text", text:"data:image/...;base64,xxx"}
            if (part.type === 'text' && part.text) {
                const r = _extractFromText(part.text);
                if (r) return r;
            }
        }
        return null;
    }

    // 格式2: content 是纯字符串
    if (typeof content === 'string') {
        return _extractFromText(content);
    }

    // 格式3: content 是对象（部分平台返回 {url:...} 或 {data:...}）
    if (typeof content === 'object') {
        if (content.url && typeof content.url === 'string') {
            const r = _extractFromDataUrl(content.url) || (content.url.startsWith('http') ? { b64_json: '', url: content.url } : null);
            if (r) return r;
        }
        if (content.data && typeof content.data === 'string') {
            const d = content.data.replace(/^data:image\/[^;]+;base64,/, '');
            if (d.length > 100) return { b64_json: d, url: '' };
        }
    }
    return null;
}

function _extractFromDataUrl(str) {
    if (!str) return null;
    const m = str.match(/^data:image\/[^;]+;base64,(.+)/s);
    if (m) return { b64_json: m[1].replace(/\s/g, ''), url: '' };
    return null;
}

function _extractFromText(text) {
    if (!text) return null;
    // 完整 dataURL: data:image/jpeg;base64,/9j/4AAQ...
    const dum = text.match(/data:image\/[^;]+;base64,([A-Za-z0-9+/=\s]+)/);
    if (dum) return { b64_json: dum[1].replace(/\s/g, ''), url: '' };
    // 裸 base64（长度 >200 且仅含合法字符）
    const raw = text.match(/([/+A-Za-z0-9][A-Za-z0-9+/=\s]{100,})/);
    if (raw) {
        const clean = raw[1].replace(/\s/g, '');
        if (/^[A-Za-z0-9+/]+=*$/.test(clean) && clean.length > 200) {
            return { b64_json: clean, url: '' };
        }
    }
    // Markdown 图片语法：![alt](url) 或 ![alt](url "title")，优先匹配
    const mdImg = text.match(/!\[[^\]]*\]\((https?:\/\/[^)\s"']+)/);
    if (mdImg) {
        const url = mdImg[1].replace(/[.,;!?）】\]]+$/, '');
        return { b64_json: '', url };
    }
    // 普通 http(s) URL（去掉末尾标点）
    const um = text.match(/https?:\/\/[^\s"'<>)]+/);
    if (um) {
        const url = um[0].replace(/[.,;!?）】\]]+$/, '');
        return { b64_json: '', url };
    }
    return null;
}

/** 下载 HTTP URL 图片并转成纯 base64 字符串（无 data: 前缀）
 *  优先前端直接 fetch，CORS 失败则走后端代理 */
async function _urlToBase64(url, apiKey) {
    // 1. 前端直接下载
    try {
        const resp = await fetch(url);
        if (resp.ok) {
            const blob = await resp.blob();
            if (blob.type && blob.type.startsWith('image/')) {
                const b64 = await _blobToBase64(blob);
                if (b64) return b64;
            }
        }
    } catch {}

    // 1b. 带 API Key 的前端直接下载（部分 API 服务器的文件需要鉴权）
    const key = apiKey || state.apiKey || '';
    if (key) {
        try {
            const resp = await fetch(url, { headers: { 'Authorization': `Bearer ${key}` } });
            if (resp.ok) {
                const blob = await resp.blob();
                if (blob.type && blob.type.startsWith('image/')) {
                    const b64 = await _blobToBase64(blob);
                    if (b64) return b64;
                }
            }
        } catch {}
    }

    // 2. 前端失败（CORS 等）→ 后端代理下载
    try {
        const resp = await fetch('/api/history/fetch-image', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url, api_key: key }),
        });
        if (resp.ok) {
            const data = await resp.json();
            if (data.success && data.b64_json) return data.b64_json;
        }
    } catch {}

    return null;
}

function _blobToBase64(blob) {
    return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => {
            const dataUrl = reader.result || '';
            const b64 = dataUrl.replace(/^data:[^;]+;base64,/, '');
            resolve(b64.length > 200 ? b64 : null);
        };
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(blob);
    });
}

function buildHeaders(mode, ctx = state) {
    const apiKey = ctx.apiKey || state.apiKey;
    if (mode === 'backend') {
        return {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
            'X-Target-Base': getActiveBaseUrl(ctx),
        };
    }
    return {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
    };
}

function buildHeadersMultipart(ctx = state) {
    const mode = getRequestMode();
    const apiKey = ctx.apiKey || state.apiKey;
    if (mode === 'backend') {
        return {
            'Authorization': `Bearer ${apiKey}`,
            'X-Target-Base': getActiveBaseUrl(ctx),
        };
    }
    return {
        'Authorization': `Bearer ${apiKey}`,
    };
}

function dataURLtoBlob(dataurl) {
    const arr = dataurl.split(',');
    const mime = arr[0].match(/:(.*?);/)[1];
    const bstr = atob(arr[1]);
    let n = bstr.length;
    const u8arr = new Uint8Array(n);
    while (n--) u8arr[n] = bstr.charCodeAt(n);
    return new Blob([u8arr], { type: mime });
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

// ============================================================
// 结果渲染 — 按模型→日期分组
// ============================================================
function _extractDate(timeStr) {
    // 从 "2026/4/27 14:30:00" 等格式提取日期部分
    if (!timeStr) return '未知日期';
    const m = timeStr.match(/(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})/);
    return m ? `${m[1]}年${m[2]}月${m[3]}日` : timeStr.split(' ')[0] || '未知日期';
}

function _extractTime(timeStr) {
    if (!timeStr) return '';
    const m = timeStr.match(/(\d{1,2}:\d{2}(:\d{2})?)/);
    return m ? m[1] : '';
}

let _expandTarget = null; // { model, date } — 生成时自动展开的目标

function renderAllResults() {
    els.resultArea.innerHTML = '';
    const expiredCount = _countExpiredHistoryImages();

    // 历史工具栏
    const toolbar = document.createElement('div');
    toolbar.className = 'r-toolbar';
    const localDirButton = _localFileHistoryEnabled()
        ? '<button class="r-open-local-dir" type="button" title="打开本机历史图片目录">📁 图片目录</button>'
        : '';
    toolbar.innerHTML = `
        ${localDirButton}
        ${state.history.length ? `<button class="r-clean-expired" type="button" title="清理已失效图片元数据和残留缓存">🧹 清理失效${expiredCount ? ` (${expiredCount})` : ''}</button>` : ''}
        ${state.history.length ? '<button class="r-clear-all" type="button" title="清空所有绘图历史">🗑️ 清空历史</button>' : ''}`;
    toolbar.querySelector('.r-open-local-dir')?.addEventListener('click', () => openLocalHistoryDir());
    toolbar.querySelector('.r-clean-expired')?.addEventListener('click', () => {
        const message = expiredCount
            ? `确定清理 ${expiredCount} 张已失效图片吗？会删除对应的历史占位和 IndexedDB/localStorage 残留，不影响仍可查看的图片。`
            : '当前没有显示为过期的图片。是否仍整理当前用户历史缓存，删除未被历史引用的 IndexedDB/localStorage 残留？';
        _confirmDialog(message, () => cleanupExpiredHistoryData());
    });
    toolbar.querySelector('.r-clear-all')?.addEventListener('click', () => {
        _confirmDialog('确定要清空所有绘图历史记录吗？此操作不可撤销。', () => clearAllHistory());
    });
    els.resultArea.appendChild(toolbar);

    if (!state.history.length) return;

    // 按模型分组
    const modelMap = {};
    state.history.forEach(batch => {
        const model = batch.model || '未知模型';
        if (!modelMap[model]) modelMap[model] = [];
        modelMap[model].push(batch);
    });

    Object.keys(modelMap).forEach(model => {
        const batches = modelMap[model];
        const modelGroup = document.createElement('div');
        modelGroup.className = 'rg-model';

        const totalImages = batches.reduce((s, b) => s + (b.images ? b.images.length : 0), 0);
        const head = document.createElement('div');
        head.className = 'rg-model-head';
        head.innerHTML = `<span class="rg-arrow">▼</span><span class="rg-model-name">${escHtml(model)}</span><span class="rg-model-count">${totalImages} 张</span>`;
        head.addEventListener('click', () => modelGroup.classList.toggle('collapsed'));
        modelGroup.appendChild(head);

        const body = document.createElement('div');
        body.className = 'rg-model-body';

        // 按日期分组
        const dateMap = {};
        batches.forEach(batch => {
            const date = _extractDate(batch.time);
            if (!dateMap[date]) dateMap[date] = [];
            dateMap[date].push(batch);
        });
        Object.keys(dateMap).forEach(date => {
            dateMap[date].sort((a, b) => (a.time || '') > (b.time || '') ? -1 : 1);
        });

        // 日期 keys 按降序排列（从新到旧）
        const sortedDates = Object.keys(dateMap).sort((a, b) => {
            // "2026年4月29日" → [2026, 4, 29]
            const pa = a.match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);
            const pb = b.match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);
            if (!pa || !pb) return 0;
            const da = new Date(+pa[1], +pa[2] - 1, +pa[3]);
            const db = new Date(+pb[1], +pb[2] - 1, +pb[3]);
            return db - da;
        });

        sortedDates.forEach(date => {
            const dateGroup = document.createElement('div');
            const shouldExpand = _expandTarget && _expandTarget.model === model && _expandTarget.date === date;
            dateGroup.className = shouldExpand ? 'rg-date' : 'rg-date collapsed';

            const dateImgCount = dateMap[date].reduce((s, b) => s + (b.images ? b.images.length : 0), 0);
            const dateHead = document.createElement('div');
            dateHead.className = 'rg-date-head';
            dateHead.innerHTML = `<div class="rg-date-left"><span class="rg-date-arrow">▼</span> 📅 ${escHtml(date)} <span style="font-weight:400;color:var(--text-mute)">(${dateImgCount} 张)</span></div>
                <button class="rg-date-del" title="删除该日期所有图片">🗑️</button>`;
            dateHead.querySelector('.rg-date-left').addEventListener('click', () => dateGroup.classList.toggle('collapsed'));
            dateHead.querySelector('.rg-date-del').addEventListener('click', (e) => {
                e.stopPropagation();
                const batchIds = dateMap[date].map(b => b.id);
                _confirmDialog(`确定删除 ${date} 的 ${dateImgCount} 张图片吗？`, async () => {
                    for (const id of batchIds) await deleteBatch(id, true);
                    renderAllResults();
                });
            });
            dateGroup.appendChild(dateHead);

            const grid = document.createElement('div');
            grid.className = 'r-grid';

            dateMap[date].forEach(batch => {
                batch.images.forEach((img, i) => {
                    const item = document.createElement('div');
                    item.className = 'r-item';

                    const isExpired = img._expired || (!img.b64_json && !img.url);
                    let src = '';
                    if (!isExpired) {
                        src = img.b64_json
                            ? `data:image/png;base64,${img.b64_json.replace(/^data:image\/[^;]+;base64,/, '')}`
                            : (img.url || '');
                    }

                    const imgEl = document.createElement('img');
                    imgEl.alt = `img${i}`;
                    imgEl.loading = 'lazy';
                    imgEl.src = src || _expiredSvg();
                    imgEl.onerror = function() { this.onerror = null; this.src = _expiredSvg(); };

                    // 图片内浮层按钮
                    const overlay = document.createElement('div');
                    overlay.className = 'r-overlay';
                    overlay.innerHTML = `
                        <button class="ro-btn" data-act="prompt" title="查看提示词">💬</button>
                        <button class="ro-btn" data-act="del" title="删除">🗑️</button>`;

                    const actions = document.createElement('div');
                    actions.className = 'r-actions';
                    actions.innerHTML = `
                        <button class="copy-btn" type="button" title="复制图片">📋</button>
                        <button class="download-btn" type="button" title="下载">⬇️</button>
                        <button class="reuse-btn" type="button" title="加载生成参数到工作台">♻️</button>
                        ${isGalleryEnabled() ? '<button class="upload-btn" type="button" title="上传广场">🎨</button>' : ''}`;

                    item.appendChild(imgEl);
                    item.appendChild(overlay);
                    item.appendChild(actions);

                    const displaySrc = imgEl.src;
                    imgEl.addEventListener('click', () => openPreview(displaySrc));
                    actions.querySelector('.copy-btn').addEventListener('click', () => copyImageToClipboard(displaySrc));
                    actions.querySelector('.download-btn').addEventListener('click', () => downloadImage(displaySrc, `${batch.id}_${i}`));
                    actions.querySelector('.reuse-btn').addEventListener('click', () => applyGenerationParams(batch));
                    if (isGalleryEnabled()) {
                        item.querySelector('.upload-btn').addEventListener('click', () => uploadToGallery(img, batch));
                    }
                    // 浮层按钮事件
                    overlay.querySelector('[data-act="prompt"]').addEventListener('click', (e) => {
                        e.stopPropagation();
                        _showPromptDialog(batch.text || '(无提示词)');
                    });
                    overlay.querySelector('[data-act="del"]').addEventListener('click', (e) => {
                        e.stopPropagation();
                        _confirmDialog('确定删除这张图片吗？', () => deleteSingleImage(batch.id, i));
                    });
                    grid.appendChild(item);
                });
            });

            dateGroup.appendChild(grid);
            body.appendChild(dateGroup);
        });

        modelGroup.appendChild(body);
        els.resultArea.appendChild(modelGroup);
    });
}

// ---- 自定义确认弹窗（替代 confirm）----
function _confirmDialog(msg, onConfirm) {
    const o = document.createElement('div');
    o.className = 'ann-overlay';
    o.innerHTML = `<div class="ann-box" style="width:380px;max-width:90vw">
        <div class="ann-header"><span>确认操作</span></div>
        <div class="ann-body" style="font-size:14px;line-height:1.7;padding:20px 24px">${escHtml(msg)}</div>
        <div style="padding:12px 24px;border-top:1px solid var(--border);display:flex;gap:8px;justify-content:flex-end">
            <button class="btn _cd-cancel">取消</button>
            <button class="btn" style="background:#ff3b30;color:#fff;border-color:#ff3b30" id="_cdOk">确认删除</button>
        </div></div>`;
    document.body.appendChild(o);
    o.querySelector('._cd-cancel').onclick = () => o.remove();
    o.querySelector('#_cdOk').onclick = () => { o.remove(); onConfirm(); };
}

// ---- 提示词查看弹窗 ----
function _showPromptDialog(text) {
    const o = document.createElement('div');
    o.className = 'ann-overlay';
    o.innerHTML = `<div class="ann-box" style="width:500px;max-width:92vw">
        <div class="ann-header"><span>💬 提示词</span><button class="ann-close _sp-close">✕</button></div>
        <div class="ann-body" style="font-size:14px;line-height:1.8;white-space:pre-wrap;word-break:break-all;max-height:60vh;overflow-y:auto;padding:16px 24px">${escHtml(text)}</div>
        <div style="padding:10px 24px;border-top:1px solid var(--border);display:flex;justify-content:flex-end">
            <button class="btn _sp-copy">📋 复制</button>
        </div></div>`;
    document.body.appendChild(o);
    o.querySelector('._sp-close').onclick = () => o.remove();
    o.querySelector('._sp-copy').onclick = () => {
        navigator.clipboard.writeText(text).then(() => showToast('已复制', 'success'));
    };
    o.addEventListener('click', (e) => { if (e.target === o) o.remove(); });
}

// ---- 删除单张图片 ----
async function deleteSingleImage(batchId, imgIndex) {
    const batch = state.history.find(b => b.id === batchId);
    if (!batch || !batch.images) return;

    // 删除 IndexedDB 中该图
    await _idbDeleteKeys([_imgKey(batchId, imgIndex)]);

    // 同步删除服务器端
    if (_serverHistoryEnabled()) {
        try {
            const token = getToken();
            await fetch(`/api/history/image/${encodeURIComponent(batchId)}/${imgIndex}`, {
                method: 'DELETE',
                headers: { 'Authorization': `Bearer ${token}` },
            });
        } catch {}
        renderUserPanel();
    }

    // 从 batch 中移除
    batch.images.splice(imgIndex, 1);

    // 如果 batch 没图了，整个删除
    if (batch.images.length === 0) {
        await deleteBatch(batchId);
    } else {
        await _deleteLocalFileImage(batchId, imgIndex);
        await _saveToLocal();
        renderAllResults();
    }
    addLog('已删除一张图片');
}

// ---- 放大编辑提示词弹窗 ----
function _expandPromptEditor() {
    const current = els.promptInput.value;
    const o = document.createElement('div');
    o.className = 'ann-overlay';
    o.innerHTML = `<div class="ann-box" style="width:700px;max-width:95vw">
        <div class="ann-header"><span>✏️ 编辑提示词</span><button class="ann-close _ep-close">✕</button></div>
        <div class="ann-body" style="padding:16px 24px">
            <textarea id="_epText" class="pg-textarea" rows="12" style="width:100%;resize:vertical;font-size:15px;line-height:1.7">${escHtml(current)}</textarea>
        </div>
        <div style="padding:12px 24px;border-top:1px solid var(--border);display:flex;gap:8px;justify-content:flex-end">
            <button class="btn _ep-cancel">取消</button>
            <button class="btn btn-primary _ep-ok">确定</button>
        </div></div>`;
    document.body.appendChild(o);
    const ta = o.querySelector('#_epText');
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
    o.querySelector('._ep-close').onclick = o.querySelector('._ep-cancel').onclick = () => o.remove();
    o.querySelector('._ep-ok').onclick = () => {
        els.promptInput.value = ta.value;
        state.prompt = ta.value;
        o.remove();
    };
}

function renderResultBatch(batch) {
    // 新 batch 加入后重新渲染全部分组，展开当前模型+今日日期
    _expandTarget = { model: batch.model, date: _extractDate(batch.time) };
    renderAllResults();
    _expandTarget = null;
    els.resultArea.scrollTo({ top: 0, behavior: 'smooth' });
}

// ---- 骨架屏：嵌入分组结构内部 ----

function showSkeletonResults(count, ctx = state) {
    // 移除旧骨架
    removeSkeletonResults();
    if (!count) return;

    const model = ctx.model || ctx.selectedModel || state.selectedModel || '未知模型';
    const todayDate = _extractDate(new Date().toLocaleString('zh-CN'));

    // 先渲染已有历史（确保分组结构存在）
    _expandTarget = { model, date: todayDate };
    renderAllResults();
    _expandTarget = null;

    // 找到对应模型分组，没有则创建临时分组
    let modelGroup = null;
    els.resultArea.querySelectorAll('.rg-model').forEach(g => {
        if (g.querySelector('.rg-model-name')?.textContent === model) modelGroup = g;
    });
    if (!modelGroup) {
        modelGroup = document.createElement('div');
        modelGroup.className = 'rg-model';
        modelGroup.innerHTML = `<div class="rg-model-head"><span class="rg-arrow">▼</span><span class="rg-model-name">${escHtml(model)}</span><span class="rg-model-count">生成中</span></div><div class="rg-model-body"></div>`;
        modelGroup.querySelector('.rg-model-head').addEventListener('click', () => modelGroup.classList.toggle('collapsed'));
        els.resultArea.prepend(modelGroup);
    }
    modelGroup.classList.remove('collapsed');

    // 找到今日日期分组，没有则创建
    const body = modelGroup.querySelector('.rg-model-body');
    let dateGroup = null;
    body.querySelectorAll('.rg-date').forEach(d => {
        const label = d.querySelector('.rg-date-head')?.textContent || '';
        if (label.includes(todayDate)) dateGroup = d;
    });
    if (!dateGroup) {
        dateGroup = document.createElement('div');
        dateGroup.className = 'rg-date';
        dateGroup.innerHTML = `<div class="rg-date-head"><span class="rg-date-arrow">▼</span> 📅 ${escHtml(todayDate)} <span style="font-weight:400;color:var(--text-mute)">(生成中)</span></div>`;
        dateGroup.querySelector('.rg-date-head').addEventListener('click', () => dateGroup.classList.toggle('collapsed'));
        body.prepend(dateGroup);
    }
    dateGroup.classList.remove('collapsed');

    // 找到或创建 grid
    let grid = dateGroup.querySelector('.r-grid');
    if (!grid) {
        grid = document.createElement('div');
        grid.className = 'r-grid';
        dateGroup.appendChild(grid);
    }

    // 创建骨架卡片（进度由 startProgressAnimation 统一驱动）
    for (let i = 0; i < count; i++) {
        const card = document.createElement('div');
        card.className = 'r-item skeleton-card';
        card.setAttribute('data-skeleton', 'true');
        card.innerHTML = `
            <div class="sk-body">
                <div class="sk-ring"><div class="sk-ring-inner"></div></div>
                <div class="sk-label">生成中 0%</div>
                <div class="sk-progress-wrap">
                    <div class="sk-progress-bar"></div>
                </div>
            </div>
            <div class="sk-shimmer"></div>
        `;
        grid.prepend(card);
    }

    els.resultArea.scrollTo({ top: 0, behavior: 'smooth' });
}

function imageResultToDisplaySrc(img) {
    if (!img || img._expired || (!img.b64_json && !img.url)) return _expiredSvg();
    return img.b64_json
        ? `data:image/png;base64,${img.b64_json.replace(/^data:image\/[^;]+;base64,/, '')}`
        : (img.url || _expiredSvg());
}

function createPartialResultCard(img, index) {
    const src = imageResultToDisplaySrc(img);
    const item = document.createElement('div');
    item.className = 'r-item partial-generated-card';
    item.setAttribute('data-partial-generated', 'true');

    const imgEl = document.createElement('img');
    imgEl.alt = `generated-${index + 1}`;
    imgEl.loading = 'lazy';
    imgEl.src = src;
    imgEl.onerror = function() { this.onerror = null; this.src = _expiredSvg(); };

    const overlay = document.createElement('div');
    overlay.className = 'r-overlay';
    overlay.innerHTML = '<button class="ro-btn" type="button" title="已生成，等待剩余图片完成">✅</button>';

    const actions = document.createElement('div');
    actions.className = 'r-actions';
    actions.innerHTML = `
        <button class="preview-btn" type="button" title="预览">🔍</button>
        <button class="download-btn" type="button" title="下载">⬇️</button>`;

    item.appendChild(imgEl);
    item.appendChild(overlay);
    item.appendChild(actions);

    imgEl.addEventListener('click', () => openPreview(imgEl.src));
    actions.querySelector('.preview-btn').addEventListener('click', () => openPreview(imgEl.src));
    actions.querySelector('.download-btn').addEventListener('click', () => downloadImage(imgEl.src, `partial_${Date.now()}_${index}`));
    return item;
}

function renderPartialGeneratedImages(images) {
    if (!Array.isArray(images) || !images.length) return;

    const shown = els.resultArea.querySelectorAll('[data-partial-generated="true"]').length;
    const nextImages = images.slice(shown);
    if (!nextImages.length) return;

    nextImages.forEach((img, offset) => {
        const index = shown + offset;
        const card = createPartialResultCard(img, index);
        const skeleton = els.resultArea.querySelector('[data-skeleton="true"]');
        if (skeleton) {
            skeleton.replaceWith(card);
            return;
        }
        const grid = els.resultArea.querySelector('.r-grid');
        if (grid) grid.prepend(card);
    });

    els.resultArea.scrollTo({ top: 0, behavior: 'smooth' });
}

function removeSkeletonResults() {
    els.resultArea.querySelectorAll('[data-skeleton="true"]').forEach(el => el.remove());
    // 清理可能留下的空临时分组
    els.resultArea.querySelectorAll('.rg-date').forEach(d => {
        const grid = d.querySelector('.r-grid');
        if (grid && grid.children.length === 0) d.remove();
    });
    els.resultArea.querySelectorAll('.rg-model').forEach(g => {
        const body = g.querySelector('.rg-model-body');
        if (body && body.children.length === 0) g.remove();
    });
}

// ============================================================
// 图片预览
// ============================================================
function openPreview(src) {
    els.previewImg.src = src;
    els.previewOverlay.hidden = false;
    els.previewOverlay.style.cursor = 'zoom-out';
}

function closePreview() {
    els.previewOverlay.hidden = true;
    els.previewImg.src = '';
}

els.previewOverlay.addEventListener('click', e => {
    if (e.target === els.previewOverlay) closePreview();
});
els.previewClose.addEventListener('click', closePreview);
document.addEventListener('keydown', e => { if (e.key === 'Escape') closePreview(); });

// ============================================================
// 图片下载
// ============================================================
function _isMobile() {
    return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
}

function _getTauriInvoke() {
    if (window.__TAURI__?.core?.invoke) {
        return (cmd, args) => window.__TAURI__.core.invoke(cmd, args);
    }
    if (window.__TAURI__?.invoke) {
        return (cmd, args) => window.__TAURI__.invoke(cmd, args);
    }
    if (window.__TAURI_INTERNALS__?.invoke) {
        return (cmd, args) => window.__TAURI_INTERNALS__.invoke(cmd, args);
    }
    return null;
}

async function openRegisterUrl(event) {
    const invoke = _getTauriInvoke();
    if (!invoke) return;
    if (event) event.preventDefault();

    try {
        await invoke('open_registration_url');
        addLog('已在系统浏览器打开注册页面', 'success');
        return;
    } catch (err) {
        addLog(`打开注册页面失败：${err.message || err}`, 'err');
        return;
    }
}

function bindDesktopRegisterLink(link) {
    if (!link || !_getTauriInvoke()) return;
    link.addEventListener('click', openRegisterUrl);
}

function _blobToBase64(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            const text = String(reader.result || '');
            resolve(text.includes(',') ? text.split(',')[1] : text);
        };
        reader.onerror = () => reject(reader.error || new Error('读取图片失败'));
        reader.readAsDataURL(blob);
    });
}

async function _saveBlobWithTauri(blob, filename) {
    const invoke = _getTauriInvoke();
    if (!invoke) return false;
    try {
        const base64Data = await _blobToBase64(blob);
        const savedPath = await invoke('save_image_file', { filename, base64Data });
        if (savedPath) {
            addLog(`已保存到：${savedPath}`, 'success');
        } else {
            addLog('已取消保存', 'warn');
        }
        return true;
    } catch (err) {
        addLog(`原生保存失败，尝试浏览器下载：${err.message}`, 'warn');
        return false;
    }
}

/** 触发一个 Blob/ObjectURL 下载，桌面端优先用原生保存对话框，移动端弹出新标签让用户长按保存 */
async function _triggerBlobDownload(blobUrl, filename, blob = null) {
    if (blob && await _saveBlobWithTauri(blob, filename)) return false;

    if (_isMobile()) {
        // 移动端：在新窗口打开图片，提示用户长按保存
        const w = window.open(blobUrl, '_blank');
        if (!w) {
            showToast('📱 请长按图片保存到相册', 'info');
        } else {
            showToast('📱 图片已在新页面打开，长按图片保存到相册', 'success');
        }
        return true;
    } else {
        const a = document.createElement('a');
        a.href = blobUrl;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        return true;
    }
}

async function downloadImage(src, name) {
    const filename = `${name}.png`;
    addLog(`正在下载：${filename}…`);

    // 情况1：base64 dataURL → 转 Blob 后触发下载
    if (src.startsWith('data:')) {
        try {
            const res = await fetch(src);
            const blob = await res.blob();
            const url = URL.createObjectURL(blob);
            const browserDownloadStarted = await _triggerBlobDownload(url, filename, blob);
            setTimeout(() => URL.revokeObjectURL(url), 30000);
            if (browserDownloadStarted) addLog('下载已开始', 'success');
            return;
        } catch (err) {
            addLog('下载失败：' + err.message, 'err');
            return;
        }
    }

    // 情况2：服务器内部路径（/api/history/image/... 或 /api/gallery/file/...）→ fetch 转 Blob
    if (src.startsWith('/')) {
        try {
            const headers = {};
            const token = getToken();
            if (token) headers['Authorization'] = `Bearer ${token}`;
            const resp = await fetch(src, { headers });
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const blob = await resp.blob();
            const url = URL.createObjectURL(blob);
            const browserDownloadStarted = await _triggerBlobDownload(url, filename, blob);
            setTimeout(() => URL.revokeObjectURL(url), 30000);
            if (browserDownloadStarted) addLog('下载已开始', 'success');
            return;
        } catch (err) {
            addLog('下载失败：' + err.message, 'err');
            return;
        }
    }

    // 情况3：外部 http URL → 尝试直接 fetch，CORS 失败则走后端代理
    if (src.startsWith('http')) {
        try {
            const resp = await fetch(src);
            if (resp.ok) {
                const blob = await resp.blob();
                const url = URL.createObjectURL(blob);
                const browserDownloadStarted = await _triggerBlobDownload(url, filename, blob);
                setTimeout(() => URL.revokeObjectURL(url), 30000);
                if (browserDownloadStarted) addLog('下载已开始', 'success');
                return;
            }
        } catch {}
        // CORS 失败 → 后端代理下载
        try {
            const resp = await fetch('/api/history/fetch-image', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url: src, api_key: state.apiKey }),
            });
            if (resp.ok) {
                const data = await resp.json();
                if (data.success && data.b64_json) {
                    const res2 = await fetch(`data:image/png;base64,${data.b64_json}`);
                    const blob = await res2.blob();
                    const blobUrl = URL.createObjectURL(blob);
                    const browserDownloadStarted = await _triggerBlobDownload(blobUrl, filename, blob);
                    setTimeout(() => URL.revokeObjectURL(blobUrl), 30000);
                    if (browserDownloadStarted) addLog('下载已开始', 'success');
                    return;
                }
            }
        } catch {}
        addLog('下载失败：无法获取图片，请长按图片手动保存', 'err');
        return;
    }

    addLog('下载失败：图片来源不支持', 'err');
}

async function _imageSrcToBlob(src) {
    if (!src || src.includes('expired.svg') || (src.startsWith('data:image/svg+xml') && src.includes('%E5%9B%BE%E7%89%87%E5%B7%B2%E8%BF%87%E6%9C%9F'))) {
        throw new Error('图片已过期');
    }

    if (src.startsWith('data:')) {
        const resp = await fetch(src);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        return await resp.blob();
    }

    if (src.startsWith('/')) {
        const headers = {};
        const token = getToken();
        if (token) headers['Authorization'] = `Bearer ${token}`;
        const resp = await fetch(src, { headers });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        return await resp.blob();
    }

    if (src.startsWith('http')) {
        try {
            const resp = await fetch(src);
            if (resp.ok) return await resp.blob();
        } catch {}

        const resp = await fetch('/api/history/fetch-image', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: src, api_key: state.apiKey }),
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();
        if (!data.success || !data.b64_json) throw new Error(data.error || '无法获取图片');
        const res2 = await fetch(`data:image/png;base64,${data.b64_json}`);
        return await res2.blob();
    }

    throw new Error('图片来源不支持');
}

async function copyImageToClipboard(src) {
    try {
        if (!navigator.clipboard || !window.ClipboardItem) {
            throw new Error('当前环境不支持复制图片到剪贴板');
        }

        let blob = await _imageSrcToBlob(src);
        if (!blob.type || !blob.type.startsWith('image/')) {
            throw new Error('不是有效图片');
        }

        await navigator.clipboard.write([
            new ClipboardItem({ [blob.type || 'image/png']: blob })
        ]);
        showToast('图片已复制', 'success');
        addLog('图片已复制到剪贴板', 'success');
    } catch (err) {
        showToast('复制失败：' + err.message, 'error');
        addLog('复制失败：' + err.message, 'err');
    }
}

// ============================================================
// 上传到广场
// ============================================================
async function uploadToGallery(img, batch) {
    let token = getToken();
    if (!token) { showToast('请先在图片广场登录后再上传', 'warning'); return; }

    // 先验证 token 有效性
    try {
        const vr = await fetch('/auth/verify', {
            method: 'POST', headers: {'Content-Type':'application/json'},
            body: JSON.stringify({token})
        });
        const vd = await vr.json();
        if (!vd.success) {
            // token 无效 — 清除并提示
            localStorage.removeItem('token');
            localStorage.removeItem('username');
            showToast('登录已过期，请在图片广场重新登录', 'error');
            return;
        }
    } catch(e) {
        showToast('验证登录状态失败', 'error');
        return;
    }

    let src = img.b64_json ? `data:image/png;base64,${img.b64_json}` : img.url;

    // 服务器 URL 图片 → 先下载转 base64
    if (src && !src.startsWith('data:') && src.startsWith('/')) {
        try {
            addLog('正在从服务器获取图片…');
            const resp = await fetch(src);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const blob = await resp.blob();
            src = await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(reader.result);
                reader.onerror = reject;
                reader.readAsDataURL(blob);
            });
        } catch {
            addLog('从服务器获取图片失败', 'err');
            return;
        }
    }
    if (!src || !src.startsWith('data:')) { addLog('仅支持 base64 图片上传', 'warn'); return; }

    // 弹窗确认
    const overlay = document.createElement('div');
    overlay.className = 'ann-overlay';
    overlay.innerHTML = `<div class="ann-box" style="width:500px;max-width:92vw">
        <div class="ann-header"><span>📤 上传到广场</span><button class="ann-close" id="uploadCancel">✕</button></div>
        <div class="ann-body" style="font-size:14px;line-height:1.7">
            <div style="margin-bottom:12px"><label style="font-size:13px;color:var(--text-soft);display:block;margin-bottom:6px">作品标题</label>
                <input type="text" id="uploadTitle" class="pg-input" placeholder="给你的作品起个名字（选填）" maxlength="100" style="width:100%;padding:10px 14px;background:var(--bg-soft);border:1px solid var(--border);border-radius:12px;color:var(--text);font-size:14px;outline:none;font-family:inherit"></div>
            <p style="color:var(--text-mute);font-size:13px">图片上传到广场后，任何人都可以查阅到您这张图片的提示词。</p>
            <p style="margin-top:6px;color:var(--text-mute);font-size:13px">如果您不想用户名出现在图片详情里，可以选择匿名上传。</p>
            <label style="display:flex;align-items:center;gap:8px;margin-top:14px;cursor:pointer;font-size:14px">
                <input type="checkbox" id="uploadAnon"> 匿名上传（不显示用户名）
            </label>
        </div>
        <div style="padding:12px 24px;border-top:1px solid var(--border);display:flex;gap:8px;justify-content:flex-end">
            <button class="btn" id="uploadCancelBtn">取消</button>
            <button class="btn btn-primary" id="uploadConfirmBtn">确认上传</button>
        </div>
    </div>`;
    document.body.appendChild(overlay);

    return new Promise((resolve) => {
        overlay.querySelector('#uploadCancel').onclick =
        overlay.querySelector('#uploadCancelBtn').onclick = () => { overlay.remove(); resolve(); };
        overlay.querySelector('#uploadConfirmBtn').onclick = async () => {
            const anonymous = overlay.querySelector('#uploadAnon').checked;
            const title = (overlay.querySelector('#uploadTitle').value || '').trim();
            overlay.remove();
            addLog('正在上传到广场…');
            try {
                const resp = await fetch('/api/gallery/upload', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                    body: JSON.stringify({
                        image: src, model: batch.model, prompt: batch.text,
                        title: title, anonymous,
                    }),
                });
                const data = await resp.json();
                if (!resp.ok) throw new Error(data.detail || data.message || '上传失败');
                addLog(`上传成功！作品 #${data.public_id}`, 'success');
                showToast('上传成功！', 'success');
            } catch (err) {
                addLog('上传失败：' + err.message, 'err');
                showToast(err.message, 'error');
            }
            resolve();
        };
    });
}

// ============================================================
// 历史记录 — IndexedDB 持久化（图片二进制 + 元信息）
// ============================================================
const IDB_NAME = 'ai_studio_history';
const IDB_VER = 2;
const IDB_STORE = 'images'; // key = batchId_imgIndex, value = base64

/** 返回当前用户 ID（用于本地存储隔离），未登录返回 'guest' */
function _currentUid() {
    const token = getToken();
    if (!token) return 'guest';
    try { return JSON.parse(atob(token.split('.')[0]))?.id || 'guest'; } catch { return 'guest'; }
}

/** 带用户隔离的 localStorage key */
function _lsKey(suffix) { return `ai_history_${_currentUid()}_${suffix}`; }

function _openDB() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(IDB_NAME, IDB_VER);
        req.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(IDB_STORE)) {
                db.createObjectStore(IDB_STORE);
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function _idbPut(key, value) {
    try {
        const db = await _openDB();
        const tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).put(value, key);
        await new Promise((r, j) => { tx.oncomplete = r; tx.onerror = j; });
        db.close();
        return true;
    } catch { return false; }
}

async function _idbGet(key) {
    try {
        const db = await _openDB();
        const tx = db.transaction(IDB_STORE, 'readonly');
        const req = tx.objectStore(IDB_STORE).get(key);
        const val = await new Promise((r, j) => { req.onsuccess = () => r(req.result); req.onerror = j; });
        db.close();
        return val;
    } catch { return undefined; }
}

async function _idbDeleteKeys(keys) {
    try {
        const db = await _openDB();
        const tx = db.transaction(IDB_STORE, 'readwrite');
        const store = tx.objectStore(IDB_STORE);
        keys.forEach(k => store.delete(k));
        await new Promise((r, j) => { tx.oncomplete = r; tx.onerror = j; });
        db.close();
    } catch {}
}

function _imgKey(batchId, idx) { return `${_currentUid()}_${batchId}_${idx}`; }
function _refImgKey(batchId, idx) { return `${_currentUid()}_${batchId}_ref_${idx}`; }

function _historyKeysForBatch(batch) {
    if (!batch?.id) return [];
    const keys = [];
    const imageCount = Math.max(batch.images ? batch.images.length : 0, Number(batch.imageCount || 0));
    for (let i = 0; i < imageCount; i++) keys.push(_imgKey(batch.id, i));
    const refCount = Math.max(batch.refImages ? batch.refImages.length : 0, Number(batch.params?.refImageCount || batch.refImageCount || 0));
    for (let i = 0; i < refCount; i++) keys.push(_refImgKey(batch.id, i));
    return keys;
}

function _removeFallbackKeys(keys) {
    if (!keys.length) return;
    try {
        const raw = localStorage.getItem(_lsKey('fallback'));
        if (!raw) return;
        const fallback = JSON.parse(raw);
        let changed = false;
        keys.forEach(k => {
            if (Object.prototype.hasOwnProperty.call(fallback, k)) {
                delete fallback[k];
                changed = true;
            }
        });
        if (changed) localStorage.setItem(_lsKey('fallback'), JSON.stringify(fallback));
    } catch {}
}

function _isExpiredHistoryImage(img) {
    return !img || img._expired || (!img.b64_json && !img.url);
}

function _countExpiredHistoryImages() {
    return state.history.reduce((sum, batch) => {
        return sum + ((batch.images || []).filter(_isExpiredHistoryImage).length);
    }, 0);
}

async function _idbDeleteCurrentUserOrphanKeys(keepKeys) {
    const prefix = `${_currentUid()}_`;
    const toDelete = [];
    try {
        const db = await _openDB();
        const tx = db.transaction(IDB_STORE, 'readonly');
        const store = tx.objectStore(IDB_STORE);
        const req = store.getAllKeys();
        const keys = await new Promise((resolve, reject) => {
            req.onsuccess = () => resolve(req.result || []);
            req.onerror = () => reject(req.error);
        });
        db.close();
        keys.forEach(key => {
            const k = String(key || '');
            if (k.startsWith(prefix) && !keepKeys.has(k)) toDelete.push(k);
        });
    } catch {}
    if (toDelete.length) await _idbDeleteKeys(toDelete);
    return toDelete.length;
}

function _pruneFallbackToKeys(keepKeys) {
    let removed = 0;
    try {
        const raw = localStorage.getItem(_lsKey('fallback'));
        if (!raw) return 0;
        const fallback = JSON.parse(raw);
        Object.keys(fallback).forEach(key => {
            if (!keepKeys.has(key)) {
                delete fallback[key];
                removed += 1;
            }
        });
        if (Object.keys(fallback).length) {
            localStorage.setItem(_lsKey('fallback'), JSON.stringify(fallback));
        } else {
            localStorage.removeItem(_lsKey('fallback'));
        }
    } catch {}
    return removed;
}

async function cleanupExpiredHistoryData() {
    const keysToDelete = [];
    let removedImages = 0;
    let removedBatches = 0;
    const cleaned = [];

    for (const batch of state.history) {
        const images = Array.isArray(batch.images) ? batch.images : [];
        const keepImages = [];
        images.forEach((img, index) => {
            if (_isExpiredHistoryImage(img)) {
                keysToDelete.push(_imgKey(batch.id, index));
                removedImages += 1;
            } else {
                keepImages.push(img);
            }
        });

        if (!keepImages.length) {
            keysToDelete.push(..._historyKeysForBatch(batch));
            removedBatches += 1;
            continue;
        }

        keepImages.forEach(img => {
            if (img && !img._server) img._saved = false;
        });
        batch.images = keepImages;
        cleaned.push(batch);
    }

    state.history = cleaned;
    await _idbDeleteKeys([...new Set(keysToDelete)]);
    _removeFallbackKeys(keysToDelete);
    if (removedImages || removedBatches) await _saveToLocal();

    const keepKeys = new Set();
    state.history.forEach(batch => _historyKeysForBatch(batch).forEach(key => keepKeys.add(key)));
    const orphanIdb = await _idbDeleteCurrentUserOrphanKeys(keepKeys);
    const orphanFallback = _pruneFallbackToKeys(keepKeys);

    _lastHistoryLoadStats = null;
    renderAllResults();
    if (removedImages || orphanIdb || orphanFallback) {
        addLog(`已清理历史数据：删除 ${removedImages} 张过期占位、${removedBatches} 个空批次，额外清理 IndexedDB 孤儿 ${orphanIdb} 条、fallback 孤儿 ${orphanFallback} 条`, 'success');
    } else {
        addLog('没有发现需要清理的失效历史或孤儿缓存');
    }
}

async function deleteHistoryBatchLocalData(batches) {
    const keys = [];
    (Array.isArray(batches) ? batches : [batches]).forEach(batch => {
        keys.push(..._historyKeysForBatch(batch));
    });
    if (keys.length) {
        await _idbDeleteKeys(keys);
        _removeFallbackKeys(keys);
    }
}

// ---- 判断是否已登录 ----
function _isLoggedIn() { return !!getToken(); }

// ---- 判断服务器历史是否启用（config 开关 + 用户已登录）----
function _serverHistoryEnabled() {
    return els.playground.dataset.historyServer === 'true' && _isLoggedIn();
}

function _localFileHistoryEnabled() {
    return ['127.0.0.1', 'localhost', '::1'].includes(location.hostname);
}

function _localHistoryHeaders(extra) {
    const headers = Object.assign({}, extra || {});
    const token = getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    return headers;
}

function _localHistoryTokenQuery() {
    const token = getToken();
    return token ? `?token=${encodeURIComponent(token)}` : '';
}

function _localImageUrl(batchId, filename) {
    return `/api/history/local/image/${encodeURIComponent(batchId)}/${encodeURIComponent(filename)}${_localHistoryTokenQuery()}`;
}

function _localFileUrl(path) {
    return `/api/history/local/file/${String(path || '').split('/').map(encodeURIComponent).join('/')}${_localHistoryTokenQuery()}`;
}

function _localManifestImageUrl(batchId, item) {
    if (item && item.path) return _localFileUrl(item.path);
    return _localImageUrl(batchId, item?.filename || item || '');
}

let _lastHistoryLoadStats = null;

async function _saveToLocalFiles(batch) {
    if (!_localFileHistoryEnabled() || !batch || batch._localFileSaved) return;
    if ((!batch.images || !batch.images.length) && (!batch.refImages || !batch.refImages.length)) return;
    try {
        const resp = await fetch('/api/history/local/save', {
            method: 'POST',
            headers: _localHistoryHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({
                batch_id: batch.id,
                model: batch.model,
                prompt: batch.text,
                batch_time: batch.time,
                params: batch.params || null,
                images: (batch.images || []).map(img => ({ b64_json: img.b64_json || '', url: img.url || '' })),
                ref_images: (batch.refImages || []).filter(Boolean),
                api_key: state.apiKey || '',
            }),
        });
        if (resp.ok) {
            batch._localFileSaved = true;
            return true;
        }
        let detail = '';
        try { detail = await resp.text(); } catch {}
        addLog(`本机文件历史保存失败：HTTP ${resp.status}${detail ? ' · ' + detail.slice(0, 120) : ''}`, 'warn');
    } catch (err) {
        addLog(`本机文件历史保存失败：${err.message}`, 'warn');
    }
    return false;
}

async function _loadFromLocalFiles() {
    if (!_localFileHistoryEnabled()) return [];
    try {
        const resp = await fetch('/api/history/local/list', { headers: _localHistoryHeaders() });
        const data = await resp.json();
        if (!data.success) return [];
        return (data.data || []).map(b => ({
            id: b.id,
            model: b.model,
            time: b.time,
            text: b.text,
            params: b.params || null,
            refImages: (b.ref_images || []).map(img => _localManifestImageUrl(b.id, img)),
            images: (b.images || []).map(img => ({
                b64_json: '',
                url: _localManifestImageUrl(b.id, img),
                _saved: true,
                _localFile: true,
            })),
            _localFileSaved: true,
        }));
    } catch { return []; }
}

function _countBatchImages(batches) {
    return (batches || []).reduce((sum, batch) => sum + (Array.isArray(batch.images) ? batch.images.length : 0), 0);
}

function _logHistoryLoadDiagnostics(fileBatches) {
    const s = _lastHistoryLoadStats;
    if (!s) return;
    const fileImageCount = _countBatchImages(fileBatches);
    const level = s.missingImages > 0 ? 'warn' : '';
    addLog(
        `历史加载诊断：元数据 ${s.metaBatches} 组/${s.metaImages} 图，IndexedDB 命中 ${s.idbImages} 图，fallback 命中 ${s.fallbackImages} 图，缺失 ${s.missingImages} 图，旧临时链接 ${s.legacyHttpImages} 图，本机文件缓存 ${fileImageCount} 图`,
        level
    );
    if (s.missingImages > 0) {
        addLog('这些图片显示“已过期”的原因：历史元数据还在，但 WebView IndexedDB 里对应图片数据已经取不到。', 'warn');
    }
    if (s.legacyHttpImages > 0) {
        addLog('检测到旧版 HTTP 临时图片链接，正在尝试迁移到本机文件缓存。', 'warn');
    }
}

function _mergeHistoryBatches(sourceBatches) {
    if (!sourceBatches || !sourceBatches.length) return;
    const sourceMap = {};
    sourceBatches.forEach(b => { sourceMap[b.id] = b; });

    for (let i = 0; i < state.history.length; i++) {
        const local = state.history[i];
        const allExpired = !local.images || local.images.every(img => img._expired || (!img.b64_json && !img.url));
        if (allExpired && sourceMap[local.id]) {
            state.history[i] = sourceMap[local.id];
        }
    }

    const localIds = new Set(state.history.map(b => b.id));
    sourceBatches.forEach(b => {
        if (!localIds.has(b.id)) {
            state.history.push(b);
        }
    });
}

function _replaceHistoryBatchesById(sourceBatches) {
    if (!sourceBatches || !sourceBatches.length) return false;
    const sourceMap = {};
    sourceBatches.forEach(b => { sourceMap[b.id] = b; });

    let changed = false;
    for (let i = 0; i < state.history.length; i++) {
        const replacement = sourceMap[state.history[i].id];
        if (replacement) {
            state.history[i] = replacement;
            changed = true;
        }
    }
    return changed;
}

async function _migrateLegacyHttpImagesToLocalFiles() {
    try {
        if (!_localFileHistoryEnabled()) return;
        const candidates = state.history.filter(b =>
            b && !b._localFileSaved && Array.isArray(b.images) && b.images.some(img => img?._legacyHttp)
        );
        if (!candidates.length) return;

        let savedAny = false;
        for (const batch of candidates) {
            await _saveToLocalFiles(batch);
            if (batch._localFileSaved) savedAny = true;
        }
        if (!savedAny) {
            addLog('旧版 HTTP 临时图片迁移失败：链接可能已失效，或上游下载需要重新连接 API 后再试。', 'warn');
            return;
        }

        const fileBatches = await _loadFromLocalFiles();
        if (_replaceHistoryBatchesById(fileBatches)) {
            const migratedIds = new Set(candidates.map(b => b.id));
            state.history.forEach(batch => {
                if (!migratedIds.has(batch.id) || !Array.isArray(batch.images)) return;
                batch.images.forEach(img => {
                    if (img && img._localFile) img._saved = false;
                });
            });
            await _saveToLocal();
            renderAllResults();
            addLog('已将旧版历史图片迁移到本机文件缓存', 'success');
        }
    } catch {}
}

async function _deleteLocalFileBatch(batchId) {
    if (!_localFileHistoryEnabled()) return;
    try { await fetch(`/api/history/local/batch/${encodeURIComponent(batchId)}`, { method: 'DELETE', headers: _localHistoryHeaders() }); } catch {}
}

async function _deleteLocalFileImage(batchId, imgIndex) {
    if (!_localFileHistoryEnabled()) return;
    try { await fetch(`/api/history/local/image/${encodeURIComponent(batchId)}/${imgIndex}`, { method: 'DELETE', headers: _localHistoryHeaders() }); } catch {}
}

async function _clearLocalFileHistory() {
    if (!_localFileHistoryEnabled()) return;
    try { await fetch('/api/history/local/clear', { method: 'DELETE', headers: _localHistoryHeaders() }); } catch {}
}

async function openLocalHistoryDir() {
    if (!_localFileHistoryEnabled()) {
        addLog('本机图片目录仅桌面/本机访问时可用', 'warn');
        return;
    }
    try {
        const resp = await fetch('/api/history/local/open-dir', { method: 'POST', headers: _localHistoryHeaders() });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok || data.success === false) {
            throw new Error(data.detail || data.message || `HTTP ${resp.status}`);
        }
        addLog(`已打开本机图片目录：${data.path || 'history_images/_local'}`, 'success');
    } catch (err) {
        addLog(`打开本机图片目录失败：${err.message}`, 'warn');
    }
}

// ---- 服务器端存储（已登录用户）----
async function _saveToServer(batch) {
    const token = getToken();
    if (!token || !batch.images || !batch.images.length) return;
    try {
        await fetch('/api/history/save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify({
                batch_id: batch.id,
                model: batch.model,
                prompt: batch.text,
                batch_time: batch.time,
                images: batch.images.map(img => ({ b64_json: img.b64_json || '', url: img.url || '' })),
            }),
        });
    } catch {}
}

async function _loadFromServer() {
    const token = getToken();
    if (!token) return [];
    try {
        const resp = await fetch('/api/history/list', {
            headers: { 'Authorization': `Bearer ${token}` },
        });
        const data = await resp.json();
        if (!data.success) return [];
        const uname = JSON.parse(atob(token.split('.')[0]))?.username || '';
        return (data.data || []).map(b => ({
            id: b.id,
            model: b.model,
            time: b.time,
            text: b.text,
            params: b.params || null,
            refImages: [],
            images: (b.images || []).map(img => ({
                b64_json: '',
                // <img> 标签无法携带 header，通过 ?token= 鉴权
                url: `/api/history/image/${encodeURIComponent(uname)}/${img.filename}?token=${encodeURIComponent(token)}`,
                _saved: true,
                _server: true,
            })),
        }));
    } catch { return []; }
}

// ---- 本地存储（未登录用户）----
async function _saveToLocal() {
    try {
        const meta = state.history.map(b => ({
            id: b.id, model: b.model, time: b.time, text: b.text,
            params: b.params || null,
            imageCount: b.images ? b.images.length : 0,
            refImageCount: Math.max(b.refImages ? b.refImages.length : 0, Number(b.params?.refImageCount || 0)),
        }));
        localStorage.setItem(_lsKey('meta'), JSON.stringify(meta));

        let idbOk = true;
        for (const batch of state.history) {
            if (batch.images) {
                for (let i = 0; i < batch.images.length; i++) {
                    const img = batch.images[i];
                    if (img._server || img._localFile) continue; // 服务器/本机文件图片不再重复存大图到 IndexedDB
                    const key = _imgKey(batch.id, i);
                    const raw = img.b64_json || img.url || '';
                    if (raw && !img._saved) {
                        const ok = await _idbPut(key, raw);
                        if (ok) { img._saved = true; } else { idbOk = false; }
                    }
                }
            }
            if (batch.refImages) {
                for (let i = 0; i < batch.refImages.length; i++) {
                    const raw = batch.refImages[i] || '';
                    if (raw) {
                        const ok = await _idbPut(_refImgKey(batch.id, i), raw);
                        if (!ok) idbOk = false;
                    }
                }
            }
        }
        if (!idbOk) {
            try {
                const fallback = {};
                for (const batch of state.history) {
                    if (batch.images) {
                        for (let i = 0; i < batch.images.length; i++) {
                            const img = batch.images[i];
                            if (img._server || img._localFile) continue;
                            const raw = img.b64_json || img.url || '';
                            if (raw) fallback[_imgKey(batch.id, i)] = raw;
                        }
                    }
                    if (batch.refImages) {
                        for (let i = 0; i < batch.refImages.length; i++) {
                            const raw = batch.refImages[i] || '';
                            if (raw) fallback[_refImgKey(batch.id, i)] = raw;
                        }
                    }
                }
                localStorage.setItem(_lsKey('fallback'), JSON.stringify(fallback));
            } catch {}
        }
    } catch {}
}

async function _loadFromLocal() {
    const raw = localStorage.getItem(_lsKey('meta'));
    if (!raw) {
        _lastHistoryLoadStats = { metaBatches: 0, metaImages: 0, idbImages: 0, fallbackImages: 0, missingImages: 0, legacyHttpImages: 0 };
        // 向后兼容：尝试读取旧的非隔离 key（一次性迁移）
        const oldRaw = localStorage.getItem('ai_history_meta');
        if (oldRaw && _currentUid() === 'guest') {
            localStorage.setItem(_lsKey('meta'), oldRaw);
            localStorage.removeItem('ai_history_meta');
            return _loadFromLocal();
        }
        return;
    }
    const meta = JSON.parse(raw);
    _lastHistoryLoadStats = {
        metaBatches: Array.isArray(meta) ? meta.length : 0,
        metaImages: Array.isArray(meta) ? meta.reduce((sum, item) => sum + Number(item.imageCount || 0), 0) : 0,
        idbImages: 0,
        fallbackImages: 0,
        missingImages: 0,
        legacyHttpImages: 0,
    };
    let fallback = {};
    try {
        const fb = localStorage.getItem(_lsKey('fallback'));
        if (fb) fallback = JSON.parse(fb);
    } catch {}

    state.history = [];
    for (const m of meta) {
        const images = [];
        for (let i = 0; i < (m.imageCount || 0); i++) {
            const key = _imgKey(m.id, i);
            let data = await _idbGet(key);
            if (!data && fallback[key]) {
                data = fallback[key];
                _lastHistoryLoadStats.fallbackImages += 1;
                await _idbPut(key, data);
            } else if (data) {
                _lastHistoryLoadStats.idbImages += 1;
            }
            if (data) {
                // 判断顺序很重要：base64 检测必须在路径检测之前
                // 因为 JPEG base64 以 /9j/ 开头，会被误判为 URL 路径
                if (data.startsWith('http')) {
                    // 旧版本可能只保存了上游临时 HTTP 链接。先保留显示，加载后再尝试迁移到本机文件历史。
                    _lastHistoryLoadStats.legacyHttpImages += 1;
                    images.push({ b64_json: '', url: data, _saved: true, _legacyHttp: true });
                } else if (data.startsWith('data:image/')) {
                    // 完整 DataURL → 提取纯 base64
                    const pure = data.replace(/^data:image\/[^;]+;base64,/, '');
                    images.push({ b64_json: pure, url: '', _saved: true });
                } else if (data.startsWith('/api/') || data.startsWith('/static/')) {
                    // 本站 API 路径（精确匹配，避免误判 base64）
                    images.push({ b64_json: '', url: data, _saved: true });
                } else {
                    // 纯 base64（包括 PNG 的 iVBOR... 和 JPEG 的 /9j/...）
                    images.push({ b64_json: data, url: '', _saved: true });
                }
            } else {
                _lastHistoryLoadStats.missingImages += 1;
                images.push({ b64_json: '', url: '', _saved: true, _expired: true });
            }
        }
        const refImages = [];
        const refCount = Number(m.refImageCount ?? m.params?.refImageCount ?? 0);
        for (let i = 0; i < refCount; i++) {
            const key = _refImgKey(m.id, i);
            let data = await _idbGet(key);
            if (!data && fallback[key]) {
                data = fallback[key];
                await _idbPut(key, data);
            }
            if (data && typeof data === 'string' && data.startsWith('data:image/')) {
                refImages.push(data);
            }
        }
        state.history.push({
            id: m.id,
            model: m.model,
            time: m.time,
            text: m.text,
            params: m.params || null,
            refImages,
            images,
        });
    }
}

// ---- 统一入口 ----
async function saveHistory() {
    const newest = state.history[0];
    // 服务器存储开启时，也同步到服务器
    if (_serverHistoryEnabled()) {
        if (newest && !newest._serverSaved) {
            await _saveToServer(newest);
            newest._serverSaved = true;
            // 服务器保存成功后刷新云缓存用量显示
            renderUserPanel();
        }
    }
    if (newest && await _saveToLocalFiles(newest)) {
        await deleteHistoryBatchLocalData(newest);
        const fileBatches = await _loadFromLocalFiles();
        if (_replaceHistoryBatchesById(fileBatches)) {
            const replacement = state.history.find(b => b.id === newest.id);
            if (replacement) replacement._serverSaved = newest._serverSaved;
        }
    }
    // 始终保存本地一份。桌面/本机场景会保存文件 URL 元数据，不再重复保存大图 base64。
    await _saveToLocal();
}

async function loadHistory() {
    try {
        // 始终先从本地加载
        await _loadFromLocal();

        // 桌面/本机环境优先从文件历史补回 IndexedDB 过期或丢失的图片
        const fileBatches = await _loadFromLocalFiles();
        _mergeHistoryBatches(fileBatches);
        _logHistoryLoadDiagnostics(fileBatches);

        // 旧版本生成的 HTTP 临时链接如果仍可访问，自动迁移到本机文件历史，避免下次更新后丢失。
        _migrateLegacyHttpImagesToLocalFiles();

        // 服务器存储未开启 → 只用本地数据
        if (!_serverHistoryEnabled()) {
            renderAllResults();
            return;
        }

        // 服务器存储开启 → 加载服务器数据，按 batch 补齐本地过期的
        const serverData = await _loadFromServer();
        _mergeHistoryBatches(serverData);
        renderAllResults();
    } catch {}
}

// ---- 删除单个 batch ----
async function deleteBatch(batchId, silent) {
    const idx = state.history.findIndex(b => b.id === batchId);
    if (idx === -1) return;
    const batch = state.history[idx];

    await deleteHistoryBatchLocalData(batch);
    await _deleteLocalFileBatch(batchId);
    state.history.splice(idx, 1);
    await _saveToLocal();

    // 同步删除服务器
    if (_serverHistoryEnabled()) {
        try {
            const token = getToken();
            await fetch(`/api/history/batch/${batchId}`, {
                method: 'DELETE',
                headers: { 'Authorization': `Bearer ${token}` },
            });
        } catch {}
        renderUserPanel();
    }
    if (!silent) {
        renderAllResults();
        addLog('已删除一组绘图记录');
    }
}

// ---- 清空所有历史 ----
async function clearAllHistory() {
    // 清除本地 IndexedDB 所有生成图和参考图
    const allKeys = [];
    state.history.forEach(b => {
        allKeys.push(..._historyKeysForBatch(b));
    });
    if (allKeys.length) {
        await _idbDeleteKeys(allKeys);
        _removeFallbackKeys(allKeys);
    }

    state.history = [];
    localStorage.removeItem(_lsKey('meta'));
    localStorage.removeItem(_lsKey('fallback'));
    await _clearLocalFileHistory();

    // 同步清空服务器
    if (_serverHistoryEnabled()) {
        try {
            const token = getToken();
            await fetch('/api/history/clear', {
                method: 'DELETE',
                headers: { 'Authorization': `Bearer ${token}` },
            });
        } catch {}
        renderUserPanel();
    }
    renderAllResults();
    addLog('已清空所有绘图历史');
}

// ============================================================
// 事件绑定
// ============================================================
function bindEvents() {
    // 连接
    els.connectBtn.addEventListener('click', connectApi);
    els.apiKeyInput.addEventListener('keydown', e => { if (e.key === 'Enter') connectApi(); });
    els.nodeSelect.addEventListener('change', () => {
        const next = getActiveBaseUrl();
        updateProviderFields();
        state.baseUrl = next;
        saveActiveNode(next);
        if (state.isConnected) addLog(`已切换模型供应商：${next}，后续请求将使用该地址`, 'success');
    });
    els.qianyeLineSelect?.addEventListener('change', () => {
        const next = getActiveBaseUrl();
        updateProviderFields();
        state.baseUrl = next;
        saveActiveNode(next);
        if (state.isConnected) addLog(`已切换浅夜の梦专属线路：${next}，后续请求将使用该线路`, 'success');
    });
    els.customBaseInput?.addEventListener('input', () => {
        if (!isCustomNodeSelected()) return;
        const next = getActiveBaseUrl();
        state.baseUrl = next;
        saveActiveNode(next);
    });
    els.customBaseInput?.addEventListener('keydown', e => { if (e.key === 'Enter') connectApi(); });
    els.balanceBindBtn?.addEventListener('click', showBalanceBindDialog);
    els.balanceRefreshBtn?.addEventListener('click', refreshBalance);

    // 放大编辑提示词
    $('#expandPromptBtn').addEventListener('click', _expandPromptEditor);

    // 比例选择
    els.ratioGrid.addEventListener('click', e => {
        const btn = e.target.closest('.r-btn');
        if (btn) selectRatio(btn.dataset.ratio);
    });

    // 分辨率选择
    els.resolutionGrid.addEventListener('click', e => {
        const btn = e.target.closest('.seg-btn');
        if (btn) selectResolution(btn.dataset.resolution);
    });

    // 生成参数
    els.qualitySelect.addEventListener('change', () => { state.quality = els.qualitySelect.value; });
    els.formatSelect.addEventListener('change', () => {
        state.outputFormat = els.formatSelect.value;
        els.compressionField.hidden = !(state.outputFormat === 'jpeg' || state.outputFormat === 'webp');
    });
    els.backgroundSelect.addEventListener('change', () => { state.background = els.backgroundSelect.value; });
    els.moderationSelect.addEventListener('change', () => { state.moderation = els.moderationSelect.value; });
    els.compressionSlider.addEventListener('input', () => {
        state.outputCompression = parseInt(els.compressionSlider.value, 10);
        els.compressionVal.textContent = state.outputCompression;
    });

    // 张数滑块
    els.countSlider.addEventListener('input', () => {
        state.count = parseInt(els.countSlider.value);
        els.countVal.textContent = state.count;
    });

    // 最大并发滑块
    els.concurrencySlider.addEventListener('input', () => {
        state.maxConcurrency = parseInt(els.concurrencySlider.value, 10);
        els.concurrencyVal.textContent = state.maxConcurrency;
    });

    // 生成按钮
    els.generateBtn.addEventListener('click', () => {
        generateImages();
    });

    // 拖拽上传
    els.dropZone.addEventListener('click', () => els.refFileInput.click());
    els.refFileInput.addEventListener('change', e => handleRefFiles(e.target.files));
    els.dropZone.addEventListener('dragover', e => {
        e.preventDefault();
        els.dropZone.classList.add('over');
    });
    els.dropZone.addEventListener('dragleave', () => els.dropZone.classList.remove('over'));
    els.dropZone.addEventListener('drop', e => {
        e.preventDefault();
        els.dropZone.classList.remove('over');
        handleRefFiles(e.dataTransfer.files);
    });

    // Ctrl+V 粘贴
    document.addEventListener('paste', e => {
        if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT') return;
        const items = e.clipboardData?.items;
        if (!items) return;
        const imgs = [];
        for (const item of items) {
            if (item.type.startsWith('image/')) imgs.push(item.getAsFile());
        }
        if (imgs.length) { e.preventDefault(); handleRefFiles(imgs); }
    });
}

// ============================================================
// 用户面板（登录/用量）
// ============================================================
async function renderUserPanel() {
    const token = getToken();
    const username = localStorage.getItem('username');
    const cloudEnabled = els.playground.dataset.historyServer === 'true';

    if (!token || !username) {
        // 未登录
        els.userInfo.innerHTML = `
            <div class="u-login-row">
                <span style="color:var(--text-mute);font-size:13px">API Key 模式</span>
                <div style="display:flex;gap:6px">
                    <button class="btn" id="playLoginBtn" style="padding:4px 14px;font-size:13px">账号登录</button>
                    <a class="btn btn-primary" id="playRegisterBtn" href="${REGISTER_URL}" target="_blank" rel="noopener noreferrer" style="padding:4px 14px;font-size:13px;text-decoration:none">免费注册</a>
                </div>
            </div>
            <div class="auth-mode-hint">账号登录只用于历史/广场身份；生成仍使用下方供应商 API Key。</div>`;
        els.userInfo.querySelector('#playLoginBtn').addEventListener('click', showPlayLogin);
        bindDesktopRegisterLink(els.userInfo.querySelector('#playRegisterBtn'));
        return;
    }

    let usageHtml = '';
    if (cloudEnabled) {
        try {
            const resp = await fetch('/api/history/usage', {
                headers: { 'Authorization': `Bearer ${token}` },
            });
            const data = await resp.json();
            if (data.success) {
                const pct = Math.round(data.used / data.max * 100);
                usageHtml = `<div class="u-usage">
                    <span>☁️ 云缓存 ${data.used}/${data.max}</span>
                    <div class="u-bar"><div class="u-bar-fill" style="width:${pct}%"></div></div>
                </div>`;
            }
        } catch {}
    }

    els.userInfo.innerHTML = `
        <div class="u-welcome">
            <span>账号登录：${escHtml(username)}</span>
            <button class="u-logout" id="playLogoutBtn" title="退出登录">退出</button>
        </div>
        <div class="auth-mode-hint">当前已登录站内账号；生成请求仍走所选供应商和 API Key。</div>
        ${usageHtml}`;
    els.userInfo.querySelector('#playLogoutBtn').addEventListener('click', () => {
        localStorage.removeItem('token');
        localStorage.removeItem('username');
        renderUserPanel();
        // 重新加载历史（切换到 guest 数据）
        state.history = [];
        loadHistory();
    });
}

function showPlayLogin() {
    const overlay = document.createElement('div');
    overlay.className = 'ann-overlay';
    overlay.innerHTML = `<div class="ann-box" style="width:380px;max-width:92vw">
        <div class="ann-header"><span>🔐 登录</span><button class="ann-close" id="plClose">✕</button></div>
        <div class="ann-body">
            <div class="field" style="margin-bottom:12px">
                <label style="font-size:13px;color:var(--text-soft);display:block;margin-bottom:4px">用户名</label>
                <input type="text" id="plUser" class="pg-input auth-input" placeholder="NewAPI 用户名" style="width:100%">
            </div>
            <div class="field">
                <label style="font-size:13px;color:var(--text-soft);display:block;margin-bottom:4px">密码</label>
                <input type="password" id="plPass" class="pg-input auth-input" placeholder="密码" style="width:100%">
            </div>
            <p id="plErr" style="color:#ff3b30;font-size:13px;margin-top:8px" hidden></p>
        </div>
        <div style="padding:12px 24px;border-top:1px solid var(--border);display:flex;gap:8px;align-items:center;justify-content:space-between">
            <a class="btn btn-primary" id="plRegisterBtn" href="${REGISTER_URL}" target="_blank" rel="noopener noreferrer" style="text-decoration:none">没有账号？立即注册</a>
            <div style="display:flex;gap:8px">
                <button class="btn" id="plCancelBtn">取消</button>
                <button class="btn btn-primary" id="plLoginBtn">登录</button>
            </div>
        </div>
    </div>`;
    document.body.appendChild(overlay);

    const close = () => overlay.remove();
    overlay.querySelector('#plClose').onclick = close;
    overlay.querySelector('#plCancelBtn').onclick = close;
    bindDesktopRegisterLink(overlay.querySelector('#plRegisterBtn'));
    overlay.querySelector('#plPass').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });

    async function doLogin() {
        const user = overlay.querySelector('#plUser').value.trim();
        const pass = overlay.querySelector('#plPass').value;
        if (!user || !pass) return;
        const errEl = overlay.querySelector('#plErr');
        const btn = overlay.querySelector('#plLoginBtn');
        btn.disabled = true; btn.textContent = '登录中…';
        try {
            const resp = await fetch('/auth/login', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username: user, password: pass }),
            });
            const data = await resp.json();
            if (!data.success) throw new Error(data.detail || data.message || '登录失败');
            localStorage.setItem('token', data.token);
            localStorage.setItem('username', data.user?.username || user);
            close();
            renderUserPanel();
            // 重新加载该用户的历史
            state.history = [];
            loadHistory();
            addLog(`欢迎回来，${user}！`, 'success');
        } catch (e) {
            errEl.textContent = e.message; errEl.hidden = false;
            btn.disabled = false; btn.textContent = '登录';
        }
    }
    overlay.querySelector('#plLoginBtn').onclick = doLogin;
}

// ============================================================
// 初始化
// ============================================================
async function init() {
    // 渲染模型供应商：浅夜の梦中转站 / 本机 NewAPI / 自定义 Base URL
    els.nodeSelect.innerHTML = '';
    [
        [PROVIDER_QIANYE, '浅夜の梦中转站'],
        [PROVIDER_LOCAL_NEWAPI, '本机 NewAPI'],
        [CUSTOM_NODE_VALUE, '自定义 Base URL'],
    ].forEach(([value, label]) => {
        const opt = document.createElement('option');
        opt.value = value;
        opt.textContent = label;
        els.nodeSelect.appendChild(opt);
    });
    if (els.qianyeLineSelect) {
        els.qianyeLineSelect.innerHTML = '';
        QIANYE_LINES.forEach(line => {
            const opt = document.createElement('option');
            opt.value = line.id;
            opt.textContent = `${line.label} · ${line.url}`;
            els.qianyeLineSelect.appendChild(opt);
        });
    }

    // 恢复 API Key / 模型供应商
    const savedKey = localStorage.getItem('ai_key');
    const savedNode = localStorage.getItem('ai_node');
    const savedCustomBase = localStorage.getItem('ai_custom_base') || '';
    const savedQianyeLine = localStorage.getItem('ai_qianye_line') || DEFAULT_QIANYE_LINE_ID;
    if (savedKey) {
        els.apiKeyInput.value = savedKey;
        state.apiKey = savedKey;
    }
    if (savedCustomBase && els.customBaseInput) els.customBaseInput.value = savedCustomBase;
    if (els.qianyeLineSelect) els.qianyeLineSelect.value = qianyeLineById(savedQianyeLine)?.id || DEFAULT_QIANYE_LINE_ID;
    if (savedNode === PROVIDER_QIANYE) {
        els.nodeSelect.value = PROVIDER_QIANYE;
    } else if (savedNode === PROVIDER_LOCAL_NEWAPI) {
        els.nodeSelect.value = PROVIDER_LOCAL_NEWAPI;
    } else if (savedNode === CUSTOM_NODE_VALUE) {
        els.nodeSelect.value = CUSTOM_NODE_VALUE;
    } else if (savedNode) {
        const qianyeLine = qianyeLineByUrl(savedNode);
        if (qianyeLine) {
            els.nodeSelect.value = PROVIDER_QIANYE;
            if (els.qianyeLineSelect) els.qianyeLineSelect.value = qianyeLine.id;
            localStorage.setItem('ai_node', PROVIDER_QIANYE);
            localStorage.setItem('ai_qianye_line', qianyeLine.id);
        } else if (normalizeBaseUrl(savedNode) === normalizeBaseUrl(LOCAL_NEWAPI_URL)) {
            els.nodeSelect.value = PROVIDER_LOCAL_NEWAPI;
            localStorage.setItem('ai_node', PROVIDER_LOCAL_NEWAPI);
        } else if (els.customBaseInput) {
            els.nodeSelect.value = CUSTOM_NODE_VALUE;
            els.customBaseInput.value = savedNode;
            localStorage.setItem('ai_custom_base', normalizeBaseUrl(savedNode));
            localStorage.setItem('ai_node', CUSTOM_NODE_VALUE);
        }
    } else {
        els.nodeSelect.value = PROVIDER_QIANYE;
    }
    updateProviderFields();
    state.baseUrl = getActiveBaseUrl();
    updateResolutionLabel();
    ensureQueuePanel();
    updateGenerateButton();

    bindEvents();
    renderUserPanel();
    await loadHistory();
    if (getBalanceToken() && isBalancePanelEnabled()) {
        refreshBalance();
    } else if (isBalancePanelEnabled()) {
        renderBalanceEmpty();
    }
    addLog('工作台已就绪');
}

// ============================================================
// 启动
// ============================================================
document.addEventListener('DOMContentLoaded', init);
