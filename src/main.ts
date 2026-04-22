import { Plugin, MarkdownView, TFile, debounce } from 'obsidian';

// 定义数据的接口
interface ScrollData {
    [filePath: string]: number;
}

export default class RememberScrollPlugin extends Plugin {
    scrollPositions: ScrollData = {};
    MAX_HISTORY = 1000; // 最大保存 1000 个文件的记录，防止文件过大

    // 🌟 改进 2: 使用 Obsidian 内置的 debounce (防抖) 优化磁盘写入
    // 无论调用多少次 requestSaveData，它都会等待 2000ms 后才执行真正写入磁盘
    requestSaveData = debounce(async () => {
        await this.cleanUpOldData(); // 写入前先清理超出限制的旧数据
        await this.saveData(this.scrollPositions);
    }, 2000, true);

    async onload() {
        console.log('Loading Remember Scroll Position plugin (V2)');

        this.scrollPositions = (await this.loadData()) || {};

        // 🌟 改进 3: 更稳定地恢复滚动位置
        this.registerEvent(
            this.app.workspace.on('file-open', (file) => {
                if (!file) return;
                this.restoreScrollPosition(file);
            })
        );

        // 离开标签页时保存
        this.registerEvent(
            this.app.workspace.on('active-leaf-change', () => {
                this.saveCurrentScroll();
            })
        );

        // 定时保存内存中的位置，并触发防抖写入
        this.registerInterval(
            window.setInterval(() => {
                this.saveCurrentScroll();
            }, 3000)
        );

        // 🌟 改进 1: 监听文件删除和重命名，保持数据整洁
        this.registerEvent(
            this.app.vault.on('delete', (file) => {
                if (file instanceof TFile && this.scrollPositions[file.path] !== undefined) {
                    delete this.scrollPositions[file.path];
                    this.requestSaveData();
                }
            })
        );

        this.registerEvent(
            this.app.vault.on('rename', (file, oldPath) => {
                if (file instanceof TFile && this.scrollPositions[oldPath] !== undefined) {
                    this.scrollPositions[file.path] = this.scrollPositions[oldPath];
                    delete this.scrollPositions[oldPath];
                    this.requestSaveData();
                }
            })
        );
    }

    async onunload() {
        // 插件卸载时立即强制保存一次
        await this.saveCurrentScroll();
        await this.saveData(this.scrollPositions);
    }

    // 智能恢复位置
    restoreScrollPosition(file: TFile) {
        const savedScroll = this.scrollPositions[file.path];
        if (savedScroll === undefined) return;

        // 使用 requestAnimationFrame 等待浏览器渲染下一帧，比写死 setTimeout 更科学
        requestAnimationFrame(() => {
            const view = this.app.workspace.getActiveViewOfType(MarkdownView);
            if (view && view.file?.path === file.path) {
                const state = view.getEphemeralState();
                state.scroll = savedScroll;
                view.setEphemeralState(state);
            }
        });
    }

    // 保存当前位置到内存
    saveCurrentScroll() {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (view && view.file) {
            const state = view.getEphemeralState();
            
            if (state && typeof state.scroll === 'number') {
                const currentPath = view.file.path;
                const currentScroll = state.scroll;

                if (this.scrollPositions[currentPath] !== currentScroll) {
                    // 更新内存
                    this.scrollPositions[currentPath] = currentScroll;
                    // 请求写入磁盘（已被防抖处理）
                    this.requestSaveData();
                }
            }
        }
    }

    // 限制字典大小，防止 data.json 爆炸
    async cleanUpOldData() {
        const keys = Object.keys(this.scrollPositions);
        if (keys.length > this.MAX_HISTORY) {
            // 这里提供一种简单的清理方式：直接砍掉一半最旧的数据（假设对象属性顺序近似于插入顺序）
            // 在更严谨的实现中，你可以将数据结构改为 Map，从而精确实现 LRU（最近最少使用）算法
            const keysToRemove = keys.slice(0, keys.length - this.MAX_HISTORY);
            for (const key of keysToRemove) {
                delete this.scrollPositions[key];
            }
        }
    }
}