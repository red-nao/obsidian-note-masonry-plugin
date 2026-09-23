import { App, FuzzySuggestModal, ItemView, MarkdownFileInfo, Menu, Modal, Notice, Plugin, PluginSettingTab, Scope, Setting, View, Workspace, WorkspaceLeaf, TFile, TFolder, setIcon, getAllTags } from 'obsidian';

export const KEEP_VIEW_TYPE = "keep-view";
const DEFAULT_TAG_FILTER = "#WIP";
const RANDOM_FILE_COUNT = 15;
/** パフォーマンス調整用定数 */
const RENDER_INITIAL_LIMIT = 100;
const RENDER_MORE_STEP = 100;
const SEARCH_CONTENT_BATCH = 40;
const RENDER_YIELD_EVERY = 20;

/** canvas絞り込みモードで扱うカード種別。配置順維持のためnodeIndexを保持する */
interface CanvasFileItem {
    kind: 'file';
    file: TFile;
    nodeIndex: number;
}

interface CanvasTextItem {
    kind: 'text';
    nodeId: string;
    text: string;
    color?: string;
    nodeIndex: number;
}

type CanvasGridItem = CanvasFileItem | CanvasTextItem;

interface NoteMasonrySettings {
    canvasLabelSplitEnabled: boolean;
    /** テキストノード編集用の使い回しスクラッチファイルを置くフォルダ（Vault相対） */
    scratchFolder: string;
    /** Card Viewの新規作成ボタンで使う既定の作成先フォルダ（Vault相対・空欄はVault直下） */
    newFileFolder: string;
}

const DEFAULT_SCRATCH_FOLDER = '__masonry-scratch';

const DEFAULT_SETTINGS: NoteMasonrySettings = {
    canvasLabelSplitEnabled: true,
    scratchFolder: DEFAULT_SCRATCH_FOLDER,
    newFileFolder: '',
};

