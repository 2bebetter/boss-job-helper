// ==UserScript==
// @name         AI-boss投递助手
// @namespace    https://github.com/2bebetter
// @version      2.0.0.0
// @description  支持AI判断简历和工作匹配度；AI结合预置问答库智能回复
// @author       wmh
// @match        https://www.zhipin.com/web/*
// @grant        GM_xmlhttpRequest
// @run-at       document-idle
// @supportURL   https://github.com/2bebetter/boss-job-helper
// @homepageURL  https://github.com/2bebetter/boss-job-helper
// @license      AGPL-3.0-or-later
// @connect      zhipin.com
// @connect      spark-api-open.xf-yun.com
// @connect      jasun.xyz
// @connect      api.siliconflow.cn
// @connect      ark.cn-beijing.volces.com
// @connect      api.openai.com
// @connect      api.deepseek.com
// @noframes
// @require      https://cdnjs.cloudflare.com/ajax/libs/crypto-js/4.1.1/crypto-js.min.js
// ==/UserScript==

"use strict";

// ==============================================
// 1. 类型定义 JSDoc（编辑器提示用）
// ==============================================
/**
 * @typedef {Object} HRInteraction
 * @property {string} hrKey - HR唯一标识
 * @property {boolean} hasSentResume - 是否已发送简历
 */

/**
 * @typedef {Object} JobInfo
 * @property {string} jobId - 职位ID
 * @property {string} title - 职位标题
 * @property {string} company - 公司名称
 * @property {string} salary - 薪资
 * @property {string} location - 地点
 * @property {string} hrKey - 关联HR
 */

// ==============================================
// 2. 全局配置（所有固定参数放这里）
// ==============================================
const CONFIG = {
    BASIC_INTERVAL: 1000,
    OPERATION_INTERVAL: 1200,

    DELAYS: {
        SHORT: 30,
        MEDIUM_SHORT: 200,
    },

    MINI_ICON_SIZE: 40,

    STORAGE_KEYS: {
        PROCESSED_HRS: "processedHRs",
        SENT_GREETINGS_HRS: "sentGreetingsHRs",
        SENT_RESUME_HRS: "sentResumeHRs",
        AI_REPLY_COUNT: "aiReplyCount",
        LAST_AI_DATE: "lastAiDate",
    },

    STORAGE_LIMITS: {
        PROCESSED_HRS: 500,
        SENT_GREETINGS_HRS: 500,
        SENT_RESUME_HRS: 300,
        SENT_IMAGE_RESUME_HRS: 300,
    },

    API: {
        TIMEOUT: 10000,
        BASE_URL: 'https://jasun.xyz/api',
        RETRY_COUNT: 3,
        RETRY_DELAY: 1000
    },

    UI: {
        MINI_ICON_SIZE: 40,
        ANIMATION_DURATION: 300,
        DEBOUNCE_DELAY: 300
    },

    PERFORMANCE: {
        DOM_CACHE_MAX_AGE: 5000,
        BATCH_SIZE: 10,
        CONCURRENT_LIMIT: 3
    }
};

const PAGE_TYPES = {
    JOB_LIST: 'jobList',
    CHAT: 'chat',
};

const THEMES = {
    JOB_LIST: {
        primary: '#4285f4',
        secondary: '#f5f7fa',
        accent: '#e8f0fe',
        neutral: '#6b7280',
    },
    CHAT: {
        primary: '#34a853',
        secondary: '#f0fdf4',
        accent: '#dcfce7',
        neutral: '#6b7280',
    },
};

// ==============================================
// 3. 工具类
// ==============================================

/**
 * 安全获取本地存储并解析JSON
 */
const getStoredJSON = (key, defaultValue) => {
    try {
        const val = localStorage.getItem(key);
        return val ? JSON.parse(val) : defaultValue;
    } catch (e) {
        console.error(`解析存储失败 ${key}:`, e);
        return defaultValue;
    }
};

/**
 * 安全地存储大文本到localStorage（自动截断）
*/
const setLargeItem = (key, value, maxLength = 500000) => {
    try {
        let textToStore = value;

        // 如果文本太长，截断它
        if (textToStore && textToStore.length > maxLength) {
            console.warn(`文本太长(${textToStore.length}字符)，已截断到${maxLength}字符`);
            textToStore = textToStore.substring(0, maxLength) + "\n[内容已截断，仅保存前" + maxLength + "字符]";
        }

        const jsonString = JSON.stringify(textToStore);

        // 检查是否超过localStorage限制
        if (jsonString.length > 2000000) { // 约2MB
            console.warn(`存储数据太大(${jsonString.length}字节)，尝试进一步截断`);
            textToStore = textToStore.substring(0, Math.floor(maxLength / 2)) + "\n[内容已大幅截断以符合存储限制]";
        }

        localStorage.setItem(key, JSON.stringify(textToStore));
        return true;
    } catch (e) {
        if (e.name === 'QuotaExceededError' || e.message.includes('quota')) {
            console.error(`存储空间不足，无法保存${key}`);
            // 尝试保存截断版本
            try {
                const truncated = String(value).substring(0, 100000) + "\n[因存储限制已截断]";
                localStorage.setItem(key, JSON.stringify(truncated));
                return 'truncated';
            } catch (e2) {
                console.error(`即使截断后仍无法保存${key}`);
                return false;
            }
        }
        console.error(`Error saving ${key}:`, e);
        return false;
    }
};

/**
 * LocalStorageManager：本地存储统一管理
 */
class LocalStorageManager {
    static setItem(key, val) {
        try {
            localStorage.setItem(key, typeof val === 'string' ? val : JSON.stringify(val));
            return true;
        } catch { return false; }
    }

    static getItem(key, def = null) {
        try {
        const v = localStorage.getItem(key);
        return v !== null ? v : def;
        } catch { return def; }
    }

    static getParsedItem(key, def = []) {
        try {
        const data = this.getItem(key);
        return data ? JSON.parse(data) : def;
        } catch { return def; }
    }
}

/**
 * DOMCache: 缓存页面元素，减少重复查询，提升脚本性能
 */
class DOMCache {
    static cache = new Map();
    static maxAge = CONFIG.PERFORMANCE.DOM_CACHE_MAX_AGE;

    static get(selector) {
        const cached = this.cache.get(selector);
        if (cached && Date.now() - cached.time < this.maxAge) {
            return cached.element;
        }

        const element = document.querySelector(selector);
        if (element) {
            this.cache.set(selector, { element, time: Date.now() });
        }
        return element;
    }

    static getAll(selector) {
        return document.querySelectorAll(selector);
    }

    static clear() {
        this.cache.clear();
    }

    static remove(selector) {
        this.cache.delete(selector);
    }
}

/**
 * ManagedSet：带大小限制的集合，防止数据溢出
 */
class ManagedSet {
    constructor(maxSize = 500) {
        this.items = new Set();
        this.maxSize = maxSize;
    }

    add(item) {
        if (this.items.size >= this.maxSize) {
            const first = this.items.values().next().value;
            this.items.delete(first);
        }
        this.items.add(item);
    }

    has(item) { return this.items.has(item); }
    delete(item) { return this.items.delete(item); }
    clear() { this.items.clear(); }
    get size() { return this.items.size; }
    toArray() { return Array.from(this.items); }
}

/**
 * EventManager：事件统一管理，防止重复绑定、内存泄漏
 */
class EventManager {
    static listeners = new Map();

    static add(element, event, handler, options = {}) {
        const key = `${element.id || element.className}-${event}-${Date.now()}`;
        if (this.listeners.has(key)) this.remove(key);
        element.addEventListener(event, handler, options);
        this.listeners.set(key, { element, event, handler });
        return key;
    }

    static remove(key) {
        const l = this.listeners.get(key);
        if (l) {
        l.element.removeEventListener(l.event, l.handler);
        this.listeners.delete(key);
        }
    }

    static removeAll() {
        this.listeners.forEach((_, k) => this.remove(k));
    }
}

/**
 * DOMUtils：DOM 常用工具：等待、点击、输入、防抖
 */
class DOMUtils {
    // 等待元素加载
    static async waitForElement(selectorOrFn, timeout = 5000) {
        return new Promise((resolve) => {
            const check = () => {
                const el = typeof selectorOrFn === "function"
                    ? selectorOrFn()
                    : document.querySelector(selectorOrFn);
                if (el) {
                    resolve(el);
                    return true;
                }
                return false;
            };

            if (check()) {
                return;
            }

            const timer = setTimeout(() => {
                observer.disconnect();
                resolve(null); // 超时返回 null
            }, timeout);

            const observer = new MutationObserver(() => {
                if (check()) {
                    clearTimeout(timer);
                    observer.disconnect();
                }
            });

            observer.observe(document.body, {
                childList: true,
                subtree: true
            });
        });
    }

    static async waitForAndAct(selector, action, options = {}) {
        const { timeout = 5000, retryInterval = 100, maxRetries = 3 } = options;
        for (let i = 0; i < maxRetries; i++) {
        try {
            const el = await this.waitForElement(selector, timeout);
            if (el) return await action(el);
        } catch (e) {
            if (i === maxRetries - 1) throw e;
            await this.delay(retryInterval);
        }
        }
        return null;
    }

    static async clickElement(sel, opt = {}) {
        return this.waitForAndAct(sel, el => this.simulateClick(el), opt);
    }

    static debounce(fn, delay = CONFIG.UI.DEBOUNCE_DELAY) {
        let t;
        return (...args) => {
        clearTimeout(t);
        t = setTimeout(() => fn(...args), delay);
        };
    }

    static delay(baseMs, context = 'default') {
        const contextMultipliers = {
            default: 1.0,
            click: 1.1,
            scroll: 1.3,
            load: 1.5,
            input: 1.2,
            modal: 1.4
        };

        const multiplier = contextMultipliers[context] || 1.0;
        const randomFactor = 0.85 + Math.random() * 0.3;
        const finalMs = baseMs * multiplier * randomFactor;
        return new Promise(resolve => setTimeout(resolve, finalMs));
    }

    // 模拟点击
    static async simulateClick(element) {
        if (!element) return;

        const events = ["mouseover", "mousemove", "mousedown", "mouseup", "click"];
        for (const event of events) {
            element.dispatchEvent(new MouseEvent(event, { bubbles: true }));
            await this.delay(CONFIG.DELAYS.SHORT);
        }
    }
}

class Logger {
    // 日志输出
    info(message) {
        const time = new Date().toLocaleTimeString();
        const logPanel = document.querySelector("#pro-log");
        if (!logPanel) return;

        const item = document.createElement("div");
        item.className = "log-item";
        item.textContent = `[${time}] ${message}`;
        logPanel.appendChild(item);
        logPanel.scrollTop = logPanel.scrollHeight;
    }

    error(message) {
        const time = new Date().toLocaleTimeString();
        const logPanel = document.querySelector("#pro-log");
        if (!logPanel) return;

        const item = document.createElement("div");
        item.className = "log-item";
        // 关键：设置红色字体
        item.style.color = "#ff4444"; // 亮红色
        item.style.fontWeight = "bold"; // 可选：加粗
        item.textContent = `[${time}] ❌ ${message}`;

        logPanel.appendChild(item);
        logPanel.scrollTop = logPanel.scrollHeight;
    }
}
let logger = new Logger();

// ==============================================
// 4. 全局状态（（脚本核心内存））
// ==============================================
const state = {
    isRunning: false,
    currentPageType: null,
    currentIndex: 0,
    currentCityIndex: 0,

    excludeKeywords: [],
    locationKeywords: [],

    jobList: [],
    totalDelivered: 0,
    maxTotalDeliver: 10,

    ui: {
        isMinimized: false,
        theme: localStorage.getItem("theme") || "light",
    },

    hrInteractions: {
        processedHRs: new Set(getStoredJSON("processedHRs", [])),
        sentGreetingsHRs: new Set(getStoredJSON("sentGreetingsHRs", [])),
        sentResumeHRs: new Set(getStoredJSON("sentResumeHRs", [])),
        lastMessageTime: getStoredJSON("lastMessageTime", {}),
    },

    ai: {
        replyCount: getStoredJSON("aiReplyCount", 0),
        lastAiDate: localStorage.getItem("lastAiDate") || "",
        useAiReply: true,
    },

    settings: {
        useAutoSendResume: getStoredJSON("useAutoSendResume", false),
        actionDelays: {
            click: parseInt(localStorage.getItem("clickDelay") || "130"),
        },
        ai: {
            role:
                localStorage.getItem("aiRole") ||
                "你是求职的应届生正在面对HR，回复需满足：20字内，编造专业对口/实习经验/证书任一岗位优势；被问个人信息或岗位条件，直接配合提供合理数据；全程积极真诚无拒绝言辞。",
            apiKey: localStorage.getItem("aiApiKey") || "",
            apiUrl: localStorage.getItem("aiApiUrl") || "https://spark-api-open.xf-yun.com/v1/chat/completions",
            model: localStorage.getItem("aiModel") || "lite",
            useCustomApi: localStorage.getItem("useCustomApi") === "true",
        },
        autoReply: getStoredJSON("autoReply", false),
        communicationMode:
        localStorage.getItem("communicationMode") || "new-only",
        recruiterActivityStatus: getStoredJSON(
            "recruiterActivityStatus",
            ["不限"]
        ),
        excludeHeadhunters: getStoredJSON("excludeHeadhunters", false),
        resumeText: getStoredJSON("resumeText", ""),
        resumeAnalysis: getStoredJSON("resumeAnalysis", ""),
        greetingsList: getStoredJSON("greetingsList", [

        ]),
        useJobDetailMatch: getStoredJSON("useJobDetailMatch", true),
        matchThreshold: getStoredJSON("matchThreshold", 60),
        useSchedule: getStoredJSON("useSchedule", false),
        scheduleHour: parseInt(getStoredJSON("scheduleHour", 11)),
        scheduleCount: parseInt(getStoredJSON("scheduleCount", 20)),
        lastScheduleDate: localStorage.getItem("lastScheduleDate") || "",
        scheduleDeliveredCount: 0,
        scheduleTargetCount: 0,
    },

    comments: {
        currentCompanyName: "",
        commentsList: [],
        isLoading: false,
        isCommentMode: false,
    },
};

