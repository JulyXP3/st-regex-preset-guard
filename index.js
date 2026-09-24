// regex_bak —— 正则预设行为修复扩展
//
// 根因与方案见仓库根目录文档《正则预设问题分析.md》《方案-正则预设修复扩展.md》。
// 本扩展不修改酒馆任何源码，行为全部通过两个手段实现：
//  1) 模块A：在 document 捕获阶段拦截正则预设控件（#regex_presets 等），官方处理函数
//     不会执行；切换预设改为"仅同步全局正则"，绝不调用 merge-attributes（角色卡）
//     与 /api/presets/save（聊天预设文件），从根上消灭"局部/预设内嵌正则被批量关闭"。
//  2) 模块B：存量体检面板（注入在正则扩展面板里），扫描被官方逻辑写入 disabled=true
//     的局部/预设内嵌正则，人工勾选恢复；恢复前把原状态备份进 IndexedDB
//     （每来源只留最近一次，自动覆盖），面板可一键还原到备份。
//
// 兼容目标：E:\SillyTavern（1.17.0）。控件 ID 在 1.18.0 未变；若未来官方改版导致
// 控件缺失，拦截自然不生效（安全降级），体检面板也不注入。

import { characters, getCurrentChatId, getRequestHeaders, reloadCurrentChat, saveSettingsDebounced, this_chid } from '../../../script.js';
import { extension_settings } from '../../../scripts/extensions.js';
import { Popup } from '../../../scripts/popup.js';
import { openai_setting_names, openai_settings } from '../../../scripts/openai.js';
import { escapeHtml, uuidv4 } from '../../../scripts/utils.js';

const TAG = '[regex_bak]';
const SELECT_ID = 'regex_presets';
const BTN_CREATE = 'regex_preset_create';
const BTN_UPDATE = 'regex_preset_update';
const BTN_APPLY = 'regex_preset_apply';
const IDB_NAME = 'regex_bak_backup';

// ------------------------------------------------------------------ 运行时状态

/** 当前生效的正则预设 id（对齐官方 RegexPresetManager.currentPresetId 语义） */
let currentPresetId = null;
/** 上次应用/保存时的全局启用清单；null = 尚未应用过，首次切换不弹未保存提醒（与官方一致） */
let lastKnownGlobalIds = null;
/** 体检恢复是否进行中（防并发点击） */
let repairing = false;

// ------------------------------------------------------------------ 小工具

function getGlobalScripts() {
    return Array.isArray(extension_settings.regex) ? extension_settings.regex : [];
}

function getPresets() {
    return Array.isArray(extension_settings.regex_presets) ? extension_settings.regex_presets : [];
}

function enabledIds(list) {
    return (list ?? []).filter(s => !s.disabled).map(s => s.id);
}

function idsChanged(a, b) {
    if (a.length !== b.length) {
        return true;
    }
    const known = new Set(b);
    return a.some(id => !known.has(id));
}

function fmtTime(ts) {
    return new Date(ts).toLocaleString();
}

// ================================================================== 模块 A
// 拦截官方正则预设控件，替换为"仅全局严格同步"

function renderPresetList() {
    const select = document.getElementById(SELECT_ID);
    if (!select) {
        return;
    }
    select.innerHTML = '';
    const presets = getPresets();
    if (presets.length === 0) {
        select.appendChild(new Option('[未保存正则预设]', '', true, true));
        select.disabled = true;
        return;
    }
    for (const p of presets) {
        select.appendChild(new Option(p.name, p.id, p.isSelected, p.isSelected));
    }
    select.disabled = false;
}

/** 官方面板列表是渲染出来的 DOM，翻转 disabled 后同步勾选框显示（列表顺序等面板重开时自然刷新） */
function refreshGlobalRows() {
    const container = document.getElementById('saved_regex_scripts');
    if (!container) {
        return;
    }
    for (const s of getGlobalScripts()) {
        const row = container.querySelector(`[id="${s.id}"] .disable_regex`);
        if (row) {
            row.checked = !!s.disabled;
        }
    }
}

/**
 * 仅同步全局正则：清单内启用、清单外关闭（严格同步），只写 settings.json，
 * 绝不触碰角色卡与聊天预设文件。返回是否成功。
 */