/** タグ名を正規化する（#なし・前後空白なし）。空文字は無効扱い */
function normalizeTagName(raw: string): string {
    return (raw ?? '').trim().replace(/^#+/, '').trim();
}

/** frontmatterのタグ値（string | string[] | mixed）を#なしタグ配列にほぐす */
function splitFrontmatterTagValue(v: unknown): string[] {
    if (v == null) return [];
    if (Array.isArray(v)) {
        const out: string[] = [];
        for (const el of v) out.push(...splitFrontmatterTagValue(el));
        return out;
    }
    if (typeof v !== 'string') return splitFrontmatterTagValue(String(v));
    return v.split(/[\s,]+/).map(normalizeTagName).filter((t) => t.length > 0);
}

/** スクラッチフォルダ設定値を正規化する。空なら既定に戻す */
function normalizeScratchFolder(raw: string): string {
    const cleaned = (raw ?? '').replace(/\\/g, '/').trim().replace(/^\/+|\/+$/g, '').replace(/\/{2,}/g, '/');
    return cleaned || DEFAULT_SCRATCH_FOLDER;
}

/** 新規ファイル作成先フォルダ設定値を正規化する。空欄はVault直下（''）として扱う */
function normalizeNewFileFolder(raw: string): string {
    return (raw ?? '').replace(/\\/g, '/').trim().replace(/^\/+|\/+$/g, '').replace(/\/{2,}/g, '/');
}

/**
 * Obsidian標準の Modal はキーボードイベント処理を横取りするため、
 * 中に埋めたエディタでユーザーのホットキー(コマンド)が発火しない。
 * 見た目はModalと同じだが Modal クラスを使わない自前オーバーレイにし、
 * workspace の activeEditor / getActiveViewOfType / getActiveFile を
 * モーダル内エディタに向けることでホットキーを効かせる。
 */
class NoteEditModal {
    app: App;
    scope: Scope;
    containerEl: HTMLElement;
    modalEl: HTMLElement;
    contentEl: HTMLElement;
    private bgEl: HTMLElement;
    file: TFile | null;
    keepLeaf: WorkspaceLeaf;
    editorLeaf: WorkspaceLeaf | null = null;
    onCloseCallback: () => void;
    selectedFolder: string;
    selectedTag: string;
    hideTitle: boolean;
    private prevActiveEditor: MarkdownFileInfo | null = null;
    private hasSavedActiveEditor = false;
    private pushedModalScope = false;
    private isOpen = false;
    private origSetActiveLeaf: Workspace['setActiveLeaf'] | null = null;
    private origGetActiveViewOfType: Workspace['getActiveViewOfType'] | null = null;
    private origGetActiveFile: Workspace['getActiveFile'] | null = null;

    constructor(app: App, file: TFile | null, keepLeaf: WorkspaceLeaf, onCloseCallback: () => void, selectedFolder: string = '', selectedTag: string = '', hideTitle = false) {
        this.app = app;
        this.file = file;
        this.keepLeaf = keepLeaf;
        this.onCloseCallback = onCloseCallback;
        this.selectedFolder = selectedFolder;
        this.selectedTag = selectedTag;
        this.hideTitle = hideTitle;
        // Escで閉じる専用。親をapp.scopeにするので他ホットキーはフォールスルーする。
        this.scope = new Scope(this.app.scope);
        this.scope.register(null, "Escape", () => {
            this.close();
            return false;
        });
        // Modalと同じDOM構造にして既存CSS(.keep-* + 組み込み.modal-*)を再利用する
        this.containerEl = document.createElement('div');
        this.containerEl.addClass('modal-container', 'mod-dim');
        this.bgEl = this.containerEl.createDiv({ cls: 'modal-bg keep-modal-bg' });
        this.bgEl.addEventListener('click', () => this.close());
        this.modalEl = this.containerEl.createDiv({ cls: 'modal keep-editor-modal' });
        if (this.hideTitle) this.modalEl.addClass('keep-hide-title');
        this.contentEl = this.modalEl.createDiv({ cls: 'modal-content keep-editor-modal-content' });
    }

    open() {
        if (this.isOpen) return;
        this.isOpen = true;
        document.body.appendChild(this.containerEl);
        this.app.keymap.pushScope(this.scope);
        this.pushedModalScope = true;
        void this.onOpen();
    }

    private onModalFocusIn = () => {
        this.claimActiveEditor();
    };

    private getEditorView(): (View & Partial<MarkdownFileInfo>) | null {
        const view = this.editorLeaf?.view;
        return (view ?? null) as (View & Partial<MarkdownFileInfo>) | null;
    }

    private isEditorFocused(): boolean {
        const ae = document.activeElement;
        return !!ae && !!this.contentEl && this.contentEl.contains(ae);
    }

    /** デタッチleaf内のviewを activeEditor として振る舞わせる。view.scopeはpushしない(Escを横取りしてモーダルが閉じなくなるため)。ホットキーはmodal scope→app.scopeへのフォールスルーで届く。 */
    private claimActiveEditor() {
        const view = this.getEditorView();
        if (!view) return;
        if (!this.hasSavedActiveEditor) {
            this.prevActiveEditor = this.app.workspace.activeEditor;
            this.hasSavedActiveEditor = true;
        }
        if (this.app.workspace.activeEditor !== view) {
            this.app.workspace.activeEditor = view as MarkdownFileInfo;
        }
    }

    private releaseActiveEditor() {
        const view = this.getEditorView();
        if (this.hasSavedActiveEditor) {
            if (!view || this.app.workspace.activeEditor === (view as MarkdownFileInfo)) {
                this.app.workspace.activeEditor = this.prevActiveEditor;
            }
            this.prevActiveEditor = null;
            this.hasSavedActiveEditor = false;
        }
    }

    /**
     * Obsidianコアは activeEditor が MarkdownView 外にあるとクリアしたり、
     * getActiveViewOfType/getActiveFile が背後のleafを返すため、
     * モーダル表示中だけworkspaceの該当箇所をモーダル内に向ける。
     * 閉じる際に必ず元に戻す。
     */
    private patchWorkspace() {
        const ws = this.app.workspace as Workspace & Record<string, unknown>;
        if (!this.origSetActiveLeaf) {
            const orig = ws.setActiveLeaf.bind(ws) as Workspace['setActiveLeaf'];
            this.origSetActiveLeaf = orig;
            const self = this;
            (ws as unknown as Record<string, unknown>).setActiveLeaf = function (leaf: WorkspaceLeaf, ...args: unknown[]) {
                // エディタ編集中にコアや他処理がactiveを奪うのを防ぐ (Kanban/Embeddable方式)
                if (self.isOpen && self.isEditorFocused()) return;
                return (orig as (...a: unknown[]) => unknown).apply(ws, [leaf, ...args]);
            };
        }
        if (!this.origGetActiveViewOfType) {
            const orig = ws.getActiveViewOfType.bind(ws) as Workspace['getActiveViewOfType'];
            this.origGetActiveViewOfType = orig;
            const self = this;
            (ws as unknown as Record<string, unknown>).getActiveViewOfType = function (type: unknown) {
                const v = self.editorLeaf?.view;
                try {
                    if (self.isOpen && v && v instanceof (type as new (...a: never[]) => unknown)) return v;
                } catch {
                    // instanceof失敗時はフォールスルー
                }
                return (orig as (...a: unknown[]) => unknown).apply(ws, [type]);
            };
        }
        if (!this.origGetActiveFile) {
            const orig = ws.getActiveFile.bind(ws) as Workspace['getActiveFile'];
            this.origGetActiveFile = orig;
            const self = this;
            (ws as unknown as Record<string, unknown>).getActiveFile = function () {
                if (self.isOpen && self.file) return self.file;
                return (orig as () => unknown).apply(ws);
            };
        }
    }

    private unpatchWorkspace() {
        const ws = this.app.workspace as unknown as Record<string, unknown>;
        if (this.origSetActiveLeaf) {
            ws.setActiveLeaf = this.origSetActiveLeaf;
            this.origSetActiveLeaf = null;
        }
        if (this.origGetActiveViewOfType) {
            ws.getActiveViewOfType = this.origGetActiveViewOfType;
            this.origGetActiveViewOfType = null;
        }
        if (this.origGetActiveFile) {
            ws.getActiveFile = this.origGetActiveFile;
            this.origGetActiveFile = null;
        }
    }

    async onOpen() {
        this.contentEl.empty();

        let isNewFile = false;
        if (!this.file) {
            const basePath = this.selectedFolder ? `${this.selectedFolder}/` : "";
            // 作成先フォルダがなければ作る（設定の既定フォルダ直指定時など）
            if (this.selectedFolder) {
                const existing = this.app.vault.getAbstractFileByPath(this.selectedFolder);
                if (!existing) {
                    await this.app.vault.createFolder(this.selectedFolder);
                }
            }
            let newPath = `${basePath}Untitled.md`;
            let counter = 1;
            while (this.app.vault.getAbstractFileByPath(newPath)) {
                newPath = `${basePath}Untitled ${counter}.md`;
                counter++;
            }
          this.file = await this.app.vault.create(newPath, "");
          
          if (this.selectedTag) {
              await this.app.fileManager.processFrontMatter(this.file, (fm) => {
                  if (!fm.tags) {
                      fm.tags = [];
                  } else if (typeof fm.tags === "string") {
                      fm.tags = [fm.tags];
                  }
                  const cleanTag = this.selectedTag.replace(/^#/, '');
                  if (!fm.tags.includes(cleanTag)) {
                      fm.tags.push(cleanTag);
                  }
              });
          }
          
          isNewFile = true;
        }

        const LeafConstructor = this.keepLeaf.constructor as new (app: App) => WorkspaceLeaf;
        this.editorLeaf = new LeafConstructor(this.app);

        const leafEl = (this.editorLeaf as WorkspaceLeaf & { containerEl: HTMLElement }).containerEl;
        this.contentEl.appendChild(leafEl);

        if (this.editorLeaf && this.file) {
            const leaf = this.editorLeaf;
            await leaf.openFile(this.file);
            // open中に閉じられていた場合はリーク防止のためdetachして終了
            if (!this.isOpen || this.editorLeaf !== leaf) {
                leaf.detach();
                return;
            }
            // モーダル内エディタを activeEditor 化し、view.scope をpushして
            // エディタ系ホットキー(editorCallback系)が効くようにする。
            // workspaceが裏でactiveEditorを書き換える場合に備え、focusinで取り直す。
            // ObsidianコアによるactiveEditorクリアにも耐えるようworkspaceをパッチする。
            this.patchWorkspace();
            this.contentEl.addEventListener('focusin', this.onModalFocusIn);
            this.claimActiveEditor();
            if (isNewFile) {
              setTimeout(() => {
                  const inlineTitle = this.contentEl.querySelector('.inline-title') as HTMLElement;
                  if (inlineTitle) {
                      inlineTitle.focus();
                      const range = document.createRange();
                      range.selectNodeContents(inlineTitle);
                      const sel = window.getSelection();
                      if (sel) {
                          sel.removeAllRanges();
                          sel.addRange(range);
                      }
                  } else {
                      const headerTitle = this.contentEl.querySelector('.view-header-title') as HTMLElement;
                      if (headerTitle) {
                          headerTitle.click();
                      }
                  }
              }, 150);
            }
        }
    }

    close() {
        if (!this.isOpen) return;
        this.isOpen = false;
        this.contentEl.removeEventListener('focusin', this.onModalFocusIn);
        this.releaseActiveEditor();
        this.unpatchWorkspace();
        if (this.pushedModalScope) {
            try {
                this.app.keymap.popScope(this.scope);
            } catch {
                // 無視
            }
            this.pushedModalScope = false;
        }
        if (this.editorLeaf) {
            this.editorLeaf.detach();
            this.editorLeaf = null;
        }
        this.containerEl.remove();
        this.contentEl.empty();
        this.app.workspace.setActiveLeaf(this.keepLeaf, { focus: true });
        this.onCloseCallback();
    }
}

export class KeepView extends ItemView {
    gridContainer: HTMLElement;
    folderSelect: HTMLSelectElement;
    tagSelect: HTMLSelectElement;
    searchInput: HTMLInputElement;
    randomButton: HTMLButtonElement;
    private filterContainer: HTMLElement | null = null;
    private leftFilters: HTMLElement | null = null;
    private createButton: HTMLElement | null = null;
    private canvasBanner: HTMLElement | null = null;
    private selectionBar: HTMLElement | null = null;
    private selectionCountEl: HTMLElement | null = null;
    /** 通常モードでの複数選択状態（Vault相対パス集合）。フィルタ変更時はクリアされる */
    private selectedPaths = new Set<string>();
    private isRendering = false;
    private pendingRender = false;
    private renderTimeout: NodeJS.Timeout | null = null;
    private hasAppliedDefaultTagFilter = false;
    private canvasFocusCycle: Record<string, number> = {};
    /** テキスト編集用スクラッチの格納フォルダ（KeepPluginから注入される） */
    scratchFolder: string = DEFAULT_SCRATCH_FOLDER;
    /** 新規作成ボタンの既定作成先フォルダ（KeepPluginから注入される・空欄はVault直下） */
    newFileFolder = '';
    private activeTextSession: { canvasPath: string; nodeId: string; baseText: string } | null = null;
    /** ページネーション・キャッシュ用 */
    private renderLimit = RENDER_INITIAL_LIMIT;
    private lastFilterKey = '';
    private displayPinned: TFile[] = [];
    private displayUnpinned: TFile[] = [];
    private displayContentCache = new Map<string, string>();
    private unpinnedGridEl: HTMLElement | null = null;
    private moreSentinelEl: HTMLElement | null = null;
    private moreObserver: IntersectionObserver | null = null;
    private searchWrapperEl: HTMLElement | null = null;
    private lastFolderPaths: string[] | null = null;
    private lastTagList: string[] | null = null;
    private lastFolderValue = '\0';
    private lastTagValue = '\0';
    private normalizedScratchCache = DEFAULT_SCRATCH_FOLDER;
    private normalizedScratchSource: string | null = null;
    /** アプリ全体で開いている編集モーダルの数。1以上なら背後の再描画を抑止する */
    private static openModalCount = 0;
    /** 全canvas共有の使い回しスクラッチファイル名。canvas名を含めないことでリネーム時の増殖を防ぐ */
    private static readonly SHARED_SCRATCH_NAME = 'masonry-scratch.md';
    /** 旧形式(canvas名ベース)の残骸掃除はセッション中1回だけ */
    private static legacyScratchCleaned = false;

    selectedFolder: string = '';
    selectedTag: string = '';
    searchQuery: string = '';
    isRandomMode: boolean = false;
    randomFiles: TFile[] = [];
    canvasSourcePath: string | null = null;

    constructor(leaf: WorkspaceLeaf) {
        super(leaf);
    }

    getViewType() {
        return KEEP_VIEW_TYPE;
    }

    getDisplayText() {
        return "Note masonry";
    }

    getIcon() {
        return "layout-grid";
    }

    async onClose() {
        this.disconnectMoreObserver();
        if (this.renderTimeout) {
            clearTimeout(this.renderTimeout);
            this.renderTimeout = null;
        }
    }

    getState() {
        return {
            ...super.getState(),
            selectedFolder: this.selectedFolder,
            selectedTag: this.selectedTag,
            searchQuery: this.searchQuery,
            canvasSourcePath: this.canvasSourcePath
        };
    }

    isCanvasMode(): boolean {
        return !!this.canvasSourcePath;
    }

    async setState(state: Record<string, unknown>, result: Parameters<ItemView['setState']>[1]) {
        if (typeof state.selectedFolder === 'string') {
            this.selectedFolder = state.selectedFolder;
        }
        if (typeof state.selectedTag === 'string') {
            this.selectedTag = state.selectedTag;
            this.hasAppliedDefaultTagFilter = true;
        }
        if (typeof state.searchQuery === 'string') {
            this.searchQuery = state.searchQuery;
        }
        if (typeof state.canvasSourcePath === 'string' && state.canvasSourcePath) {
            this.canvasSourcePath = state.canvasSourcePath;
        } else if (state.canvasSourcePath === null || state.canvasSourcePath === '') {
            this.canvasSourcePath = null;
        }
        this.isRandomMode = false;
        this.randomFiles = [];
        this.canvasFocusCycle = {};
        if (this.canvasSourcePath && this.selectedPaths.size > 0) {
            this.selectedPaths.clear();
        }
        await super.setState(state, result);
        this.updateCanvasModeUI();
        if (this.searchInput && typeof this.searchQuery === 'string') {
            this.searchInput.value = this.searchQuery;
            this.updateSearchVisibility();
        }
        this.requestRender();
    }

    async onOpen() {
        const container = this.containerEl.children[1];
        container.empty();
        container.addClass('keep-view-container');

        const filterContainer = container.createEl('div', { cls: 'keep-filter-container' });
        this.filterContainer = filterContainer;
        
        const leftFilters = filterContainer.createEl('div', { cls: 'keep-filter-left' });
        this.leftFilters = leftFilters;
    
        this.folderSelect = leftFilters.createEl('select', { cls: 'keep-select' });
        this.folderSelect.addEventListener('change', (e) => {
            this.selectedFolder = (e.target as HTMLSelectElement).value;
            this.adjustSelectWidth(this.folderSelect); 
            this.exitRandomMode();
            this.requestRender();
        });
    
        this.tagSelect = leftFilters.createEl('select', { cls: 'keep-select' });
        this.tagSelect.addEventListener('change', (e) => {
            this.selectedTag = (e.target as HTMLSelectElement).value;
            this.adjustSelectWidth(this.tagSelect);   
            this.exitRandomMode();
            this.requestRender();
        });

        this.randomButton = filterContainer.createEl('button', {
            cls: 'keep-random-button',
            attr: { 'aria-label': 'Show 15 random notes', 'title': 'ランダムに15件表示' },
        });
        setIcon(this.randomButton, 'shuffle');
        this.randomButton.addEventListener('click', () => {
            this.showRandomFiles();
        });

        const searchContainer = filterContainer.createEl('div', { cls: 'keep-search-container' });
    
        const searchWrapper = searchContainer.createEl('div', { cls: 'keep-search-wrapper' });
        
        const searchIconWrapper = searchWrapper.createEl('div', { cls: 'keep-search-icon' });
        setIcon(searchIconWrapper, 'search');
        
        this.searchInput = searchWrapper.createEl('input', {
            cls: 'keep-search-input',
            attr: {
                type: 'text',
                placeholder: 'Search notes...'
            }
        });
        
        this.searchInput.value = this.searchQuery;
        
        this.searchInput.addEventListener('input', (e) => {
            this.searchQuery = (e.target as HTMLInputElement).value;
            this.updateSearchVisibility();
            this.exitRandomMode();
            this.requestRender();
        });
    
        this.searchInput.addEventListener('focus', () => {
            searchWrapper.addClass('is-focused');
        });
    
        this.searchInput.addEventListener('blur', () => {
            searchWrapper.removeClass('is-focused');
        });
    
        // 初期表示状態を設定
        this.updateSearchVisibility();
    
        const createButton = filterContainer.createEl('button', {
            cls: 'keep-create-button',
        });
        this.createButton = createButton;
        setIcon(createButton, 'plus');
        createButton.addEventListener('click', () => {
            this.openNoteModal(null, { selectedFolder: this.getEffectiveNewFileFolder(), selectedTag: this.selectedTag });
        });

        this.canvasBanner = container.createEl('div', { cls: 'keep-canvas-banner' });
        this.canvasBanner.hide();

        this.buildSelectionBar(container);
    
        this.gridContainer = container.createEl('div', { cls: 'keep-grid-wrapper' });
        this.searchWrapperEl = searchWrapper;

        // スクラッチファイルの変更では再描画しない。高頻度のmodify/changedは長めにデバウンスする。
        this.registerEvent(this.app.vault.on('create', (f) => {
            if (f instanceof TFile && this.isScratchFile(f)) return;
            this.requestRender(300);
        }));
        this.registerEvent(this.app.vault.on('modify', (f) => {
            if (f instanceof TFile && this.isScratchFile(f)) return;
            if (f instanceof TFile && f.extension === 'canvas' && !this.isCanvasMode()) return;
            this.requestRender(600);
        }));
        this.registerEvent(this.app.vault.on('delete', (f) => {
            if (f instanceof TFile && this.isScratchFile(f)) return;
            this.requestRender(300);
        }));
        this.registerEvent(this.app.vault.on('rename', () => this.requestRender(300)));
        this.registerEvent(this.app.metadataCache.on('changed', (f) => {
            if (f instanceof TFile && this.isScratchFile(f)) return;
            this.requestRender(600);
        }));

        // Escで選択解除（編集モーダル／確認モーダル／ピッカーが開いている間はそちらを優先）
        // View.scopeは初期値nullのため自前で割り当てる（フォーカス中のみ有効になる）
        this.scope = new Scope(this.app.scope);
        this.scope.register(null, 'Escape', () => {
            if (this.selectedPaths.size === 0) return true;
            if (KeepView.openModalCount > 0) return true;
            if (document.body.querySelector('.modal-container')) return true;
            this.clearSelection();
            return false;
        });

        this.updateCanvasModeUI();
        void this.cleanupLegacyScratchFiles();
        await this.renderGrid();
    }

    /** canvasモードではフォルダ/タグ/ランダム/新規作成を隠し、検索バーのみ＋バナーを表示する */
    updateCanvasModeUI() {
        const canvasMode = this.isCanvasMode();
        if (this.leftFilters) {
            this.leftFilters.style.display = canvasMode ? 'none' : '';
        }
        if (this.randomButton) {
            this.randomButton.style.display = canvasMode ? 'none' : '';
        }
        if (this.createButton) {
            this.createButton.style.display = canvasMode ? 'none' : '';
        }
        if (this.canvasBanner) {
            this.canvasBanner.empty();
            if (canvasMode && this.canvasSourcePath) {
                this.canvasBanner.show();
                const label = this.canvasBanner.createEl('span', {
                    cls: 'keep-canvas-banner-label',
                    text: `Filtered by ${this.canvasSourcePath}`,
                });
                label.setAttr('title', this.canvasSourcePath);
                const clearBtn = this.canvasBanner.createEl('button', {
                    cls: 'keep-canvas-banner-clear',
                    attr: { 'aria-label': 'Clear canvas filter' },
                });
                setIcon(clearBtn, 'x');
                clearBtn.addEventListener('click', () => {
                    this.canvasSourcePath = null;
                    this.canvasFocusCycle = {};
                    this.updateCanvasModeUI();
                    this.requestRender();
                });
            } else {
                this.canvasBanner.hide();
            }
        }
        this.updateSelectionBar();
    }

    /** 複数選択バー（通常モード＋選択ありのときだけ表示） */
    private buildSelectionBar(container: Element) {
        const bar = container.createEl('div', { cls: 'keep-selection-bar' });
        this.selectionBar = bar;
        this.selectionCountEl = bar.createEl('span', { cls: 'keep-selection-count', text: '' });
        const sendBtn = bar.createEl('button', { cls: 'keep-selection-btn', text: 'Send to Canvas' });
        sendBtn.addEventListener('click', () => {
            void this.sendSelectedToCanvas();
        });
        const newBtn = bar.createEl('button', { cls: 'keep-selection-btn', text: 'New Canvas' });
        newBtn.addEventListener('click', () => {
            void this.createCanvasFromSelected();
        });
        const tagsBtn = bar.createEl('button', { cls: 'keep-selection-btn', text: 'Tags' });
        tagsBtn.addEventListener('click', () => {
            this.openSelectedTagEditor();
        });
        const delBtn = bar.createEl('button', { cls: 'keep-selection-btn keep-selection-delete', text: 'Delete' });
        delBtn.addEventListener('click', () => {
            void this.deleteSelectedWithConfirm();
        });
        const clearBtn = bar.createEl('button', { cls: 'keep-selection-clear', attr: { 'aria-label': 'Clear selection' } });
        setIcon(clearBtn, 'x');
        clearBtn.addEventListener('click', () => this.clearSelection());
        bar.hide();
    }

    private isSelected(file: TFile): boolean {
        return this.selectedPaths.has(file.path);
    }

    private getSelectedFiles(): TFile[] {
        const out: TFile[] = [];
        for (const p of this.selectedPaths) {
            const f = this.app.vault.getAbstractFileByPath(p);
            if (f instanceof TFile) out.push(f);
        }
        return out;
    }

    private toggleSelection(file: TFile, card?: HTMLElement | null) {
        if (this.isCanvasMode()) return;
        if (this.selectedPaths.has(file.path)) {
            this.selectedPaths.delete(file.path);
        } else {
            this.selectedPaths.add(file.path);
        }
        if (card) {
            const selected = this.selectedPaths.has(file.path);
            card.toggleClass('is-selected', selected);
            const box = card.querySelector('.keep-select-checkbox');
            if (box) box.toggleClass('is-checked', selected);
        } else {
            this.syncSelectionCards();
        }
        this.updateSelectionBar();
    }

    private clearSelection() {
        if (this.selectedPaths.size === 0) return;
        this.selectedPaths.clear();
        this.syncSelectionCards();
        this.updateSelectionBar();
    }

    /** DOM上のカード選択表示を選択集合に合わせる（再描画なしの軽量同期） */
    private syncSelectionCards() {
        try {
            const cards = this.gridContainer?.querySelectorAll('.keep-card');
            if (!cards) return;
            cards.forEach((el) => {
                const path = (el as HTMLElement).getAttr('data-file-path');
                const selected = !!path && this.selectedPaths.has(path);
                (el as HTMLElement).toggleClass('is-selected', selected);
                const box = (el as HTMLElement).querySelector('.keep-select-checkbox');
                if (box) box.toggleClass('is-checked', selected);
            });
        } catch {
            // ignore
        }
    }

    private updateSelectionBar() {
        if (!this.selectionBar || !this.selectionCountEl) return;
        const count = this.selectedPaths.size;
        if (this.isCanvasMode() || count === 0) {
            this.selectionBar.hide();
            return;
        }
        this.selectionBar.show();
        this.selectionCountEl.setText(`${count} selected`);
    }

    /** 右クリック対象の解決。選択中のカード上なら選択全体、未選択上なら単体 */
    private getBulkTargets(file: TFile): TFile[] {
        if (this.selectedPaths.has(file.path) && this.selectedPaths.size > 1) {
            const files = this.getSelectedFiles();
            if (files.length > 1) return files;
        }
        return [file];
    }

    private getCanvasSourceFile(): TFile | null {
        if (!this.canvasSourcePath) return null;
        const f = this.app.vault.getAbstractFileByPath(this.canvasSourcePath);
        return f instanceof TFile ? f : null;
    }

    /** .canvas JSONからfile/textノードを取り出す（link/groupは除外）。配置順維持のためnodeIndexを付与する */
    private async loadCanvasGridItems(canvasFile: TFile): Promise<CanvasGridItem[]> {
        let raw = '';
        try {
            raw = await this.app.vault.read(canvasFile);
        } catch {
            return [];
        }
        try {
            const data = JSON.parse(raw) as { nodes?: unknown };
            if (!data || !Array.isArray(data.nodes)) return [];
            const fileSeen = new Set<string>();
            const fileByKey = new Map<string, { file: TFile; nodeIndex: number }>();
            const texts: CanvasTextItem[] = [];
            data.nodes.forEach((n, index) => {
                const node = n as { type?: unknown; file?: unknown; id?: unknown; text?: unknown; color?: unknown };
                if (!node || typeof node.type !== 'string') return;
                if (node.type === 'file' && typeof node.file === 'string' && node.file) {
                    let f = this.app.vault.getAbstractFileByPath(node.file);
                    if (!(f instanceof TFile)) {
                        try {
                            const dest = this.app.metadataCache.getFirstLinkpathDest(node.file, canvasFile.path);
                            if (dest instanceof TFile) f = dest;
                        } catch {
                            // ignore
                        }
                    }
                    if (f instanceof TFile && !fileSeen.has(f.path)) {
                        fileSeen.add(f.path);
                        fileByKey.set(f.path, { file: f, nodeIndex: index });
                    }
                } else if (node.type === 'text' && typeof node.id === 'string' && typeof node.text === 'string') {
                    texts.push({
                        kind: 'text',
                        nodeId: node.id,
                        text: node.text,
                        color: typeof node.color === 'string' ? node.color : undefined,
                        nodeIndex: index,
                    });
                }
            });
            const items: CanvasGridItem[] = [];
            for (const { file, nodeIndex } of fileByKey.values()) {
                items.push({ kind: 'file', file, nodeIndex });
            }
            for (const t of texts) items.push(t);
            items.sort((a, b) => a.nodeIndex - b.nodeIndex);
            return items;
        } catch {
            return [];
        }
    }

    private isMarkdownFile(file: TFile): boolean {
        return file.extension === 'md';
    }

    updateSearchVisibility() {
      const searchWrapper = this.searchWrapperEl ?? (this.containerEl.querySelector('.keep-search-wrapper') as HTMLElement | null);
      if (!this.searchWrapperEl && searchWrapper) this.searchWrapperEl = searchWrapper;
      if (searchWrapper) {
          if (this.searchQuery) {
              searchWrapper.addClass('has-value');
          } else {
              searchWrapper.removeClass('has-value');
          }
      }
    }

    /**
     * 編集モーダルを開く共通ヘルパー。開いている間は requestRender を抑止して
     * 背後のカードViewが編集中にちらつかないようにし、閉じた後に1回だけ再描画する。
     */
    private openNoteModal(
        file: TFile | null,
        opts: { selectedFolder?: string; selectedTag?: string; hideTitle?: boolean; renderOnClose?: boolean; onClosed?: () => void } = {},
    ) {
        KeepView.openModalCount++;
        let closed = false;
        const doClose = () => {
            if (closed) return;
            closed = true;
            KeepView.openModalCount = Math.max(0, KeepView.openModalCount - 1);
            try {
                opts.onClosed?.();
            } finally {
                if (opts.renderOnClose !== false) this.requestRender();
            }
        };
        try {
            new NoteEditModal(this.app, file, this.leaf, doClose, opts.selectedFolder ?? '', opts.selectedTag ?? '', opts.hideTitle ?? false).open();
        } catch (e) {
            doClose();
            throw e;
        }
    }

    requestRender(delay = 300) {
        // 編集モーダルを開いている間は背後への反映を抑止し、閉じた後の1回にまとめる
        if (KeepView.openModalCount > 0) return;
        if (this.renderTimeout) {
            clearTimeout(this.renderTimeout);
        }
        this.renderTimeout = setTimeout(() => {
            this.renderTimeout = null;
            if (this.isRendering) {
                this.pendingRender = true;
                return;
            }
            void this.renderGrid();
        }, delay);
    }

    applyDefaultTagFilter() {
        if (this.hasAppliedDefaultTagFilter) return;
        if (this.selectedTag) {
            this.hasAppliedDefaultTagFilter = true;
            return;
        }
        // @ts-ignore
        const tags: string[] = Object.keys(this.app.metadataCache.getTags() ?? {}).sort();
        if (tags.length === 0) return;
        if (tags.includes(DEFAULT_TAG_FILTER)) {
            this.selectedTag = DEFAULT_TAG_FILTER;
        } else {
            this.selectedTag = tags[0];
        }
        this.hasAppliedDefaultTagFilter = true;
    }

    showRandomFiles() {
        const all = this.app.vault.getMarkdownFiles().filter((f) => !this.isScratchFile(f));
        for (let i = all.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [all[i], all[j]] = [all[j], all[i]];
        }
        this.randomFiles = all.slice(0, RANDOM_FILE_COUNT);
        this.isRandomMode = true;
        this.updateRandomButtonState();
        this.requestRender();
    }

    exitRandomMode() {
        if (!this.isRandomMode) return;
        this.isRandomMode = false;
        this.randomFiles = [];
        this.updateRandomButtonState();
    }

    updateRandomButtonState() {
        if (this.randomButton) {
            this.randomButton.toggleClass('is-active', this.isRandomMode);
        }
    }

    private isSameStringArray(a: string[] | null, b: string[]): boolean {
        if (!a || a.length !== b.length) return false;
        for (let i = 0; i < b.length; i++) {
            if (a[i] !== b[i]) return false;
        }
        return true;
    }

    updateFilterUI() {
        const folders = this.app.vault.getAllLoadedFiles().filter((f): f is TFolder => f instanceof TFolder);
        // @ts-ignore
        const tags: string[] = Object.keys(this.app.metadataCache.getTags()).sort();

        // 一覧の中身が変わったときだけoptionを作り直す（毎renderでのDOM再構築と強制レイアウトを避ける）
        const folderPaths = folders.map((f) => f.path);
        if (!this.isSameStringArray(this.lastFolderPaths, folderPaths) || this.folderSelect.options.length !== folders.length + 1) {
            const currentFolder = this.selectedFolder;
            this.folderSelect.empty();
            this.folderSelect.createEl('option', { value: '', text: 'All folders' });
            folders.forEach(f => {
                if (f.path === '/') return;
                const option = this.folderSelect.createEl('option', { value: f.path, text: f.path });
                if (f.path === currentFolder) option.selected = true;
            });
            this.lastFolderPaths = folderPaths;
            this.lastFolderValue = '\0';
        }

        if (!this.isSameStringArray(this.lastTagList, tags) || this.tagSelect.options.length !== tags.length + 1) {
            const currentTag = this.selectedTag;
            this.tagSelect.empty();
            this.tagSelect.createEl('option', { value: '', text: 'All tags' });
            tags.forEach(t => {
                const option = this.tagSelect.createEl('option', { value: t, text: t });
                if (t === currentTag) option.selected = true;
            });
            this.lastTagList = tags.slice();
            this.lastTagValue = '\0';
        }

        if (this.folderSelect.value !== this.selectedFolder) {
            this.folderSelect.value = this.selectedFolder;
        }
        if (this.lastFolderValue !== this.selectedFolder) {
            this.adjustSelectWidth(this.folderSelect);
            this.lastFolderValue = this.selectedFolder;
        }

        if (this.tagSelect.value !== this.selectedTag) {
            this.tagSelect.value = this.selectedTag;
        }
        if (this.lastTagValue !== this.selectedTag) {
            this.adjustSelectWidth(this.tagSelect);
            this.lastTagValue = this.selectedTag;
        }
    }

    adjustSelectWidth(select: HTMLSelectElement) {
        if (!select || select.options.length === 0) return;
        const selected = select.options[select.selectedIndex];
        if (!selected) return;
        // 同じ表示名なら再計測しない（getBoundingClientRectの強制レイアウトを削減）
        const cacheKey = selected.text;
        if ((select as HTMLSelectElement & { dataset: DOMStringMap }).dataset.lastWidthFor === cacheKey) return;

        const tempSpan = document.createElement('span');
        tempSpan.setCssProps({
            'visibility': 'hidden',
            'position': 'absolute',
            'white-space': 'nowrap',
        });

        const computedStyle = window.getComputedStyle(select);
        tempSpan.setCssProps({
            'font-size': computedStyle.fontSize,
            'font-family': computedStyle.fontFamily,
        });

        tempSpan.innerText = cacheKey;
        document.body.appendChild(tempSpan);

        const textWidth = tempSpan.getBoundingClientRect().width;
        document.body.removeChild(tempSpan);

        select.style.width = `${textWidth + 20}px`;
        (select as HTMLSelectElement & { dataset: DOMStringMap }).dataset.lastWidthFor = cacheKey;
    }
  
    /** フィルタ条件のキー。変わったときだけページネーションをリセットする */
    private getFilterKey(): string {
        return `${this.selectedFolder}\n${this.selectedTag}\n${this.searchQuery}\n${this.isRandomMode ? 'R' : ''}\n${this.canvasSourcePath ?? ''}`;
    }

    /** frontmatterを除いた本文を取り出す（検索・スニペット共通） */
    private stripFrontmatter(content: string, file: TFile): string {
        try {
            const cache = this.app.metadataCache.getFileCache(file);
            if (cache?.frontmatterPosition) {
                return content.substring(cache.frontmatterPosition.end.offset);
            }
        } catch {
            // ignore
        }
        if (content.charCodeAt(0) === 45 && content.startsWith('---')) {
            return content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
        }
        return content;
    }

    private async readCachedWithCache(file: TFile, cache: Map<string, string>): Promise<string> {
        const hit = cache.get(file.path);
        if (hit !== undefined) return hit;
        const content = await this.app.vault.cachedRead(file);
        // メモリ肥大防止のため上限を設ける
        if (cache.size > 500) {
            const first = cache.keys().next();
            if (!first.done) cache.delete(first.value);
        }
        cache.set(file.path, content);
        return content;
    }

    /**
     * 本文検索。basename一致を先に確定させ、残りだけ本文読み＋バッチ処理する。
     * 読み込んだ本文はcontentCacheに残し、カード描画での二重読みを避ける。
     */
    private async filterBySearchQuery(files: TFile[], query: string, contentCache: Map<string, string>): Promise<TFile[]> {
        const matched: TFile[] = [];
        const needContent: TFile[] = [];
        const matchedPaths = new Set<string>();
        for (const f of files) {
            if (f.basename.toLowerCase().includes(query) || f.path.toLowerCase().includes(query)) {
                matched.push(f);
                matchedPaths.add(f.path);
            } else {
                needContent.push(f);
            }
        }
        if (needContent.length === 0) return matched;
        const contentMatched: TFile[] = [];
        for (let i = 0; i < needContent.length; i += SEARCH_CONTENT_BATCH) {
            const slice = needContent.slice(i, i + SEARCH_CONTENT_BATCH);
            const results = await Promise.all(slice.map(async (f) => {
                try {
                    const content = await this.readCachedWithCache(f, contentCache);
                    const body = this.stripFrontmatter(content, f);
                    return body.toLowerCase().includes(query);
                } catch {
                    return false;
                }
            }));
            for (let j = 0; j < slice.length; j++) {
                if (results[j]) contentMatched.push(slice[j]);
            }
            // 大量ファイル時にUIを固めないよう1バッチごとに譲る
            if (i + SEARCH_CONTENT_BATCH < needContent.length) {
                await new Promise((r) => setTimeout(r, 0));
            }
        }
        // mtime順を保つため元の順序で結合し直す
        if (contentMatched.length === 0) return matched;
        const contentSet = new Set(contentMatched.map((f) => f.path));
        const out: TFile[] = [];
        for (const f of files) {
            if (matchedPaths.has(f.path) || contentSet.has(f.path)) out.push(f);
        }
        return out;
    }

    async renderGrid() {
        if (this.isRendering) {
            this.pendingRender = true;
            return;
        }
        this.isRendering = true;

        try {
            this.updateCanvasModeUI();
            if (this.isCanvasMode()) {
                await this.renderCanvasGrid();
                return;
            }
            this.applyDefaultTagFilter();
            this.updateFilterUI();
            this.updateRandomButtonState();

            const filterKey = this.getFilterKey();
            if (filterKey !== this.lastFilterKey) {
                this.renderLimit = RENDER_INITIAL_LIMIT;
                this.lastFilterKey = filterKey;
                // フィルタが変わったら不可視ファイルへの誤操作を防ぐため選択をクリア
                if (this.selectedPaths.size > 0) {
                    this.selectedPaths.clear();
                    this.updateSelectionBar();
                }
            }

            let files: TFile[];
            const contentCache = new Map<string, string>();

            if (this.isRandomMode) {
                const allMarkdown = this.app.vault.getMarkdownFiles();
                const existingPaths = new Set(allMarkdown.map(f => f.path));
                files = this.randomFiles.filter(f => existingPaths.has(f.path) && !this.isScratchFile(f));
            } else {
                let filtered = this.app.vault.getMarkdownFiles().filter((f) => !this.isScratchFile(f));

                if (this.selectedFolder) {
                    const prefix = this.selectedFolder + '/';
                    filtered = filtered.filter(f => f.parent?.path === this.selectedFolder || f.parent?.path.startsWith(prefix));
                }

                if (this.selectedTag) {
                    const tag = this.selectedTag;
                    filtered = filtered.filter(f => {
                        const cache = this.app.metadataCache.getFileCache(f);
                        const tags = cache ? getAllTags(cache) || [] : [];
                        return tags.includes(tag);
                    });
                }

                if (this.searchQuery) {
                    const query = this.searchQuery.toLowerCase();
                    filtered = await this.filterBySearchQuery(filtered, query, contentCache);
                }

                files = filtered;
            }

            files.sort((a, b) => b.stat.mtime - a.stat.mtime);

            const pinnedFiles: TFile[] = [];
            const unpinnedFiles: TFile[] = [];

            for (const file of files) {
                const cache = this.app.metadataCache.getFileCache(file);
                const isPinned = cache?.frontmatter?.pinned === true;
                if (isPinned) pinnedFiles.push(file);
                else unpinnedFiles.push(file);
            }

            this.displayPinned = pinnedFiles;
            this.displayUnpinned = unpinnedFiles;
            this.displayContentCache = contentCache;

            this.disconnectMoreObserver();
            this.gridContainer.empty();
            this.unpinnedGridEl = null;
            this.moreSentinelEl = null;

            if (pinnedFiles.length > 0) {
                this.gridContainer.createEl('h3', { text: 'Pinned', cls: 'keep-section-title' });
                const pinnedGrid = this.gridContainer.createEl('div', { cls: 'keep-grid' });
                await this.renderCards(pinnedFiles, pinnedGrid, contentCache);

                if (unpinnedFiles.length > 0) {
                    this.gridContainer.createEl('h3', { text: 'Others', cls: 'keep-section-title keep-section-title-others' });
                }
            }

            const unpinnedGrid = this.gridContainer.createEl('div', { cls: 'keep-grid' });
            this.unpinnedGridEl = unpinnedGrid;
            const visible = unpinnedFiles.slice(0, Math.max(0, this.renderLimit - pinnedFiles.length));
            await this.renderCards(visible, unpinnedGrid, contentCache);
            this.setupMoreUI(unpinnedFiles.length, visible.length);
            // 削除・リネームで消えたパスを掃除
            if (this.selectedPaths.size > 0) {
                const alive = new Set(files.map((f) => f.path));
                let changed = false;
                for (const p of Array.from(this.selectedPaths)) {
                    if (!alive.has(p)) {
                        this.selectedPaths.delete(p);
                        changed = true;
                    }
                }
                if (changed) this.syncSelectionCards();
            }
            this.updateSelectionBar();

        } finally {
            this.isRendering = false;
            if (this.pendingRender) {
                this.pendingRender = false;
                this.requestRender(100);
            }
        }
    }

    private disconnectMoreObserver() {
        if (this.moreObserver) {
            try { this.moreObserver.disconnect(); } catch { /* ignore */ }
            this.moreObserver = null;
        }
    }

    /** 残り件数表示＋自動追加（IntersectionObserver）で初回描画を軽く保つ */
    private setupMoreUI(total: number, rendered: number) {
        const rest = total - rendered;
        if (rest <= 0) return;
        const moreWrap = this.gridContainer.createEl('div', { cls: 'keep-more-wrap' });
        const btn = moreWrap.createEl('button', {
            cls: 'keep-more-button',
            text: `さらに表示 (${rendered}/${total})`,
        });
        btn.addEventListener('click', () => void this.renderMore());
        this.moreSentinelEl = moreWrap;
        try {
            this.moreObserver = new IntersectionObserver((entries) => {
                for (const e of entries) {
                    if (e.isIntersecting) {
                        void this.renderMore();
                        break;
                    }
                }
            }, { rootMargin: '600px' });
            this.moreObserver.observe(moreWrap);
        } catch {
            // Observer非対応環境ではボタンクリックのみ
        }
    }

    private async renderMore() {
        if (this.isRendering) return;
        if (!this.unpinnedGridEl || !this.moreSentinelEl) return;
        const total = this.displayUnpinned.length;
        const rendered = this.unpinnedGridEl.children.length;
        if (rendered >= total) {
            this.moreSentinelEl.remove();
            this.moreSentinelEl = null;
            this.disconnectMoreObserver();
            return;
        }
        this.isRendering = true;
        try {
            this.renderLimit += RENDER_MORE_STEP;
            const next = this.displayUnpinned.slice(rendered, rendered + RENDER_MORE_STEP);
            await this.renderCards(next, this.unpinnedGridEl, this.displayContentCache);
            const now = this.unpinnedGridEl.children.length;
            if (now >= total) {
                this.moreSentinelEl.remove();
                this.moreSentinelEl = null;
                this.disconnectMoreObserver();
            } else {
                const btn = this.moreSentinelEl.querySelector('.keep-more-button') as HTMLElement | null;
                if (btn) btn.setText(`さらに表示 (${now}/${total})`);
            }
        } finally {
            this.isRendering = false;
            if (this.pendingRender) {
                this.pendingRender = false;
                this.requestRender(100);
            }
        }
    }

    /** canvasモード専用: そのcanvas内のfile/textノードを配置順で表示し、検索バーで絞り込む */
    private async renderCanvasGrid() {
        this.gridContainer.empty();
        const canvasFile = this.getCanvasSourceFile();
        if (!canvasFile || canvasFile.extension !== 'canvas') {
            this.gridContainer.createEl('div', {
                text: this.canvasSourcePath
                    ? `Canvas not found: ${this.canvasSourcePath}`
                    : 'No canvas selected.',
                cls: 'keep-empty-message',
            });
            return;
        }
        let items = await this.loadCanvasGridItems(canvasFile);
        const canvasContentCache = new Map<string, string>();

        if (this.searchQuery) {
            const query = this.searchQuery.toLowerCase();
            const out: CanvasGridItem[] = [];
            for (let i = 0; i < items.length; i += SEARCH_CONTENT_BATCH) {
                const slice = items.slice(i, i + SEARCH_CONTENT_BATCH);
                const results = await Promise.all(slice.map((item) => {
                    if (item.kind === 'file') return this.matchesCanvasSearch(item.file, query, canvasContentCache);
                    return Promise.resolve(item.text.toLowerCase().includes(query));
                }));
                for (let j = 0; j < slice.length; j++) {
                    if (results[j]) out.push(slice[j]);
                }
                if (i + SEARCH_CONTENT_BATCH < items.length) {
                    await new Promise((r) => setTimeout(r, 0));
                }
            }
            items = out;
        }

        if (items.length === 0) {
            this.gridContainer.createEl('div', {
                text: 'このキャンバスに表示できるファイルがありません。',
                cls: 'keep-empty-message',
            });
            return;
        }
        const grid = this.gridContainer.createEl('div', { cls: 'keep-grid' });
        await this.renderCanvasCards(items, grid, canvasContentCache);
    }

    private async matchesCanvasSearch(file: TFile, query: string, contentCache?: Map<string, string>): Promise<boolean> {
        if (file.basename.toLowerCase().includes(query)) return true;
        if (file.path.toLowerCase().includes(query)) return true;
        if (!this.isMarkdownFile(file)) return false;
        try {
            const content = contentCache
                ? await this.readCachedWithCache(file, contentCache)
                : await this.app.vault.cachedRead(file);
            const body = this.stripFrontmatter(content, file);
            return body.toLowerCase().includes(query);
        } catch {
            return false;
        }
    }

    /** canvasモード専用の混在グリッド描画（配置順）。fileは既存カード、textはタイトルなし＋その場編集 */
    private async renderCanvasCards(items: CanvasGridItem[], container: HTMLElement, contentCache?: Map<string, string>) {
        const filesOnly = items.every((i) => i.kind === 'file');
        if (filesOnly) {
            await this.renderCards(items.map((i) => (i as CanvasFileItem).file), container, contentCache);
            return;
        }
        const cache = contentCache ?? new Map<string, string>();
        const fragment = document.createDocumentFragment();
        let sinceYield = 0;
        for (const item of items) {
            if (item.kind === 'file') {
                await this.buildCanvasFileCard(item.file, fragment, cache);
            } else {
                this.buildCanvasTextCard(item, fragment);
            }
            if (++sinceYield >= RENDER_YIELD_EVERY) {
                container.appendChild(fragment);
                await new Promise((r) => setTimeout(r, 0));
                sinceYield = 0;
            }
        }
        if (fragment.childNodes.length > 0) container.appendChild(fragment);
    }

    /** canvasモードのファイルカード1件分（renderCardsのcanvas分岐と同等。split残存／pin・menu・DnDなし） */
    private async buildCanvasFileCard(file: TFile, fragment: DocumentFragment, contentCache?: Map<string, string>) {
        const isMd = this.isMarkdownFile(file);
        let contentWithoutFrontmatter = '';
        if (isMd) {
            try {
                const content = contentCache
                    ? await this.readCachedWithCache(file, contentCache)
                    : await this.app.vault.cachedRead(file);
                contentWithoutFrontmatter = this.stripFrontmatter(content, file).trim();
            } catch {
                contentWithoutFrontmatter = '';
            }
        }
        const images: string[] = [];
        let match;
        if (isMd) {
            const imageRegex = /!\[.*?\]\((.*?)\)|!\[\[(.*?)\]\]/g;
            while ((match = imageRegex.exec(contentWithoutFrontmatter)) !== null && images.length < 2) {
                const url = match[1] || match[2];
                if (url) images.push(url);
            }
        }
        const resolvedImages = images.map((img) => {
            if (img.startsWith('http://') || img.startsWith('https://') || img.startsWith('app://') || img.startsWith('data:')) {
                return img;
            }
            const linkedFile = this.app.metadataCache.getFirstLinkpathDest(img, file.path);
            if (linkedFile) return this.app.vault.getResourcePath(linkedFile);
            return null;
        }).filter((img): img is string => img !== null);
        if (!isMd && this.isImageFile(file)) {
            try {
                resolvedImages.unshift(this.app.vault.getResourcePath(file));
            } catch {
                // ignore
            }
        }
        const snippetText = isMd
            ? contentWithoutFrontmatter.replace(/!\[.*?\]\(.*?\)|!\[\[.*?\]\]/g, '').trim()
            : `${file.extension.toUpperCase()} • ${file.path}`;
        const snippet = isMd
            ? snippetText.substring(0, 250) + (snippetText.length > 250 ? '...' : '')
            : snippetText;

        const card = fragment.createEl('div', { cls: 'keep-card' });
        card.draggable = false;
        if (resolvedImages.length > 0) {
            const imgContainer = card.createEl('div', { cls: `keep-card-images keep-card-images-${Math.min(resolvedImages.length, 2)}` });
            resolvedImages.slice(0, 2).forEach((img) => {
                const imgEl = imgContainer.createEl('img', { attr: { src: img } });
                imgEl.draggable = false;
            });
        }
        const splitBtn = card.createEl('button', {
            cls: 'keep-split-btn',
            attr: { 'aria-label': 'Open in split view' },
        });
        setIcon(splitBtn, 'panel-right');
        const splitSvg = splitBtn.querySelector('svg');
        if (splitSvg) {
            splitSvg.setAttribute('fill', 'none');
            splitSvg.setAttribute('stroke', 'currentColor');
        }
        splitBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const leaf = this.app.workspace.getLeaf('split');
            void leaf.openFile(file);
        });
        if (file.basename) {
            card.createEl('h3', { text: file.basename, cls: 'keep-card-title' });
        }
        if (snippet) {
            card.createEl('div', { text: snippet, cls: 'keep-card-snippet' });
        }
        card.addEventListener('click', (e: MouseEvent) => {
            if (e.metaKey || e.ctrlKey) {
                e.preventDefault();
                e.stopPropagation();
                void this.focusCanvasNode(file);
                return;
            }
            if (isMd) {
                this.openNoteModal(file);
            } else {
                const leaf = this.app.workspace.getLeaf('tab');
                void leaf.openFile(file);
            }
        });
    }

    /** テキストカード1件分。タイトルなし・全文スニペットのみ。通常クリックで大モーダル編集、Cmd+クリックでフォーカス */
    private buildCanvasTextCard(item: CanvasTextItem, fragment: DocumentFragment) {
        const card = fragment.createEl('div', { cls: 'keep-card keep-text-card' });
        card.draggable = false;
        card.setAttr('data-canvas-node-id', item.nodeId);
        const body = item.text.trim();
        const snippet = body.length > 250 ? body.substring(0, 250) + '...' : body;
        card.createEl('div', {
            text: snippet || '(空のテキストカード)',
            cls: 'keep-card-snippet keep-text-snippet',
        });
        card.addEventListener('click', (e: MouseEvent) => {
            if (e.metaKey || e.ctrlKey) {
                e.preventDefault();
                e.stopPropagation();
                void this.focusCanvasNodeById(item.nodeId);
                return;
            }
            void this.openCanvasTextModal(item);
        });
    }

    private getScratchFolder(): string {
        if (this.normalizedScratchSource !== this.scratchFolder) {
            this.normalizedScratchCache = normalizeScratchFolder(this.scratchFolder);
            this.normalizedScratchSource = this.scratchFolder;
        }
        return this.normalizedScratchCache;
    }

    /**
     * 新規作成ボタンの実効的な作成先フォルダを返す。
     * フォルダで絞り込み中はそのフォルダを優先し、未絞り込み(All folders)のときだけ
     * 設定の既定フォルダを使う。空文字はVault直下を意味する。
     */
    getEffectiveNewFileFolder(): string {
        if (this.selectedFolder) return this.selectedFolder;
        return normalizeNewFileFolder(this.newFileFolder);
    }

    private isScratchFile(f: TFile): boolean {
        // 旧形式の残骸が別フォルダにあってもカード一覧に紛れ込ませない
        if (f.name.endsWith('.masonry-scratch.md')) return true;
        const folder = this.getScratchFolder();
        return folder ? f.path === folder || f.path.startsWith(folder + '/') : false;
    }

    private async ensureScratchFolder(folder: string): Promise<void> {
        if (!folder) return;
        const existing = this.app.vault.getAbstractFileByPath(folder);
        if (existing) {
            if (existing instanceof TFolder) return;
            throw new Error(`Scratch folder path is occupied by a file: ${folder}`);
        }
        await this.app.vault.createFolder(folder);
    }

    private getSharedScratchPath(): string {
        const folder = this.getScratchFolder();
        return folder ? `${folder}/${KeepView.SHARED_SCRATCH_NAME}` : KeepView.SHARED_SCRATCH_NAME;
    }

    /**
     * 全canvas共有の使い回しスクラッチファイルを取得する。なければ作成する。
     * 毎回の作成・削除は行わない。canvas名を含めない単一ファイルにすることで、
     * canvasリネームのたびに別ファイルが増殖する問題を防ぐ。
     * 編集はモーダル排他のため共有でも競合しない（残存セッションはflushで先に書き戻す）。
     */
    private async getScratchFile(): Promise<TFile> {
        const folder = this.getScratchFolder();
        await this.ensureScratchFolder(folder);
        const path = this.getSharedScratchPath();
        const existing = this.app.vault.getAbstractFileByPath(path);
        if (existing instanceof TFile) return existing;
        if (existing) {
            throw new Error(`Scratch file path is occupied: ${path}`);
        }
        return await this.app.vault.create(path, '');
    }

    /**
     * 旧形式（`<canvas名>.masonry-scratch.md`）の残骸をゴミ箱に移動する。
     * canvasリネームのたびに増殖した分を回収する。セッション中1回だけ実行。
     */
    private async cleanupLegacyScratchFiles(): Promise<void> {
        if (KeepView.legacyScratchCleaned) return;
        KeepView.legacyScratchCleaned = true;
        try {
            const stale = this.app.vault.getFiles().filter((f) =>
                f.name.endsWith('.masonry-scratch.md') && f.name !== KeepView.SHARED_SCRATCH_NAME);
            for (const f of stale) {
                try {
                    await this.app.fileManager.trashFile(f);
                } catch (e) {
                    console.warn('Cleanup legacy scratch failed', f.path, e);
                }
            }
            if (stale.length > 0) {
                new Notice(`古いスクラッチファイル${stale.length}件をゴミ箱に移動しました`);
            }
        } catch (e) {
            console.warn('Cleanup legacy scratch failed', e);
        }
    }

    /**
     * テキストノードを通常ファイルと同じ大モーダルで編集する。
     * スクラッチに本文を流し込んでNoteEditModalで開き、close時にcanvasへ書き戻す。
     */
    async openCanvasTextModal(item: CanvasTextItem): Promise<void> {
        try {
            const canvasFile = this.getCanvasSourceFile();
            if (!canvasFile) {
                new Notice('Canvasが見つかりません');
                return;
            }
            await this.flushActiveTextSession();
            const scratch = await this.getScratchFile();
            let current = '';
            try {
                current = await this.app.vault.read(scratch);
            } catch {
                current = '';
            }
            if (current !== item.text) {
                await this.app.vault.modify(scratch, item.text);
            }
            const baseText = item.text;
            this.activeTextSession = { canvasPath: canvasFile.path, nodeId: item.nodeId, baseText };
            // 書き戻し側(onTextModalClose)のfinallyで再描画するため、ここではrenderOnCloseを抑える
            this.openNoteModal(scratch, {
                hideTitle: true,
                renderOnClose: false,
                onClosed: () => {
                    void this.onTextModalClose(canvasFile, item.nodeId, baseText);
                },
            });
        } catch (e) {
            console.error('Open canvas text modal failed', e);
            new Notice('テキストの編集を開けませんでした');
        }
    }

    /** モーダルclose時の書き戻し。エディタの自動保存を待ってからスクラッチ→canvasへ反映する */
    private async onTextModalClose(canvasFile: TFile, nodeId: string, baseText: string): Promise<void> {
        try {
            // エディタの自動保存フラッシュを待つ
            await new Promise((r) => window.setTimeout(r, 300));
            const scratch = this.app.vault.getAbstractFileByPath(this.getSharedScratchPath());
            if (scratch instanceof TFile) {
                let scratchText = '';
                try {
                    scratchText = await this.app.vault.read(scratch);
                } catch {
                    scratchText = '';
                }
                await this.writeScratchBackToNode(canvasFile, nodeId, baseText, scratchText);
            }
        } catch (e) {
            console.error('Save canvas text from modal failed', e);
            new Notice('テキストカードの更新に失敗しました');
        } finally {
            if (this.activeTextSession?.nodeId === nodeId) {
                this.activeTextSession = null;
            }
            this.requestRender();
        }
    }

    /** スクラッチ内容をcanvasノードへ書き戻す。canvas側でも変わっていれば上書き＋通知する */
    private async writeScratchBackToNode(canvasFile: TFile, nodeId: string, baseText: string, scratchText: string): Promise<boolean> {
        const raw = await this.app.vault.read(canvasFile);
        const data = JSON.parse(raw) as { nodes?: Array<{ id?: unknown; type?: unknown; text?: unknown }> };
        if (!data || !Array.isArray(data.nodes)) return false;
        const node = data.nodes.find((n) => n && n.id === nodeId && n.type === 'text');
        if (!node || typeof node.text !== 'string') return false;
        if (node.text === scratchText) return true;
        if (node.text !== baseText) {
            new Notice('Canvas側でも変更がありました。上書きしました');
        }
        node.text = scratchText;
        await this.app.vault.modify(canvasFile, JSON.stringify(data, null, 2));
        return true;
    }

    /** 残存セッションがあれば書き戻す（モーダル排他のため通常は空のはずだが安全のため） */
    private async flushActiveTextSession(): Promise<void> {
        const session = this.activeTextSession;
        if (!session) return;
        try {
            const canvasFile = this.app.vault.getAbstractFileByPath(session.canvasPath);
            if (!(canvasFile instanceof TFile)) {
                this.activeTextSession = null;
                return;
            }
            const scratch = this.app.vault.getAbstractFileByPath(this.getSharedScratchPath());
            if (scratch instanceof TFile) {
                const scratchText = await this.app.vault.read(scratch);
                await this.writeScratchBackToNode(canvasFile, session.nodeId, session.baseText, scratchText);
            }
        } catch (e) {
            console.error('Flush text session failed', e);
        } finally {
            this.activeTextSession = null;
        }
    }

    /** ノードID指定でキャンバス上のテキストカードへフォーカスする（単一ノード想定） */
    async focusCanvasNodeById(nodeId: string): Promise<void> {
        try {
            const canvasPath = this.canvasSourcePath;
            if (!canvasPath) return;
            const canvasFile = this.app.vault.getAbstractFileByPath(canvasPath);
            if (!(canvasFile instanceof TFile)) {
                new Notice(`Canvas not found: ${canvasPath}`);
                return;
            }
            const leaf = await this.ensureCanvasLeafOpen(canvasFile);
            if (!leaf) {
                new Notice('Canvasを開けませんでした');
                return;
            }
            const canvas = await this.waitForCanvasNodes(leaf);
            if (!canvas?.nodes) {
                new Notice('Canvasの読み込みに失敗しました');
                return;
            }
            const node = canvas.nodes.get(nodeId);
            if (!node) {
                new Notice('Canvas上に見つかりません（未保存の可能性があります）');
                return;
            }
            this.applyCanvasFocus(canvas, node);
        } catch (e) {
            console.error('Focus canvas node failed', e);
            new Notice('Canvasへのフォーカスに失敗しました');
        }
    }

    async renderCards(files: TFile[], container: HTMLElement, contentCache?: Map<string, string>) {
        const fragment = document.createDocumentFragment();
        const canvasMode = this.isCanvasMode();
        let sinceYield = 0;
        for (const file of files) {
            const isMd = this.isMarkdownFile(file);
            let contentWithoutFrontmatter = '';
            let cache: ReturnType<App['metadataCache']['getFileCache']> = null;
            if (isMd) {
                try {
                    const content = contentCache
                        ? await this.readCachedWithCache(file, contentCache)
                        : await this.app.vault.cachedRead(file);
                    cache = this.app.metadataCache.getFileCache(file);
                    contentWithoutFrontmatter = this.stripFrontmatter(content, file).trim();
                } catch {
                    contentWithoutFrontmatter = '';
                }
            }

            const images: string[] = [];
            let match;
            if (isMd) {
                const imageRegex = /!\[.*?\]\((.*?)\)|!\[\[(.*?)\]\]/g;
                while ((match = imageRegex.exec(contentWithoutFrontmatter)) !== null && images.length < 2) {
                    const url = match[1] || match[2];
                    if (url) {
                        images.push(url);
                    }
                }
            }

            const resolvedImages = images.map(img => {
                if (img.startsWith('http://') || img.startsWith('https://') || img.startsWith('app://') || img.startsWith('data:')) {
                    return img;
                }
                const linkedFile = this.app.metadataCache.getFirstLinkpathDest(img, file.path);
                if (linkedFile) {
                    return this.app.vault.getResourcePath(linkedFile);
                }
                return null;
            }).filter((img): img is string => img !== null);

            // 非mdの画像ファイル自体はプレビュー表示する
            if (!isMd && this.isImageFile(file)) {
                try {
                    resolvedImages.unshift(this.app.vault.getResourcePath(file));
                } catch {
                    // ignore
                }
            }

            const snippetText = isMd
                ? contentWithoutFrontmatter.replace(/!\[.*?\]\(.*?\)|!\[\[.*?\]\]/g, '').trim()
                : `${file.extension.toUpperCase()} • ${file.path}`;
            const snippet = isMd
                ? snippetText.substring(0, 250) + (snippetText.length > 250 ? '...' : '')
                : snippetText;

            const card = fragment.createEl('div', { cls: 'keep-card' });
            card.setAttr('data-file-path', file.path);
            if (!canvasMode && this.selectedPaths.has(file.path)) {
                card.addClass('is-selected');
            }
            card.draggable = !canvasMode;
            let cardWasDragged = false;
            let dragWasSelected = false;
            if (!canvasMode) {
                card.addEventListener('dragstart', (e: DragEvent) => {
                    cardWasDragged = true;
                    // 選択中のカードなら選択全体をドラッグ対象にする
                    const dragTargets = this.getBulkTargets(file);
                    dragWasSelected = this.selectedPaths.has(file.path);
                    if (dragTargets.length > 1) {
                        try {
                            this.gridContainer?.querySelectorAll('.keep-card.is-selected').forEach((c) => c.addClass('is-dragging'));
                        } catch {
                            card.addClass('is-dragging');
                        }
                    } else {
                        card.addClass('is-dragging');
                    }
                    try {
                        const dm = (this.app as unknown as { dragManager?: {
                            dragFile?: (evt: DragEvent, file: TFile) => unknown;
                            dragFiles?: (evt: DragEvent, files: TFile[]) => unknown;
                            onDragStart?: (evt: DragEvent, info: unknown) => void;
                        } }).dragManager;
                        if (dragTargets.length > 1 && dm?.dragFiles && dm?.onDragStart) {
                            // 複数ファイルドラッグ（エクスプローラの複数選択と同じ扱いでCanvasが複数ノード作成する）
                            const info = dm.dragFiles(e, dragTargets);
                            if (info) dm.onDragStart(e, info);
                        } else if (dm?.dragFile && dm?.onDragStart) {
                            // dragFile()はdataTransferにobsidian://URLを積んだ上で内部用ドラッグ情報を返す。
                            // それをonDragStart()に渡さないとCanvasのhandleDrop受け口が
                            // 内部fileドロップとして認識できず、URLのリンクカードになってしまう。
                            const info = dm.dragFile(e, file);
                            if (info) dm.onDragStart(e, info);
                        } else if (dm?.dragFile) {
                            dm.dragFile(e, file);
                        } else if (e.dataTransfer) {
                            e.dataTransfer.effectAllowed = 'copy';
                            try { e.dataTransfer.setData('text/plain', file.path); } catch { /* ignore */ }
                        }
                    } catch {
                        // 非公開APIが無い/変わってもDnD以外は壊さない
                    }
                });
                card.addEventListener('dragend', (e: DragEvent) => {
                    try {
                        this.gridContainer?.querySelectorAll('.keep-card.is-dragging').forEach((c) => c.removeClass('is-dragging'));
                    } catch {
                        card.removeClass('is-dragging');
                    }
                    // Canvas等へのドロップ成功後は選択を自動解除（キャンセル時は維持）
                    if (dragWasSelected && this.selectedPaths.size > 0) {
                        const dropEffect = e.dataTransfer?.dropEffect;
                        if (!dropEffect || dropEffect !== 'none') {
                            this.clearSelection();
                        }
                    }
                    dragWasSelected = false;
                    window.setTimeout(() => { cardWasDragged = false; }, 150);
                });
            }
            
            if (resolvedImages.length > 0) {
                const imgContainer = card.createEl('div', { cls: `keep-card-images keep-card-images-${Math.min(resolvedImages.length, 2)}` });
                resolvedImages.slice(0, 2).forEach(img => {
                    const imgEl = imgContainer.createEl('img', { attr: { src: img } });
                    imgEl.draggable = false;
                });
            }
            
            const splitBtn = card.createEl('button', {
              cls: 'keep-split-btn',
              attr: { 'aria-label': 'Open in split view' }
            });
            setIcon(splitBtn, 'panel-right');
            
            const splitSvg = splitBtn.querySelector('svg');
            if (splitSvg) {
                splitSvg.setAttribute('fill', 'none');
                splitSvg.setAttribute('stroke', 'currentColor');
            }
            
            splitBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const leaf = this.app.workspace.getLeaf('split');
                void leaf.openFile(file);
            });

            if (!canvasMode) {
                const selectBtn = card.createEl('button', {
                    cls: 'keep-select-checkbox' + (this.selectedPaths.has(file.path) ? ' is-checked' : ''),
                    attr: { 'aria-label': 'Select card' },
                });
                setIcon(selectBtn, 'check');
                selectBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    this.toggleSelection(file, card);
                });
                const pinBtn = card.createEl('button', { cls: 'keep-pin-btn' });
                setIcon(pinBtn, 'pin');

                const svg = pinBtn.querySelector('svg');
                if (svg) {
                    svg.setAttribute('fill', 'none');
                    svg.setAttribute('stroke', 'currentColor');
                }

                const isPinned = cache?.frontmatter?.pinned === true;

                if (isPinned) {
                    pinBtn.addClass('is-pinned');
                    if (svg) {
                        svg.setAttribute('fill', 'currentColor');
                    }
                }

                pinBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    void this.app.fileManager.processFrontMatter(file, (fm) => {
                        fm.pinned = !isPinned;
                    });
                });

                const menuBtn = card.createEl('button', {
                    cls: 'keep-menu-btn',
                    attr: { 'aria-label': 'Card menu' }
                });
                setIcon(menuBtn, 'more-horizontal');

                const menuSvg = menuBtn.querySelector('svg');
                if (menuSvg) {
                    menuSvg.setAttribute('fill', 'none');
                    menuSvg.setAttribute('stroke', 'currentColor');
                }

                menuBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const menu = new Menu();
                    menu.addItem((item) => {
                        item.setTitle('Edit tags')
                            .setIcon('tag')
                            .onClick(() => this.openTagEditor([file]));
                    });
                    menu.addItem((item) => {
                        item.setTitle('Delete')
                            .setIcon('trash')
                            .onClick(() => {
                                void this.app.fileManager.trashFile(file).then(() => {
                                    this.requestRender();
                                });
                            });
                    });
                    menu.showAtMouseEvent(e);
                });
            }

            if (file.basename) {
                card.createEl('h3', { text: file.basename, cls: 'keep-card-title' });
            }
            
            if (snippet) {
                card.createEl('div', { text: snippet, cls: 'keep-card-snippet' });
            }

            // 通常モードのみ：frontmatterタグを小さなチップで表示（最大5件＋残件数）
            if (!canvasMode) {
                const fmTags = this.getFrontmatterTagList(file);
                if (fmTags.length > 0) {
                    const chipsEl = card.createEl('div', { cls: 'keep-tag-chips' });
                    const CHIP_MAX = 5;
                    fmTags.slice(0, CHIP_MAX).forEach((t) => {
                        const chip = chipsEl.createEl('button', {
                            cls: 'keep-tag-chip',
                            text: `#${t}`,
                            attr: { title: `Filter by #${t}` },
                        });
                        chip.addEventListener('click', (e) => {
                            e.stopPropagation();
                            this.selectedTag = `#${t}`;
                            this.exitRandomMode();
                            this.requestRender(0);
                        });
                    });
                    if (fmTags.length > CHIP_MAX) {
                        chipsEl.createEl('span', {
                            cls: 'keep-tag-chip keep-tag-chip-more',
                            text: `+${fmTags.length - CHIP_MAX}`,
                        });
                    }
                }
            }

            card.addEventListener('click', (e: MouseEvent) => {
                if (cardWasDragged) {
                    cardWasDragged = false;
                    return;
                }
                if (!canvasMode && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    e.stopPropagation();
                    this.toggleSelection(file, card);
                    return;
                }
                if (canvasMode && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    e.stopPropagation();
                    void this.focusCanvasNode(file);
                    return;
                }
                if (isMd) {
                    this.openNoteModal(file);
                } else {
                    const leaf = this.app.workspace.getLeaf('tab');
                    void leaf.openFile(file);
                }
            });

            if (!canvasMode) {
                card.addEventListener('contextmenu', (e: MouseEvent) => {
                    e.preventDefault();
                    e.stopPropagation();
                    const targets = this.getBulkTargets(file);
                    const menu = new Menu();
                    if (targets.length > 1) {
                        menu.addItem((item) => {
                            item.setTitle(`Send ${targets.length} to Canvas`)
                                .setIcon('layout-dashboard')
                                .onClick(() => void this.sendFilesToCanvas(targets));
                        });
                        menu.addItem((item) => {
                            item.setTitle(`Send ${targets.length} to new Canvas`)
                                .setIcon('plus')
                                .onClick(() => void this.createCanvasAndAddMultiple(targets));
                        });
                        menu.addItem((item) => {
                            item.setTitle(`Edit tags for ${targets.length}`)
                                .setIcon('tag')
                                .onClick(() => this.openTagEditor(targets));
                        });
                        menu.addSeparator();
                        menu.addItem((item) => {
                            item.setTitle(`Delete ${targets.length}`)
                                .setIcon('trash')
                                .onClick(() => void this.deleteFilesWithConfirm(targets));
                        });
                        menu.addSeparator();
                        menu.addItem((item) => {
                            item.setTitle('Clear selection')
                                .setIcon('x')
                                .onClick(() => this.clearSelection());
                        });
                    } else {
                        menu.addItem((item) => {
                            item.setTitle('Send to Canvas')
                                .setIcon('layout-dashboard')
                                .onClick(() => void this.sendFileToCanvas(file));
                        });
                        menu.addItem((item) => {
                            item.setTitle('Send to new Canvas')
                                .setIcon('plus')
                                .onClick(() => void this.createCanvasAndAdd(file));
                        });
                        menu.addItem((item) => {
                            item.setTitle('Edit tags')
                                .setIcon('tag')
                                .onClick(() => this.openTagEditor([file]));
                        });
                        menu.addSeparator();
                        menu.addItem((item) => {
                            item.setTitle('Delete')
                                .setIcon('trash')
                                .onClick(() => {
                                    void this.app.fileManager.trashFile(file).then(() => {
                                        this.requestRender();
                                    });
                                });
                        });
                    }
                    menu.showAtMouseEvent(e);
                });
            }
            // 大量カード時にUIスレッドを占有しないよう、一定件数ごとにDOM反映＋譲る
            if (++sinceYield >= RENDER_YIELD_EVERY) {
                container.appendChild(fragment);
                await new Promise((r) => setTimeout(r, 0));
                sinceYield = 0;
            }
        }
        if (fragment.childNodes.length > 0) container.appendChild(fragment);
    }

    private isImageFile(file: TFile): boolean {
        return ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif'].includes(file.extension.toLowerCase());
    }

    /**
     * Cmd/Ctrl+クリックでキャンバス上の該当ノードへフォーカスする。
     * 同一ファイルの複数ノードは1件ずつサイクルし、canvasが閉じていれば開き直す。
     */
    async focusCanvasNode(file: TFile): Promise<void> {
        try {
            const canvasPath = this.canvasSourcePath;
            if (!canvasPath) return;
            const canvasFile = this.app.vault.getAbstractFileByPath(canvasPath);
            if (!(canvasFile instanceof TFile)) {
                new Notice(`Canvas not found: ${canvasPath}`);
                return;
            }
            const leaf = await this.ensureCanvasLeafOpen(canvasFile);
            if (!leaf) {
                new Notice('Canvasを開けませんでした');
                return;
            }
            const canvas = await this.waitForCanvasNodes(leaf);
            if (!canvas) {
                new Notice('Canvasの読み込みに失敗しました');
                return;
            }
            const matches = this.findCanvasNodesForFile(canvas, file);
            if (matches.length === 0) {
                new Notice('Canvas上に見つかりません（未保存の可能性があります）');
                return;
            }
            const prev = this.canvasFocusCycle[file.path] ?? -1;
            const next = (prev + 1) % matches.length;
            this.canvasFocusCycle[file.path] = next;
            const node = matches[next];
            this.applyCanvasFocus(canvas, node);
        } catch (e) {
            console.error('Focus canvas node failed', e);
            new Notice('Canvasへのフォーカスに失敗しました');
        }
    }

    private applyCanvasFocus(canvas: { nodes?: Map<string, unknown> }, node: unknown) {
        const c = canvas as unknown as {
            deselectAll?: () => void;
            select?: (n: unknown) => void;
            selectOnly?: (n: unknown) => void;
            zoomToSelection?: () => void;
            zoomToBbox?: (bbox: unknown) => void;
        };
        const n = node as { focus?: () => void; x?: number; y?: number; width?: number; height?: number };
        try {
            if (typeof c.deselectAll === 'function') c.deselectAll();
            if (typeof c.selectOnly === 'function') c.selectOnly(node);
            else if (typeof c.select === 'function') c.select(node);
            if (typeof n.focus === 'function') {
                try { n.focus(); } catch { /* ignore */ }
            }
            if (typeof c.zoomToSelection === 'function') {
                c.zoomToSelection();
            } else if (typeof c.zoomToBbox === 'function') {
                if (typeof n.x === 'number' && typeof n.y === 'number') {
                    const w = typeof n.width === 'number' ? n.width : 400;
                    const h = typeof n.height === 'number' ? n.height : 300;
                    c.zoomToBbox({ minX: n.x - w * 0.5, minY: n.y - h * 0.5, maxX: n.x + w * 1.5, maxY: n.y + h * 1.5 });
                }
            }
        } catch (e) {
            console.error('Focus canvas node failed', e);
            new Notice('Canvasへのフォーカスに失敗しました');
        }
    }

    private async ensureCanvasLeafOpen(canvasFile: TFile): Promise<WorkspaceLeaf | null> {
        try {
            const leaves = this.app.workspace.getLeavesOfType('canvas');
            for (const leaf of leaves) {
                try {
                    const f = (leaf.view as unknown as { file?: TFile }).file;
                    if (f?.path === canvasFile.path) {
                        await this.app.workspace.revealLeaf(leaf);
                        return leaf;
                    }
                } catch {
                    // 次のleafを試す
                }
            }
            const leaf = this.app.workspace.getLeaf('tab');
            await leaf.openFile(canvasFile);
            await this.app.workspace.revealLeaf(leaf);
            return leaf;
        } catch {
            return null;
        }
    }

    private async waitForCanvasNodes(leaf: WorkspaceLeaf, timeoutMs = 3000): Promise<{ nodes?: Map<string, unknown> } | null> {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            try {
                const canvas = (leaf.view as unknown as { canvas?: { nodes?: Map<string, unknown> } }).canvas;
                if (canvas?.nodes && canvas.nodes.size > 0) return canvas;
            } catch {
                // リトライ
            }
            await new Promise((r) => window.setTimeout(r, 100));
        }
        try {
            const canvas = (leaf.view as unknown as { canvas?: { nodes?: Map<string, unknown> } }).canvas;
            return canvas ?? null;
        } catch {
            return null;
        }
    }

    private findCanvasNodesForFile(canvas: { nodes?: Map<string, unknown> }, file: TFile): unknown[] {
        const out: unknown[] = [];
        try {
            const nodes = canvas.nodes;
            if (!nodes || typeof nodes.values !== 'function') return out;
            for (const n of nodes.values()) {
                const node = n as { type?: unknown; url?: unknown; filePath?: unknown; file?: unknown };
                if (!node) continue;
                if (typeof node.url === 'string' && node.url) continue;
                const fp = typeof node.filePath === 'string' ? node.filePath : null;
                const nf = node.file as TFile | string | undefined;
                const resolved = nf instanceof TFile ? nf.path : (typeof nf === 'string' ? nf : fp);
                if (resolved === file.path) {
                    out.push(node);
                    continue;
                }
                // linkpath解決のフォールバック
                if (fp) {
                    try {
                        const dest = this.app.metadataCache.getFirstLinkpathDest(fp, this.canvasSourcePath ?? '');
                        if (dest instanceof TFile && dest.path === file.path) out.push(node);
                    } catch {
                        // ignore
                    }
                }
            }
        } catch {
            // ignore
        }
        return out;
    }

    getCanvasFiles(): TFile[] {
        return this.app.vault.getFiles().filter((f) => f.extension === 'canvas');
    }

    private generateCanvasNodeId(): string {
        try {
            const buf = new Uint8Array(8);
            crypto.getRandomValues(buf);
            return Array.from(buf).map((b) => b.toString(16).padStart(2, '0')).join('');
        } catch {
            return Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
        }
    }

    private getCanvasNodeXY(node: Record<string, unknown>): { x: number; y: number; w: number; h: number } {
        const pos = (node.position as { x?: unknown; y?: unknown } | undefined) ?? undefined;
        const x = typeof node.x === 'number' ? node.x : (typeof pos?.x === 'number' ? pos.x : 0);
        const y = typeof node.y === 'number' ? node.y : (typeof pos?.y === 'number' ? pos.y : 0);
        const w = typeof node.width === 'number' ? node.width : 400;
        const h = typeof node.height === 'number' ? node.height : 300;
        return { x, y, w, h };
    }

    private calcCanvasNewPosition(nodes: Record<string, unknown>[]): { x: number; y: number } {
        if (!nodes || nodes.length === 0) return { x: 0, y: 0 };
        let maxRight = Number.NEGATIVE_INFINITY;
        let yForNew = 0;
        let hasValid = false;
        for (const n of nodes) {
            const { x, y, w } = this.getCanvasNodeXY(n);
            if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
            hasValid = true;
            const right = x + (Number.isFinite(w) ? w : 400);
            if (right > maxRight) {
                maxRight = right;
                yForNew = y;
            }
        }
        if (!hasValid) return { x: 0, y: 0 };
        // 右端にカスケード配置。50pxずらしで重なり回避しつつ、縦にも少しずらす
        const offset = (nodes.length % 8) * 40;
        return { x: maxRight + 50, y: yForNew + offset };
    }

    private getActiveCanvasFile(): TFile | null {
        try {
            const activeLeaf = this.app.workspace.activeLeaf;
            if (!activeLeaf) return null;
            const canvasLeaves = this.app.workspace.getLeavesOfType('canvas');
            if (!canvasLeaves.includes(activeLeaf)) return null;
            const f = (activeLeaf.view as unknown as { file?: TFile }).file;
            if (f instanceof TFile && f.extension === 'canvas') return f;
        } catch {
            // ignore
        }
        return null;
    }

    private pickCanvasFile(files: TFile[]): Promise<TFile | null> {
        return new Promise((resolve) => {
            const modal = new CanvasPickerModal(this.app, files, (f) => resolve(f));
            modal.open();
        });
    }

    async sendFileToCanvas(file: TFile): Promise<void> {
        await this.sendFilesToCanvas([file]);
    }

    /** 選択バー用：選択中ファイルを既存Canvasへ一括送信 */
    async sendSelectedToCanvas(): Promise<void> {
        const files = this.getSelectedFiles();
        if (files.length === 0) {
            new Notice('選択中のファイルがありません');
            return;
        }
        await this.sendFilesToCanvas(files);
    }

    /** 選択バー用：選択中ファイルで新規Canvasを1つ作る */
    async createCanvasFromSelected(): Promise<void> {
        const files = this.getSelectedFiles();
        if (files.length === 0) {
            new Notice('選択中のファイルがありません');
            return;
        }
        await this.createCanvasAndAddMultiple(files);
    }

    async sendFilesToCanvas(files: TFile[]): Promise<void> {
        const targets = files.filter((f): f is TFile => f instanceof TFile);
        if (targets.length === 0) return;
        try {
            const canvasFiles = this.getCanvasFiles();
            if (canvasFiles.length === 0) {
                await this.createCanvasAndAddMultiple(targets);
                return;
            }
            const active = this.getActiveCanvasFile();
            if (active && canvasFiles.some((f) => f.path === active.path)) {
                await this.addFilesToCanvas(active, targets);
                return;
            }
            if (canvasFiles.length === 1) {
                await this.addFilesToCanvas(canvasFiles[0], targets);
                return;
            }
            const picked = await this.pickCanvasFile(canvasFiles);
            if (!picked) return;
            await this.addFilesToCanvas(picked, targets);
        } catch (e) {
            console.error('Send to Canvas failed', e);
            new Notice('Canvasへの送信に失敗しました');
        }
    }

    async createCanvasAndAdd(file: TFile): Promise<void> {
        await this.createCanvasAndAddMultiple([file]);
    }

    async createCanvasAndAddMultiple(files: TFile[]): Promise<void> {
        const targets = files.filter((f): f is TFile => f instanceof TFile);
        if (targets.length === 0) return;
        const baseName = 'Untitled Canvas';
        const folder = this.selectedFolder ? `${this.selectedFolder}/` : '';
        let path = `${folder}${baseName}.canvas`;
        let counter = 1;
        while (this.app.vault.getAbstractFileByPath(path)) {
            path = `${folder}${baseName} ${counter}.canvas`;
            counter++;
        }
        const canvasFile = await this.app.vault.create(path, JSON.stringify({ nodes: [], edges: [] }, null, 2));
        await this.addFilesToCanvas(canvasFile, targets);
    }

    /** 選択バー／右クリック用：件数確認つきでまとめてゴミ箱へ */
    async deleteSelectedWithConfirm(): Promise<void> {
        const files = this.getSelectedFiles();
        await this.deleteFilesWithConfirm(files);
    }

    async deleteFilesWithConfirm(files: TFile[]): Promise<void> {
        const targets = files.filter((f): f is TFile => f instanceof TFile);
        if (targets.length === 0) return;
        if (targets.length === 1) {
            const single = targets[0];
            const ok = await new ConfirmDeleteModal(this.app, [single]).awaitChoice();
            if (!ok) return;
        } else {
            const ok = await new ConfirmDeleteModal(this.app, targets).awaitChoice();
            if (!ok) return;
        }
        let failed = 0;
        for (const f of targets) {
            try {
                await this.app.fileManager.trashFile(f);
                this.selectedPaths.delete(f.path);
            } catch (e) {
                console.warn('Trash failed', f.path, e);
                failed++;
            }
        }
        this.syncSelectionCards();
        this.updateSelectionBar();
        this.requestRender();
        if (failed > 0) {
            new Notice(`${targets.length - failed}/${targets.length}件をゴミ箱に移動しました（${failed}件失敗）`);
        } else if (targets.length > 1) {
            new Notice(`${targets.length}件をゴミ箱に移動しました`);
        }
    }

    /** frontmatterのtags/tagだけを読む（#なし・重複なし・ソート済み）。本文インラインは含めない */
    private getFrontmatterTagList(file: TFile): string[] {
        try {
            const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
            if (!fm) return [];
            const set = new Set<string>();
            for (const t of splitFrontmatterTagValue(fm.tags)) set.add(t);
            for (const t of splitFrontmatterTagValue(fm.tag)) set.add(t);
            return Array.from(set).sort((a, b) => a.localeCompare(b));
        } catch {
            return [];
        }
    }

    /** タグ編集モーダルを開く（Markdownのみ対象。非mdは除外して通知する） */
    openTagEditor(files: TFile[]): void {
        const targets = files.filter((f): f is TFile => f instanceof TFile && f.extension === 'md');
        const skipped = files.length - targets.length;
        if (targets.length === 0) {
            new Notice('タグ編集はMarkdownファイルのみ対象です');
            return;
        }
        if (skipped > 0) {
            new Notice(`${skipped}件の非Markdownファイルは対象外です`);
        }
        let vaultTags: string[] = [];
        try {
            // @ts-ignore - getTagsはバージョンにより公開型に無いが実行時は存在する
            const keys = Object.keys(this.app.metadataCache.getTags() ?? {});
            const set = new Set<string>();
            for (const k of keys) {
                const t = normalizeTagName(k);
                if (t) set.add(t);
            }
            vaultTags = Array.from(set).sort((a, b) => a.localeCompare(b));
        } catch {
            vaultTags = [];
        }
        new TagEditModal(
            this.app,
            targets,
            (f) => this.getFrontmatterTagList(f),
            vaultTags,
            async (toAdd, toRemove) => {
                await this.applyTagChanges(targets, toAdd, toRemove);
            },
        ).open();
    }

    openSelectedTagEditor(): void {
        const files = this.getSelectedFiles();
        if (files.length === 0) {
            new Notice('選択中のファイルがありません');
            return;
        }
        this.openTagEditor(files);
    }

    /** Apply確定時の一括書き込み。ファイルごとに差分だけprocessFrontMatterする */
    private async applyTagChanges(files: TFile[], toAdd: string[], toRemove: string[]): Promise<void> {
        const addSet = new Set(toAdd);
        const removeSet = new Set(toRemove);
        if (addSet.size === 0 && removeSet.size === 0) return;
        for (const f of files) {
            const current = new Set(this.getFrontmatterTagList(f));
            const needsAdd = [...addSet].filter((t) => !current.has(t));
            const needsRemove = [...removeSet].filter((t) => current.has(t));
            if (needsAdd.length === 0 && needsRemove.length === 0) continue;
            try {
                await this.app.fileManager.processFrontMatter(f, (fm) => {
                    const tagsSet = new Set(splitFrontmatterTagValue(fm.tags));
                    const hadSingular = fm.tag !== undefined;
                    const singularSet = new Set(splitFrontmatterTagValue(fm.tag));
                    for (const t of needsRemove) {
                        tagsSet.delete(t);
                        singularSet.delete(t);
                    }
                    for (const t of needsAdd) {
                        if (!singularSet.has(t)) tagsSet.add(t);
                    }
                    fm.tags = Array.from(tagsSet).sort((a, b) => a.localeCompare(b));
                    if (hadSingular) {
                        if (singularSet.size === 0) {
                            delete fm.tag;
                        } else {
                            fm.tag = Array.from(singularSet).sort((a, b) => a.localeCompare(b));
                        }
                    }
                });
            } catch (e) {
                console.warn('Apply tags failed', f.path, e);
            }
        }
        this.requestRender();
    }

    /** 送信先Canvasを開いていればそのタブをアクティブ化し、無ければ新規タブで開く */
    private async revealCanvasFile(canvasFile: TFile): Promise<void> {
        try {
            const leaves = this.app.workspace.getLeavesOfType('canvas');
            for (const leaf of leaves) {
                try {
                    const f = (leaf.view as unknown as { file?: TFile }).file;
                    if (f?.path === canvasFile.path) {
                        await this.app.workspace.revealLeaf(leaf);
                        return;
                    }
                } catch {
                    // 次のleafを試す
                }
            }
            const leaf = this.app.workspace.getLeaf('tab');
            await leaf.openFile(canvasFile);
        } catch {
            // 表示に失敗してもノード追記自体は成功しているので無視
        }
    }

    async addFileToCanvas(canvasFile: TFile, file: TFile): Promise<void> {
        await this.addFilesToCanvas(canvasFile, [file]);
    }

    /** 複数ファイルを1回の読み書きでCanvasへ追記し、右端にカスケード配置する */
    async addFilesToCanvas(canvasFile: TFile, files: TFile[]): Promise<void> {
        const targets = files.filter((f): f is TFile => f instanceof TFile);
        if (targets.length === 0) return;
        let raw = '';
        try {
            raw = await this.app.vault.read(canvasFile);
        } catch {
            raw = '';
        }
        let data: { nodes: Record<string, unknown>[]; edges: unknown[]; [k: string]: unknown };
        try {
            data = raw && raw.trim().length >= 2 ? JSON.parse(raw) as typeof data : { nodes: [], edges: [] };
        } catch {
            data = { nodes: [], edges: [] };
        }
        if (!Array.isArray(data.nodes)) data.nodes = [];
        if (!Array.isArray(data.edges)) data.edges = [];

        for (const file of targets) {
            const { x, y } = this.calcCanvasNewPosition(data.nodes);
            data.nodes.push({
                id: this.generateCanvasNodeId(),
                type: 'file',
                file: file.path,
                x,
                y,
                width: 400,
                height: 300,
            });
        }

        await this.app.vault.modify(canvasFile, JSON.stringify(data, null, 2));
        if (targets.length === 1) {
            new Notice(`Sent ${targets[0].basename} → ${canvasFile.basename}`);
        } else {
            new Notice(`Sent ${targets.length} files → ${canvasFile.basename}`);
        }
        // 送信後は選択を自動解除
        this.clearSelection();
        await this.revealCanvasFile(canvasFile);
    }
}