/**
 * StatePersistence：状态持久化，支持保存与恢复
 */
class StatePersistence {
    static saveState() {
        const data = {
            aiReplyCount: state.ai.replyCount,
            lastAiDate: state.ai.lastAiDate,
            useAiReply: state.ai.useAiReply,
            useAutoSendResume: state.settings.useAutoSendResume,
            useJobDetailMatch: state.settings.useJobDetailMatch,
            matchThreshold: state.settings.matchThreshold,
            theme: state.ui.theme,
            excludeKeywords: state.excludeKeywords,
            locationKeywords: state.locationKeywords,
        };
        Object.entries(data).forEach(([k, v]) => LocalStorageManager.setItem(k, v));
    }

    static loadState() {
        state.excludeKeywords = LocalStorageManager.getParsedItem("excludeKeywords", []);
        state.locationKeywords = LocalStorageManager.getParsedItem("locationKeywords", []);
    }

    static saveSettings() {
        const data = {
            useAutoSendResume: state.settings.useAutoSendResume,
            clickDelay: state.settings.actionDelays.click,
            aiRole: state.settings.aiRole,
            autoReply: state.settings.autoReply,
            recruiterActivityStatus: state.settings.recruiterActivityStatus,
            excludeHeadhunters: state.settings.excludeHeadhunters,
            useJobDetailMatch: state.settings.useJobDetailMatch,
            matchThreshold: state.settings.matchThreshold,
            useSchedule: state.settings.useSchedule,
            scheduleHour: state.settings.scheduleHour,
            scheduleCount: state.settings.scheduleCount,
        };
        Object.entries(data).forEach(([k, v]) => LocalStorageManager.setItem(k, v));
    }
}

const elements = {
    panel: null,
    miniIcon: null,
    log: null,
    controlBtn: null,
    excludeInput: null,
    locationInput: null,
    communicationIncludeInput: null,
    communicationModeSelector: null,
};

// ==============================================
// 5. UI配置：UI管理、设置对话框
// ==============================================
class UIManager {
    static init() {
        this.setCurrentPageType();
        this.applyTheme();
        this.createControlPanel();
        this.createMiniIcon();
    }

    static setCurrentPageType() {
        state.currentPageType = location.pathname.includes('/chat')
            ? PAGE_TYPES.CHAT
            : PAGE_TYPES.JOB_LIST;
    }

    static applyTheme() {
        const colors = state.currentPageType === PAGE_TYPES.JOB_LIST
            ? THEMES.JOB_LIST
            : THEMES.CHAT;

        const root = document.documentElement;
        root.style.setProperty('--primary-color', colors.primary);
        root.style.setProperty('--secondary-color', colors.secondary);
        root.style.setProperty('--accent-color', colors.accent);
        root.style.setProperty('--neutral-color', colors.neutral);
        root.style.setProperty('--primary-rgb', this.hexToRgb(colors.primary));
    }

    static createControlPanel() {
        const oldPanel = document.getElementById('boss-pro-panel');
        if (oldPanel) oldPanel.remove();

        elements.panel = this.createPanel();
        const header = this.createHeader();
        const controls = this.createPageControls();
        elements.log = this.createLogger();
        const footer = this.createFooter();

        elements.panel.append(header, controls, elements.log, footer);
        document.body.appendChild(elements.panel);
        this.makeDraggable(elements.panel);
    }

    static createPanel() {
        return this.createDiv({
            id: 'boss-pro-panel',
            className: state.currentPageType === PAGE_TYPES.JOB_LIST
                ? 'boss-joblist-panel'
                : 'boss-chat-panel',
            cssText: `
                position: fixed; top: 36px; right: 24px;
                width: clamp(300px, 80vw, 400px);
                border-radius: 12px; padding: 12px;
                font-family: 'Segoe UI', system-ui, sans-serif;
                z-index: 2147483647; display: flex;
                flex-direction: column; transition: all 0.3s ease;
                background: #fff; box-shadow: 0 10px 25px rgba(var(--primary-rgb), 0.15);
                border: 1px solid var(--accent-color); cursor: default;
            `
        });
    }

    static createHeader() {
        const header = this.createDiv({
            className: state.currentPageType === PAGE_TYPES.JOB_LIST
                ? 'boss-header'
                : 'boss-chat-header',
            cssText: `
                display: flex; justify-content: space-between;
                align-items: center; padding: 0 10px 15px;
                margin-bottom: 15px; border-bottom: 1px solid var(--accent-color);
            `
        });

        const title = this.createTitle();
        const btnGroup = this.createHeaderButtons();
        header.append(title, btnGroup);
        return header;
    }

    static createTitle() {
        const title = this.createDiv({
            cssText: 'display: flex; align-items: center; gap: 10px;'
        });

        const iconSvg = `
            <svg viewBox="0 0 1024 1024" style="width:100%;height:100%;fill:white;">
                <path d="M896 256H640V160c0-35.3-28.7-64-64-64H448c-35.3 0-64 28.7-64 64v96H128c-35.3 0-64 28.7-64 64v512c0 35.3 28.7 64 64 64h768c35.3 0 64-28.7 64-64V320c0-35.3-28.7-64-64-64zM448 160h128v96H448V160zm448 672H128V320h768v512z" />
                <path d="M512 480c-70.7 0-128 57.3-128 128s57.3 128 128 128 128-57.3 128-128-57.3-128-128-128zm0 192c-35.3 0-64-28.7-64-64s28.7-64 64-64 64 28.7 64 64-28.7 64-64 64z" />
            </svg>`;

        const text = state.currentPageType === PAGE_TYPES.JOB_LIST
            ? { main: '<span style="color:var(--primary-color);">AI</span>-Boss海投助手', sub: '高效求职 · 智能匹配' }
            : { main: '<span style="color:var(--primary-color);">AI</span>-Boss智能聊天', sub: '智能对话 · 高效沟通' };

        title.innerHTML = `
            <div style="width:40px;height:40px;background:var(--primary-color);border-radius:10px;display:flex;justify-content:center;align-items:center;box-shadow:0 2px 8px rgba(var(--primary-rgb),0.3);">
                ${iconSvg}
            </div>
            <div>
                <h3 style="margin:0;color:#2c3e50;font-weight:600;font-size:1.2rem;">${text.main}</h3>
                <span style="font-size:0.8em;color:var(--neutral-color);">${text.sub}</span>
            </div>`;
        return title;
    }

    static createHeaderButtons() {
        const container = this.createDiv({ cssText: 'display: flex; gap: 8px;' });
        const buttons = [
            {
                html: `<svg t="1767250169245" viewBox="0 0 1024 1024" width="20" height="20" fill="#4285f4"><path d="M512 64C264.6 64 64 264.6 64 512s200.6 448 448 448 448-200.6 448-448S759.4 64 512 64z m0 820c-205.4 0-372-166.6-372-372s166.6-372 372-372 372 166.6 372 372-166.6 372-372 372z" fill="currentColor"/><path d="M512 540m-80 0a80 80 0 1 0 160 0 80 80 0 1 0-160 0Z" fill="currentColor"/><path d="M512 300c-26.5 0-48 21.5-48 48v96c0 26.5 21.5 48 48 48s48-21.5 48-48v-96c0-26.5-21.5-48-48-48zM300 512c0-26.5-21.5-48-48-48h-96c-26.5 0-48 21.5-48 48s21.5 48 48 48h96c26.5 0 48-21.5 48-48zM512 724c-26.5 0-48 21.5-48 48v96c0 26.5 21.5 48 48 48s48-21.5 48-48v-96c0-26.5-21.5-48-48-48zM868 464h-96c-26.5 0-48 21.5-48 48s21.5 48 48 48h96c26.5 0 48-21.5 48-48s-21.5-48-48-48z" fill="currentColor"/></svg>`,
                click: () => DialogManager.showActivationDialog(),
                title: 'AI配置'
            },
            { html: '⚙', click: () => DialogManager.showSettingsDialog(), title: '插件设置' },
            {
                html: '✕',
                click: () => {
                    state.isMinimized = true;
                    elements.panel.style.transform = 'translateY(160%)';
                    elements.miniIcon.style.display = 'flex';
                },
                title: state.currentPageType === PAGE_TYPES.JOB_LIST ? '最小化海投面板' : '最小化聊天面板'
            }
        ];

        buttons.forEach(item => {
            container.appendChild(this.createIconButton(item.html, item.click, item.title));
        });
        return container;
    }

    static createPageControls() {
        return state.currentPageType === PAGE_TYPES.JOB_LIST
            ? this.createJobListControls()
            : this.createChatControls();
    }

    static createJobListControls() {
        const container = this.createDiv({
            className: 'boss-joblist-controls',
            cssText: 'margin-bottom:15px; padding:0 10px;'
        });

        const filter = this.createDiv({
            cssText: 'background:var(--secondary-color); border-radius:12px; padding:15px;'
        });

        const row = this.createDiv({
            cssText: 'display:flex; gap:10px; margin-bottom:12px;'
        });

        const exclude = this.createInput('职位名不包含：', 'exclude-filter', '如：外包,字节');
        const location = this.createInput('工作地包含：', 'location-filter', '如：杭州,滨江');

        elements.excludeInput = exclude.querySelector('input');
        elements.locationInput = location.querySelector('input');
        row.append(exclude, location);

        elements.controlBtn = this.createTextButton('启动海投', {
            bg: 'var(--primary-color)',
            onClick: ActionManager.toggleProcess
        });

        filter.append(row, elements.controlBtn);
        container.append(filter);
        return container;
    }

    static createChatControls() {
        const container = this.createDiv({
            cssText: 'background:var(--secondary-color); border-radius:12px; padding:15px; margin:0 10px 15px;'
        });

        const row = this.createDiv({
            cssText: 'display:flex; gap:10px; margin-bottom:15px;'
        });

        const include = this.createInput('沟通岗位包含：', 'communication-include', '如：技术,产品,设计');
        const mode = this.createSelect('沟通模式：', 'communication-mode-selector', [
            { value: 'new-only', text: '仅新消息' },
            { value: 'auto', text: '自动轮询' },
        ]);

        elements.communicationIncludeInput = include.querySelector('input');
        elements.communicationModeSelector = mode.querySelector('select');
        elements.communicationModeSelector.addEventListener('change', e => {
            state.settings.communicationMode = e.target.value;
            StatePersistence.saveSettings();
        });

        elements.controlBtn = this.createTextButton('开始智能聊天', {
            bg: 'var(--primary-color)',
            onClick: ActionManager.toggleChatProcess
        });

        row.append(include, mode);
        container.append(row, elements.controlBtn);
        return container;
    }

    static createFooter() {
        return this.createDiv({
            cssText: `
                text-align:center; font-size:0.8em; color:var(--neutral-color);
                padding-top:15px; border-top:1px solid var(--accent-color);
            `
        }, '© 2026 AI-boss海投助手 · AGPL-3.0-or-later');
    }

    static createDiv(options = {}) {
        const div = document.createElement('div');
        if (options.id) div.id = options.id;
        if (options.className) div.className = options.className;
        if (options.cssText) div.style.cssText = options.cssText;
        if (options.textContent) div.textContent = options.textContent;
        return div;
    }

    static createTextSpan(text, options = {}) {
        const { min_width = '30px', color = '#6b7280', font_size = '14px' } = options;
        const label = document.createElement('span');
        label.textContent = text;
        label.style.cssText = `
            font-size: ${font_size};
            color: ${color};
            min-width: ${min_width};
        `;
        return label;
    }

    static createInput(label, id, placeholder) {
        const wrap = this.createDiv({ cssText: 'flex:1;' });
        const lab = document.createElement('label');
        lab.textContent = label;
        lab.style.cssText = 'display:block;margin-bottom:5px;font-weight:500;color:#333;font-size:0.9rem;';

        const input = document.createElement('input');
        input.id = id;
        input.placeholder = placeholder;
        input.style.cssText = `
            width:100%;padding:8px 10px;border-radius:8px;
            border:1px solid #d1d5db;font-size:14px;
        `;

        wrap.append(lab, input);
        return wrap;
    }

