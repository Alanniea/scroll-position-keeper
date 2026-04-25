import { App, Plugin, PluginSettingTab, Setting, MarkdownView, TFile, debounce } from 'obsidian';

// =======================================================
// 1. 设置接口与默认值
// =======================================================
interface RememberScrollSettings {
    maxHistory: number;
    rememberCursor: boolean;
    saveDelay: number;
}

const DEFAULT_SETTINGS: RememberScrollSettings = {
    maxHistory: 1000,
    rememberCursor: true,
    saveDelay: 2000
}

interface PluginData {
    settings: RememberScrollSettings;
    history: Record<string, any>;
}

// =======================================================
// 2. 主插件类
// =======================================================
export default class RememberScrollPlugin extends Plugin {
    settings: RememberScrollSettings;
    historyMap: Map<string, any> = new Map();
    requestSaveData: () => void;
    isUnloading = false;
    
    // 🌟【修复核心 1】：安全锁机制。记录正在被恢复的文件，防止其默认的0状态覆盖历史记录
    restoringFiles: Set<string> = new Set();

    async onload() {
        console.log('Loading Remember Scroll Position plugin (V4 Anti-Race-Condition)');

        await this.loadPluginData();
        this.setupDebouncer();
        this.addSettingTab(new RememberScrollSettingTab(this.app, this));

        // 1. 冷启动恢复（App 刚打开时）
        this.app.workspace.onLayoutReady(() => {
            const activeFile = this.app.workspace.getActiveFile();
            if (activeFile) {
                setTimeout(() => {
                    this.restoreState(activeFile);
                }, 100);
            }
        });

        // 2. 日常切换标签页恢复
        this.registerEvent(
            this.app.workspace.on('file-open', (file) => {
                if (file && this.app.workspace.layoutReady) {
                    this.restoreState(file);
                }
            })
        );

        // 🌟【修复核心 2】：废除 active-leaf-change 事件，改为 1 秒 1 次的后台扫描。
        // 读取内存极其轻量（消耗 < 1ms），只有位置改变才会触发防抖磁盘写入。
        this.registerInterval(
            window.setInterval(() => {
                this.saveAllStates();
            }, 1000) 
        );

        // 3. 监听文件清理
        this.registerEvent(
            this.app.vault.on('delete', (file) => {
                if (file instanceof TFile && this.historyMap.has(file.path)) {
                    this.historyMap.delete(file.path);
                    this.requestSaveData();
                }
            })
        );
        this.registerEvent(
            this.app.vault.on('rename', (file, oldPath) => {
                if (file instanceof TFile && this.historyMap.has(oldPath)) {
                    const data = this.historyMap.get(oldPath);
                    this.historyMap.delete(oldPath);
                    this.historyMap.set(file.path, data);
                    this.requestSaveData();
                }
            })
        );
    }

    async onunload() {
        this.isUnloading = true;
        this.saveAllStates(); // 关闭时最后扫描一次所有窗口
        await this.savePluginData(); 
    }

    // ================== 核心逻辑 ==================

    restoreState(file: TFile) {
        const path = file.path;
        const savedState = this.historyMap.get(path);
        if (!savedState) return;

        const stateToRestore = { ...savedState };
        if (!this.settings.rememberCursor) {
            delete stateToRestore.cursor;
        }

        // 🔒 上锁：告诉保存系统，这个文件正在恢复中，千万不要读它的状态！
        this.restoringFiles.add(path);

        let retryCount = 0;
        const maxRetries = 15;

        const tryRestore = () => {
            // 智能查找对应的视图，兼容多开分屏情况
            let view = this.app.workspace.getActiveViewOfType(MarkdownView);
            if (!view || view.file?.path !== path) {
                const leaves = this.app.workspace.getLeavesOfType("markdown");
                const targetLeaf = leaves.find(l => (l.view as MarkdownView).file?.path === path);
                if (targetLeaf) view = targetLeaf.view as MarkdownView;
            }

            if (view) {
                view.setEphemeralState(stateToRestore);

                const currentState = view.getEphemeralState();
                const targetScroll = Number(stateToRestore.scroll) || 0;
                const currentScroll = Number(currentState.scroll) || 0;

                if (Math.abs(currentScroll - targetScroll) > 5 && retryCount < maxRetries) {
                    retryCount++;
                    setTimeout(tryRestore, 100);
                } else {
                    // 🔓 解锁：恢复成功或超时放弃后，延迟 500ms 撤销保护锁
                    setTimeout(() => {
                        this.restoringFiles.delete(path);
                    }, 500);
                }
            } else {
                // 如果找不到视图直接解锁
                this.restoringFiles.delete(path);
            }
        };

        setTimeout(tryRestore, 50);
    }

