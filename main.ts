import { App, FuzzySuggestModal, ItemView, MarkdownFileInfo, Menu, Notice, Plugin, Scope, View, Workspace, WorkspaceLeaf, TFile, TFolder, setIcon, getAllTags } from 'obsidian';

export const KEEP_VIEW_TYPE = "keep-view";
const DEFAULT_TAG_FILTER = "#WIP";
const RANDOM_FILE_COUNT = 15;

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
    private prevActiveEditor: MarkdownFileInfo | null = null;
    private hasSavedActiveEditor = false;
    private pushedModalScope = false;
    private isOpen = false;
    private origSetActiveLeaf: Workspace['setActiveLeaf'] | null = null;
    private origGetActiveViewOfType: Workspace['getActiveViewOfType'] | null = null;
    private origGetActiveFile: Workspace['getActiveFile'] | null = null;

    constructor(app: App, file: TFile | null, keepLeaf: WorkspaceLeaf, onCloseCallback: () => void, selectedFolder: string = '', selectedTag: string = '') {
        this.app = app;
        this.file = file;
        this.keepLeaf = keepLeaf;
        this.onCloseCallback = onCloseCallback;
        this.selectedFolder = selectedFolder;
        this.selectedTag = selectedTag;
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
            let newPath = `${basePath}Untitled.md`;
            let counter = 1;
            while (this.app.vault.getAbstractFileByPath(newPath)) {
                newPath = `Untitled ${counter}.md`;
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
    private isRendering = false;
    private renderTimeout: NodeJS.Timeout | null = null;
    private hasAppliedDefaultTagFilter = false;
    
    selectedFolder: string = '';
    selectedTag: string = '';
    searchQuery: string = '';
    isRandomMode: boolean = false;
    randomFiles: TFile[] = [];

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

    getState() {
        return {
            ...super.getState(),
            selectedFolder: this.selectedFolder,
            selectedTag: this.selectedTag,
            searchQuery: this.searchQuery
        };
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
        this.isRandomMode = false;
        this.randomFiles = [];
        await super.setState(state, result);
        this.requestRender();
    }

    async onOpen() {
        const container = this.containerEl.children[1];
        container.empty();
        container.addClass('keep-view-container');

        const filterContainer = container.createEl('div', { cls: 'keep-filter-container' });
        
        const leftFilters = filterContainer.createEl('div', { cls: 'keep-filter-left' });
    
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
        setIcon(createButton, 'plus');
        createButton.addEventListener('click', () => {
            new NoteEditModal(this.app, null, this.leaf, () => this.requestRender(), this.selectedFolder, this.selectedTag).open();
        });
    
        this.gridContainer = container.createEl('div', { cls: 'keep-grid-wrapper' });

        this.registerEvent(this.app.vault.on('create', () => this.requestRender()));
        this.registerEvent(this.app.vault.on('modify', () => this.requestRender()));
        this.registerEvent(this.app.vault.on('delete', () => this.requestRender()));
        this.registerEvent(this.app.vault.on('rename', () => this.requestRender()));
        this.registerEvent(this.app.metadataCache.on('changed', () => this.requestRender()));

        await this.renderGrid();
    }

    updateSearchVisibility() {
      const searchWrapper = this.containerEl.querySelector('.keep-search-wrapper') as HTMLElement;
      if (searchWrapper) {
          if (this.searchQuery) {
              searchWrapper.addClass('has-value');
          } else {
              searchWrapper.removeClass('has-value');
          }
      }
    }
    
    requestRender() {
        if (this.renderTimeout) {
            clearTimeout(this.renderTimeout);
        }
        this.renderTimeout = setTimeout(() => {
            void this.renderGrid();
        }, 300);
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
        const all = this.app.vault.getMarkdownFiles();
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

    updateFilterUI() {
        const folders = this.app.vault.getAllLoadedFiles().filter((f): f is TFolder => f instanceof TFolder);
        // @ts-ignore
        const tags: string[] = Object.keys(this.app.metadataCache.getTags()).sort();

        if (this.folderSelect.options.length !== folders.length + 1) {
            const currentFolder = this.selectedFolder;
            this.folderSelect.empty();
            this.folderSelect.createEl('option', { value: '', text: 'All folders' });
            folders.forEach(f => {
                if (f.path === '/') return;
                const option = this.folderSelect.createEl('option', { value: f.path, text: f.path });
                if (f.path === currentFolder) option.selected = true;
            });
        }

        if (this.tagSelect.options.length !== tags.length + 1) {
            const currentTag = this.selectedTag;
            this.tagSelect.empty();
            this.tagSelect.createEl('option', { value: '', text: 'All tags' });
            tags.forEach(t => {
                const option = this.tagSelect.createEl('option', { value: t, text: t });
                if (t === currentTag) option.selected = true;
            });
        }
      
        this.folderSelect.value = this.selectedFolder;
        this.adjustSelectWidth(this.folderSelect);
        
        this.tagSelect.value = this.selectedTag;
        this.adjustSelectWidth(this.tagSelect);
    }

    adjustSelectWidth(select: HTMLSelectElement) {
        if (!select || select.options.length === 0) return;
        
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
        
        tempSpan.innerText = select.options[select.selectedIndex].text;
        document.body.appendChild(tempSpan);
        
        const textWidth = tempSpan.getBoundingClientRect().width;
        document.body.removeChild(tempSpan);
        
        select.style.width = `${textWidth + 20}px`;
    }
  
    async renderGrid() {
        if (this.isRendering) return;
        this.isRendering = true;

        try {
            this.applyDefaultTagFilter();
            this.updateFilterUI();
            this.updateRandomButtonState();

            let files: TFile[];

            if (this.isRandomMode) {
                const existingPaths = new Set(this.app.vault.getMarkdownFiles().map(f => f.path));
                files = this.randomFiles.filter(f => existingPaths.has(f.path));
            } else {
                let filtered = this.app.vault.getMarkdownFiles();
                
                if (this.selectedFolder) {
                    filtered = filtered.filter(f => f.parent?.path === this.selectedFolder || f.parent?.path.startsWith(this.selectedFolder + '/'));
                }
                
                if (this.selectedTag) {
                    filtered = filtered.filter(f => {
                        const cache = this.app.metadataCache.getFileCache(f);
                        const tags = cache ? getAllTags(cache) || [] : [];
                        return tags.includes(this.selectedTag);
                    });
                }

                if (this.searchQuery) {
                    const query = this.searchQuery.toLowerCase();
                    const searchPromises = filtered.map(async (f) => {
                        const content = await this.app.vault.cachedRead(f);
                        const cache = this.app.metadataCache.getFileCache(f);
                        
                        if (f.basename.toLowerCase().includes(query)) {
                            return true;
                        }
                        
                        let contentWithoutFrontmatter = content;
                        if (cache?.frontmatterPosition) {
                            contentWithoutFrontmatter = content.substring(cache.frontmatterPosition.end.offset);
                        } else {
                            contentWithoutFrontmatter = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
                        }
                        
                        return contentWithoutFrontmatter.toLowerCase().includes(query);
                    });
                    
                    const searchResults = await Promise.all(searchPromises);
                    filtered = filtered.filter((_, index) => searchResults[index]);
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

            this.gridContainer.empty();

            if (pinnedFiles.length > 0) {
                this.gridContainer.createEl('h3', { text: 'Pinned', cls: 'keep-section-title' });
                const pinnedGrid = this.gridContainer.createEl('div', { cls: 'keep-grid' });
                await this.renderCards(pinnedFiles, pinnedGrid);
                
                if (unpinnedFiles.length > 0) {
                    this.gridContainer.createEl('h3', { text: 'Others', cls: 'keep-section-title keep-section-title-others' });
                }
            }

            const unpinnedGrid = this.gridContainer.createEl('div', { cls: 'keep-grid' });
            await this.renderCards(unpinnedFiles, unpinnedGrid);

        } finally {
            this.isRendering = false;
        }
    }

    async renderCards(files: TFile[], container: HTMLElement) {
        const fragment = document.createDocumentFragment();
        for (const file of files) {
            const content = await this.app.vault.cachedRead(file);
            const cache = this.app.metadataCache.getFileCache(file);
            
            let contentWithoutFrontmatter = content;
            if (cache?.frontmatterPosition) {
                contentWithoutFrontmatter = content.substring(cache.frontmatterPosition.end.offset).trim();
            } else {
                contentWithoutFrontmatter = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trim();
            }

            const imageRegex = /!\[.*?\]\((.*?)\)|!\[\[(.*?)\]\]/g;
            const images: string[] = [];
            let match;
            while ((match = imageRegex.exec(contentWithoutFrontmatter)) !== null && images.length < 2) {
                const url = match[1] || match[2];
                if (url) {
                    images.push(url);
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

            const snippetText = contentWithoutFrontmatter.replace(/!\[.*?\]\(.*?\)|!\[\[.*?\]\]/g, '').trim();
            const snippet = snippetText.substring(0, 250) + (snippetText.length > 250 ? '...' : '');

            const card = fragment.createEl('div', { cls: 'keep-card' });
            card.draggable = true;
            let cardWasDragged = false;
            card.addEventListener('dragstart', (e: DragEvent) => {
                cardWasDragged = true;
                card.addClass('is-dragging');
                try {
                    const dm = (this.app as unknown as { dragManager?: {
                        dragFile?: (evt: DragEvent, file: TFile) => unknown;
                        onDragStart?: (evt: DragEvent, info: unknown) => void;
                    } }).dragManager;
                    if (dm?.dragFile && dm?.onDragStart) {
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
            card.addEventListener('dragend', () => {
                card.removeClass('is-dragging');
                window.setTimeout(() => { cardWasDragged = false; }, 150);
            });
            
            if (resolvedImages.length > 0) {
                const imgContainer = card.createEl('div', { cls: `keep-card-images keep-card-images-${resolvedImages.length}` });
                resolvedImages.forEach(img => {
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

            const canvasBtn = card.createEl('button', {
                cls: 'keep-canvas-btn',
                attr: { 'aria-label': 'Send to Canvas' }
            });
            setIcon(canvasBtn, 'layout-dashboard');
            
            const canvasSvg = canvasBtn.querySelector('svg');
            if (canvasSvg) {
                canvasSvg.setAttribute('fill', 'none');
                canvasSvg.setAttribute('stroke', 'currentColor');
            }
            
            canvasBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                void this.sendFileToCanvas(file);
            });
          
          
            if (file.basename) {
                card.createEl('h3', { text: file.basename, cls: 'keep-card-title' });
            }
            
            if (snippet) {
                card.createEl('div', { text: snippet, cls: 'keep-card-snippet' });
            }

            card.addEventListener('click', () => {
                if (cardWasDragged) {
                    cardWasDragged = false;
                    return;
                }
                new NoteEditModal(this.app, file, this.leaf, () => this.requestRender()).open();
            });

            card.addEventListener('contextmenu', (e: MouseEvent) => {
                e.preventDefault();
                e.stopPropagation();
                const menu = new Menu();
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
                menu.showAtMouseEvent(e);
            });
        }
        container.appendChild(fragment);
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
        try {
            const canvasFiles = this.getCanvasFiles();
            if (canvasFiles.length === 0) {
                await this.createCanvasAndAdd(file);
                return;
            }
            const active = this.getActiveCanvasFile();
            if (active && canvasFiles.some((f) => f.path === active.path)) {
                await this.addFileToCanvas(active, file);
                return;
            }
            if (canvasFiles.length === 1) {
                await this.addFileToCanvas(canvasFiles[0], file);
                return;
            }
            const picked = await this.pickCanvasFile(canvasFiles);
            if (!picked) return;
            await this.addFileToCanvas(picked, file);
        } catch (e) {
            console.error('Send to Canvas failed', e);
            new Notice('Canvasへの送信に失敗しました');
        }
    }

    async createCanvasAndAdd(file: TFile): Promise<void> {
        const baseName = 'Untitled Canvas';
        const folder = this.selectedFolder ? `${this.selectedFolder}/` : '';
        let path = `${folder}${baseName}.canvas`;
        let counter = 1;
        while (this.app.vault.getAbstractFileByPath(path)) {
            path = `${folder}${baseName} ${counter}.canvas`;
            counter++;
        }
        const canvasFile = await this.app.vault.create(path, JSON.stringify({ nodes: [], edges: [] }, null, 2));
        await this.addFileToCanvas(canvasFile, file);
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

        await this.app.vault.modify(canvasFile, JSON.stringify(data, null, 2));
        new Notice(`Sent ${file.basename} → ${canvasFile.basename}`);
        await this.revealCanvasFile(canvasFile);
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
    onload() {
        this.registerView(KEEP_VIEW_TYPE, (leaf) => new KeepView(leaf));
        this.addRibbonIcon('layout-grid', 'Open note masonry', () => void this.activateView());
    }

    async activateView() {
        const { workspace } = this.app;
        const leaf = workspace.getLeaf('tab');
        await leaf.setViewState({ type: KEEP_VIEW_TYPE, active: true });
        await workspace.revealLeaf(leaf);
    }
}