async function applyGlobalOnly(presetId) {
    const preset = getPresets().find(p => p.id === presetId);
    if (!preset) {
        toastr.error('找不到选中的正则预设');
        return false;
    }

    const globals = getGlobalScripts();
    const wanted = new Set((preset.global ?? []).map(x => x.id));
    let turnedOn = 0;
    let turnedOff = 0;
    for (const s of globals) {
        const wantDisabled = !wanted.has(s.id);
        if (!!s.disabled !== wantDisabled) {
            wantDisabled ? turnedOff++ : turnedOn++;
        }
        s.disabled = wantDisabled;
    }
    // 按预设清单顺序重排（对齐官方 applyPresetList 的排序语义，仅作用于全局清单）
    const order = preset.global ?? [];
    const rank = id => {
        const i = order.findIndex(p => p.id === id);
        return i === -1 ? order.length : i;
    };
    globals.sort((a, b) => rank(a.id) - rank(b.id));

    getPresets().forEach(p => { p.isSelected = p.id === presetId; });
    saveSettingsDebounced();
    renderPresetList();
    document.getElementById(SELECT_ID).value = presetId;
    currentPresetId = presetId;
    lastKnownGlobalIds = enabledIds(globals);
    refreshGlobalRows();

    const chatId = getCurrentChatId();
    if (chatId) {
        await reloadCurrentChat();
    }
    const changed = turnedOn + turnedOff;
    toastr[changed ? 'success' : 'info'](`正则预设「${preset.name}」已应用：开启 ${turnedOn} 条，关闭 ${turnedOff} 条`);
    return true;
}

async function handleSwitch(selectedId, { fromSlashCommand = false } = {}) {
    const presets = getPresets();
    const target = presets.find(p => p.id === selectedId);
    if (!target) {
        toastr.error('找不到选中的正则预设');
        return;
    }

    // 未保存提醒（仅全局维度）。斜杠命令路径与官方行为一致：跳过检查。
    if (!fromSlashCommand && currentPresetId && lastKnownGlobalIds) {
        const current = presets.find(p => p.id === currentPresetId);
        const now = enabledIds(getGlobalScripts());
        if (current && idsChanged(now, lastKnownGlobalIds)) {
            const save = await Popup.show.confirm(
                `正则预设「${current.name}」有未保存的开关组合`,
                '要先把当前组合存进它，再切换吗？',
                { okButton: '保存并切换', cancelButton: '丢弃并切换' },
            );
            if (save) {
                current.global = now.map(id => ({ id }));
                lastKnownGlobalIds = now;
                saveSettingsDebounced();
                toastr.success(`已把当前组合存入预设「${current.name}」`);
            }
        }
    }

    await applyGlobalOnly(selectedId);
}

async function onCreateClick() {
    const name = await Popup.show.input('为新的正则预设起个名字：', '');
    if (!name || !name.trim().length) {
        return;
    }
    const preset = {
        id: uuidv4(),
        name: name.trim(),
        isSelected: false,
        global: enabledIds(getGlobalScripts()).map(id => ({ id })),
        scoped: [],
        preset: [],
    };
    getPresets().push(preset);
    getPresets().forEach(p => { p.isSelected = p.id === preset.id; });
    saveSettingsDebounced();
    renderPresetList();
    document.getElementById(SELECT_ID).value = preset.id;
    currentPresetId = preset.id;
    lastKnownGlobalIds = preset.global.map(x => x.id);
    toastr.success(`正则预设「${preset.name}」已创建`);
}

function onCaptureChange(event) {
    if (event.target?.id !== SELECT_ID) {
        return;
    }
    // 捕获阶段截停，官方监听器（注册在 select 本体上）不再执行
    event.stopPropagation();
    const value = event.target.value;
    if (!value) {
        return;
    }
    const fromSlashCommand = event instanceof CustomEvent && event.detail?.fromSlashCommand === true;
    void handleSwitch(value, { fromSlashCommand });
}

function onCaptureClick(event) {
    // 删除按钮故意不拦：官方 deletePreset 只删预设记录本身，不写脚本开关，无破坏性
    const el = event.target.closest?.(`#${BTN_CREATE}, #${BTN_UPDATE}, #${BTN_APPLY}`);
    if (!el) {
        return;
    }
    event.stopPropagation();

    if (el.id === BTN_CREATE) {
        void onCreateClick();
        return;
    }

    const selectedId = document.getElementById(SELECT_ID)?.value;
    const preset = getPresets().find(p => p.id === selectedId);
    if (!preset) {
        toastr.error('当前没有可用的正则预设');
        return;
    }

    if (el.id === BTN_UPDATE) {
        const now = enabledIds(getGlobalScripts());
        preset.global = now.map(id => ({ id }));
        lastKnownGlobalIds = now;
        saveSettingsDebounced();
        toastr.success(`已把当前启用的 ${now.length} 条全局正则存入预设「${preset.name}」`);
        return;
    }

    if (el.id === BTN_APPLY) {
        void applyGlobalOnly(selectedId);
    }
}

