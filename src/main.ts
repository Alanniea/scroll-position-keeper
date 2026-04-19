import { Plugin, MarkdownView } from 'obsidian';

export default class RememberScrollPlugin extends Plugin {
    // 在内存中保存所有文件的滚动位置 { "文件路径": 滚动高度 }
    scrollPositions: Record<string, number> = {};

    async onload() {
        console.log('Loading Remember Scroll Position plugin');

        // 1. 从插件的 data.json 读取历史数据
        this.scrollPositions = (await this.loadData()) || {};

        // 2. 监听文件打开事件：当打开文件时，恢复滚动位置
        this.registerEvent(
            this.app.workspace.on('file-open', (file) => {
                if (!file) return;

                const savedScroll = this.scrollPositions[file.path];
                if (savedScroll !== undefined) {
                    // 使用 setTimeout 给 Obsidian 一点时间渲染文档，否则滚动可能不生效
                    setTimeout(() => {
                        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
                        if (view && view.file?.path === file.path) {
                            // 使用 EphemeralState 设置滚动位置（兼容源码模式和实时预览模式）
                            const state = view.getEphemeralState();
                            state.scroll = savedScroll;
                            view.setEphemeralState(state);
                        }
                    }, 150); // 150毫秒的延迟通常足够了
                }
            })
        );

        // 3. 监听标签页切换事件：当离开当前文件前，保存其滚动位置
        this.registerEvent(
            this.app.workspace.on('active-leaf-change', () => {
                this.saveCurrentScroll();
            })
        );

        // 4. 定时保存：防止 Obsidian 突然崩溃导致丢失
        // 每 3 秒检查一次当前滚动位置
        this.registerInterval(
            window.setInterval(() => {
                this.saveCurrentScroll();
            }, 3000)
        );
    }

    async onunload() {
        console.log('Unloading Remember Scroll Position plugin');
        // 插件卸载或 Obsidian 关闭时强制保存一次
        await this.saveCurrentScroll();
    }

    // 保存当前活跃文档的滚动位置
    async saveCurrentScroll() {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (view && view.file) {
            const state = view.getEphemeralState();
            
            // 确保 state.scroll 存在
            if (state && typeof state.scroll === 'number') {
                const currentPath = view.file.path;
                const currentScroll = state.scroll;

                // 只有当位置发生改变时才写入磁盘，避免不必要的 I/O 操作
                if (this.scrollPositions[currentPath] !== currentScroll) {
                    this.scrollPositions[currentPath] = currentScroll;
                    await this.saveData(this.scrollPositions);
                }
            }
        }
    }
}