    static createRangeInput(threshold) {
        const slider = document.createElement('input');
        slider.type = 'range';
        slider.min = '0';
        slider.max = '100';
        slider.value = threshold || 60;
        slider.style.cssText = `
            flex:1; height:6px; border-radius:3px; background:#e5e7eb; cursor:pointer;
        `;
        return slider;
    }

    static createTextArea(options = {}) {
        const text = document.createElement('textarea');
        if (options.id) text.id = options.id;
        if (options.rows && options.rows > 0) text.rows = options.rows;
        if (options.value) text.value = options.value;
        if (options.placeholder) text.placeholder = options.placeholder;
        if (options.className) text.className = options.className;
        if (options.cssText) text.style.cssText = options.cssText;
        else {
            text.style.cssText = `
                width:100%; padding:12px; border-radius:8px; border:1px solid #d1d5db;
                resize:vertical; font-size:14px; transition:all 0.2s ease; margin-top:10px;
                opacity: '1';
                pointer-events: 'auto';
            `;
        }
        if (options.textContent) text.textContent = options.textContent;
        return text;
    }

    static createSelect(label, id, options) {
        const wrap = this.createDiv({ cssText: 'flex:1;' });
        const lab = document.createElement('label');
        lab.textContent = label;
        lab.style.cssText = 'display:block;margin-bottom:5px;font-weight:500;color:#333;font-size:0.9rem;';

        const select = document.createElement('select');
        select.id = id;
        select.style.cssText = `
            width:100%; padding:8px 10px; border-radius:8px;
            border:1px solid #d1d5db; font-size:14px; background:#fff;
        `;

        options.forEach(opt => {
            const o = document.createElement('option');
            o.value = opt.value;
            o.textContent = opt.text;
            select.appendChild(o);
        });

        wrap.append(lab, select);
        return wrap;
    }

    static createTextButton(text, options = {}) {
        const btn = document.createElement('button');
        btn.textContent = text;

        if (options.className) btn.className = options.className;
        if (options.cssText) btn.style.cssText = options.cssText
        else {
            btn.style.cssText = `
                width:100%; padding:10px 16px; background:${options.bg || 'rgba(0, 123, 255, 0.9)'}; color:${options.color || '#fff'};
                border:none; border-radius:10px; cursor:pointer; font-size:15px; font-weight:500;
                transition:all 0.3s ease; box-shadow:0 4px 10px rgba(0,0,0,0.1);
            `;
        }
        if (options.onClick) btn.addEventListener('click', options.onClick);

        btn.addEventListener('mouseenter', () => {
            btn.style.boxShadow = '0 6px 15px rgba(var(--primary-rgb),0.3)';
        });
        btn.addEventListener('mouseleave', () => {
            btn.style.boxShadow = '0 4px 10px rgba(0,0,0,0.1)';
        });
        return btn;
    }

    static createIconButton(icon, onClick, title) {
        const btn = document.createElement('button');
        btn.className = 'boss-icon-btn';
        btn.innerHTML = icon;
        btn.title = title;

        btn.style.cssText = `
            width:32px; height:32px; border-radius:50%; border:none;
            background:var(--accent-color); cursor:pointer; font-size:16px;
            transition:all 0.2s ease; display:flex; justify-content:center;
            align-items:center; color:var(--primary-color); overflow:hidden;
        `;

        if (icon.includes('<svg')) btn.style.padding = '4px';

        btn.addEventListener('click', onClick);
        btn.addEventListener('mouseenter', () => {
            btn.style.background = 'var(--primary-color)';
            btn.style.color = '#fff';
            btn.style.transform = 'scale(1.1)';
            const svg = btn.querySelector('svg path');
            if (svg) svg.setAttribute('fill', '#fff');
        });
        btn.addEventListener('mouseleave', () => {
            btn.style.background = 'var(--accent-color)';
            btn.style.color = 'var(--primary-color)';
            btn.style.transform = 'scale(1)';
        });
        return btn;
    }

    static toggleStatusOption(value, settings) {
        if (value === "不限") {
            settings.recruiterActivityStatus = settings.recruiterActivityStatus.includes("不限") ? [] : ["不限"];
        } else {
            if (settings.recruiterActivityStatus.includes("不限")) {
                settings.recruiterActivityStatus = [value];
            } else {
                if (settings.recruiterActivityStatus.includes(value)) {
                    settings.recruiterActivityStatus = settings.recruiterActivityStatus.filter(v => v !== value);
                } else {
                    settings.recruiterActivityStatus.push(value);
                }
                if (settings.recruiterActivityStatus.length === 0) {
                    settings.recruiterActivityStatus = ["不限"];
                }
            }
        }
        return settings.recruiterActivityStatus;
    }

    static updateStatusOptions(settings) {
        const options = document.querySelectorAll("#recruiter-status-select .select-option");
        options.forEach(option => {
            const isSelected = settings.recruiterActivityStatus.includes(option.dataset.value);
            option.className = "select-option" + (isSelected ? " selected" : "");
            const checkIcon = option.querySelector(".check-icon");
            if (checkIcon) checkIcon.style.display = isSelected ? "inline" : "none";

            if (option.dataset.value === "不限") {
                if (isSelected) {
                    options.forEach(opt => {
                        if (opt.dataset.value !== "不限") {
                            opt.className = "select-option";
                            const chk = opt.querySelector(".check-icon");
                            if (chk) chk.style.display = "none";
                        }
                    });
                }
            } else if (settings.recruiterActivityStatus.includes("不限")) {
                const chk = option.querySelector(".check-icon");
                if (chk) chk.style.display = "none";
                option.className = "select-option";
            }
        });

        const clearEl = document.querySelector("#recruiter-status-select .select-clear");
        if (clearEl) {
            clearEl.style.display = (settings.recruiterActivityStatus.length > 0 && !settings.recruiterActivityStatus.includes("不限")) ? "inline" : "none";
        }
    }

    static getStatusDisplayText(settings) {
        const arr = settings.recruiterActivityStatus || [];
        if (arr.includes("不限")) return "不限";
        if (arr.length === 0) return "请选择";
        if (arr.length <= 2) return arr.join("、");
        return `${arr[0]}、${arr[1]}等${arr.length}项`;
    }

    static createLogger() {
        const log = this.createDiv({
            id: 'pro-log',
            cssText: `
                height:260px; overflow-y:auto; background:var(--secondary-color);
                border-radius:12px; padding:12px; font-size:13px; line-height:1.5;
                margin:0 10px 15px; user-select:text;
            `
        });
        log.innerHTML = `
            <style>
                #pro-log::-webkit-scrollbar{width:6px;}
                #pro-log::-webkit-scrollbar-track{background:var(--secondary-color);}
                #pro-log::-webkit-scrollbar-thumb{background:var(--primary-color);border-radius:4px;}
            </style>`;
        return log;
    }

    static createMiniIcon() {
        elements.miniIcon = this.createDiv({
            cssText: `
                width:${CONFIG.MINI_ICON_SIZE}px; height:${CONFIG.MINI_ICON_SIZE}px;
                position:fixed; bottom:40px; left:40px; background:var(--primary-color);
                border-radius:50%; box-shadow:0 6px 16px rgba(var(--primary-rgb),0.4);
                cursor:pointer; display:none; justify-content:center; align-items:center;
                color:#fff; z-index:2147483647; transition:all 0.3s ease;
            `
        });

        elements.miniIcon.innerHTML = `<svg viewBox="0 0 1024 1024" style="width:80%;height:80%;fill:white;"><path d="M512 116.032a160 160 0 0 1 52.224 311.232v259.008c118.144-22.272 207.552-121.088 207.552-239.36 0-25.152 21.568-45.568 48.128-45.568 26.624 0 48.128 20.416 48.128 45.632 0 184.832-158.848 335.232-354.048 335.232S160 631.808 160 446.976c0-25.152 21.568-45.632 48.128-45.632 26.624 0 48.128 20.48 48.128 45.632 0 118.144 89.088 216.96 206.976 239.296V428.416A160.064 160.064 0 0 1 512 116.032z"/></svg>`;

        elements.miniIcon.addEventListener('click', () => {
            state.isMinimized = false;
            elements.panel.style.transform = 'translateY(0)';
            elements.miniIcon.style.display = 'none';
        });
        document.body.appendChild(elements.miniIcon);
    }

    static makeDraggable(panel) {
        const header = panel.querySelector('.boss-header, .boss-chat-header');
        if (!header) return;
        header.style.cursor = 'move';

        let isDrag = false, startX = 0, startY = 0, initX = 0, initY = 0;

        header.addEventListener('mousedown', e => {
            isDrag = true;
            startX = e.clientX;
            startY = e.clientY;
            initX = panel.offsetLeft;
            initY = panel.offsetTop;
            panel.style.transition = 'none';
        });

        document.addEventListener('mousemove', e => {
            if (!isDrag) return;
            panel.style.left = initX + e.clientX - startX + 'px';
            panel.style.top = initY + e.clientY - startY + 'px';
            panel.style.right = 'auto';
        });

        document.addEventListener('mouseup', () => {
            isDrag = false;
            panel.style.transition = 'all 0.3s ease';
        });
    }

    static setActiveTab(tab, panel) {
        const tabs = document.querySelectorAll('.settings-tab');
        const panels = [
            document.getElementById('ai-settings-panel'),
            document.getElementById('advanced-settings-panel')
        ];

        tabs.forEach(t => {
            t.classList.remove('active');
            t.style.backgroundColor = 'rgba(0, 0, 0, 0.05)';
            t.style.color = '#333';
        });

        panels.forEach(p => {
            p.style.display = 'none';
        });

        tab.classList.add('active');
        tab.style.backgroundColor = 'rgba(0, 123, 255, 0.9)';
        tab.style.color = 'white';
        panel.style.display = 'block';
    }

    static addFocusBlurEffects(...elements) {
        const allElements = Array.from(elements).flat();

        allElements.forEach(el => {
            if (!el || !el.addEventListener) return;

            el.addEventListener('focus', () => {
            el.style.borderColor = 'rgba(0, 123, 255, 0.7)';
            el.style.boxShadow = '0 0 0 3px rgba(0, 123, 255, 0.2)';
            });

            el.addEventListener('blur', () => {
            el.style.borderColor = '#d1d5db';
            el.style.boxShadow = 'none';
            });
        });
    }

    static hexToRgb(hex) {
        hex = hex.replace('#', '');
        const r = parseInt(hex.substring(0, 2), 16);
        const g = parseInt(hex.substring(2, 4), 16);
        const b = parseInt(hex.substring(4, 6), 16);
        return `${r},${g},${b}`;
    }

    static showNotification(message, type = 'success') {
        const notification = document.createElement('div');
        const bgColor = type === 'success'
            ? 'rgba(40, 167, 69, 0.9)'
            : 'rgba(220, 53, 69, 0.9)';

        notification.style.cssText = `
            position: fixed; top: 20px; left: 50%; transform: translateX(-50%);
            background: ${bgColor}; color: white; padding: 10px 15px; border-radius: 8px;
            box-shadow: 0 4px 10px rgba(0,0,0,0.2); z-index: 9999999;
            opacity: 0; transition: opacity 0.3s ease;
        `;

        notification.textContent = message;
        document.body.appendChild(notification);

        setTimeout(() => { notification.style.opacity = '1'}, 10);
        setTimeout(() => {
            notification.style.opacity = '0';
            setTimeout(() => document.body.removeChild(notification), 300);
        }, 2000);
    }
}

// ==============================================
// 6. 弹出会话框：设置修改、投递、聊天
// ==============================================
/**
 * DialogManager：设置框
 */
class DialogManager {
    static showSettingsDialog() {
        let d = document.getElementById('boss-settings-dialog');
        if (!d) {
            d = this.createSettingsDialog();
            document.body.appendChild(d);
        }
        d.style.display = 'flex';
        setTimeout(() => d.classList.add('active'), 10);
    }

    static createSettingsDialog() {
        const dialog = UIManager.createDiv({
            id: 'boss-settings-dialog',
            cssText: `
                position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);
                width:clamp(300px,90vw,550px);height:80vh;background:#fff;border-radius:12px;
                box-shadow:0 10px 30px rgba(0,0,0,0.15);z-index:999999;display:none;
                flex-direction:column;overflow:hidden;`
        });

        dialog.innerHTML = `
        <style>
            #boss-settings-dialog{opacity:0;transform:translate(-50%,-50%) scale(0.95);}
            #boss-settings-dialog.active{opacity:1;transform:translate(-50%,-50%) scale(1);}
            .setting-item{transition:all .2s ease;}
            .setting-item:hover{background:rgba(0,123,255,.05);}
            .multi-select-container{position:relative;width:100%;margin-top:10px;}
            .multi-select-header{display:flex;justify-content:space-between;align-items:center;padding:10px;border-radius:8px;border:1px solid #d1d5db;background:#fff;cursor:pointer;transition:.2s;}
            .multi-select-header:hover{border-color:rgba(0,123,255,.7);}
            .multi-select-options{position:absolute;top:100%;left:0;right:0;max-height:200px;overflow-y:auto;border-radius:8px;border:1px solid #d1d5db;background:#fff;z-index:100;box-shadow:0 4px 10px rgba(0,0,0,.1);display:none;}
            .multi-select-option{padding:10px;cursor:pointer;transition:.2s;}
            .multi-select-option:hover{background:rgba(0,123,255,.05);}
            .multi-select-option.selected{background:rgba(0,123,255,.1);}
            .multi-select-clear{color:#666;cursor:pointer;margin-left:5px;}
            .multi-select-clear:hover{color:#333;}
        </style>`;

        dialog.append(
            this.createSettingDialogHeader("AI-Boss海投助手·设置"),
            this.createSettingDialogContent(),
            this.createSettingDialogFooter()
        );

        dialog.addEventListener('click', e => e.target === dialog && (dialog.style.display = 'none'));

        return dialog;
    }