// ================================================================== 模块 B
// 存量体检：扫描 / 报告 / 勾选恢复 / IndexedDB 备份与还原

// ---- IndexedDB（备份每来源只留最近一次，put 同 key 自动覆盖）

function idbOpen() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(IDB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore('backups', { keyPath: 'key' });
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function backupPut(record) {
    const db = await idbOpen();
    return new Promise((resolve, reject) => {
        const tx = db.transaction('backups', 'readwrite');
        tx.objectStore('backups').put(record);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

async function backupGet(key) {
    const db = await idbOpen();
    return new Promise((resolve, reject) => {
        const tx = db.transaction('backups', 'readonly');
        const rq = tx.objectStore('backups').get(key);
        rq.onsuccess = () => resolve(rq.result ?? null);
        rq.onerror = () => reject(rq.error);
    });
}

// ---- 扫描（只读）

async function fetchAllCharacters() {
    const res = await fetch('/api/characters/all', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({}),
    });
    if (!res.ok) {
        throw new Error(`角色卡列表获取失败（HTTP ${res.status}）`);
    }
    const list = await res.json();
    return Array.isArray(list) ? list : [];
}

async function scanSources() {
    const report = [];

    for (const ch of await fetchAllCharacters()) {
        const scripts = ch?.data?.extensions?.regex_scripts;
        if (!Array.isArray(scripts)) {
            continue;
        }
        const items = scripts.filter(s => s?.disabled === true).map(s => ({ id: s.id, name: s.scriptName }));
        if (items.length) {
            report.push({ kind: 'char', key: `char:${ch.avatar}`, label: `${ch.name || ch.avatar}（${ch.avatar}）`, avatar: ch.avatar, items });
        }
    }

    // 聊天预设全量在页面加载时已进内存（openai_settings），与磁盘文件一致
    if (Array.isArray(openai_setting_names)) {
        for (const name of openai_setting_names) {
            const scripts = openai_settings?.[name]?.extensions?.regex_scripts;
            if (!Array.isArray(scripts)) {
                continue;
            }
            const items = scripts.filter(s => s?.disabled === true).map(s => ({ id: s.id, name: s.scriptName }));
            if (items.length) {
                report.push({ kind: 'preset', key: `preset:${name}`, label: `${name}（聊天预设）`, presetName: name, items });
            }
        }
    }

    return report;
}

// ---- 修复与还原

/** 角色卡修复后同步内存中的角色对象（对齐官方 writeExtensionField 的三处回填） */
function syncMemoryCharacter(avatar, scripts) {
    const ch = characters.find(c => c?.avatar === avatar);
    if (!ch?.data) {
        return;
    }
    ch.data.extensions = ch.data.extensions ?? {};
    ch.data.extensions.regex_scripts = scripts;
    try {
        const json = JSON.parse(ch.json_data ?? '{}');
        json.data = json.data ?? {};
        json.data.extensions = json.data.extensions ?? {};
        json.data.extensions.regex_scripts = scripts;
        ch.json_data = JSON.stringify(json);
    } catch {
        // json_data 不是合法 JSON 时不阻塞修复，仅跳过该回填
    }
    if (characters[this_chid] === ch) {
        const field = document.getElementById('character_json_data');
        if (field && field.value !== ch.json_data) {
            field.value = ch.json_data;
        }
    }
}

async function repairCharacter(source, checkedIds) {
    const fresh = (await fetchAllCharacters()).find(c => c.avatar === source.avatar);
    const scripts = fresh?.data?.extensions?.regex_scripts;
    if (!Array.isArray(scripts)) {
        throw new Error(`找不到角色 ${source.avatar}`);
    }
    // 备份先落库（原样、含开关状态），再动数据
    await backupPut({ key: source.key, kind: 'char', avatar: source.avatar, label: source.label, ts: Date.now(), scripts: structuredClone(scripts) });
    scripts.forEach(s => { if (checkedIds.has(s.id)) { s.disabled = false; } });
    const res = await fetch('/api/characters/merge-attributes', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ avatar: source.avatar, data: { extensions: { regex_scripts: scripts } } }),
    });
    if (!res.ok) {
        throw new Error(`角色 ${source.avatar} 写回失败（HTTP ${res.status}）`);
    }
    syncMemoryCharacter(source.avatar, scripts);
}