type TagTriState = 'checked' | 'unchecked' | 'indeterminate';

/**
 * 複数ファイルのタグ一括編集モーダル。
 * 全ファイル共通=チェック、一部=横線(indeterminate)、なし=空欄で表示する。
 * 横線開始のタグは 横線→チェック→空欄→横線… の3遷移、それ以外はチェック⇄空欄のトグル。
 * 先頭の検索ボックスで既存タグを絞り込み、存在しなければ新規作成できる。Applyで一括確定する。
 */
class TagEditModal extends Modal {
    private files: TFile[];
    private readTags: (f: TFile) => string[];
    private onApply: (toAdd: string[], toRemove: string[]) => Promise<void>;
    private counts = new Map<string, number>();
    private initial = new Map<string, TagTriState>();
    private current = new Map<string, TagTriState>();
    private order: string[] = [];
    private filter = '';
    private listEl: HTMLElement | null = null;
    private createRowEl: HTMLElement | null = null;
    private applyBtn: HTMLButtonElement | null = null;
    private applying = false;

    constructor(
        app: App,
        files: TFile[],
        readTags: (f: TFile) => string[],
        vaultTags: string[],
        onApply: (toAdd: string[], toRemove: string[]) => Promise<void>,
    ) {
        super(app);
        this.files = files;
        this.readTags = readTags;
        this.onApply = onApply;
        const union = new Set<string>();
        for (const f of files) {
            for (const t of readTags(f)) {
                union.add(t);
                this.counts.set(t, (this.counts.get(t) ?? 0) + 1);
            }
        }
        for (const t of vaultTags) union.add(t);
        this.order = Array.from(union).sort((a, b) => a.localeCompare(b));
        for (const t of this.order) {
            const n = this.counts.get(t) ?? 0;
            const st: TagTriState = n >= files.length && files.length > 0 ? 'checked' : n > 0 ? 'indeterminate' : 'unchecked';
            this.initial.set(t, st);
            this.current.set(t, st);
        }
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('keep-tag-modal');
        const n = this.files.length;
        contentEl.createEl('h3', {
            text: n === 1 ? `Edit tags — ${this.files[0].basename}` : `Edit tags — ${n} files`,
        });
        const search = contentEl.createEl('input', {
            cls: 'keep-tag-search',
            attr: { type: 'text', placeholder: 'Search or create tag...' },
        });
        search.addEventListener('input', (e) => {
            this.filter = (e.target as HTMLInputElement).value;
            this.renderList();
        });
        search.addEventListener('keydown', (e: KeyboardEvent) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                this.tryCreateFromFilter();
            }
        });
        // モーダルを開いたら検索にフォーカス
        window.setTimeout(() => search.focus(), 50);
        this.createRowEl = contentEl.createEl('div', { cls: 'keep-tag-create-row' });
        this.listEl = contentEl.createEl('div', { cls: 'keep-tag-list' });
        const btns = contentEl.createEl('div', { cls: 'keep-confirm-btns' });
        const cancel = btns.createEl('button', { text: 'キャンセル' });
        cancel.addEventListener('click', () => this.close());
        this.applyBtn = btns.createEl('button', { text: 'Apply', cls: 'mod-cta' }) as HTMLButtonElement;
        this.applyBtn.addEventListener('click', () => void this.handleApply());
        this.renderList();
        this.updateApplyState();
    }

    onClose() {
        this.contentEl.empty();
    }

    private matchesFilter(tag: string): boolean {
        const q = this.filter.trim().replace(/^#+/, '').toLowerCase();
        if (!q) return true;
        return tag.toLowerCase().includes(q);
    }

    private normalizedFilter(): string {
        return normalizeTagName(this.filter);
    }

    private tryCreateFromFilter() {
        const name = this.normalizedFilter();
        if (!name) return;
        if (/[\s,]/.test(name)) {
            new Notice('タグに空白・カンマは使えません');
            return;
        }
        if (this.order.includes(name)) {
            // 既存タグへの完全一致はその行へスクロールするだけ
            this.renderList();
            return;
        }
        this.order.push(name);
        this.order.sort((a, b) => a.localeCompare(b));
        this.initial.set(name, 'unchecked');
        this.current.set(name, 'checked');
        this.renderList();
        this.updateApplyState();
    }

    private getChanges(): { toAdd: string[]; toRemove: string[] } {
        const toAdd: string[] = [];
        const toRemove: string[] = [];
        for (const t of this.order) {
            const init = this.initial.get(t) ?? 'unchecked';
            const cur = this.current.get(t) ?? 'unchecked';
            if (cur === 'indeterminate') continue;
            if (cur === 'checked' && init !== 'checked') toAdd.push(t);
            if (cur === 'unchecked' && init !== 'unchecked') toRemove.push(t);
        }
        return { toAdd, toRemove };
    }

    private updateApplyState() {
        if (!this.applyBtn) return;
        const { toAdd, toRemove } = this.getChanges();
        const total = toAdd.length + toRemove.length;
        this.applyBtn.disabled = total === 0 || this.applying;
        this.applyBtn.setText('Apply');
    }

    private syncTagRow(row: HTMLElement, box: HTMLInputElement, tag: string) {
        const state = this.current.get(tag) ?? 'unchecked';
        if (state === 'checked') {
            box.checked = true;
            box.indeterminate = false;
        } else if (state === 'indeterminate') {
            box.checked = false;
            box.indeterminate = true;
        } else {
            box.checked = false;
            box.indeterminate = false;
        }
        row.toggleClass('is-indeterminate', state === 'indeterminate');
        this.updateHint(row, tag);
    }

    private cycleState(tag: string) {
        const init = this.initial.get(tag) ?? 'unchecked';
        const cur = this.current.get(tag) ?? 'unchecked';
        let next: TagTriState;
        if (cur === 'indeterminate') next = 'checked';
        else if (cur === 'checked') next = 'unchecked';
        else next = init === 'indeterminate' ? 'indeterminate' : 'checked';
        this.current.set(tag, next);
        return next;
    }

    private renderList() {
        if (!this.listEl || !this.createRowEl) return;
        const list = this.listEl;
        const createRow = this.createRowEl;
        list.empty();
        createRow.empty();
        createRow.hide();
        const name = this.normalizedFilter();
        if (name && !this.order.includes(name)) {
            createRow.show();
            const btn = createRow.createEl('button', {
                cls: 'keep-tag-create-btn',
                text: /[\s,]/.test(name) ? `#${name}（空白・カンマは使えません）` : `Create #${name}`,
            });
            if (/[\s,]/.test(name)) {
                btn.disabled = true;
            } else {
                btn.addEventListener('click', () => this.tryCreateFromFilter());
            }
        }
        const total = this.files.length;
        let shown = 0;
        for (const tag of this.order) {
            if (!this.matchesFilter(tag)) continue;
            shown++;
            // labelだとラベル転送クリックと既定トグルが競合するためdivで行全体を受ける
            const row = list.createEl('div', { cls: 'keep-tag-row' });
            const box = row.createEl('input', { cls: 'keep-tag-check', attr: { type: 'checkbox' } }) as HTMLInputElement;
            // 直接クリックと行クリックのどちらからでも必ず1回だけ遷移させる。
            // box側でpreventDefault()すると取消時復元がsyncTagRowの書き込みを消すため、
            // stopPropagation()のみで二重発火を防ぐ（論理状態はcurrentマップ駆動のためpre-toggleとも競合しない）
            box.addEventListener('click', (e) => {
                e.stopPropagation();
                this.cycleState(tag);
                this.syncTagRow(row, box, tag);
                this.updateApplyState();
            });
            row.addEventListener('click', (e) => {
                e.preventDefault();
                this.cycleState(tag);
                this.syncTagRow(row, box, tag);
                this.updateApplyState();
            });
            row.createEl('span', { cls: 'keep-tag-name', text: `#${tag}` });
            this.syncTagRow(row, box, tag);
        }
        if (shown === 0 && !name) {
            list.createEl('div', { text: 'タグがありません', cls: 'keep-empty-message' });
        }
    }

    private updateHint(row: HTMLElement, tag: string) {
        let hint = row.querySelector('.keep-tag-hint');
        if (!hint) hint = row.createEl('span', { cls: 'keep-tag-hint' });
        const n = this.counts.get(tag) ?? 0;
        const total = this.files.length;
        const init = this.initial.get(tag) ?? 'unchecked';
        const state = this.current.get(tag) ?? 'unchecked';
        let text = '';
        let pending = false;
        if (state === 'indeterminate') {
            text = total > 1 ? `一部 ${n}/${total}` : '';
        } else if (state !== init) {
            text = state === 'checked' ? '→ 追加' : '→ 削除';
            pending = true;
        } else if (n >= total && total > 1) {
            text = 'all';
        }
        hint.setText(text);
        hint.toggleClass('is-pending', pending);
    }

    private async handleApply() {
        if (this.applying) return;
        const { toAdd, toRemove } = this.getChanges();
        if (toAdd.length === 0 && toRemove.length === 0) {
            this.close();
            return;
        }
        this.applying = true;
        this.updateApplyState();
        try {
            await this.onApply(toAdd, toRemove);
            this.close();
        } catch (e) {
            console.error('Apply tags failed', e);
            new Notice('タグの反映に失敗しました');
            this.applying = false;
            this.updateApplyState();
        }
    }
}