    static createSettingDialogHeader(title, dialogId = "boss-settings-dialog") {
        const header = document.createElement("div");
        header.style.cssText = `
            padding: 16px 20px;background: #4285f4;color: white;font-size: 18px;font-weight: 600;
            display: flex;justify-content: space-between;align-items: center;position: relative;
            border-radius: 12px 12px 0 0;
        `;

        const titleElement = document.createElement("div");
        titleElement.textContent = title;
        titleElement.style.fontWeight = "600";

        const closeBtn = document.createElement("button");
        closeBtn.innerHTML = "✕";
        closeBtn.title = "关闭";
        closeBtn.style.cssText = `
            width: 28px;height: 28px;background: rgba(255, 255, 255, 0.2);color: white;
            border-radius: 50%;display: flex;justify-content: center;align-items: center;
            cursor: pointer;transition: all 0.2s ease;border: none;font-size: 16px;font-weight: bold;
        `;

        closeBtn.addEventListener("mouseenter", () => {
            closeBtn.style.backgroundColor = "rgba(255, 255, 255, 0.3)";
            closeBtn.style.transform = "scale(1.1)";
        });

        closeBtn.addEventListener("mouseleave", () => {
            closeBtn.style.backgroundColor = "rgba(255, 255, 255, 0.2)";
            closeBtn.style.transform = "scale(1)";
        });

        closeBtn.addEventListener("click", () => {
            const dialog = document.getElementById(dialogId);
            if (dialog) {
                dialog.style.display = "none";
            }
        });

        header.append(titleElement, closeBtn);
        return header;
    }

    static createSettingDialogContent() {
        const dialogContent = UIManager.createDiv({
            cssText: `
                padding: 18px;flex: 1;overflow-y: auto;scrollbar-width: thin;
                scrollbar-color: rgba(0, 123, 255, 0.5) rgba(0, 0, 0, 0.05);`
        });
        dialogContent.innerHTML += `
            <style>
                #boss-settings-dialog ::-webkit-scrollbar {
                    width: 8px;
                    height: 8px;
                }
                #boss-settings-dialog ::-webkit-scrollbar-track {
                    background: rgba(0,0,0,0.05);
                    border-radius: 10px;
                    margin: 8px 0;
                }
                #boss-settings-dialog ::-webkit-scrollbar-thumb {
                    background: rgba(0, 123, 255, 0.5);
                    border-radius: 10px;
                    box-shadow: 0 1px 3px rgba(0,0,0,0.1);
                    transition: all 0.2s ease;
                }
                #boss-settings-dialog ::-webkit-scrollbar-thumb:hover {
                    background: rgba(0, 123, 255, 0.7);
                    box-shadow: 0 1px 5px rgba(0,0,0,0.15);
                }
            </style>
        `;
        const aiSettingsPanel = this.createAISettings();
        const advancedSettingsPanel = this.createAdvancedSettings();

        const aiTab = UIManager.createTextButton("聊天设置", {
            bg: "rgba(0, 123, 255, 0.9)",
            className: "settings-tab active",
            onClick: () => { UIManager.setActiveTab(aiTab, aiSettingsPanel); },
        });
        const advancedTab = UIManager.createTextButton("高级设置", {
            bg: "rgba(0, 0, 0, 0.05)",
            className: "settings-tab",
            color: "#333",
            onClick: () => { UIManager.setActiveTab(advancedTab, advancedSettingsPanel); },
        });
        const tabsContainer = document.createElement("div");
        tabsContainer.style.cssText = `display: flex;border-bottom: 1px solid rgba(0, 123, 255, 0.2);margin-bottom: 20px;`;
        tabsContainer.append(aiTab, advancedTab);

        dialogContent.append(tabsContainer, aiSettingsPanel, advancedSettingsPanel);
        return dialogContent;
    }

    static createSettingDialogFooter() {
        const dialogFooter = document.createElement("div");
        dialogFooter.style.cssText = `
            padding: 15px 20px;border-top: 1px solid #e5e7eb;display: flex;
            justify-content: flex-end;gap: 10px;background: rgba(0, 0, 0, 0.03);
        `;

        const cancelBtn = UIManager.createTextButton("取消", {
            bg: "#e5e7eb",
            onClick: () => {
                const dialog = document.getElementById('boss-settings-dialog');
                if (dialog) dialog.style.display = "none";
            }
        });
        const saveBtn = UIManager.createTextButton("保存设置", {
            bg: "rgba(0, 123, 255, 0.9)",
            onClick: () => {
                try {
                    const aiRoleInput = document.getElementById("ai-role-input");
                    state.settings.ai.role = aiRoleInput ? aiRoleInput.value : "";
                    StatePersistence.saveSettings();
                    UIManager.showNotification("设置已保存");
                    const dialog = document.getElementById('boss-settings-dialog');
                    if (dialog) dialog.style.display = "none";
                } catch (error) {
                    UIManager.showNotification("保存失败: " + error.message, "error");
                    console.error("保存设置失败:", error);
                }
            },
        });

        dialogFooter.append(cancelBtn, saveBtn);
        return dialogFooter;
    }

    static createSettingItem(title, description, controlGetter) {
        const settingItem = document.createElement("div");
        settingItem.className = "setting-item";
        settingItem.style.cssText = `
            padding: 15px;
            border-radius: 10px;
            margin-bottom: 15px;
            background: white;
            box-shadow: 0 1px 3px rgba(0,0,0,0.05);
            border: 1px solid rgba(0, 123, 255, 0.1);
            display: flex;
            flex-direction: column;
        `;

        const titleElement = document.createElement("h4");
        titleElement.textContent = title;
        titleElement.style.cssText = `
            margin: 0 0 5px;
            color: #333;
            font-size: 16px;
            font-weight: 500;
        `;

        const descElement = document.createElement("p");
        descElement.textContent = description;
        descElement.style.cssText = `
            margin: 0;
            color: #666;
            font-size: 13px;
            line-height: 1.4;
        `;

        const descriptionContainer = document.createElement("div");
        descriptionContainer.style.cssText = `
            display: flex;
            justify-content: space-between;
            align-items: center;
            width: 100%;
        `;

        const textContainer = document.createElement("div");
        textContainer.append(titleElement, descElement);
        descriptionContainer.append(textContainer);
        settingItem.append(descriptionContainer);

        settingItem.addEventListener("click", () => {
            const control = controlGetter();
            if (control && typeof control.focus === "function") {
                control.focus();
            }
        });

        return {
            settingItem,
            descriptionContainer,
        };
    }

    static createAISettings() {
        const aiSettingsPanel = document.createElement("div");
        aiSettingsPanel.id = "ai-settings-panel";

        const roleSettingResult = this.createSettingItem("AI角色定位", "定义AI在对话中的角色和语气特点",
            () => document.getElementById("ai-role-input"));
        const roleSetting = roleSettingResult.settingItem;
        const roleInput = UIManager.createTextArea({id: "ai-role-input", rows: 5 });
        UIManager.addFocusBlurEffects(roleInput);
        roleSetting.append(roleInput);

        // 简历文本编辑区域
        const resumeTextLabel = UIManager.createDiv({
            "textContent": "简历内容（可编辑）：",
            "cssText": `font-size: 14px;font-weight: 600;color: #374151;margin-top: 15px;margin-bottom: 8px;`
        })
        const resumeUploadSettingResult = this.createSettingItem(
            "简历AI分析",
            "粘贴简历内容，AI将自动分析并判断岗位符合分数",
            () => document.getElementById("resume-upload-container")
        );
        const resumeUploadSetting = resumeUploadSettingResult.settingItem;
        const resumeUploadContainer = document.createElement("div");
        resumeUploadContainer.id = "resume-upload-container";
        resumeUploadContainer.style.cssText = `width: 100%;margin-top: 10px;`;
        const resumeTextArea = UIManager.createTextArea({
            id: "resume-text-input",
            placeholder: "请上传简历文件，或在此直接粘贴简历内容...",
            value: state.settings.resumeText || "",
        });
        const analysisResultArea = UIManager.createTextArea({id: "resume-analysis-result",
            placeholder: "AI分析结果将显示在这里...",
            value: state.settings.resumeAnalysis || "",
        });
        UIManager.addFocusBlurEffects(resumeTextArea, analysisResultArea);
        const resumeBtnContainer = UIManager.createDiv({cssText: `display:flex;gap:10px;margin-top:10px;`});
        const analyzeBtn = UIManager.createTextButton("AI分析简历", {
            cssText: `
                flex: 1;padding: 10px 16px;border-radius: 6px;border: none;
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);color: white;
                cursor: pointer;font-size: 14px;font-weight: 600;transition: all 0.3s ease;
            `,
            onClick: async () => {
                const resumeText = resumeTextArea.value.trim();
                if (!resumeText) {
                    UIManager.showNotification("请先输入简历内容", "error");
                    return;
                }

                state.settings.resumeText = resumeText;
                const saveResult = setLargeItem("resumeText", resumeText);
                if (saveResult === 'truncated') {
                    UIManager.showNotification("简历内容已截断", "warning");
                } else if (saveResult === false) {
                    UIManager.showNotification("无法保存到本地存储", "warning");
                } else {
                    UIManager.showNotification("简历已保存", "success");
                }

                analyzeBtn.textContent = "🔄 分析中...";
                analyzeBtn.disabled = true;

                try {
                    const ai = new AIService();
                    const analysis = await ai.analyzeResume(resumeText);
                    if (analysis) {
                        state.settings.resumeAnalysis = analysis;
                        setLargeItem("resumeAnalysis", analysis);
                        analysisResultArea.value = analysis;
                        UIManager.showNotification("简历分析完成", "success");
                    }
                } catch (error) {
                    UIManager.showNotification("分析失败: " + error.message, "error");
                } finally {
                    analyzeBtn.textContent = "🤖 AI分析简历";
                    analyzeBtn.disabled = false;
                }
            }
        });
        const saveResumeBtn = UIManager.createTextButton("保存简历", {
            cssText: `
                padding: 10px 16px;border-radius: 6px;border: 1px solid #10b981;
                background: rgba(16, 185, 129, 0.1);color: #10b981;cursor: pointer;
                font-size: 14px;font-weight: 600;transition: all 0.3s ease;
            `,
            onClick: () => {
                state.settings.resumeText = resumeTextArea.value;
                const saveResult = setLargeItem("resumeText", resumeTextArea.value);
                if (saveResult === 'truncated') {
                    UIManager.showNotification("简历已保存（内容已截断以符合存储限制）", "warning");
                } else if (saveResult === false) {
                    UIManager.showNotification("无法保存到本地存储，但当前会话可用", "warning");
                } else {
                    UIManager.showNotification("简历已保存！", "success");
            }},
        });
        resumeBtnContainer.append(analyzeBtn, saveResumeBtn);

        resumeUploadContainer.append(resumeTextLabel, resumeTextArea, resumeBtnContainer, analysisResultArea);
        resumeUploadSetting.append(resumeUploadContainer);

        const customQaSettingResult = this.createSettingItem(
            "自定义问答",
            "设置常见问题的固定回复，例如工作年限、是否在职等",
            () => document.querySelector("#custom-qa-container")
        );
        const customQaSetting = customQaSettingResult.settingItem;
        const customQaDescriptionContainer = customQaSettingResult.descriptionContainer;
        const customQaContainer = document.createElement("div");
        customQaContainer.id = "custom-qa-container";
        customQaContainer.style.cssText = `margin-top: 15px;display: flex;flex-direction: column;gap: 10px;`;

        const qaListContainer = document.createElement("div");
        qaListContainer.id = "qa-list-container";
        qaListContainer.style.cssText = `display: flex;flex-direction: column;gap: 8px;`;
        this.renderQaList();

        const addQaBtn = UIManager.createTextButton("+ 添加问答对", {
            onClick: () => {
                const qaList = getStoredJSON("customQa", []);
                qaList.push({ question: "", answer: "" });
                localStorage.setItem("customQa", JSON.stringify(qaList));
                this.renderQaList();
            }
        });
        customQaContainer.append(qaListContainer, addQaBtn);
        customQaDescriptionContainer.append(customQaContainer);
        aiSettingsPanel.append(roleSetting, resumeUploadSetting, customQaSetting);

        return aiSettingsPanel;
    }

