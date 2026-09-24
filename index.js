// regex_bak —— 正则预设行为修复扩展
//
// 唯一职责：拦截官方「正则预设」切换控件，把切换行为改为"仅同步全局正则"。
//
// 为什么要拦截：官方 RegexPresetManager（本机上由 cocktail 的 regex-refresh-optimizer
// 抢先劫持执行）在切换正则预设时，会把局部（角色卡内）与预设内嵌（聊天预设文件内）
// 正则中"不在清单里的"批量写成 disabled=true 并立即写盘；上下文错配（保存快照时的
// 角色/聊天预设与切换时不同）或导入换 UUID 都会导致整批误杀。
//
// 怎么拦截：监听器挂在 window 捕获阶段——事件传播路径上 window 必然先于 document
// 和控件本体（与注册顺序无关），从而抢在 cocktail（document 捕获层）和官方（控件层）
// 之前接管。拦截后只按预设快照翻转全局正则的 disabled，绝不调用
// merge-attributes（角色卡）与 /api/presets/save（聊天预设文件）。
//
// v1.1.0 起移除「存量体检」面板：对用户场景属过度设计（误关的正则切到对应预设
// 用官方批量启用即可恢复；删除的内容酒馆无版本历史，任何工具都无法找回）。
// 旧版本代码可从 Git 历史找回。

import { getCurrentChatId, reloadCurrentChat, saveSettingsDebounced } from '/script.js';
import { extension_settings } from '/scripts/extensions.js';
import { Popup } from '/scripts/popup.js';
import { uuidv4 } from '/scripts/utils.js';

const TAG = '[regex_bak]';
const SELECT_ID = 'regex_presets';
const BTN_CREATE = 'regex_preset_create';
const BTN_UPDATE = 'regex_preset_update';
const BTN_APPLY = 'regex_preset_apply';

// ------------------------------------------------------------------ 运行时状态

/** 当前生效的正则预设 id（对齐官方 RegexPresetManager.currentPresetId 语义） */
let currentPresetId = null;
/** 上次应用/保存时的全局启用清单；null = 尚未应用过，首次切换不弹未保存提醒（与官方一致） */
let lastKnownGlobalIds = null;

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
    // 捕获阶段截停：cocktail（document 捕获层）与官方（控件层）的监听器都不再执行
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

    window.addEventListener('change', onCaptureChange, true);
    window.addEventListener('click', onCaptureClick, true);

    console.log(TAG, '已加载：正则预设切换只同步全局正则，不再改写角色卡与预设文件。');
}

init();