class ConfirmDeleteModal extends Modal {
    private files: TFile[];
    private resolveChoice: ((ok: boolean) => void) | null = null;
    private decided = false;

    constructor(app: App, files: TFile[]) {
        super(app);
        this.files = files;
    }

    awaitChoice(): Promise<boolean> {
        return new Promise((resolve) => {
            this.resolveChoice = resolve;
            this.open();
        });
    }

    private decide(ok: boolean) {
        if (this.decided) return;
        this.decided = true;
        this.close();
        // close時のonClose二重解決を防ぐため先に解決する
        const r = this.resolveChoice;
        this.resolveChoice = null;
        if (r) r(ok);
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('keep-confirm-modal');
        const count = this.files.length;
        contentEl.createEl('h3', { text: count === 1 ? 'このノートをゴミ箱に移動しますか？' : `${count}件のノートをゴミ箱に移動しますか？` });
        const list = contentEl.createEl('div', { cls: 'keep-confirm-list' });
        this.files.slice(0, 10).forEach((f) => {
            list.createEl('div', { text: f.path, cls: 'keep-confirm-item' });
        });
        if (count > 10) {
            list.createEl('div', { text: `…他 ${count - 10}件`, cls: 'keep-confirm-item keep-confirm-more' });
        }
        const btns = contentEl.createEl('div', { cls: 'keep-confirm-btns' });
        const cancel = btns.createEl('button', { text: 'キャンセル' });
        cancel.addEventListener('click', () => this.decide(false));
        const okBtn = btns.createEl('button', { text: count === 1 ? '移動する' : `${count}件移動する`, cls: 'mod-warning' });
        okBtn.addEventListener('click', () => this.decide(true));
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
        if (!this.decided) {
            this.decided = true;
            const r = this.resolveChoice;
            this.resolveChoice = null;
            if (r) r(false);
        }
    }
}

