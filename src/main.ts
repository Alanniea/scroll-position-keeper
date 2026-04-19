import { Plugin, MarkdownView, Debouncer, debounce, TFile } from 'obsidian';

// 定义数据结构：键是文件路径，值是滚动位置（Top值）
interface ScrollPositionData {
	[filePath: string]: number;
}

interface RememberScrollSettings {
	positions: ScrollPositionData;
}

const DEFAULT_SETTINGS: RememberScrollSettings = {
	positions: {}
};

export default class RememberScrollPlugin extends Plugin {
	settings: RememberScrollSettings;
	// 用于防抖保存，避免频繁写入磁盘
	saveScrollPositionDebounced: Debouncer<[MarkdownView], void>;

	async onload() {
		await this.loadSettings();

		// 创建防抖函数，300ms 内的多次滚动只保存一次
		this.saveScrollPositionDebounced = debounce((view: MarkdownView) => {
			this.saveScrollPosition(view);
		}, 300, true);

		// 1. 监听文件打开事件：用于恢复滚动位置
		this.registerEvent(
			this.app.workspace.on('file-open', (file) => {
				if (file) {
					// 移动端视图渲染较慢，给予极短的延时以确保编辑器已就绪
					setTimeout(() => {
						this.restoreScrollPosition(file);
					}, 100); 
				}
			})
		);

		// 2. 注册一个全局的 DOM 监听器来捕获滚动
		// 注意：Obsidian 没有直接的 "onScroll" API，我们需要监听 active-leaf-change 并绑定事件，
		// 或者更简单地，利用 CodeMirror 的事件。
		
		this.registerDomEvent(window, 'scroll', (evt) => {
             // 这种全局监听在 Obsidian 内部复杂的 DOM 结构中可能不准确
             // 更好的方式是定期检查或监听编辑器更新
		}, true);

        // 更可靠的方法：监听编辑器变化 (Editor Change) 或 光标/滚动更新
        // 实际上，Obsidian 的 update 事件涵盖了滚动
        this.registerEvent(
            this.app.workspace.on('editor-change', (editor, view) => {
                if (view instanceof MarkdownView) {
                     this.saveScrollPositionDebounced(view);
                }
            })
        );
        
        // 补充：专门监听 active-leaf-change，以防切换标签页时丢失状态
        this.registerEvent(
            this.app.workspace.on('active-leaf-change', (leaf) => {
                const view = leaf?.view;
                if (view instanceof MarkdownView) {
                    // 切换到一个新视图时，先尝试保存旧视图状态比较困难
                    // 但我们可以确保新视图加载时恢复状态（在 file-open 中已处理）
                }
            })
        );
        
        // 高级技巧：直接 hook 编辑器的滚动事件
        // 每次布局变化重新绑定监听比较复杂，这里使用一个定时器轮询作为兜底（对性能影响极小）
        // 或者利用 CodeMirror 的 dom 结构。
        // 为了简化且保证 Android 兼容性，我们利用 editor-change 配合一个简单的 Interval
        // 因为仅仅滚动不一定会触发 editor-change
        
        this.registerInterval(window.setInterval(() => {
            const view = this.app.workspace.getActiveViewOfType(MarkdownView);
            if (view) {
                const currentScroll = view.editor.getScrollInfo().top;
                const file = view.file;
                if(file && this.settings.positions[file.path] !== currentScroll) {
                    this.saveScrollPositionDebounced(view);
                }
            }
        }, 1000)); // 每秒检查一次滚动位置变化
	}

	async saveScrollPosition(view: MarkdownView) {
		const file = view.file;
		if (!file) return;

		const scrollInfo = view.editor.getScrollInfo();
		// 更新内存中的设置
		this.settings.positions[file.path] = scrollInfo.top;
		
		// 写入硬盘 (data.json)
		await this.saveData(this.settings);
	}

	restoreScrollPosition(file: TFile) {
		const savedTop = this.settings.positions[file.path];
		
		// 如果没有存过，或者位置是 0 (顶部)，则忽略
		if (savedTop === undefined) return;

		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (view && view.file && view.file.path === file.path) {
            // 获取当前的 left 位置，只恢复 top
			const currentInfo = view.editor.getScrollInfo();
			view.editor.scrollTo(currentInfo.left, savedTop);
		}
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}
}