    static renderQaList() {
        const qaListContainer = document.getElementById("qa-list-container");
        if (!qaListContainer) return;
        const qaList = getStoredJSON("customQa", []);
        qaListContainer.innerHTML = "";

        qaList.forEach((qa, index) => {
            const qaItem = document.createElement("div");
            qaItem.style.cssText = `
                display: flex;
                flex-direction: column;
                gap: 6px;
                padding: 8px;
                border: 1px solid #e5e7eb;
                border-radius: 6px;
                background: #f9fafb;
            `;

            const qaHeader = document.createElement("div");
            qaHeader.style.cssText = `
                display: flex;
                align-items: center;
                gap: 8px;
            `;

            // === 展开/收起按钮 ===
            const toggleBtn = document.createElement("button");
            toggleBtn.textContent = "▶";
            toggleBtn.style.cssText = `
                width: 22px;
                height: 22px;
                border: none;
                background: transparent;
                cursor: pointer;
                font-size: 12px;
                color: #6b7280;
            `;

            const indexLabel = document.createElement("span");
            indexLabel.textContent = `${index + 1}.`;
            indexLabel.style.cssText = `
                font-size: 13px;
                color: #6b7280;
                min-width: 20px;
            `;

            const questionInput = document.createElement("input");
            questionInput.type = "text";
            questionInput.placeholder = "问题（如：做了多久go开发）";
            questionInput.value = qa.question || "";
            questionInput.style.cssText = `
                flex: 1;
                padding: 4px 6px;
                border: 1px solid #d1d5db;
                border-radius: 4px;
                font-size: 13px;
            `;

            const answerInput = document.createElement("input");
            answerInput.type = "text";
            answerInput.placeholder = "答案（如：3年）";
            answerInput.value = qa.answer || "";
            answerInput.style.cssText = `
                flex: 1;
                padding: 4px 6px;
                border: 1px solid #d1d5db;
                border-radius: 4px;
                font-size: 13px;
            `;

            const deleteBtn = document.createElement("button");
            deleteBtn.textContent = "×";
            deleteBtn.style.cssText = `
                width: 24px;
                height: 24px;
                border-radius: 50%;
                border: none;
                background: #fee2e2;
                color: #dc2626;
                cursor: pointer;
                font-size: 14px;
                display: flex;
                align-items: center;
                justify-content: center;
            `;

            // === 展开内容区域（默认隐藏） ===
            const qaContent = document.createElement("div");
            qaContent.style.display = "none";
            qaContent.style.marginTop = "6px";
            qaContent.style.paddingTop = "6px";
            qaContent.style.borderTop = "1px solid #e5e7eb";
            qaContent.style.fontSize = "13px";
            qaContent.innerHTML = `
                <div><strong>问题：</strong>${qa.question || '未设置'}</div>
                <div style="margin-top:4px;"><strong>答案：</strong>${qa.answer || '未设置'}</div>
            `;

            // === 展开/收起逻辑 ===
            toggleBtn.onclick = () => {
                const isHidden = qaContent.style.display === "none";
                qaContent.style.display = isHidden ? "block" : "none";
                toggleBtn.textContent = isHidden ? "▼" : "▶";
            };

            // === 保存逻辑 ===
            const saveQa = () => {
                const qaList = getStoredJSON("customQa", []);
                const q = questionInput.value.trim();
                const a = answerInput.value.trim();
                qaList[index] = { question: q, answer: a };
                localStorage.setItem("customQa", JSON.stringify(qaList));

                // 同步更新展开内容
                qaContent.innerHTML = `
                    <div><strong>问题：</strong>${q || '未设置'}</div>
                    <div style="margin-top:4px;"><strong>答案：</strong>${a || '未设置'}</div>
                `;
            };

            questionInput.addEventListener("change", saveQa);
            answerInput.addEventListener("change", saveQa);

            // === 删除 ===
            deleteBtn.addEventListener("click", () => {
                const qaList = getStoredJSON("customQa", []);
                qaList.splice(index, 1);
                localStorage.setItem("customQa", JSON.stringify(qaList));
                this.renderQaList();
            });

            // 组装
            qaHeader.append(toggleBtn, indexLabel, questionInput, answerInput, deleteBtn);
            qaItem.append(qaHeader, qaContent);
            qaListContainer.append(qaItem);
        });
    }

    static createAdvancedSettings() {
        const advancedSettingsPanel = document.createElement("div");
        advancedSettingsPanel.id = "advanced-settings-panel";
        advancedSettingsPanel.style.display = "none";

        // 确保默认状态正确
        if (!Array.isArray(state.settings.recruiterActivityStatus)) {
            state.settings.recruiterActivityStatus = ["不限"];
        }

        // ===== 开关1：自动发送附件简历 =====
        const autoSendResumeSettingResult = this.createSettingItem(
            "自动发送附件简历",
            "开启后系统将自动发送附件简历给HR",
            () => document.querySelector("#toggle-auto-send-resume input")
        );
        const autoSendResumeSetting = autoSendResumeSettingResult.settingItem;
        const autoSendResumeDescriptionContainer = autoSendResumeSettingResult.descriptionContainer;
        const autoSendResumeToggle = this.createToggleSwitch(
            "auto-send-resume",
            state.settings.useAutoSendResume,
            (checked) => {
                state.settings.useAutoSendResume = checked;
            },
        );
        autoSendResumeDescriptionContainer.append(autoSendResumeToggle);

        // ===== 开关2：排除猎头 =====
        const excludeHeadhuntersSettingResult = this.createSettingItem(
            "投递时排除猎头",
            "开启后将不会向猎头职位自动投递简历",
            () => document.querySelector("#toggle-exclude-headhunters input")
        );
        const excludeHeadhuntersSetting = excludeHeadhuntersSettingResult.settingItem;
        const excludeHeadhuntersDescriptionContainer = excludeHeadhuntersSettingResult.descriptionContainer;
        const excludeHeadhuntersToggle = this.createToggleSwitch(
            "exclude-headhunters",
            state.settings.excludeHeadhunters,
            (checked) => {
                state.settings.excludeHeadhunters = checked;
            },
        );
        excludeHeadhuntersDescriptionContainer.append(excludeHeadhuntersToggle);

        // ===== 开关3：LLM职位匹配 =====
        const jobMatchSettingResult = this.createSettingItem(
            "LLM职位匹配",
            "投递前使用AI分析简历与职位的匹配度，低于阈值则跳过",
            () => document.querySelector("#toggle-job-match input")
        );
        const jobMatchSetting = jobMatchSettingResult.settingItem;
        const jobMatchDescriptionContainer = jobMatchSettingResult.descriptionContainer;
        const jobMatchToggle = this.createToggleSwitch(
            "job-match",
            state.settings.useJobDetailMatch,
            (checked) => {
                state.settings.useJobDetailMatch = checked;
            },
        );

        const thresholdContainer = document.createElement("div");
        thresholdContainer.style.cssText = `
            margin-top: 10px;
            display: flex;
            flex-direction: column;
            gap: 8px;
        `;
        const thresholdLabel = document.createElement("div");
        thresholdLabel.textContent = "匹配阈值（0-100）：";
        thresholdLabel.style.cssText = `
            font-size: 13px;
            color: #6b7280;
        `;
        const thresholdInputContainer = document.createElement("div");
        thresholdInputContainer.style.cssText = `
            display: flex;
            gap: 10px;
            align-items: center;
        `;
        const thresholdSlider = UIManager.createRangeInput(state.settings.matchThreshold || 60);
        const thresholdValue = UIManager.createTextSpan(`${state.settings.matchThreshold || 60}分`, {
            'color': 'var(--primary-color)', 'min_width': '50px'
        });
        thresholdSlider.addEventListener("input", () => {
            state.settings.matchThreshold = parseInt(thresholdSlider.value);
            thresholdValue.textContent = `${thresholdSlider.value}分`;
        });
        thresholdInputContainer.append(thresholdSlider, thresholdValue);
        thresholdContainer.append(thresholdLabel, thresholdInputContainer);
        jobMatchDescriptionContainer.append(jobMatchToggle, thresholdContainer);

        // ===== 4. 招聘者状态筛选=====
        const { settingItem: recruiterStatusSetting } = this.createSettingItem(
            "投递招聘者状态（多选）",
            "筛选活跃状态符合要求的招聘者进行投递",
            () => document.querySelector("#recruiter-status-select .select-header")
        );

        const statusSelect = UIManager.createDiv({
            id: "recruiter-status-select",
            className: "custom-select",
            cssText: "position:relative; width:100%; margin-top:10px;"
        });

        const statusHeader = UIManager.createDiv({
            className: "select-header",
            cssText: `
                display:flex; justify-content:space-between; align-items:center;
                padding:12px 16px; border-radius:8px; border:1px solid #e2e8f0;
                background:#fff; cursor:pointer; transition:all .2s ease;
                box-shadow:0 1px 2px rgba(0,0,0,0.05); min-height:44px;
            `
        });

        const statusDisplay = UIManager.createDiv({
            className: "select-value",
            cssText: "flex:1; text-align:left; color:#334155; font-size:14px; overflow:hidden; white-space:nowrap; text-overflow:ellipsis;",
        });

        // 初始化显示文字
        statusDisplay.textContent = UIManager.getStatusDisplayText(state.settings);

        const statusIcon = UIManager.createDiv({
            className: "select-icon",
            cssText: "margin-left:10px; color:#64748b; transition:transform .2s ease;"
        });
        statusIcon.innerHTML = "&#9660;";

        const statusClear = UIManager.createTextButton("×", {
            className: "select-clear",
            bg: "transparent",
            color: "#94a3b8",
            cssText: "display: none;",
            onClick: (e) => {
                e.stopPropagation();
                state.settings.recruiterActivityStatus = ["不限"];
                UIManager.updateStatusOptions(state.settings);
                statusDisplay.textContent = UIManager.getStatusDisplayText(state.settings);
            }
        });

        const statusOptions = UIManager.createDiv({
            className: "select-options",
            cssText: `
                position:absolute; top:calc(100% + 6px); left:0; right:0; max-height:240px;
                overflow-y:auto; border-radius:8px; border:1px solid #e2e8f0;
                background:#fff; z-index:100; display:none; transition:all .2s ease;
                box-shadow:0 10px 15px -3px rgba(0,0,0,0.1);
                scrollbar-width:thin; scrollbar-color:#cbd5e1 #f1f5f9;
            `
        });

        statusOptions.innerHTML += `
            <style>
                .select-options::-webkit-scrollbar{width:6px;}
                .select-options::-webkit-scrollbar-track{background:#f1f5f9; border-radius:10px;}
                .select-options::-webkit-scrollbar-thumb{background:#cbd5e1; border-radius:10px;}
            </style>
        `;

        const statusOptionsList = [
            "不限", "在线", "刚刚活跃", "今日活跃", "3日内活跃", "本周活跃", "本月活跃", "半年前活跃"
        ];

        statusOptionsList.forEach(val => {
            const isSelected = state.settings.recruiterActivityStatus?.includes(val);
            const option = UIManager.createDiv({
                className: `select-option ${isSelected ? "selected" : ""}`,
                cssText: "padding:12px 16px; cursor:pointer; display:flex; align-items:center; font-size:14px; color:#334155; transition:all .2s ease;"
            });
            option.dataset.value = val;

            // ✅ 关键修复：加上 class="check-icon" 兼容原版
            const check = UIManager.createDiv({
                className: "check-icon",
                cssText: `margin-right:8px; color:#007bff; font-weight:bold; display:${isSelected ? "inline" : "none"};`
            });
            check.textContent = "✓";

            const text = UIManager.createDiv();
            text.textContent = val;

            option.append(check, text);
            option.onclick = (e) => {
                e.stopPropagation();
                state.settings.recruiterActivityStatus = UIManager.toggleStatusOption(val, state.settings);
                UIManager.updateStatusOptions(state.settings);
                statusDisplay.textContent = UIManager.getStatusDisplayText(state.settings);
            };
            statusOptions.append(option);
        });

        statusHeader.onclick = () => {
            const show = statusOptions.style.display !== "block";
            statusOptions.style.display = show ? "block" : "none";
            statusIcon.style.transform = show ? "rotate(180deg)" : "rotate(0)";
        };

        document.addEventListener("click", (e) => {
            if (!statusSelect.contains(e.target)) {
                statusOptions.style.display = "none";
                statusIcon.style.transform = "rotate(0)";
            }
        });

        // hover 效果
        const headerHover = () => {
            statusHeader.style.borderColor = "rgba(0,123,255,.7)";
            statusHeader.style.boxShadow = "0 0 0 3px rgba(0,123,255,.2)";
        };
        const headerLeave = () => {
            statusHeader.style.borderColor = "#e2e8f0";
            statusHeader.style.boxShadow = "0 1px 2px rgba(0,0,0,0.05)";
        };

        statusHeader.addEventListener("mouseenter", headerHover);
        statusHeader.addEventListener("mouseleave", headerLeave);

        statusHeader.append(statusDisplay, statusClear, statusIcon);
        statusSelect.append(statusHeader, statusOptions);
        recruiterStatusSetting.append(statusSelect);

        UIManager.updateStatusOptions(state.settings);

        advancedSettingsPanel.append(
            autoSendResumeSetting,
            excludeHeadhuntersSetting,
            jobMatchSetting,
            recruiterStatusSetting
        );

        return advancedSettingsPanel;
    }

