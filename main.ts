import { App, ItemView, Plugin, WorkspaceLeaf, TFile, TFolder, Modal, setIcon, getAllTags } from 'obsidian';

export const KEEP_VIEW_TYPE = "keep-view";

class NoteEditModal extends Modal {
    file: TFile | null;
    keepLeaf: WorkspaceLeaf;
    editorLeaf: WorkspaceLeaf | null = null;
    onCloseCallback: () => void;
    selectedFolder: string;
    selectedTag: string;

    constructor(app: App, file: TFile | null, keepLeaf: WorkspaceLeaf, onCloseCallback: () => void, selectedFolder: string = '', selectedTag: string = '') {
        super(app);
        this.file = file;
        this.keepLeaf = keepLeaf;
        this.onCloseCallback = onCloseCallback;
        this.selectedFolder = selectedFolder;
        this.selectedTag = selectedTag;
    }

    async onOpen() {
        this.contentEl.empty();
        this.modalEl.addClass('keep-editor-modal');
        const modal = this as Modal & { bgEl?: HTMLElement };
        if (modal.bgEl) {
            modal.bgEl.addClass('keep-modal-bg');
        }
        this.contentEl.addClass('keep-editor-modal-content');

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
            await this.editorLeaf.openFile(this.file);
        
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

    onClose() {
        if (this.editorLeaf) {
            this.editorLeaf.detach();
        }
        this.app.workspace.setActiveLeaf(this.keepLeaf, { focus: true });
        this.onCloseCallback();
    }
}

export class KeepView extends ItemView {
    gridContainer: HTMLElement;
    folderSelect: HTMLSelectElement;
    tagSelect: HTMLSelectElement;
    private isRendering = false;
    private renderTimeout: NodeJS.Timeout | null = null;
    
    selectedFolder: string = '';
    selectedTag: string = '';

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
            selectedTag: this.selectedTag
        };
    }

    async setState(state: Record<string, unknown>, result: Parameters<ItemView['setState']>[1]) {
        this.selectedFolder = typeof state.selectedFolder === 'string' ? state.selectedFolder : '';
        this.selectedTag = typeof state.selectedTag === 'string' ? state.selectedTag : '';
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
            this.requestRender();
        });
    
        this.tagSelect = leftFilters.createEl('select', { cls: 'keep-select' });
        this.tagSelect.addEventListener('change', (e) => {
            this.selectedTag = (e.target as HTMLSelectElement).value;
            this.adjustSelectWidth(this.tagSelect);   
            this.requestRender();
        });
    
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

    requestRender() {
        if (this.renderTimeout) {
            clearTimeout(this.renderTimeout);
        }
        this.renderTimeout = setTimeout(() => {
            void this.renderGrid();
        }, 300);
    }

    updateFilterUI() {
        const folders = this.app.vault.getAllLoadedFiles().filter((f): f is TFolder => f instanceof TFolder);
        // @ts-ignore
        const tags = Object.keys(this.app.metadataCache.getTags());

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
            this.updateFilterUI();

            let files = this.app.vault.getMarkdownFiles();
            
            if (this.selectedFolder) {
                files = files.filter(f => f.parent?.path === this.selectedFolder || f.parent?.path.startsWith(this.selectedFolder + '/'));
            }
            if (this.selectedTag) {
                files = files.filter(f => {
                    const cache = this.app.metadataCache.getFileCache(f);
                    const tags = cache ? getAllTags(cache) || [] : [];
                    return tags.includes(this.selectedTag);
                });
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
            
            if (resolvedImages.length > 0) {
                const imgContainer = card.createEl('div', { cls: `keep-card-images keep-card-images-${resolvedImages.length}` });
                resolvedImages.forEach(img => {
                    imgContainer.createEl('img', { attr: { src: img } });
                });
            }
            
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

            const deleteBtn = card.createEl('button', {
                cls: 'keep-delete-btn',
            });
            setIcon(deleteBtn, 'trash');
            
            const deleteSvg = deleteBtn.querySelector('svg');
            if (deleteSvg) {
                deleteSvg.setAttribute('fill', 'none');
                deleteSvg.setAttribute('stroke', 'currentColor');
            }
            
            deleteBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                void this.app.fileManager.trashFile(file).then(() => {
                    this.requestRender();
                });
            });
          
          
            if (file.basename) {
                card.createEl('h3', { text: file.basename, cls: 'keep-card-title' });
            }
            
            if (snippet) {
                card.createEl('div', { text: snippet, cls: 'keep-card-snippet' });
            }

            card.addEventListener('click', () => {
                new NoteEditModal(this.app, file, this.leaf, () => this.requestRender()).open();
            });
        }
        container.appendChild(fragment);
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