class CanvasPickerModal extends FuzzySuggestModal<TFile> {
    private files: TFile[];
    private onPick: (f: TFile | null) => void;
    private picked = false;

    constructor(app: App, files: TFile[], onPick: (f: TFile | null) => void) {
        super(app);
        this.files = files;
        this.onPick = onPick;
        this.setPlaceholder('Send to Canvas: select target canvas');
    }

    getItems(): TFile[] {
        return this.files;
    }

    getItemText(file: TFile): string {
        return file.path;
    }

    onChooseItem(file: TFile): void {
        this.picked = true;
        this.onPick(file);
    }

    onClose(): void {
        super.onClose();
        // 注意: SuggestModal.selectSuggestion() は close() → onChooseItem() の順で呼ぶため、
        // 選択時にも onClose が先に発火する。null解決を遅延させ、後続の選択を優先させる。
        // (遅延なしだと選択が常にnull扱いになり、複数Canvas時に追加されない)
        const self = this;
        window.setTimeout(() => {
            if (!self.picked) self.onPick(null);
        }, 50);
    }
}

export default class KeepPlugin extends Plugin {
    settings: NoteMasonrySettings = { ...DEFAULT_SETTINGS };
    private canvasHeaderActions = new Map<WorkspaceLeaf, HTMLElement>();
    private headerUpdateTimer: number | null = null;

