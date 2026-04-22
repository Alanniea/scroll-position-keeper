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
    isUnloading = false; // 标记是否正在关闭软件，防止覆盖脏数据

    async onload() {
        console.log('Loading Remember Scroll Position plugin (V3.1 Fixed)');

        // 1. 加载数据并初始化
        await this.loadPluginData();
        this.setupDebouncer();

        // 2. 添加设置面板
        this.addSettingTab(new RememberScrollSettingTab(this.app, this));

        // 🌟【修复核心 1】：处理 Obsidian 刚启动时的冷启动恢复
        // 必须等待 Obsidian 将初始布局完全画好后，再恢复滚动，否则会被原生机制覆盖
        this.app.workspace.onLayoutReady(() => {
            const activeFile = this.app.workspace.getActiveFile();
            if (activeFile) {
                // 稍微给一丁点延迟，确保 CodeMirror 编辑器彻底就绪
                setTimeout(() => {
                    this.restoreState(activeFile);
                }, 100);
            }
        });

        // 3. 监听日常文件打开（针对启动后切换标签的情况）
        this.registerEvent(
            this.app.workspace.on('file-open', (file) => {
                // 仅当布局已经准备好时才触发，避免与 onLayoutReady 冲突
                if (file && this.app.workspace.layoutReady) {
                    this.restoreState(file);
                }
            })
        );

        // 4. 监听离开标签页：保存状态
        this.registerEvent(
            this.app.workspace.on('active-leaf-change', () => {
                this.saveCurrentState();
            })
        );

        // 5. 定时检查并保存
        this.registerInterval(
            window.setInterval(() => {
                this.saveCurrentState();
            }, 3000)
        );

        // 6. 监听清理
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

    // 🌟【修复核心 2】：关闭软件时的强制同步保存
    async onunload() {
        console.log('Unloading Remember Scroll Position plugin');
        this.isUnloading = true; // 告诉插件软件正在关闭
        this.saveCurrentState();
        // 直接绕过防抖，强行同步写入磁盘，防止数据丢失
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

        let retryCount = 0;
        const maxRetries = 15; // 启动时可能较卡，重试次数增加到 15 次 (1.5秒)

        const tryRestore = () => {
            const view = this.app.workspace.getActiveViewOfType(MarkdownView);
            if (view && view.file?.path === file.path) {
                view.setEphemeralState(stateToRestore);

                const currentState = view.getEphemeralState();
                const targetScroll = Number(stateToRestore.scroll) || 0;
                const currentScroll = Number(currentState.scroll) || 0;

                // 容差设定为 5
                if (Math.abs(currentScroll - targetScroll) > 5 && retryCount < maxRetries) {
                    retryCount++;
                    setTimeout(tryRestore, 100);
                }
            }
        };

        // 稍微延迟启动第一次恢复
        setTimeout(tryRestore, 50);
    }

    saveCurrentState() {
        // 如果软件正在关闭，不再读取试图状态（此时视图可能已经被销毁，会读到 0）
        if (this.isUnloading) return; 

        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (view && view.file) {
            const state = view.getEphemeralState();
            const path = view.file.path;

            // 如果读取不到 scroll 属性，直接跳过，防止保存脏数据
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