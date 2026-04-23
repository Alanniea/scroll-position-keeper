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

    // 🌟 核心修复：恢复锁。记录哪些文件正在执行恢复操作，防止被保存成 0
    restoringFiles: Set<string> = new Set();

    async onload() {
        console.log('Loading Remember Scroll Position plugin (V5 Anti-Overwrite)');

        await this.loadPluginData();
        this.setupDebouncer();
        this.addSettingTab(new RememberScrollSettingTab(this.app, this));

        // 启动时冷恢复
        this.app.workspace.onLayoutReady(() => {
            const activeFile = this.app.workspace.getActiveFile();
            if (activeFile) {
                setTimeout(() => {
                    this.restoreState(activeFile);
                }, 100);
            }
        });

        // 切换到后台标签或打开新文件时恢复
        this.registerEvent(
            this.app.workspace.on('file-open', (file) => {
                if (file && this.app.workspace.layoutReady) {
                    this.restoreState(file);
                }
            })
        );

        // 🌟 废弃 active-leaf-change，改为高频轮询检查当前状态 (1秒一次)
        // 这样既能实时捕获最后位置，又完美避开了标签页切换时的生命周期冲突Bug
        this.registerInterval(
            window.setInterval(() => {
                this.saveCurrentState();
            }, 1000)
        );

        // 监听清理：文件删除或重命名时同步更新 Map
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
        console.log('Unloading Remember Scroll Position plugin');
        this.isUnloading = true; 
        this.saveCurrentState();
        await this.savePluginData(); 
    }

    // ================== 核心逻辑 ==================

    restoreState(file: TFile) {
        const savedState = this.historyMap.get(file.path);
        if (!savedState) return;

        const stateToRestore = { ...savedState };
        if (!this.settings.rememberCursor) {
            delete stateToRestore.cursor;
        }

        // 🌟 加上恢复锁：告诉系统“我正在恢复中，谁也别动我的历史数据！”
        this.restoringFiles.add(file.path);

        let retryCount = 0;
        const maxRetries = 20; 

        const tryRestore = () => {
            const view = this.app.workspace.getActiveViewOfType(MarkdownView);
            if (view && view.file?.path === file.path) {
                
                view.setEphemeralState(stateToRestore);

                setTimeout(() => {
                    const checkView = this.app.workspace.getActiveViewOfType(MarkdownView);
                    
                    // 容错：如果还在恢复期间用户切走了文件，必须解除锁！
                    if (!checkView || checkView.file?.path !== file.path) {
                        this.restoringFiles.delete(file.path);
                        return;
                    }

                    const currentState = checkView.getEphemeralState();
                    const targetScroll = Number(stateToRestore.scroll) || 0;
                    const currentScroll = Number(currentState.scroll) || 0;

                    if (Math.abs(currentScroll - targetScroll) > 0.1 && retryCount < maxRetries) {
                        retryCount++;
                        const nextDelay = 50 + (retryCount * 20); 
                        setTimeout(tryRestore, nextDelay);
                    } else {
                        // 🌟 恢复大功告成（或者达到最大重试次数放弃），解除锁！
                        this.restoringFiles.delete(file.path);
                    }
                }, 40); 
            } else {
                // 容错：视图突然消失，解除锁
                this.restoringFiles.delete(file.path);
            }
        };

        setTimeout(tryRestore, 100);
    }

    saveCurrentState() {
        if (this.isUnloading) return; 

        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (view && view.file) {
            const path = view.file.path;

            // 🌟 保护机制：如果这个文件正在执行恢复动画，绝对不能读取并覆盖！
            if (this.restoringFiles.has(path)) {
                return;
            }

            const state = view.getEphemeralState();
            if (state.scroll === undefined || state.scroll === null) return;

            const oldState = this.historyMap.get(path);
            const isChanged = !oldState || 
                              oldState.scroll !== state.scroll || 
                              JSON.stringify(oldState.cursor) !== JSON.stringify(state.cursor);

            if (isChanged) {
                this.historyMap.delete(path);
                this.historyMap.set(path, state);
                this.requestSaveData();
            }
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