    static createToggleSwitch(id, isChecked, onChange) {
        const container = document.createElement("div");
        container.className = "toggle-container";
        container.style.cssText = `display: flex;justify-content: space-between;align-items: center;`;

        const switchContainer = document.createElement("div");
        switchContainer.className = "toggle-switch";

        switchContainer.style.cssText = `
            position: relative;
            width: 50px;
            height: 26px;
            border-radius: 13px;
            background-color: ${isChecked ? "rgba(0, 123, 255, 0.9)" : "#e5e7eb"};
            cursor: "pointer";
            opacity: 1;
        `;

        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.id = `toggle-${id}`;
        checkbox.checked = isChecked;
        checkbox.style.display = "none";

        const slider = document.createElement("span");
        slider.className = "toggle-slider";
        slider.style.cssText = `
            position: absolute;
            top: 3px;
            left: ${isChecked ? "27px" : "3px"};
            width: 20px;
            height: 20px;
            border-radius: 50%;
            background-color: #fff;
            box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
            transition: none;
        `;

        const forceUpdateUI = (checked) => {
            checkbox.checked = checked;
            switchContainer.style.backgroundColor = checked
                ? "rgba(0, 123, 255, 0.9)"
                : "#e5e7eb";
            slider.style.left = checked ? "27px" : "3px";
        };

        checkbox.addEventListener("change", () => {
            let allowChange = true;
            if (onChange) {
                allowChange = onChange(checkbox.checked) !== false;
            }
            if (!allowChange) {
                forceUpdateUI(!checkbox.checked);
                return;
            }
            forceUpdateUI(checkbox.checked);
        });

        switchContainer.addEventListener("click", () => {
            const newState = !checkbox.checked;
            if (onChange) {
                if (onChange(newState) !== false) {
                    forceUpdateUI(newState);
                }
            } else {
                forceUpdateUI(newState);
            }
        });

        switchContainer.append(checkbox, slider);
        container.append(switchContainer);
        return container;
    }

    static showActivationDialog() {
        let d = document.getElementById('boss-activation-dialog');
        if (!d) {
            d = this.createActivationDialog();
            document.body.appendChild(d);
        }
        d.style.display = 'flex';
        setTimeout(() => d.classList.add('active'), 10);
    }

    static createActivationDialog() {
        const dialog = document.createElement('div');
        dialog.id = 'boss-activation-dialog';
        dialog.style.cssText = `
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            width: clamp(360px, 90vw, 480px);
            max-height: 85vh;
            background: #ffffff;
            border-radius: 12px;
            box-shadow: 0 10px 30px rgba(0,0,0,0.2);
            z-index: 999999;
            display: none;
            flex-direction: column;
            font-family: 'Segoe UI', 'Microsoft YaHei', sans-serif;
            overflow: hidden;
            transition: all 0.3s ease;
        `;
        dialog.innerHTML = `
            <style>
            #boss-activation-dialog.active {
                animation: dialogSlideIn 0.3s ease;
            }
            @keyframes dialogSlideIn {
                from {
                    opacity: 0;
                    transform: translate(-50%, -45%);
                }
                to {
                    opacity: 1;
                    transform: translate(-50%, -50%);
                }
            }
            .ai-config-input:focus, .ai-config-select:focus, .ai-config-textarea:focus {
                border-color: #4285f4 !important;
                box-shadow: 0 0 0 3px rgba(66, 133, 244, 0.1);
            }
            .ai-config-btn:hover {
                transform: scale(1.02);
                box-shadow: 0 6px 20px rgba(33, 150, 243, 0.3);
            }
            .ai-preset-btn {
                padding: 6px 12px;
                border: 1px solid #e0e0e0;
                border-radius: 6px;
                background: #f5f5f5;
                cursor: pointer;
                font-size: 12px;
                transition: all 0.2s ease;
            }
            .ai-preset-btn:hover {
                background: #4285f4;
                color: white;
                border-color: #4285f4;
            }
            .ai-config-section {
                margin-bottom: 16px;
            }
            .ai-config-label {
                display: block;
                margin-bottom: 6px;
                color: #333;
                font-weight: 500;
                font-size: 13px;
            }
            .ai-config-input, .ai-config-select {
                width: 100%;
                padding: 10px 12px;
                border: 2px solid #e0e0e0;
                border-radius: 8px;
                font-size: 13px;
                transition: all 0.3s ease;
                background: #fafafa;
                box-sizing: border-box;
            }
            .ai-config-textarea {
                width: 100%;
                padding: 10px 12px;
                border: 2px solid #e0e0e0;
                border-radius: 8px;
                font-size: 13px;
                transition: all 0.3s ease;
                background: #fafafa;
                box-sizing: border-box;
                resize: vertical;
                min-height: 80px;
                font-family: inherit;
            }
            .ai-config-scroll {
                max-height: calc(85vh - 70px);
                overflow-y: auto;
                padding: 20px;
            }
            </style>
            <div style="padding: 16px 20px; background: #4285f4; color: white; font-size: 18px; font-weight: 600; display: flex; justify-content: space-between; align-items: center; flex-shrink: 0;">
                <div>AI配置</div>
                <button onclick="document.getElementById('boss-activation-dialog').style.display='none'"
                        style="width: 28px; height: 28px; background: rgba(255,255,255,0.2); color: white; border-radius: 50%; border: none; cursor: pointer; font-size: 16px; font-weight: bold; transition: all 0.2s ease;">✕</button>
            </div>

            <div class="ai-config-scroll">
                <p style="color: #666; font-size: 13px; margin: 0 0 16px 0;">配置你自己的AI API，支持硅基流动、火山引擎等平台</p>

                <div class="ai-config-section">
                <label class="ai-config-label">快速选择平台：</label>
                <div style="display: flex; flex-wrap: wrap; gap: 8px;">
                    <button class="ai-preset-btn" data-preset="siliconflow">硅基流动</button>
                    <button class="ai-preset-btn" data-preset="volcano">火山引擎</button>
                    <button class="ai-preset-btn" data-preset="openai">OpenAI</button>
                    <button class="ai-preset-btn" data-preset="deepseek">DeepSeek</button>
                    <button class="ai-preset-btn" data-preset="custom">自定义</button>
                </div>
                <div style="margin-top: 10px;">
                    <button id="siliconflow-visit-btn"
                            style="padding: 8px 16px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; border: none; border-radius: 6px; font-size: 13px; cursor: pointer; transition: all 0.3s ease;">
                    🚀 一键访问硅基流动获取API Key
                    </button>
                </div>
                </div>

                <div class="ai-config-section">
                <label class="ai-config-label">API Key：</label>
                <input type="password" id="ai-api-key" placeholder="输入你的API Key"
                        class="ai-config-input">
                </div>

                <div class="ai-config-section">
                <label class="ai-config-label">API URL：</label>
                <input type="text" id="ai-api-url" placeholder="https://api.example.com/v1/chat/completions"
                        class="ai-config-input">
                </div>

                <div class="ai-config-section">
                <label class="ai-config-label">模型名称：</label>
                <input type="text" id="ai-model" placeholder="如：gpt-3.5-turbo、lite、deepseek-chat"
                        class="ai-config-input">
                </div>

                <div class="ai-config-section">
                <label class="ai-config-label">AI角色设定（系统提示词）：</label>
                <textarea id="ai-role-config" placeholder="设定AI的角色和行为方式..."
                            class="ai-config-textarea"></textarea>
                </div>

                <div style="display: flex; gap: 10px; margin-top: 20px;">
                <button id="ai-test-btn" class="ai-config-btn"
                        style="flex: 1; padding: 12px; background: #34a853; color: white; border: none; border-radius: 8px; font-size: 14px; font-weight: 600; cursor: pointer; transition: all 0.3s ease;">
                    测试连接
                </button>
                <button id="ai-save-btn" class="ai-config-btn"
                        style="flex: 1; padding: 12px; background: #4285f4; color: white; border: none; border-radius: 8px; font-size: 14px; font-weight: 600; cursor: pointer; transition: all 0.3s ease;">
                    保存配置
                </button>
                </div>

                <div id="ai-config-status" style="margin-top: 12px; font-size: 12px; color: #666; min-height: 16px; text-align: center;"></div>
            </div>
        `;

        setTimeout(() => {
            const aiPresets = {
                siliconflow: { url: "https://api.siliconflow.cn/v1/chat/completions", model: "deepseek-ai/DeepSeek-V2.5" },
                volcano: { url: "https://ark.cn-beijing.volces.com/api/v3/chat/completions", model: "doubao-lite-4k" },
                openai: { url: "https://api.openai.com/v1/chat/completions", model: "gpt-3.5-turbo" },
                deepseek: { url: "https://api.deepseek.com/v1/chat/completions", model: "deepseek-chat" },
                custom: { url: "", model: "" }
            };

            const apiKeyInput = document.getElementById("ai-api-key");
            const apiUrlInput = document.getElementById("ai-api-url");
            const modelInput = document.getElementById("ai-model");
            const roleInput = document.getElementById("ai-role-config");
            const statusDiv = document.getElementById("ai-config-status");

            if (apiKeyInput) apiKeyInput.value = localStorage.getItem("aiApiKey") || "";
            if (apiUrlInput) apiUrlInput.value = localStorage.getItem("aiApiUrl") || "";
            if (modelInput) modelInput.value = localStorage.getItem("aiModel") || "";
            if (roleInput) roleInput.value = localStorage.getItem("aiRole") || "你是求职的应届生正在面对HR，回复需满足：20字内，编造专业对口/实习经验/证书任一岗位优势；被问个人信息或岗位条件，直接配合提供合理数据；全程积极真诚无拒绝言辞。";

            document.querySelectorAll(".ai-preset-btn").forEach(btn => {
                btn.addEventListener("click", () => {
                    const preset = btn.dataset.preset;
                    const config = aiPresets[preset];
                    if (config && apiUrlInput && modelInput) {
                        apiUrlInput.value = config.url;
                        modelInput.value = config.model;
                        if (statusDiv) statusDiv.textContent = `已选择：${btn.textContent}`;
                    }
                });
            });

            const siliconflowVisitBtn = document.getElementById("siliconflow-visit-btn");
            if (siliconflowVisitBtn) {
                siliconflowVisitBtn.addEventListener("click", () => {
                    window.open("https://cloud.siliconflow.cn/i/8Wt6MyMe", "_blank");
                });
            }

            const testBtn = document.getElementById("ai-test-btn");
            if (testBtn) {
                testBtn.addEventListener("click", async () => {
                    const apiKey = apiKeyInput?.value?.trim();
                    const apiUrl = apiUrlInput?.value?.trim();
                    const model = modelInput?.value?.trim();

                    if (!apiKey || !apiUrl || !model) {
                        if (statusDiv) {
                            statusDiv.textContent = "请填写完整API信息";
                            statusDiv.style.color = "#ea4335";
                        }
                        return;
                    }

                    testBtn.disabled = true;
                    testBtn.textContent = "测试中...";
                    if (statusDiv) statusDiv.textContent = "正在测试连接...";

                    try {
                        const result = await this.testAiConnection(apiKey, apiUrl, model);
                        if (result.success) {
                            if (statusDiv) {
                                statusDiv.textContent = "✓ 连接成功：" + result.message;
                                statusDiv.style.color = "#34a853";
                            }
                        } else {
                            if (statusDiv) {
                                statusDiv.textContent = "✗ 连接失败：" + result.message;
                                statusDiv.style.color = "#ea4335";
                            }
                        }
                    } catch (error) {
                        if (statusDiv) {
                            statusDiv.textContent = "✗ 测试出错：" + error.message;
                            statusDiv.style.color = "#ea4335";
                        }
                    } finally {
                        testBtn.disabled = false;
                        testBtn.textContent = "测试连接";
                    }
                });
            }

            const saveBtn = document.getElementById("ai-save-btn");
            if (saveBtn) {
                saveBtn.addEventListener("click", () => {
                    const apiKey = apiKeyInput?.value?.trim();
                    const apiUrl = apiUrlInput?.value?.trim();
                    const model = modelInput?.value?.trim();
                    const role = roleInput?.value?.trim();

                    if (apiKey) localStorage.setItem("aiApiKey", apiKey);
                    if (apiUrl) localStorage.setItem("aiApiUrl", apiUrl);
                    if (model) localStorage.setItem("aiModel", model);
                    if (role) localStorage.setItem("aiRole", role);

                    state.settings.ai.apiKey = apiKey;
                    state.settings.ai.apiUrl = apiUrl;
                    state.settings.ai.model = model;
                    state.settings.ai.role = role;

                    if (statusDiv) {
                        statusDiv.textContent = "✓ 配置已保存";
                        statusDiv.style.color = "#34a853";
                    }

                    setTimeout(() => {
                        dialog.style.display = "none";
                    }, 1000);
                });
            }
        }, 100);

        return dialog;
    }