    // 🌟【修复核心 3】：扫描并保存所有打开的标签页状态
    saveAllStates() {
        if (this.isUnloading) return; 

        const leaves = this.app.workspace.getLeavesOfType("markdown");
        let hasChanges = false;

        leaves.forEach(leaf => {
            const view = leaf.view as MarkdownView;
            if (view && view.file) {
                const path = view.file.path;

                // ⛔【拦截机制】：如果这个文件正戴着“恢复锁”，直接跳过，防止脏数据覆盖
                if (this.restoringFiles.has(path)) return;

                const state = view.getEphemeralState();
                if (state.scroll === undefined || state.scroll === null) return;

                const oldState = this.historyMap.get(path);
                const isChanged = !oldState || 
                                  oldState.scroll !== state.scroll || 
                                  JSON.stringify(oldState.cursor) !== JSON.stringify(state.cursor);

                if (isChanged) {
                    this.historyMap.delete(path);
                    this.historyMap.set(path, state);
                    hasChanges = true;
                }
            }
        });

        // 只要任何一个标签页有滚动，就通知系统 2 秒后写入硬盘
        if (hasChanges) {
            this.requestSaveData();
        }
    }

    // ================== 数据管理 ==================

    async loadPluginData() {
        const data: PluginData = await this.loadData();
        this.settings = Object.assign({}, DEFAULT_SETTINGS, data?.settings);
        
        const historyObj = data?.history || {};
        this.historyMap = new Map();
        
        for (const key in historyObj) {
            this.historyMap.set(key, historyObj[key]);
        }
    }

    async savePluginData() {
        while (this.historyMap.size > this.settings.maxHistory) {
            const oldestKey = this.historyMap.keys().next().value;
            this.historyMap.delete(oldestKey);
        }

        const historyObj: Record<string, any> = {};
        this.historyMap.forEach((value, key) => {
            historyObj[key] = value;
        });

        await this.saveData({
            settings: this.settings,
            history: historyObj
        });
    }

    setupDebouncer() {
        this.requestSaveData = debounce(async () => {
            await this.savePluginData();
        }, this.settings.saveDelay, true);
    }
}

// =======================================================
// 3. 用户设置面板
// =======================================================
class RememberScrollSettingTab extends PluginSettingTab {
    plugin: RememberScrollPlugin;

    constructor(app: App, plugin: RememberScrollPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        containerEl.createEl('h2', { text: 'Remember Scroll Position 设置' });

        new Setting(containerEl)
            .setName('最大记录数量')
            .setDesc('最多记住多少个文件的滚动位置。默认：1000')
            .addText(text => text
                .setPlaceholder('1000')
                .setValue(this.plugin.settings.maxHistory.toString())
                .onChange(async (value) => {
                    const parsed = parseInt(value, 10);
                    if (!isNaN(parsed) && parsed > 0) {
                        this.plugin.settings.maxHistory = parsed;
                        await this.plugin.savePluginData();
                    }
                }));

        new Setting(containerEl)
            .setName('记住光标位置')
            .setDesc('开启后，不仅恢复滚动条，还会将光标恢复到上次离开前的位置。')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.rememberCursor)
                .onChange(async (value) => {
                    this.plugin.settings.rememberCursor = value;
                    await this.plugin.savePluginData();
                }));

        new Setting(containerEl)
            .setName('磁盘写入延迟 (防抖)')
            .setDesc('停止滚动多少毫秒后才写入磁盘。默认：2000')
            .addSlider(slider => slider
                .setLimits(500, 5000, 500)
                .setValue(this.plugin.settings.saveDelay)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    this.plugin.settings.saveDelay = value;
                    await this.plugin.savePluginData();
                    this.plugin.setupDebouncer();
                }));
    }
}