    async onload() {
        await this.loadSettings();
        this.registerView(KEEP_VIEW_TYPE, (leaf) => {
            const view = new KeepView(leaf);
            view.scratchFolder = this.settings.scratchFolder;
            view.newFileFolder = this.settings.newFileFolder ?? '';
            return view;
        });
        this.addRibbonIcon('layout-grid', 'Open note masonry', () => void this.activateView());
        this.addSettingTab(new NoteMasonrySettingTab(this.app, this));
        // Canvasコアは .canvas-node-label の click を Mod付きのときのみ開く
        // (素のクリックは何もしない)。素の左クリックだけを横取りして右分割で開く。
        // キャプチャ段階で拾うことで、コアや他プラグインのバブルハンドラより先に処理する。
        this.registerDomEvent(document, 'click', this.onCanvasLabelClickCapture, true);
        this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.scheduleCanvasHeaderUpdate()));
        this.registerEvent(this.app.workspace.on('layout-change', () => this.scheduleCanvasHeaderUpdate()));
        this.registerEvent(this.app.workspace.on('file-open', () => this.scheduleCanvasHeaderUpdate()));
        this.app.workspace.onLayoutReady(() => this.updateCanvasHeaderButtons());
        this.updateBodyClass();
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        this.settings.scratchFolder = normalizeScratchFolder(this.settings.scratchFolder);
        this.settings.newFileFolder = normalizeNewFileFolder(this.settings.newFileFolder ?? '');
        await this.saveData(this.settings);
        this.updateBodyClass();
        this.syncSettingsToViews();
    }

    /** 設定変更を既存の全KeepViewへ反映する */
    private syncSettingsToViews() {
        try {
            for (const leaf of this.app.workspace.getLeavesOfType(KEEP_VIEW_TYPE)) {
                const view = leaf.view as unknown as KeepView;
                if (view instanceof KeepView) {
                    view.scratchFolder = this.settings.scratchFolder;
                    view.newFileFolder = this.settings.newFileFolder ?? '';
                }
            }
        } catch {
            // ignore
        }
    }

    private updateBodyClass() {
        document.body.toggleClass('note-masonry-canvas-label-split', this.settings.canvasLabelSplitEnabled);
    }

    onunload() {
        document.body.removeClass('note-masonry-canvas-label-split');
        for (const el of this.canvasHeaderActions.values()) {
            try { el.remove(); } catch { /* ignore */ }
        }
        this.canvasHeaderActions.clear();
        if (this.headerUpdateTimer !== null) {
            window.clearTimeout(this.headerUpdateTimer);
            this.headerUpdateTimer = null;
        }
    }

    private scheduleCanvasHeaderUpdate() {
        if (this.headerUpdateTimer !== null) {
            window.clearTimeout(this.headerUpdateTimer);
        }
        this.headerUpdateTimer = window.setTimeout(() => {
            this.headerUpdateTimer = null;
            this.updateCanvasHeaderButtons();
        }, 150);
    }

    /**
     * canvasビューのview-header（3点メニュー左）にCard View絞り込みボタンを注入する。
     * header再描画で消えるため冪等な再付与＋不要分の除去を行う。
     */
    private updateCanvasHeaderButtons() {
        try {
            const canvasLeaves = this.app.workspace.getLeavesOfType('canvas');
            const alive = new Set(canvasLeaves);
            for (const [leaf, el] of Array.from(this.canvasHeaderActions.entries())) {
                if (!alive.has(leaf)) {
                    try { el.remove(); } catch { /* ignore */ }
                    this.canvasHeaderActions.delete(leaf);
                    continue;
                }
                // header再生成でDOMから外れた場合は再注入対象に戻す
                if (!el.isConnected) {
                    this.canvasHeaderActions.delete(leaf);
                }
            }
            for (const leaf of canvasLeaves) {
                if (this.canvasHeaderActions.has(leaf)) continue;
                try {
                    const view = leaf.view as unknown as ItemView & { file?: TFile };
                    if (!view || typeof view.addAction !== 'function') continue;
                    const canvasFile = view.file;
                    if (!(canvasFile instanceof TFile) || canvasFile.extension !== 'canvas') continue;
                    const el = view.addAction('layout-grid', 'このキャンバス内のファイルをCard Viewで表示', () => {
                        const current = (leaf.view as unknown as { file?: TFile }).file;
                        if (current instanceof TFile && current.extension === 'canvas') {
                            void this.openCanvasFilteredView(current);
                        }
                    });
                    el.addClass('note-masonry-canvas-filter-btn');
                    el.setAttr('aria-label', 'このキャンバス内のファイルをCard Viewで表示');
                    this.canvasHeaderActions.set(leaf, el);
                } catch {
                    // 1leafの失敗で全体を止めない
                }
            }
        } catch {
            // ignore
        }
    }

    /**
     * Canvasカード左上のファイル名ラベル(.canvas-node-label)の素の左クリックを、
     * 右側の分割ペインで開く動作に変える。修飾キー付き・中クリックはコアに任せる。
     */
    private onCanvasLabelClickCapture = (evt: MouseEvent) => {
        if (!this.settings.canvasLabelSplitEnabled) return;
        if (evt.button !== 0) return;
        if (evt.metaKey || evt.ctrlKey || evt.shiftKey || evt.altKey) return;
        if (evt.defaultPrevented) return;
        const target = evt.target as Element | null;
        if (!target || typeof target.closest !== 'function') return;
        const labelEl = target.closest('.canvas-node-label');
        if (!labelEl) return;
        // グループ名やエッジラベル(.canvas-group-label/.canvas-path-label)は対象外。
        // .canvas-node-label は file/link ノードにだけ作られるが念のため除外する。
        if (labelEl.closest('.canvas-node-group, .canvas-group-label, .canvas-path-label, .canvas-edge')) return;

        const canvasLeaf = this.app.workspace.getLeavesOfType('canvas')
            .find((l) => {
                try {
                    return l.view.containerEl.contains(target);
                } catch {
                    return false;
                }
            });
        if (!canvasLeaf) return;
        const view = canvasLeaf.view as unknown as { canvas?: { nodes?: Map<string, unknown> }; file?: TFile | null };
        const nodeEl = labelEl.closest('.canvas-node');
        let linktext: string | null = null;
        try {
            const nodes = view.canvas?.nodes;
            if (nodes && typeof nodes.values === 'function' && nodeEl) {
                for (const n of nodes.values()) {
                    const node = n as { nodeEl?: unknown; url?: unknown; filePath?: unknown; subpath?: unknown };
                    if (node?.nodeEl !== nodeEl) continue;
                    // link(URL)カードは対象外。コア同様ブラウザオープンはMod+クリックに任せる。
                    if (typeof node.url === 'string' && node.url) return;
                    if (typeof node.filePath === 'string' && node.filePath) {
                        linktext = node.filePath + (typeof node.subpath === 'string' ? node.subpath : '');
                    }
                    break;
                }
            }
        } catch {
            // フォールバックせず何もしない(誤爆防止)
        }
        if (!linktext) return;
        const sourcePath = view.file instanceof TFile ? view.file.path : '';
        const dest = this.app.metadataCache.getFirstLinkpathDest(linktext, sourcePath);
        if (!(dest instanceof TFile)) return;

        evt.preventDefault();
        evt.stopPropagation();
        void this.openInRightSplit(dest, canvasLeaf);
    };

    /**
     * 既存の右側リーフがあれば再利用し、なければ右にvertical分割を作って開く。
     * 同一ファイルを既に開いているリーフがあればそこを優先してペイン増殖を防ぐ。
     * KeepView/canvas自体は再利用候補から除外する。
     */
    private async openInRightSplit(file: TFile, canvasLeaf?: WorkspaceLeaf): Promise<void> {
        const ws = this.app.workspace;
        const leaves: WorkspaceLeaf[] = [];
        ws.iterateRootLeaves((l) => leaves.push(l));
        const candidates = leaves.filter((l) => {
            try {
                const t = (l.view as unknown as { getViewType?: () => string }).getViewType?.();
                return t !== KEEP_VIEW_TYPE && t !== 'canvas';
            } catch {
                return true;
            }
        });
        let target: WorkspaceLeaf | null = null;
        if (candidates.length > 0) {
            try {
                const same = candidates.find((l) => {
                    try {
                        return (l.view as unknown as { file?: TFile }).file?.path === file.path;
                    } catch {
                        return false;
                    }
                });
                if (same) {
                    target = same;
                } else {
                    target = candidates.find((l) => l !== canvasLeaf) ?? null;
                }
            } catch {
                target = null;
            }
        }
        if (!target) {
            target = ws.getLeaf('split', 'vertical');
        }
        await target.openFile(file);
        await ws.revealLeaf(target);
    }

    /**
     * 指定canvasで絞り込んだCard Viewを右分割で開く。既存があれば再利用する。
     */
    async openCanvasFilteredView(canvasFile: TFile): Promise<void> {
        const ws = this.app.workspace;
        const keepLeaves = ws.getLeavesOfType(KEEP_VIEW_TYPE);
        for (const leaf of keepLeaves) {
            try {
                const v = leaf.view as unknown as KeepView;
                if (v instanceof KeepView && v.canvasSourcePath === canvasFile.path) {
                    await ws.revealLeaf(leaf);
                    v.requestRender();
                    return;
                }
            } catch {
                // 次を試す
            }
        }
        const reusable = keepLeaves.find((leaf) => {
            try {
                return (leaf.view as unknown as KeepView).canvasSourcePath != null;
            } catch {
                return false;
            }
        });
        if (reusable) {
            await reusable.setViewState({
                type: KEEP_VIEW_TYPE,
                active: true,
                state: { canvasSourcePath: canvasFile.path },
            });
            await ws.revealLeaf(reusable);
            return;
        }
        const leaf = ws.getLeaf('split', 'vertical');
        await leaf.setViewState({
            type: KEEP_VIEW_TYPE,
            active: true,
            state: { canvasSourcePath: canvasFile.path },
        });
        await ws.revealLeaf(leaf);
    }

    async activateView() {
        const { workspace } = this.app;
        const leaf = workspace.getLeaf('tab');
        await leaf.setViewState({ type: KEEP_VIEW_TYPE, active: true });
        await workspace.revealLeaf(leaf);
    }
}