    static async testAiConnection(apiKey, apiUrl, model) {
        return new Promise((resolve) => {
            const testMessage = "你好，请回复'连接成功'即可。";
            const requestBody = {
                model: model,
                messages: [{ role: "user", content: testMessage }],
                max_tokens: 50
            };

            if (!apiUrl.includes("siliconflow.cn")) {
                requestBody.messages.unshift({ role: "system", content: "你是 helpful assistant。" });
                requestBody.temperature = 0.7;
                requestBody.stream = false;
            }

            const headers = { "Content-Type": "application/json", "Authorization": "Bearer " + apiKey };

            GM_xmlhttpRequest({
                method: "POST",
                url: apiUrl,
                headers: headers,
                data: JSON.stringify(requestBody),
                timeout: 10000,
                onload: (response) => {
                    try {
                        const result = JSON.parse(response.responseText);
                        if (response.status !== 200) {
                            resolve({ success: false, message: `错误 ${response.status}: ${result.error?.message || "未知错误"}` });
                            return;
                        }
                        if (result.choices?.[0]?.message) {
                            resolve({ success: true, message: result.choices[0].message.content.trim() });
                        } else if (result.choices?.[0]?.text) {
                            resolve({ success: true, message: result.choices[0].text.trim() });
                        } else {
                            resolve({ success: false, message: "无法解析响应" });
                        }
                    } catch (error) {
                        resolve({ success: false, message: "解析失败：" + error.message });
                    }
                },
                onerror: () => resolve({ success: false, message: "网络请求失败" }),
                ontimeout: () => resolve({ success: false, message: "请求超时" })
            });
        });
    }
}

/**
 * ActionManager：动作管理框
 */
class ActionManager {
    static async toggleProcess() {
        state.isRunning = !state.isRunning;
        if (state.isRunning) {
            elements.controlBtn.textContent = '停止海投';
            state.excludeKeywords = elements.excludeInput.value.trim().split(/[,，]/).filter(Boolean);
            state.locationKeywords = elements.locationInput.value.trim().split(/[,，]/).filter(Boolean);
            logger.info(`开始海投 | 职位：${state.excludeKeywords.join('、') || '外包'} | 城市：${state.locationKeywords.join('、') || '不限'}`);
            state.jobList = [];
            state.currentIndex = 0;
            await Core.startProcessing();
        } else {
            elements.controlBtn.textContent = '启动海投';
            logger.info('已停止海投');
        }
    }

    static toggleChatProcess() {
        state.isRunning = !state.isRunning;
        elements.controlBtn.textContent = state.isRunning ? '停止智能聊天' : '开始智能聊天';
        if (state.isRunning) {
            logger.info('开始智能聊天');
            Core.startProcessing();
        } else {
            logger.info('停止智能聊天');
        }
    }
}

// ==============================================
// 7. Boss工具
// ==============================================
/**
 * BossDOMApi：Boss直聘网页的页面数据提取
 */

class BossDOMApi {
    static isGoldHunter(jobTag) {
        return jobTag?.__vue__?.data?.goldHunter === 1
    }

    static getJobList() {
        return DOMCache.querySelectorAll(".job-card-wrapper");
    }

    static getCleanText(el) {
        if (!el) return '';

        // 克隆节点，避免修改原页面
        const clone = el.cloneNode(true);

        // 1. 删掉 <style> 标签
        const styles = clone.querySelectorAll('style');
        styles.forEach(s => s.remove());

        // 2. 删掉所有带反爬类的 span（关键！）
        const garbageSpans = clone.querySelectorAll('[class]');
        garbageSpans.forEach(span => {
            const cls = span.className;
            // 删掉 BOSS 反爬的随机字符串 class
            if (typeof cls === 'string' && (
                cls.length > 6 || // 随机类名
                cls.match(/^[A-Za-z0-9_]+$/) // 纯字母数字下划线
            )) {
                span.remove();
            }
        });

        // 3. 取纯文本 + 清理
        let text = clone.textContent.trim()
            .replace(/\s+/g, ' ') // 多余空格
            .replace(/来自BOSS直聘/g, '') // 垃圾词
            .replace(/BOSS直聘/g, '')
            .replace(/直聘/g, '')
            .trim();

        return text;
    }

    static async getJobDetail() {
        try {
            let detail = {}

            // 获取职位名称
            const positionName = document.querySelector(".job-detail-header .job-name");
            if (positionName) detail.positionName = positionName.textContent.trim();

            // 获取薪资
            const salaryEl = document.querySelector('.job-detail-header .job-salary, .salary')
            if (salaryEl) detail.salary = salaryEl.textContent.trim();

            // 获取工作地点
            const locationEl = document.querySelector('.job-detail-body .job-address-desc')
            if (locationEl) detail.location = locationEl.textContent.trim();

            // 获取经验、学历、城市要求
            const jobTag = document.querySelector('.job-detail-body .job-label-list')
            if (jobTag) detail.jobTag = jobTag.textContent.trim();

            // 获取职位描述
            const description = document.querySelector('.job-detail-body .desc')
            if (description) {
                detail.description = BossDOMApi.getCleanText(description);
            }

            // 获取公司信息
            const companyNameEl = document.querySelector('.company-name, .company-info .name')
            if (companyNameEl) detail.companyName = companyNameEl.textContent.trim()

            return detail
        } catch (error) {
            this.log(`获取职位详情出错: ${error.message}`)
            return {}
        }
    }

    static getJobTitle(jobTag) {
        let innerText = jobTag.querySelector(".job-title").innerText;
        return innerText.replace("\n", " ");
    }

    static getCompanyName(jobTag) {
        return jobTag.querySelector(".company-name").innerText;
    }

    static getJobName(jobTag) {
        return jobTag.querySelector(".job-name").innerText;
    }

    static getSalaryRange(jobTag) {
        let text = jobTag.querySelector(".salary").innerText;
        if (text.includes(".")) {
            // 1-2K·13薪
            return text.split("·")[0];
        }
        return text;
    }

    static getCompanyScaleRange(jobTag) {
        return jobTag.querySelector(".company-tag-list").lastElementChild.innerHTML;
    }

    /**
     * 获取当前job标签的招聘人名称以及他的职位
     * @param jobTag
     */
    static getBossNameAndPosition(jobTag) {
        let nameAndPositionTextArr = jobTag.querySelector(".info-public").innerHTML.split("<em>");
        nameAndPositionTextArr[0] = nameAndPositionTextArr[0].trim();
        nameAndPositionTextArr[1] = nameAndPositionTextArr[1].replace("</em>", "").trim();
        return nameAndPositionTextArr;
    }

    static getJobDetailUrlParams(jobTag) {
        return jobTag.querySelector(".job-card-left").href.split("?")[1]
    }

    static getDetailSrc(jobTag) {
        return jobTag.querySelector(".job-card-left").href;
    }

    static getUniqueKey(jobTag) {
        const title = this.getJobTitle(jobTag)
        const company = this.getCompanyName(jobTag)
        return `${title}--${company}`
    }

    static nextPage() {
        let nextPageBtn = DOMCache.get(".ui-icon-arrow-right");

        if (nextPageBtn.parentElement.className === "disabled") {
            // 没有下一页
            return;

        }
        nextPageBtn.click();
        return true;
    }

    static getLatestChatLi() {
        return DOMCache.get(
            'ul[role="group"] li[role="listitem"][class]:has(.friend-content-warp)'
        );
    }

    static cleanMessage(message) {
        if (!message) return "";

        let clean = message.replace(/<[^>]*>/g, "");
        clean = clean
            .trim()
            .replace(/\s+/g, " ")
            .replace(/[\u200B-\u200D\uFEFF]/g, "");
        return clean;
    }
}

// ==============================================
// 8. AI工具
// ==============================================
class AIService {
    constructor() {
        this.loadConfig();
    }

    loadConfig() {
        this.apiKey = localStorage.getItem("aiApiKey");
        this.apiUrl = localStorage.getItem("aiApiUrl");
        this.model = localStorage.getItem("aiModel");
        this.customRole = localStorage.getItem("aiRole");

        // 默认角色
        this.defaultRole = "你是求职的应届生正在面对HR，回复需满足：20字内，编造专业对口/实习经验/证书任一岗位优势；被问个人信息或岗位条件，直接配合提供合理数据；全程积极真诚无拒绝言辞。";
    }

    async request(prompt, systemRole = null) {
        this.loadConfig();

        // 配置校验
        if (!this.apiKey || !this.apiUrl || !this.model) {
            console.warn("未配置AI API");
            return "您好，我对这个岗位很感兴趣，希望能有机会进一步沟通。";
        }

        const messages = [];
        // 非硅基API添加system角色
        if (!this.apiUrl.includes("siliconflow.cn")) {
            messages.push({
                role: "system",
                content: systemRole || this.customRole || this.defaultRole
            });
        }

        messages.push({ role: "user", content: prompt });

        const requestBody = {
            model: this.model,
            messages,
            max_tokens: 512,
            ...(!this.apiUrl.includes("siliconflow.cn") && {
            temperature: 0.9,
            top_p: 0.8
            })
        };

        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: "POST",
                url: this.apiUrl,
                headers: {
                    "Content-Type": "application/json",
                    Authorization: "Bearer " + this.apiKey
                },
                data: JSON.stringify(requestBody),
                onload: (response) => {
                    try {
                        const result = JSON.parse(response.responseText);
                        let content = "";

                        if (result.choices?.[0]?.message) {
                            content = result.choices[0].message.content.trim();
                        } else if (result.choices?.[0]?.text) {
                            content = result.choices[0].text.trim();
                        } else {
                            throw new Error("API响应格式异常");
                        }

                        resolve(content);
                    } catch (error) {
                        reject(new Error(`AI解析失败：${error.message}`));
                    }
                },
                onerror: (error) => reject(new Error("AI网络请求失败"))
            });
        });
    }

    async matchResume(resumeText, jobDetail) {
        const systemPrompt = `
            你是专业HR，只做简历与职位匹配分析。
            规则：
            1. 给出0-100匹配分数
            2. 建议投递：是/否
            3. 理由50字内
            4. 如果公司是字节，一律不建议投递

            输出格式：
            分数：数字
            建议投递：是/否
            理由：xxx
        `.trim();

        if (!jobDetail.positionName) {
            logger.error('无法获取职位名称，无法匹配')
            return { match: false, score: 0, reason: '无法获取职位信息' }
        }

        // 构建职位详情字符串
        let jobInfo = `职位名称: ${jobDetail.positionName || '未知'}\n`
        if (jobDetail.salary) jobInfo += `薪资: ${jobDetail.salary}\n`
        if (jobDetail.location) jobInfo += `工作地点: ${jobDetail.location}\n`
        if (jobDetail.tag) jobInfo += `工作标签: ${jobDetail.jobTag}\n`
        if (jobDetail.companyName) jobInfo += `公司: ${jobDetail.companyName}\n`
        if (jobDetail.description) jobInfo += `职位描述: ${jobDetail.description}\n`

        const userPrompt = `【简历】\n${resumeText}\n\n【职位】\n${jobInfo}`;
        const aiResult = await this.request(userPrompt, systemPrompt);

        logger.info("AI 返回结果:\n" + aiResult);

        // ✅ 解析 AI 返回的格式
        const scoreMatch = aiResult.match(/分数[:：]\s*(\d+)/);
        const recommendMatch = aiResult.match(/建议投递[:：]\s*(是|否)/);
        const reasonMatch = aiResult.match(/理由[:：]\s*(.+)/);

        const score = scoreMatch ? parseInt(scoreMatch[1]) : 0;
        const shouldDeliver = recommendMatch ? recommendMatch[1] === '是' : false
        const reason = reasonMatch ? reasonMatch[1].trim() : "解析失败";

        return { match: shouldDeliver, score, reason, raw: aiResult }
    }

    async matchCustomQA(message, qaList) {
        const prompt = `
        【处理规则】
        1. 匹配问题语义，用答案核心信息润色回答
        2. 不编造信息
        3. 不匹配返回：无匹配

        用户问题：${message}
        问答库：${qaList.map((q, i) => `${i+1}. 问：${q.question} 答：${q.answer}`).join('\n')}
        输出：
        `.trim();

        return this.request(prompt);
    }

    async matchSendResume(message) {
        const prompt = `请分析以下HR消息，判断是否需要回复并发送简历。只回答"是"或"否"，不要其他内容。\n\n消息内容："""${message}"""\n\n以下情况回答"是"：\n1. HR明确要求发送简历、提供简历、看简历、发简历\n2. HR表示看过你的简历觉得合适、符合要求、邀请进一步沟通\n3. HR问是否感兴趣、是否有兴趣聊聊、方便进一步沟通、邀请面试等积极回应\n\n以下情况回答"否"：\n1. HR表示简历不匹配、不符合要求、婉拒等拒绝内容\n2. HR发送的是自动回复、广告、招聘信息等`;
        try {
            const result = await this.request(prompt);
            logger.info(`AI分析简历请求结果: ${result}`);
            return result.trim() === "是";
        } catch (error) {
            logger.error(`AI分析简历请求出错: ${error.message}`);
            return false;
        }
    }

    async generateReply(hrMessage, resumeText, analysis, positionName) {
        const prompt = `
        简历：${resumeText}
        分析：${analysis}
        岗位：${positionName}
        HR消息：${hrMessage}
        要求：自然口语化，50字内，真人求职语气
        `.trim();

        return this.request(prompt);
    }

    async analyzeResume(resumeText) {
        const prompt = `分析简历，提取：核心技能、工作亮点、教育背景、个人优势、适合岗位\n简历：${resumeText}`;
        return this.request(prompt);
    }
}