async function repairPreset(source, checkedIds) {
    const preset = openai_settings?.[source.presetName];
    const scripts = preset?.extensions?.regex_scripts;
    if (!preset || !Array.isArray(scripts)) {
        throw new Error(`找不到预设 ${source.presetName}`);
    }
    await backupPut({ key: source.key, kind: 'preset', presetName: source.presetName, label: source.label, ts: Date.now(), preset: structuredClone(preset) });
    scripts.forEach(s => { if (checkedIds.has(s.id)) { s.disabled = false; } });
    // /api/presets/save 是整文件替换，所以备份必须存完整预设对象（上面已存）
    const res = await fetch('/api/presets/save', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ apiId: 'openai', name: source.presetName, preset }),
    });
    if (!res.ok) {
        throw new Error(`预设 ${source.presetName} 写回失败（HTTP ${res.status}）`);
    }
}

async function restoreFromBackup(sourceKey) {
    const rec = await backupGet(sourceKey);
    if (!rec) {
        toastr.warning('该来源还没有备份');
        return;
    }
    if (rec.kind === 'char') {
        const res = await fetch('/api/characters/merge-attributes', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ avatar: rec.avatar, data: { extensions: { regex_scripts: rec.scripts } } }),
        });
        if (!res.ok) {
            throw new Error(`角色 ${rec.avatar} 还原失败（HTTP ${res.status}）`);
        }
        syncMemoryCharacter(rec.avatar, rec.scripts);
    } else {
        const res = await fetch('/api/presets/save', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ apiId: 'openai', name: rec.presetName, preset: rec.preset }),
        });
        if (!res.ok) {
            throw new Error(`预设 ${rec.presetName} 还原失败（HTTP ${res.status}）`);
        }
    }
    toastr.success(`已把「${rec.label}」还原到 ${fmtTime(rec.ts)} 的备份`);
}

// ---- 面板 UI（注入到正则扩展面板，避开 Popup 交互复杂度）

let lastScanReport = [];

function renderReport() {
    const $report = $('#regexbak_report');
    if (!lastScanReport.length) {
        $report.html('<small>未发现被写为"关闭"的局部/预设内嵌正则。</small>').show();
        return;
    }
    const rows = lastScanReport.map(src => {
        const items = src.items.map(it =>
            `<li><label><input type="checkbox" class="regexbak-item" data-key="${escapeHtml(src.key)}" data-id="${escapeHtml(it.id)}"> ${escapeHtml(it.name || '(未命名正则)')}</label></li>`,
        ).join('');
        return `<div class="regexbak-source">
            <label><input type="checkbox" class="regexbak-src" data-key="${escapeHtml(src.key)}"> <b>${src.kind === 'char' ? '[角色卡]' : '[聊天预设]'} ${escapeHtml(src.label)}</b> — ${src.items.length} 条被关闭</label>
            <div class="regexbak-backup" data-key="${escapeHtml(src.key)}">备份：无</div>
            <ul>${items}</ul>
        </div>`;
    }).join('');
    $report.html(`
        <div class="flex-container alignItemsBaseline">
            <strong class="flex1">勾选要恢复的正则（自己故意关过的不要勾）</strong>
            <div id="regexbak_fix" class="menu_button" title="把勾选的正则恢复为开启；恢复前自动把原状态备份进浏览器">恢复勾选项</div>
        </div>
        ${rows}`).show();
    // 回填各来源已有备份的显示
    $report.find('.regexbak-backup').each(async function () {
        const key = $(this).data('key');
        const rec = await backupGet(key);
        if (rec) {
            $(this).html(`备份：${fmtTime(rec.ts)} <a class="regexbak-restore-one" data-key="${escapeHtml(key)}" href="javascript:void(0)">还原到此备份</a>`);
        }
    });
}

async function refreshBackupBadges() {
    for (const el of $('#regexbak_report .regexbak-backup')) {
        const $el = $(el);
        const rec = await backupGet($el.data('key'));
        if (rec) {
            $el.html(`备份：${fmtTime(rec.ts)} <a class="regexbak-restore-one" data-key="${escapeHtml($el.data('key'))}" href="javascript:void(0)">还原到此备份</a>`);
        }
    }
}

async function onScanClick() {
    const $status = $('#regexbak_status');
    try {
        $status.text('扫描中…');
        lastScanReport = await scanSources();
        const total = lastScanReport.reduce((n, src) => n + src.items.length, 0);
        renderReport();
        await refreshBackupBadges();
        $status.text(lastScanReport.length ? `发现 ${lastScanReport.length} 个来源、共 ${total} 条被关闭` : '未发现问题');
    } catch (err) {
        console.error(TAG, err);
        $status.text('扫描失败');
        toastr.error(String(err.message || err));
    }
}