class NoteMasonrySettingTab extends PluginSettingTab {
    plugin: KeepPlugin;

    constructor(app: App, plugin: KeepPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();
        new Setting(containerEl)
            .setName('Open canvas label in right split')
            .setDesc('Single-click a file name label on Canvas to open it in the right split (created if needed). Cmd/Ctrl+click behavior is unchanged.')
            .addToggle((toggle) => toggle
                .setValue(this.plugin.settings.canvasLabelSplitEnabled)
                .onChange(async (value) => {
                    this.plugin.settings.canvasLabelSplitEnabled = value;
                    await this.plugin.saveSettings();
                }));
        new Setting(containerEl)
            .setName('Default location for new files')
            .setDesc('Default folder for files created with the + button in Card View (vault-relative, empty means vault root). When a folder filter is active, that folder takes precedence. Missing folders are created automatically.')
            .addText((text) => text
                .setPlaceholder('e.g. Inbox (empty = vault root)')
                .setValue(this.plugin.settings.newFileFolder ?? '')
                .onChange(async (value) => {
                    this.plugin.settings.newFileFolder = normalizeNewFileFolder(value);
                    await this.plugin.saveSettings();
                }));
        new Setting(containerEl)
            .setName('Scratch folder for text editing')
            .setDesc('Location of the reusable file used to edit text cards inside a canvas in the large modal (vault-relative, one shared file for all canvases, never auto-deleted). To keep it out of search, we recommend adding it under Settings → Files and links → Excluded files.')
            .addText((text) => text
                .setPlaceholder(DEFAULT_SCRATCH_FOLDER)
                .setValue(this.plugin.settings.scratchFolder)
                .onChange(async (value) => {
                    this.plugin.settings.scratchFolder = normalizeScratchFolder(value);
                    await this.plugin.saveSettings();
                }));
    }
}