class HRHandler {
    constructor() {
        this.aiService = new AIService();
        this.lastProcessedMessage = null;
        this.processingMessage = false;
        this.currentMonitoredHR = null;
        this.repliedMessages = new Set();

        this.messageObserver = null;

        this.domCache = {};
    }

    async setupMessageObserver(hrKey) {
        const container = await DOMUtils.waitForElement(".chat-message .im-list");
        if (!container) return;

        this.messageObserver?.disconnect();
        this.messageObserver = new MutationObserver(async () => {
            await this.handleNewMessage(hrKey);
        });

        this.messageObserver.observe(container, { childList: true, subtree: true });
    }

    async processNewMessages() {
        const latestChatLi = await DOMUtils.waitForElement(BossDOMApi.getLatestChatLi);
        if (!latestChatLi) {
            logger.error("未找到聊天窗口");
            return;
        }

        const nameEl = latestChatLi.querySelector(".name-text");
        const companyEl = latestChatLi.querySelector(
            ".name-box span:nth-child(2)"
        );
        const name = (nameEl?.textContent || "未知").trim();
        const company = (companyEl?.textContent || "").trim();
        const hrKey = `${name}-${company}`.toLowerCase();

        if (this.currentMonitoredHR !== hrKey) {
            logger.info(`切换到最新HR：${hrKey}`);

            // 清理旧监听
            if (this.messageObserver) {
                this.messageObserver.disconnect();
                this.messageObserver = null;
            }

            this.currentMonitoredHR = hrKey;
            this.resetMessageState();
            latestChatLi.classList.remove("last-clicked");
        }

        // 如果没点击过 → 点击进入对话
        if (!latestChatLi.classList.contains("last-clicked")) {
            await DOMUtils.simulateClick(latestChatLi.querySelector(".figure"));
            latestChatLi.classList.add("last-clicked");

            await DOMUtils.delay(CONFIG.OPERATION_INTERVAL);
            await this.handleNewMessage(hrKey);
        }

        // 如果没有监听 → 创建监听
        if (!this.messageObserver) {
            await this.setupMessageObserver(hrKey);
            logger.info(`正在监听新消息: ${hrKey}`);
        }
    }

    // 处理新消息
    async handleNewMessage(hrKey) {
        if (this.processingMessage || !state.isRunning) return;
        this.processingMessage = true;

        try {
            await DOMUtils.delay(CONFIG.OPERATION_INTERVAL);
            const lastMsg = await this.getLastFriendMessageText();
            if (!lastMsg || BossDOMApi.cleanMessage(lastMsg) === this.lastProcessedMessage) {
                return;
            }

            this.lastProcessedMessage = BossDOMApi.cleanMessage(lastMsg);
            logger.info(`收到HR消息：${lastMsg}`);

            // 优先匹配自定义问答
            const customQA = LocalStorageManager.getParsedItem("customQa", []);
            const answer = await this.aiService.matchCustomQA(lastMsg, customQA);
            const sendResume = await this.aiService.matchSendResume(lastMsg);

            if (answer && answer !== "无匹配") {
                await this.sendCustomReply(answer);
            } else if (sendResume){
                await this.sendResume(hrKey);
            }
        } catch (e) {
            logger.error(`消息处理失败：${e.message}`);
        } finally {
            this.processingMessage = false;
        }
    }

    async getLastFriendMessageText() {
        try {
            const chatContainer = DOMCache.get(".chat-message .im-list");
            if (!chatContainer) return null;

            const friendMessages = Array.from(
                chatContainer.querySelectorAll("li.message-item.item-friend")
            );
            if (friendMessages.length === 0) return null;

            const lastMessageEl = friendMessages[friendMessages.length - 1];
            const textEl = lastMessageEl.querySelector(".text span");
            return textEl?.textContent?.trim() || null;
        } catch (error) {
            this.log(`获取消息出错: ${error.message}`);
            return null;
        }
    }

    async sendCustomReply(replyText) {
        try {
            const inputBox = await DOMUtils.waitForElement("#chat-input");
            if (!inputBox) {
                logger.error("未找到聊天输入框");
                return false;
            }

            inputBox.textContent = "";
            inputBox.focus();
            document.execCommand("insertText", false, replyText);
            await DOMUtils.delay(CONFIG.OPERATION_INTERVAL / 10);

            const sendButton = DOMCache.get(".btn-send");
            if (sendButton) {
                await DOMUtils.simulateClick(sendButton);
            } else {
                const enterKeyEvent = new KeyboardEvent("keydown", {
                    key: "Enter",
                    keyCode: 13,
                    code: "Enter",
                    which: 13,
                    bubbles: true,
                });
                inputBox.dispatchEvent(enterKeyEvent);
            }
            return true;
        } catch (error) {
            logger.error(`发送自定义回复出错: ${error.message}`);
            return false;
        }
    }

    async sendResume() {
        try {
            const resumeBtn = await DOMUtils.waitForElement(() => {
                return [...document.querySelectorAll(".toolbar-btn")].find(
                    (el) => el.textContent.trim() === "发简历"
                );
            });

            if (!resumeBtn) {
                logger.error("无法发送简历，未找到发简历按钮");
                return false;
            }

            if (resumeBtn.classList.contains("unable")) {
                logger.info("对方未回复，您无权发送简历");
                return false;
            }

            await DOMUtils.simulateClick(resumeBtn);
            await DOMUtils.delay(state.settings.actionDelays.click, "click");
            await DOMUtils.delay(800, "load");

            const confirmDialog = document.querySelector(
                ".panel-resume.sentence-popover"
            );
            if (confirmDialog) {
                const confirmBtn = confirmDialog.querySelector(".btn-sure-v2");
                if (!confirmBtn) {
                    logger.error("未找到确认按钮");
                    return false;
                }

                await DOMUtils.simulateClick(confirmBtn);
                return true;
            }
        } catch (error) {
            logger.error(`发送简历出错: ${error.message}`);
            return false;
        }
    }

    resetMessageState() {
        this.lastProcessedMessage = null;
        this.processingMessage = false;
        if (!this.repliedMessages) {
            this.repliedMessages = new Set();
        }
    }
}

class JobsHandler {
    constructor() {
        this.aiService = new AIService();
        this.lastJobCount = 0;
        this.lastScrollTop = 0;
        this.emptyBatchCount = 0;
    }

    resetCycle() {
        logger.info("当前批次已投递完毕，准备加载下一批");
        state.currentIndex = 0;
    }

    async scrollToLoadJobs({ waitTime = 1500 } = {}) {
        logger.info(`正在加载更多职位... (${this.lastScrollTop})`);
        window.scrollTo({
            top: this.lastScrollTop,
            behavior: "instant" // 瞬间跳回，不动画
        });
        await DOMUtils.delay(100); // 等待位置还原

        let currentScroll = this.lastScrollTop;

        for (let i = 0; i < 1; i++) {
            const viewportHeight = window.innerHeight;
            const targetScroll = currentScroll + viewportHeight * 0.8;

            window.scrollTo({
                top: targetScroll,
                behavior: "smooth"
            });

            await DOMUtils.delay(waitTime);
            currentScroll = targetScroll;
        }

        this.lastScrollTop = currentScroll;
        logger.info("岗位加载完成");
    }

    shouldStopByMaxDeliver() {
        if (state.totalDelivered >= state.maxTotalDeliver) {
            logger.info(`已达到最大投递次数 ${state.maxTotalDeliver} 次，自动停止`);
            state.isRunning = false;
            elements.controlBtn.textContent = '启动海投';
            return true;
        }
        return false;
    }

    async loadNewJobBatch() {
        const excludeHeadhunters = state.settings.excludeHeadhunters;
        await this.scrollToLoadJobs();

        const allCards = Array.from(document.querySelectorAll("li.job-card-box")).filter((card) => {
            const title = card.querySelector(".job-name")?.textContent?.toLowerCase() || "";
            const addressText = (
                card.querySelector(".job-address-desc")?.textContent ||
                card.querySelector(".company-location")?.textContent ||
                card.querySelector(".job-area")?.textContent ||
                ""
            ).toLowerCase().trim();

            const headhuntingElement = card.querySelector(".job-tag-icon");
            const altText = headhuntingElement ? headhuntingElement.alt : "";

            const excludeMatch =
                state.excludeKeywords.length === 0 ||
                !state.excludeKeywords.some((kw) => kw && title.includes(kw.trim()));
            const locationMatch =
                state.locationKeywords.length === 0 ||
                state.locationKeywords.some((kw) => kw && addressText.includes(kw.trim()));
            const excludeHeadhunterMatch =
                !excludeHeadhunters || !altText.includes("猎头");

            return excludeMatch && locationMatch && excludeHeadhunterMatch;
        });

        const newCards = allCards.slice(this.lastJobCount);
        this.lastJobCount = allCards.length;
        state.jobList = newCards;

        return newCards;
    }

    checkEmptyBatch(newCards) {
        if (!newCards.length) {
            this.emptyBatchCount++;
            logger.info(`本批次无新岗位，连续空批次：${this.emptyBatchCount}/3`);
            if (this.emptyBatchCount >= 3) {
                logger.info("✅ 页面已滚动到底部，无更多岗位，自动停止");
                state.isRunning = false;
                elements.controlBtn.textContent = '启动海投';
            }
            return true;
        }
        this.emptyBatchCount = 0;
        return false;
    }

    async handleResumeMatch() {
        if (state.settings.useJobDetailMatch) {
            const resumeText = state.settings.resumeText || "";
            if (resumeText) {
                logger.info("正在获取职位详情并匹配...");
                const jobDetail = await BossDOMApi.getJobDetail();
                const matchResult = await this.aiService.matchResume(resumeText, jobDetail);
                logger.info(`匹配分数: ${matchResult.score}分 - ${matchResult.reason}`);

                const threshold = state.settings.matchThreshold || 60;
                if (!matchResult.match || matchResult.score < threshold) {
                    logger.info(`跳过投递: 匹配度不足（阈值:${threshold}分）`);
                    state.currentIndex++;
                    return false;
                }
                logger.info(`匹配通过，准备投递`);
            } else {
                logger.info("未上传简历，跳过LLM匹配，直接投递");
            }
            return true;
        }
        return false;
    }

    async tryChat() {
        const chatBtn = document.querySelector("a.op-btn-chat");
        if (chatBtn && chatBtn.textContent.trim() === "立即沟通") {
            chatBtn.click();
            state.totalDelivered++;
            logger.info(`✅ 投递成功！累计：${state.totalDelivered}/${state.maxTotalDeliver}`);
        }
    }

    async processJobList() {
        // 1. 判断是否达到最大投递数
        if (this.shouldStopByMaxDeliver()) return;

        // 2. 加载新批次
        if (!state.jobList || state.jobList.length === 0) {
            const newCards = await this.loadNewJobBatch();
            if (this.checkEmptyBatch(newCards)) return;
            logger.info(`已加载 ${state.jobList.length} 个符合条件的职位`);
        }

        // 3. 判断批次是否结束
        if (state.currentIndex >= state.jobList.length) {
            this.resetCycle();
            state.jobList = [];
            return;
        }

        // 4. 获取当前岗位并点击
        const currentCard = state.jobList[state.currentIndex];
        currentCard.scrollIntoView({ behavior: "smooth", block: "center" });
        currentCard.click();
        await DOMUtils.delay(CONFIG.OPERATION_INTERVAL * 2);

        // 5. LLM 跳过逻辑
        if (!await this.handleResumeMatch()) return;

        // 6. 判断在线状态
        let activeTime = "未知";
        const onlineTag = document.querySelector(".boss-online-tag");
        if (onlineTag && onlineTag.textContent.trim() === "在线") {
            activeTime = "在线";
        } else {
        const activeTimeElement = document.querySelector(".boss-active-time");
            activeTime = activeTimeElement?.textContent?.trim() || "未知";
        }

        const isActiveStatusMatch =
            state.settings.recruiterActivityStatus.includes("不限") ||
            state.settings.recruiterActivityStatus.includes(activeTime);

        if (!isActiveStatusMatch) {
            logger.info(`跳过: 招聘者状态 "${activeTime}"`);
            state.currentIndex++;
            return;
        }

        // 7. 发送沟通
        await this.tryChat();

        const excludeLog = state.excludeKeywords.length
            ? `职位名不包含[${state.excludeKeywords.join("、")}]`
            : "职位名不限";
        const locationLog = state.locationKeywords.length
            ? `工作地包含[${state.locationKeywords.join("、")}]`
            : "工作地不限";
        logger.info(`正在沟通：${++state.currentIndex}/${state.jobList.length}，${excludeLog}，${locationLog}，招聘者"${activeTime}"`);
    }
}

class CoreManager {
    constructor() {
        this.jobsHandler = new JobsHandler();
        this.hrHandler = new HRHandler();
    }

    async startProcessing() {
        while (state.isRunning) {
            if (location.pathname.includes("/jobs")) {
                await this.jobsHandler.processJobList();
            } else if (location.pathname.includes("/chat")) {
                await this.hrHandler.processNewMessages();
            }
            await DOMUtils.delay(CONFIG.BASIC_INTERVAL);
        }
    }
}
const Core = new CoreManager();

(function () {
    window.addEventListener('load', () => {
        UIManager.init();
    });
})();