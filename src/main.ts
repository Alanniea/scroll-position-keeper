import { App, Plugin, PluginSettingTab, Setting, MarkdownView, TFile, debounce } from 'obsidian';

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

export default class RememberScrollPlugin extends Plugin {
    settings: RememberScrollSettings;
    historyMap: Map<string, any> = new Map();
    requestSaveData: () => void;
    isUnloading = false; 

    // 恢复锁：防止恢复过程中被覆盖为 0
    restoringFiles: Set<string> = new Set();

    // 🌟 核心追踪器 1：记录每个标签页(Leaf)最后加载的文件。用来判断是“新打开”还是“只是切回来看一眼”
    lastLoadedFileInLeaf: Map<string, string> = new Map();
    
    // 🌟 核心追踪器 2：记录上一次活跃的视图。用来在离开标签页的瞬间，精准保存旧标签页的状态
    lastActiveView: MarkdownView | null = null;

    async onload() {
        console.log('Loading Remember Scroll Position plugin (V6 Perfect Tab Sync)');

        await this.loadPluginData();
        this.setupDebouncer();
        this.addSettingTab(new RememberScrollSettingTab(this.app, this));

        // 1. 软件启动时冷恢复
        this.app.workspace.onLayoutReady(() => {
            const view = this.app.workspace.getActiveViewOfType(MarkdownView);
            if (view && view.file) {
                this.lastActiveView = view;
                // 记录当前标签页加载了该文件
                const leafId = (view.leaf as any).id;
                this.lastLoadedFileInLeaf.set(leafId, view.file.path);
                
                setTimeout(() => {
                    this.restoreState(view.file!);
                }, 100);
            }
        });

        // 2. 监听文件打开
        this.registerEvent(
            this.app.workspace.on('file-open', (file) => {
                if (!file || !this.app.workspace.layoutReady) return;

                const view = this.app.workspace.getActiveViewOfType(MarkdownView);
                if (!view) return;

                const leafId = (view.leaf as any).id;
                const previousFile = this.lastLoadedFileInLeaf.get(leafId);

                // 🌟 关键判断：如果这个标签页本来打开的就是这个文件（即用户只是在多标签页间切换）
                // 插件直接放手！让 Obsidian 原生功能保持当前滚动条，绝对不覆盖。
                if (previousFile === file.path) {
                    return; 
                }

                // 否则，说明是“新打开”的文件（或者是刚重启后首次加载），记录并恢复！
                this.lastLoadedFileInLeaf.set(leafId, file.path);
                this.restoreState(file);
            })
        );

        // 3. 监听切换标签页：精准保存上一个标签页的状态
        this.registerEvent(
            this.app.workspace.on('active-leaf-change', () => {
                // 🌟 在焦点移走的一瞬间，强行保存刚才那个视图的状态（解决手速过快 1 秒定时器没抓到的问题）
                if (this.lastActiveView) {
                    this.saveSpecificView(this.lastActiveView);
                }
                // 更新当前活跃视图
                this.lastActiveView = this.app.workspace.getActiveViewOfType(MarkdownView);
            })
        );

        // 4. 定时保存：防止用户一直停留在一个长笔记里阅读但突然崩溃
        this.registerInterval(
            window.setInterval(() => {
                const view = this.app.workspace.getActiveViewOfType(MarkdownView);
                if (view) this.saveSpecificView(view);
            }, 1000)
        );

        // 5. 文件维护
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
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (view) this.saveSpecificView(view);
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

        // 加锁
        this.restoringFiles.add(file.path);

        let retryCount = 0;
        const maxRetries = 20; 

        const tryRestore = () => {
            const view = this.app.workspace.getActiveViewOfType(MarkdownView);
            if (view && view.file?.path === file.path) {
                
                view.setEphemeralState(stateToRestore);

                setTimeout(() => {
                    const checkView = this.app.workspace.getActiveViewOfType(MarkdownView);
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
                        // 解锁
                        this.restoringFiles.delete(file.path);
                    }
                }, 40); 
            } else {
                this.restoringFiles.delete(file.path);
            }
        };

        setTimeout(tryRestore, 100);
    }

    // 🌟 改造后的保存函数：接收具体的 View，精准保存
    saveSpecificView(view: MarkdownView) {
        if (this.isUnloading || !view || !view.file) return; 

        const path = view.file.path;

        // 如果该文件正在执行恢复动画，绝不能覆盖！
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