async function onFixClick() {
    if (repairing) {
        return;
    }
    const byKey = new Map();
    $('#regexbak_report .regexbak-item:checked').each(function () {
        const key = $(this).data('key');
        if (!byKey.has(key)) {
            byKey.set(key, new Set());
        }
        byKey.get(key).add($(this).data('id'));
    });
    if (!byKey.size) {
        toastr.warning('先勾选要恢复的正则');
        return;
    }

    repairing = true;
    const $status = $('#regexbak_status');
    $status.text('恢复中…（请勿同时编辑对应角色/预设）');
    try {
        let fixed = 0;
        const errors = [];
        for (const [key, checkedIds] of byKey) {
            const source = lastScanReport.find(src => src.key === key);
            if (!source) {
                continue;
            }
            try {
                if (source.kind === 'char') {
                    await repairCharacter(source, checkedIds);
                } else {
                    await repairPreset(source, checkedIds);
                }
                fixed += checkedIds.size;
            } catch (err) {
                console.error(TAG, err);
                errors.push(String(err.message || err));
            }
        }
        lastScanReport = await scanSources();
        renderReport();
        await refreshBackupBadges();
        const remain = lastScanReport.reduce((n, src) => n + src.items.length, 0);
        $status.text(`已恢复 ${fixed} 条；剩余被关闭 ${remain} 条（原状态已备份进浏览器）`);
        if (errors.length) {
            toastr.error(errors.join('；'));
        } else {
            toastr.success(`已恢复 ${fixed} 条，备份存于浏览器（IndexedDB）`);
        }
    } finally {
        repairing = false;
    }
}

function bindPanelEvents() {
    $('#regexbak_scan').on('click', () => void onScanClick());
    $('#regexbak_report').on('change', '.regexbak-src', function () {
        $(this).closest('.regexbak-source').find('.regexbak-item').prop('checked', this.checked);
    });
    $('#regexbak_report').on('click', '#regexbak_fix', () => void onFixClick());
    $('#regexbak_report').on('click', '.regexbak-restore-one', function () {
        if (repairing) {
            return;
        }
        repairing = true;
        void restoreFromBackup($(this).data('key'))
            .catch(err => { console.error(TAG, err); toastr.error(String(err.message || err)); })
            .finally(() => { repairing = false; });
    });
}

function injectPanel(retries = 60) {
    if (document.getElementById('regexbak_block')) {
        return;
    }
    const anchor = document.getElementById('regex_presets_block');
    if (!anchor) {
        if (retries > 0) {
            setTimeout(() => injectPanel(retries - 1), 500);
        } else {
            console.warn(TAG, '未找到正则扩展面板，体检功能未注入（拦截功能不受影响）');
        }
        return;
    }
    const block = document.createElement('div');
    block.id = 'regexbak_block';
    block.innerHTML = `
        <hr />
        <div class="flex-container alignItemsBaseline">
            <strong class="flex1">regex_bak 存量体检</strong>
        </div>
        <small>扫描被正则预设误写为"关闭"的角色卡/预设内嵌正则（只读）。恢复前自动把原状态备份进浏览器（每来源只留最近一次，自动覆盖，不下载文件）。扫描/恢复时请勿同时编辑对应角色或预设。</small>
        <div class="flex-container marginTop5">
            <div id="regexbak_scan" class="menu_button fa-solid fa-magnifying-glass" title="扫描存量数据"></div>
            <span id="regexbak_status" class="flex1"></span>
        </div>
        <div id="regexbak_report" style="display:none;"></div>`;
    anchor.after(block);
    bindPanelEvents();
}

// ------------------------------------------------------------------ 启动

function init() {
    if (!Array.isArray(extension_settings.regex)) {
        extension_settings.regex = [];
    }
    if (!Array.isArray(extension_settings.regex_presets)) {
        extension_settings.regex_presets = [];
    }
    // 与官方一致：lastKnownGlobalIds 保持 null，页面加载后的首次切换不弹未保存提醒
    currentPresetId = getPresets().find(p => p.isSelected)?.id ?? null;

    // 捕获阶段监听：先于官方（注册在控件本体）执行，且不依赖扩展加载顺序
    document.addEventListener('change', onCaptureChange, true);
    document.addEventListener('click', onCaptureClick, true);
    injectPanel();

    console.log(TAG, '已加载：正则预设切换只同步全局正则，不再改写角色卡与预设文件。');
}

init();
