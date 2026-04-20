import {
  App,
  Component,
  ItemView,
  MarkdownRenderer,
  MarkdownView,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  WorkspaceLeaf,
} from "obsidian";

const BOOK_VIEW_TYPE = "book-mode-reader";
const MIN_PAGE_WIDTH = 280;
const MIN_PAGE_HEIGHT = 360;
const PAGE_OVERFLOW_TOLERANCE = 2;

interface BookModeSettings {
  pageWidth: number;
  pageHeight: number;
  pageGap: number;
  fontScalePercent: number;
  defaultFocusMode: boolean;
  openInBookModeByDefault: boolean;
  autoOpenFolderPaths: string[];
  debugMode: boolean;
  showCoverPage: boolean;
  animatePageTurns: boolean;
}

interface BookModeViewState extends Record<string, unknown> {
  file?: string;
  pageIndex?: number;
  focusMode?: boolean;
}

interface MarkdownBlock {
  markdown: string;
  startOffset: number;
  endOffset: number;
}

interface BookPage {
  markdown: string;
  startOffset: number | null;
  endOffset: number | null;
}

const DEFAULT_SETTINGS: BookModeSettings = {
  pageWidth: 420,
  pageHeight: 560,
  pageGap: 28,
  fontScalePercent: 100,
  defaultFocusMode: false,
  openInBookModeByDefault: false,
  autoOpenFolderPaths: [],
  debugMode: false,
  showCoverPage: true,
  animatePageTurns: true,
};

export default class BookModePlugin extends Plugin {
  settings: BookModeSettings = DEFAULT_SETTINGS;
  private suppressAutoBookMode = false;
  private autoOpenRequestId = 0;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.registerView(
      BOOK_VIEW_TYPE,
      (leaf) => new BookModeView(leaf, this),
    );

    this.addRibbonIcon("book-open", "Open current note in book mode", () => {
      void this.openCurrentNoteInBookMode();
    });

    this.addCommand({
      id: "open-current-note-in-book-mode",
      name: "Open current note in book mode",
      callback: () => {
        void this.openCurrentNoteInBookMode(this.settings.defaultFocusMode);
      },
    });

    this.addCommand({
      id: "next-page-spread",
      name: "Next page spread",
      checkCallback: (checking) => {
        const view = this.getActiveBookView();

        if (!view) {
          return false;
        }

        if (!checking) {
          void view.goForward();
        }

        return true;
      },
    });

    this.addCommand({
      id: "previous-page-spread",
      name: "Previous page spread",
      checkCallback: (checking) => {
        const view = this.getActiveBookView();

        if (!view) {
          return false;
        }

        if (!checking) {
          void view.goBackward();
        }

        return true;
      },
    });

    this.addCommand({
      id: "open-current-note-in-focus-book-mode",
      name: "Open current note in focus book mode",
      callback: () => {
        void this.openCurrentNoteInBookMode(true);
      },
    });

    this.addCommand({
      id: "toggle-focus-reading-mode",
      name: "Toggle focus reading mode",
      checkCallback: (checking) => {
        const view = this.getActiveBookView();

        if (!view) {
          return false;
        }

        if (!checking) {
          void view.toggleFocusMode();
        }

        return true;
      },
    });

    this.addCommand({
      id: "increase-book-font-size",
      name: "Increase book font size",
      callback: () => {
        void this.adjustFontScale(10);
      },
    });

    this.addCommand({
      id: "decrease-book-font-size",
      name: "Decrease book font size",
      callback: () => {
        void this.adjustFontScale(-10);
      },
    });

    this.addCommand({
      id: "reset-book-font-size",
      name: "Reset book font size",
      callback: () => {
        void this.setFontScale(DEFAULT_SETTINGS.fontScalePercent);
      },
    });

    this.addCommand({
      id: "show-book-mode-debug-state",
      name: "Show Book Mode debug state",
      callback: () => {
        this.showDebugState();
      },
    });

    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (!(file instanceof TFile)) {
          return;
        }

        void this.refreshOpenBookViews(file.path);
      }),
    );

    this.registerEvent(
      this.app.workspace.on("file-open", (file) => {
        if (!(file instanceof TFile)) {
          this.debugLog("file-open skipped: not a file", {
            file,
          });
          return;
        }

        const matchesFolder = this.shouldAutoOpenFile(file);

        this.debugLog("file-open", {
          filePath: file.path,
          openInBookModeByDefault: this.settings.openInBookModeByDefault,
          suppressAutoBookMode: this.suppressAutoBookMode,
          matchesFolder,
          activeLeafType: this.app.workspace.activeLeaf?.view?.getViewType?.() ?? "none",
          activeFilePath: this.app.workspace.getActiveFile()?.path ?? null,
        });

        if (
          !this.settings.openInBookModeByDefault ||
          this.suppressAutoBookMode ||
          !matchesFolder
        ) {
          this.debugLog("auto-open blocked", {
            filePath: file.path,
            reason: !this.settings.openInBookModeByDefault
              ? "setting-disabled"
              : this.suppressAutoBookMode
                ? "suppressed"
                : "folder-mismatch",
          });
          return;
        }

        this.scheduleAutoOpen(file);
      }),
    );

    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        this.debugLog("active-leaf-change", {
          leafType: leaf?.view?.getViewType?.() ?? "none",
          filePath: getLeafFilePath(leaf) ?? null,
        });
      }),
    );

    this.addSettingTab(new BookModeSettingTab(this.app, this));
  }

  async onunload(): Promise<void> {
    await this.app.workspace.detachLeavesOfType(BOOK_VIEW_TYPE);
  }

  async loadSettings(): Promise<void> {
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...(await this.loadData()),
    };
  }

  async updateSettings(update: Partial<BookModeSettings>): Promise<void> {
    this.settings = {
      ...this.settings,
      ...update,
    };
    await this.saveData(this.settings);
    await this.refreshOpenBookViews();
  }

  private getActiveBookView(): BookModeView | null {
    const activeView = this.app.workspace.activeLeaf?.view;
    return activeView instanceof BookModeView ? activeView : null;
  }

  private shouldAutoOpenFile(file: TFile): boolean {
    const folderPaths = this.settings.autoOpenFolderPaths
      .map(normalizeFolderPath)
      .filter(Boolean);

    if (!folderPaths.length) {
      return true;
    }

    const normalizedFilePath = file.path.toLowerCase();

    return folderPaths.some((folderPath) => {
      const normalizedFolderPath = folderPath.toLowerCase();
      return normalizedFilePath.startsWith(`${normalizedFolderPath}/`);
    });
  }

  private showDebugState(): void {
    const activeLeaf = this.app.workspace.activeLeaf;
    const activeFile = this.app.workspace.getActiveFile();
    const message = [
      `Book Mode debug`,
      `file=${activeFile?.path ?? "none"}`,
      `activeLeaf=${activeLeaf?.view?.getViewType?.() ?? "none"}`,
      `autoOpen=${String(this.settings.openInBookModeByDefault)}`,
      `suppress=${String(this.suppressAutoBookMode)}`,
      `folders=${this.settings.autoOpenFolderPaths.join(", ") || "(all)"}`,
      `matches=${activeFile instanceof TFile ? String(this.shouldAutoOpenFile(activeFile)) : "n/a"}`,
    ].join(" | ");

    this.debugLog("manual state dump", { message }, true);
  }

  private debugLog(event: string, details: Record<string, unknown>, showNotice = false): void {
    if (!this.settings.debugMode && !showNotice) {
      return;
    }

    const payload = {
      event,
      ...details,
    };

    console.info("[Book Mode]", payload);

    if (showNotice) {
      const message = typeof details.message === "string"
        ? details.message
        : `${event}: ${JSON.stringify(details)}`;
      new Notice(message, 8000);
    }
  }

  private scheduleAutoOpen(file: TFile): void {
    const requestId = ++this.autoOpenRequestId;

    this.debugLog("scheduleAutoOpen", {
      requestId,
      filePath: file.path,
    });

    window.setTimeout(() => {
      if (requestId !== this.autoOpenRequestId) {
        this.debugLog("scheduleAutoOpen canceled: superseded", {
          requestId,
          filePath: file.path,
        });
        return;
      }

      const activeFile = this.app.workspace.getActiveFile();

      if (!(activeFile instanceof TFile) || activeFile.path !== file.path) {
        this.debugLog("scheduleAutoOpen canceled: active file changed", {
          requestId,
          expectedFilePath: file.path,
          activeFilePath: activeFile?.path ?? null,
        });
        return;
      }

      void this.openFileInBookMode(file, this.settings.defaultFocusMode, 1);
    }, 0);
  }

  private async openCurrentNoteInBookMode(focusMode = this.settings.defaultFocusMode): Promise<void> {
    const file = this.app.workspace.getActiveFile();

    if (!(file instanceof TFile)) {
      new Notice("Book Mode: open a markdown note first.");
      return;
    }

    await this.openFileInBookMode(file, focusMode);
  }

  private async openFileInBookMode(
    file: TFile,
    focusMode = this.settings.defaultFocusMode,
    attempt = 1,
  ): Promise<void> {
    const activeView = this.app.workspace.activeLeaf?.view;

    if (activeView instanceof BookModeView && activeView.getFile()?.path === file.path) {
      this.debugLog("openFileInBookMode skipped: already open", {
        filePath: file.path,
      });
      return;
    }

    const existingLeaf = this.app.workspace
      .getLeavesOfType(BOOK_VIEW_TYPE)
      .find((leaf) => leaf.view instanceof BookModeView && leaf.view.getFile()?.path === file.path);

    const activeLeaf = this.app.workspace.activeLeaf;
    const shouldReuseActiveLeaf =
      activeLeaf?.view instanceof MarkdownView ||
      activeLeaf?.view?.getViewType?.() === "empty";
    const leaf = existingLeaf ?? (shouldReuseActiveLeaf && activeLeaf ? activeLeaf : this.app.workspace.getLeaf(true));

    this.debugLog("openFileInBookMode", {
      filePath: file.path,
      focusMode,
      attempt,
      reusedExistingLeaf: Boolean(existingLeaf),
      reusedActiveLeaf: !existingLeaf && shouldReuseActiveLeaf && Boolean(activeLeaf),
      targetLeafTypeBeforeOpen: leaf.view.getViewType?.() ?? "unknown",
    });

    this.suppressAutoBookMode = true;

    try {
      await leaf.setViewState({
        type: BOOK_VIEW_TYPE,
        active: true,
        state: {
          file: file.path,
          pageIndex: 0,
          focusMode,
        },
      });
      await this.app.workspace.revealLeaf(leaf);

      const openedInBookMode = leaf.view instanceof BookModeView && leaf.view.getFile()?.path === file.path;

      this.debugLog("openFileInBookMode result", {
        filePath: file.path,
        attempt,
        targetLeafTypeAfterOpen: leaf.view.getViewType?.() ?? "unknown",
        openedInBookMode,
      });

      if (!openedInBookMode && attempt < 3) {
        const retryDelayMs = attempt * 40;

        this.debugLog("openFileInBookMode retry scheduled", {
          filePath: file.path,
          nextAttempt: attempt + 1,
          retryDelayMs,
        });

        window.setTimeout(() => {
          const activeFile = this.app.workspace.getActiveFile();

          if (!(activeFile instanceof TFile) || activeFile.path !== file.path) {
            this.debugLog("openFileInBookMode retry canceled: active file changed", {
              filePath: file.path,
              nextAttempt: attempt + 1,
              activeFilePath: activeFile?.path ?? null,
            });
            return;
          }

          void this.openFileInBookMode(file, focusMode, attempt + 1);
        }, retryDelayMs);
      }
    } finally {
      window.setTimeout(() => {
        this.suppressAutoBookMode = false;
        this.debugLog("auto-open suppression cleared", {
          filePath: file.path,
        });
      }, 0);
    }
  }

  private async adjustFontScale(delta: number): Promise<void> {
    const nextPercent = clampNumber(
      String(this.settings.fontScalePercent + delta),
      70,
      180,
      DEFAULT_SETTINGS.fontScalePercent,
    );
    await this.setFontScale(nextPercent);
  }

  private async setFontScale(fontScalePercent: number): Promise<void> {
    await this.updateSettings({ fontScalePercent });
    new Notice(`Book Mode font size: ${fontScalePercent}%`);
  }

  async refreshOpenBookViews(filePath?: string): Promise<void> {
    const leaves = this.app.workspace.getLeavesOfType(BOOK_VIEW_TYPE);

    for (const leaf of leaves) {
      if (!(leaf.view instanceof BookModeView)) {
        continue;
      }

      const activeFile = leaf.view.getFile();

      if (filePath && activeFile?.path !== filePath) {
        continue;
      }

      await leaf.view.refreshFromSource();
    }
  }
}

class BookModeView extends ItemView {
  private readonly plugin: BookModePlugin;
  private file: TFile | null = null;
  private currentPageIndex = 0;
  private pages: BookPage[] = [];
  private focusMode = false;
  private frameEl: HTMLElement | null = null;
  private fileLabelEl: HTMLElement | null = null;
  private progressEl: HTMLElement | null = null;
  private spreadEl: HTMLElement | null = null;
  private emptyStateEl: HTMLElement | null = null;
  private previousButtonEl: HTMLButtonElement | null = null;
  private nextButtonEl: HTMLButtonElement | null = null;
  private measureHostEl: HTMLElement | null = null;
  private measurePageEl: HTMLElement | null = null;
  private measureContentEl: HTMLElement | null = null;
  private pageComponents: Component[] = [];
  private requestToken = 0;

  constructor(leaf: WorkspaceLeaf, plugin: BookModePlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return BOOK_VIEW_TYPE;
  }

  getDisplayText(): string {
    return this.file ? `Book Mode: ${this.file.basename}` : "Book Mode";
  }

  getIcon(): string {
    return "book-open";
  }

  getState(): BookModeViewState {
      return {
        file: this.file?.path,
        pageIndex: this.currentPageIndex,
        focusMode: this.focusMode,
      };
  }

  async setState(state: unknown): Promise<void> {
    this.ensureLayout();

    const viewState = normalizeViewState(state);

    if (!viewState.file) {
      this.file = null;
      this.pages = [];
      this.currentPageIndex = 0;
      this.focusMode = this.plugin.settings.defaultFocusMode;
      await this.renderSpread();
      return;
    }

    const maybeFile = this.app.vault.getAbstractFileByPath(viewState.file);

    if (!(maybeFile instanceof TFile)) {
      this.file = null;
      this.pages = [];
      this.currentPageIndex = 0;
      this.focusMode = this.plugin.settings.defaultFocusMode;
      await this.renderEmptyState(`Book Mode could not find ${viewState.file}.`);
      return;
    }

    if (this.file?.path !== maybeFile.path) {
      this.file = maybeFile;
      this.currentPageIndex = Math.max(0, viewState.pageIndex ?? 0);
      this.focusMode = viewState.focusMode ?? this.plugin.settings.defaultFocusMode;
      await this.refreshFromSource();
      return;
    }

    this.currentPageIndex = Math.max(0, viewState.pageIndex ?? this.currentPageIndex);
    this.focusMode = viewState.focusMode ?? this.plugin.settings.defaultFocusMode;
    await this.renderSpread();
  }

  async onOpen(): Promise<void> {
    this.ensureLayout();
    this.registerDomEvent(document, "keydown", (event) => {
      const activeView = this.app.workspace.activeLeaf?.view;

      if (!(activeView instanceof BookModeView) || activeView !== this) {
        return;
      }

      if (event.defaultPrevented || isEditableTarget(event.target)) {
        return;
      }

      if (event.key === "ArrowRight") {
        event.preventDefault();
        void this.goForward();
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        void this.goBackward();
      }
    });

    await this.renderSpread();
  }

  async onClose(): Promise<void> {
    this.cleanupPageComponents();
    this.requestToken += 1;
  }

  onResize(): void {
    void this.renderSpread();
  }

  getFile(): TFile | null {
    return this.file;
  }

  async jumpToSourceOffset(offset: number): Promise<boolean> {
    if (!this.pages.length) {
      return false;
    }

    const pageIndex = this.findPageIndexForOffset(offset);

    if (pageIndex < 0) {
      return false;
    }

    this.currentPageIndex = pageIndex;
    await this.renderSpread();
    return true;
  }

  async refreshFromSource(): Promise<void> {
    this.ensureLayout();

    if (!this.file) {
      await this.renderEmptyState("Open a note and run Book Mode from the command palette.");
      return;
    }

    const requestToken = ++this.requestToken;

    this.contentEl.toggleClass("book-mode-loading", true);

    try {
      const source = await this.app.vault.cachedRead(this.file);

      if (requestToken !== this.requestToken) {
        return;
      }

      this.pages = await this.paginateMarkdown(source);

      if (requestToken !== this.requestToken) {
        return;
      }

      await this.renderSpread();
    } finally {
      if (requestToken === this.requestToken) {
        this.contentEl.toggleClass("book-mode-loading", false);
      }
    }
  }

  async goForward(): Promise<void> {
    if (!this.pages.length) {
      return;
    }

    const pagesPerSpread = this.getPagesPerSpread();
    const nextIndex = Math.min(
      this.getMaxStartIndex(pagesPerSpread),
      this.currentPageIndex + pagesPerSpread,
    );

    if (nextIndex === this.currentPageIndex) {
      return;
    }

    this.currentPageIndex = nextIndex;
    await this.renderSpread();
  }

  async goBackward(): Promise<void> {
    if (!this.pages.length) {
      return;
    }

    const pagesPerSpread = this.getPagesPerSpread();
    const previousIndex = Math.max(0, this.currentPageIndex - pagesPerSpread);

    if (previousIndex === this.currentPageIndex) {
      return;
    }

    this.currentPageIndex = previousIndex;
    await this.renderSpread();
  }

  async toggleFocusMode(): Promise<void> {
    this.focusMode = !this.focusMode;
    await this.plugin.updateSettings({ defaultFocusMode: this.focusMode });
    await this.renderSpread();
  }

  private ensureLayout(): void {
    this.contentEl.empty();
    this.contentEl.addClass("book-mode-view");
    this.contentEl.toggleClass("book-mode-view--focus", this.focusMode);
    this.applyCssVars();

    this.frameEl = this.contentEl.createDiv({ cls: "book-mode-frame" });

    const toolbarEl = this.frameEl.createDiv({ cls: "book-mode-toolbar" });
    const titleGroupEl = toolbarEl.createDiv({ cls: "book-mode-toolbar__group" });
    this.fileLabelEl = titleGroupEl.createDiv({ cls: "book-mode-file" });
    this.progressEl = titleGroupEl.createDiv({ cls: "book-mode-progress" });

    const buttonGroupEl = toolbarEl.createDiv({ cls: "book-mode-toolbar__group" });
    this.previousButtonEl = buttonGroupEl.createEl("button", {
      cls: "book-mode-nav-button",
      text: "Previous",
    });
    this.previousButtonEl.addEventListener("click", () => {
      void this.goBackward();
    });

    this.nextButtonEl = buttonGroupEl.createEl("button", {
      cls: "book-mode-nav-button",
      text: "Next",
    });
    this.nextButtonEl.addEventListener("click", () => {
      void this.goForward();
    });

    this.spreadEl = this.frameEl.createDiv({ cls: "book-mode-spread" });
    this.emptyStateEl = this.frameEl.createDiv({ cls: "book-mode-empty" });
    this.ensureMeasureElements();
  }

  private applyCssVars(): void {
    this.contentEl.style.setProperty("--book-mode-page-width", `${this.plugin.settings.pageWidth}px`);
    this.contentEl.style.setProperty("--book-mode-page-height", `${this.plugin.settings.pageHeight}px`);
    this.contentEl.style.setProperty("--book-mode-page-gap", `${this.plugin.settings.pageGap}px`);
    this.contentEl.style.setProperty("--book-mode-font-scale", `${this.plugin.settings.fontScalePercent}%`);
  }

  private ensureMeasureElements(): void {
    if (!this.contentEl.isConnected) {
      return;
    }

    this.measureHostEl = this.contentEl.createDiv({ cls: "book-mode-measure-host" });
    this.measurePageEl = this.measureHostEl.createDiv({
      cls: "book-mode-page book-mode-page--measure",
    });
    this.measureContentEl = this.measurePageEl.createDiv({
      cls: "book-mode-page__content markdown-rendered",
    });
    this.measurePageEl.createDiv({
      cls: "book-mode-page__number",
      text: "measure",
    });
  }

  private async renderSpread(): Promise<void> {
    this.ensureLayout();
    this.cleanupPageComponents();

    if (!this.spreadEl || !this.fileLabelEl || !this.progressEl || !this.emptyStateEl) {
      return;
    }

    this.spreadEl.empty();
    this.emptyStateEl.empty();

    if (!this.file) {
      await this.renderEmptyState("Open a note and run Book Mode from the command palette.");
      return;
    }

    if (!this.pages.length) {
      await this.renderEmptyState("This note is empty.");
      return;
    }

    const pagesPerSpread = this.getPagesPerSpread();
    this.currentPageIndex = this.normalizePageIndex(this.currentPageIndex, pagesPerSpread);

    const start = this.currentPageIndex;
    const end = Math.min(this.pages.length, start + pagesPerSpread);
    const visiblePages = this.pages.slice(start, end);

    this.fileLabelEl.setText(this.file.basename);
    this.progressEl.setText(`Pages ${start + 1}-${end} of ${this.pages.length}`);

    for (let offset = 0; offset < visiblePages.length; offset += 1) {
      const pageNumber = start + offset + 1;
      const page = visiblePages[offset];
      const markdown = page.markdown;
      const isCoverPage = this.plugin.settings.showCoverPage && pageNumber === 1;
      const pageEl = this.createPageElement(pageNumber, isCoverPage);
      const pageContentEl = pageEl.querySelector(".book-mode-page__content");

      if (!(pageContentEl instanceof HTMLElement)) {
        continue;
      }

      await this.renderMarkdownInto(pageContentEl, markdown, true);
    }

    if (pagesPerSpread === 2 && visiblePages.length === 1) {
      this.createPlaceholderPage();
    }

    if (this.previousButtonEl) {
      this.previousButtonEl.disabled = start === 0;
    }

    if (this.nextButtonEl) {
      this.nextButtonEl.disabled = end >= this.pages.length;
    }
  }

  private async renderEmptyState(message: string): Promise<void> {
    this.ensureLayout();

    if (!this.spreadEl || !this.emptyStateEl || !this.fileLabelEl || !this.progressEl) {
      return;
    }

    this.spreadEl.empty();
    this.emptyStateEl.setText(message);
    this.fileLabelEl.setText(this.file?.basename ?? "Book Mode");
    this.progressEl.setText("");

    if (this.previousButtonEl) {
      this.previousButtonEl.disabled = true;
    }

    if (this.nextButtonEl) {
      this.nextButtonEl.disabled = true;
    }
  }

  private createPageElement(pageNumber: number, isCoverPage: boolean): HTMLElement {
    if (!this.spreadEl) {
      throw new Error("Book Mode spread element is not ready.");
    }

    const pageEl = this.spreadEl.createDiv({
      cls: [
        "book-mode-page",
        this.plugin.settings.animatePageTurns ? "book-mode-page--animated" : "",
        isCoverPage ? "book-mode-page--cover" : "",
      ].filter(Boolean).join(" "),
    });

    pageEl.createDiv({
      cls: "book-mode-page__content markdown-rendered",
    });
    pageEl.createDiv({
      cls: "book-mode-page__number",
      text: `Page ${pageNumber}`,
    });

    return pageEl;
  }

  private createPlaceholderPage(): void {
    if (!this.spreadEl) {
      return;
    }

    const placeholderEl = this.spreadEl.createDiv({
      cls: "book-mode-page book-mode-page--placeholder",
    });
    placeholderEl.createDiv({
      cls: "book-mode-page__content",
    });
    placeholderEl.createDiv({
      cls: "book-mode-page__number",
      text: "",
    });
  }

  private async paginateMarkdown(markdown: string): Promise<BookPage[]> {
    const source = markdown.replace(/\r\n/g, "\n");
    const blocks = splitMarkdownIntoBlocks(source);
    const pages: BookPage[] = [];
    let currentBlocks: MarkdownBlock[] = [];

    const pushCurrentPage = (): void => {
      const pageMarkdown = joinBlocks(currentBlocks.map((block) => block.markdown));

      if (pageMarkdown) {
        pages.push({
          markdown: pageMarkdown,
          startOffset: currentBlocks[0]?.startOffset ?? null,
          endOffset: currentBlocks[currentBlocks.length - 1]?.endOffset ?? null,
        });
      }

      currentBlocks = [];
    };

    for (const block of blocks) {
      const candidate = joinBlocks([...currentBlocks, block].map((item) => item.markdown));

      if (candidate && (await this.pageFits(candidate))) {
        currentBlocks.push(block);
        continue;
      }

      if (currentBlocks.length) {
        pushCurrentPage();
      }

      if (await this.pageFits(block.markdown)) {
        currentBlocks = [block];
        continue;
      }

      const splitParts = await this.splitOversizedBlock(block);

      for (const part of splitParts) {
        const splitCandidate = joinBlocks([...currentBlocks, part].map((item) => item.markdown));

        if (splitCandidate && (await this.pageFits(splitCandidate))) {
          currentBlocks.push(part);
          continue;
        }

        if (currentBlocks.length) {
          pushCurrentPage();
        }

        if (await this.pageFits(part.markdown)) {
          currentBlocks = [part];
        } else {
          pages.push({
            markdown: part.markdown,
            startOffset: part.startOffset,
            endOffset: part.endOffset,
          });
        }
      }
    }

    if (currentBlocks.length) {
      pushCurrentPage();
    }

    if (!pages.length && this.file) {
      pages.push({
        markdown: `# ${this.file.basename}\n\n_This note is empty._`,
        startOffset: null,
        endOffset: null,
      });
    }

    if (this.plugin.settings.showCoverPage && this.file) {
      pages.unshift({
        markdown: buildCoverPageMarkdown(this.file),
        startOffset: null,
        endOffset: null,
      });
    }

    return pages;
  }

  private async splitOversizedBlock(block: MarkdownBlock): Promise<MarkdownBlock[]> {
    if (isHardToSplitBlock(block.markdown)) {
      return [block];
    }

    const lineUnits = block.markdown.split("\n").filter((line) => line.trim().length > 0);

    if (lineUnits.length > 1) {
      return this.packUnitsIntoPages(lineUnits, "\n", block);
    }

    const sentenceUnits = splitIntoSentences(block.markdown);

    if (sentenceUnits.length > 1) {
      return this.packUnitsIntoPages(sentenceUnits, " ", block);
    }

    const wordUnits = block.markdown.split(/\s+/).filter(Boolean);

    if (wordUnits.length > 1) {
      return this.packUnitsIntoPages(wordUnits, " ", block);
    }

    return [block];
  }

  private async packUnitsIntoPages(
    units: string[],
    joiner: string,
    sourceBlock: MarkdownBlock,
  ): Promise<MarkdownBlock[]> {
    const pages: MarkdownBlock[] = [];
    let currentUnits: string[] = [];

    const pushCurrent = (): void => {
      const pageMarkdown = currentUnits.join(joiner).trim();

      if (pageMarkdown) {
        pages.push({
          markdown: pageMarkdown,
          startOffset: sourceBlock.startOffset,
          endOffset: sourceBlock.endOffset,
        });
      }

      currentUnits = [];
    };

    for (const unit of units) {
      const candidate = [...currentUnits, unit].join(joiner).trim();

      if (candidate && (await this.pageFits(candidate))) {
        currentUnits.push(unit);
        continue;
      }

      if (currentUnits.length) {
        pushCurrent();
      }

      currentUnits = [unit];

      if (!(await this.pageFits(unit))) {
        pushCurrent();
      }
    }

    if (currentUnits.length) {
      pushCurrent();
    }

    return pages.length ? pages : [{
      markdown: units.join(joiner),
      startOffset: sourceBlock.startOffset,
      endOffset: sourceBlock.endOffset,
    }];
  }

  private async pageFits(markdown: string): Promise<boolean> {
    if (!this.measurePageEl || !this.measureContentEl) {
      return true;
    }

    this.measureContentEl.empty();
    await this.renderMarkdownInto(this.measureContentEl, markdown, false);

    return (
      this.measureContentEl.scrollHeight <= this.measureContentEl.clientHeight + PAGE_OVERFLOW_TOLERANCE &&
      this.measureContentEl.scrollWidth <= this.measureContentEl.clientWidth + PAGE_OVERFLOW_TOLERANCE
    );
  }

  private async renderMarkdownInto(targetEl: HTMLElement, markdown: string, persistent: boolean): Promise<void> {
    const renderComponent = persistent ? this.addChild(new Component()) : new Component();

    if (persistent) {
      this.pageComponents.push(renderComponent);
    } else {
      renderComponent.load();
    }

    try {
      await MarkdownRenderer.render(
        this.app,
        markdown,
        targetEl,
        this.file?.path ?? "",
        renderComponent,
      );
    } finally {
      if (!persistent) {
        renderComponent.unload();
      }
    }
  }

  private cleanupPageComponents(): void {
    for (const component of this.pageComponents) {
      this.removeChild(component);
    }

    this.pageComponents = [];
  }

  private getPagesPerSpread(): number {
    const usableWidth = this.contentEl.clientWidth;
    const twoPageWidth = (this.plugin.settings.pageWidth * 2) + this.plugin.settings.pageGap + 80;
    return usableWidth >= twoPageWidth ? 2 : 1;
  }

  private normalizePageIndex(pageIndex: number, pagesPerSpread: number): number {
    if (!this.pages.length) {
      return 0;
    }

    const maxStartIndex = this.getMaxStartIndex(pagesPerSpread);
    let normalized = Math.min(Math.max(0, pageIndex), maxStartIndex);

    if (pagesPerSpread === 2) {
      normalized -= normalized % 2;
    }

    return normalized;
  }

  private getMaxStartIndex(pagesPerSpread: number): number {
    return Math.max(0, this.pages.length - pagesPerSpread);
  }

  private findPageIndexForOffset(offset: number): number {
    const rawIndex = this.pages.findIndex((page) => {
      if (page.startOffset === null || page.endOffset === null) {
        return false;
      }

      return offset >= page.startOffset && offset <= page.endOffset;
    });

    if (rawIndex >= 0) {
      return this.normalizePageIndex(rawIndex, this.getPagesPerSpread());
    }

    const nearestIndex = this.pages.findIndex((page) => page.startOffset !== null && page.startOffset > offset);

    if (nearestIndex > 0) {
      return this.normalizePageIndex(nearestIndex - 1, this.getPagesPerSpread());
    }

    return nearestIndex === 0
      ? this.normalizePageIndex(0, this.getPagesPerSpread())
      : -1;
  }
}

class BookModeSettingTab extends PluginSettingTab {
  private readonly plugin: BookModePlugin;

  constructor(app: App, plugin: BookModePlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Book Mode" });

    new Setting(containerEl)
      .setName("Page width")
      .setDesc("Width of each page in pixels.")
      .addText((text) => {
        text
          .setPlaceholder("420")
          .setValue(String(this.plugin.settings.pageWidth))
          .onChange((value) => {
            const pageWidth = clampNumber(value, MIN_PAGE_WIDTH, 900, DEFAULT_SETTINGS.pageWidth);
            void this.plugin.updateSettings({ pageWidth });
          });
      });

    new Setting(containerEl)
      .setName("Page height")
      .setDesc("Height of each page in pixels.")
      .addText((text) => {
        text
          .setPlaceholder("560")
          .setValue(String(this.plugin.settings.pageHeight))
          .onChange((value) => {
            const pageHeight = clampNumber(value, MIN_PAGE_HEIGHT, 1200, DEFAULT_SETTINGS.pageHeight);
            void this.plugin.updateSettings({ pageHeight });
          });
      });

    new Setting(containerEl)
      .setName("Page gap")
      .setDesc("Horizontal gap between pages in pixels.")
      .addText((text) => {
        text
          .setPlaceholder("28")
          .setValue(String(this.plugin.settings.pageGap))
          .onChange((value) => {
            const pageGap = clampNumber(value, 0, 120, DEFAULT_SETTINGS.pageGap);
            void this.plugin.updateSettings({ pageGap });
          });
      });

    new Setting(containerEl)
      .setName("Font scale")
      .setDesc("Reader font size percentage.")
      .addText((text) => {
        text
          .setPlaceholder("100")
          .setValue(String(this.plugin.settings.fontScalePercent))
          .onChange((value) => {
            const fontScalePercent = clampNumber(value, 70, 180, DEFAULT_SETTINGS.fontScalePercent);
            void this.plugin.updateSettings({ fontScalePercent });
          });
      });

    new Setting(containerEl)
      .setName("Default focus mode")
      .setDesc("Hide the top toolbar when Book Mode opens.")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.defaultFocusMode)
          .onChange((defaultFocusMode) => {
            void this.plugin.updateSettings({ defaultFocusMode });
          });
      });

    new Setting(containerEl)
      .setName("Open notes in Book Mode by default")
      .setDesc("When enabled, opening a note automatically switches that leaf into Book Mode. Use the folder list below to limit where this happens.")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.openInBookModeByDefault)
          .onChange((openInBookModeByDefault) => {
            void this.plugin.updateSettings({ openInBookModeByDefault });
          });
      });

    new Setting(containerEl)
      .setName("Auto-open folders")
      .setDesc("One vault-relative folder path per line. 'books' matches everything under books/. 'books/audiobooks' matches only that subtree.")
      .addTextArea((text) => {
        text
          .setPlaceholder("books\nreading/longform")
          .setValue(this.plugin.settings.autoOpenFolderPaths.join("\n"))
          .onChange((value) => {
            const autoOpenFolderPaths = value
              .split("\n")
              .map(normalizeFolderPath)
              .filter(Boolean);

            void this.plugin.updateSettings({ autoOpenFolderPaths });
          });

        text.inputEl.rows = 4;
        text.inputEl.cols = 32;
      });

    new Setting(containerEl)
      .setName("Debug mode")
      .setDesc("Log auto-open decisions to the developer console. Helpful when Book Mode seems inconsistent.")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.debugMode)
          .onChange((debugMode) => {
            void this.plugin.updateSettings({ debugMode });
          });
      });

    new Setting(containerEl)
      .setName("Cover page")
      .setDesc("Insert a generated cover page before the note content.")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.showCoverPage)
          .onChange((showCoverPage) => {
            void this.plugin.updateSettings({ showCoverPage });
          });
      });

    new Setting(containerEl)
      .setName("Animate page turns")
      .setDesc("Adds a small motion effect when pages rerender.")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.animatePageTurns)
          .onChange((animatePageTurns) => {
            void this.plugin.updateSettings({ animatePageTurns });
          });
      });
  }
}

function normalizeViewState(state: unknown): BookModeViewState {
  if (!state || typeof state !== "object") {
    return {};
  }

  const maybeState = state as Record<string, unknown>;

  return {
    file: typeof maybeState.file === "string" ? maybeState.file : undefined,
    pageIndex: typeof maybeState.pageIndex === "number" ? maybeState.pageIndex : undefined,
    focusMode: typeof maybeState.focusMode === "boolean" ? maybeState.focusMode : undefined,
  };
}

function splitMarkdownIntoBlocks(markdown: string): MarkdownBlock[] {
  if (!markdown.trim()) {
    return [];
  }

  const lines = markdown.split("\n");
  const blocks: MarkdownBlock[] = [];
  let currentBlock: string[] = [];
  let currentBlockStart: number | null = null;
  let currentBlockEnd: number | null = null;
  let inFence = false;
  let cursor = 0;

  const flush = (): void => {
    const block = currentBlock.join("\n").trim();

    if (block && currentBlockStart !== null && currentBlockEnd !== null) {
      blocks.push({
        markdown: block,
        startOffset: currentBlockStart,
        endOffset: currentBlockEnd,
      });
    }

    currentBlock = [];
    currentBlockStart = null;
    currentBlockEnd = null;
  };

  for (const line of lines) {
    const lineStart = cursor;
    const lineEnd = lineStart + line.length;
    const trimmed = line.trim();

    if (/^(```+|~~~+)/.test(trimmed)) {
      if (currentBlockStart === null) {
        currentBlockStart = lineStart;
      }

      currentBlock.push(line);
      currentBlockEnd = lineEnd;
      inFence = !inFence;

      if (!inFence) {
        flush();
      }

      cursor = lineEnd + 1;
      continue;
    }

    if (!inFence && trimmed === "") {
      flush();
      cursor = lineEnd + 1;
      continue;
    }

    if (currentBlockStart === null) {
      currentBlockStart = lineStart;
    }

    currentBlock.push(line);
    currentBlockEnd = lineEnd;
    cursor = lineEnd + 1;
  }

  flush();

  return blocks;
}

function splitIntoSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+(?=[A-Z0-9#*_`[(])/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function joinBlocks(blocks: string[]): string {
  return blocks
    .map((block) => block.trim())
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

function isHardToSplitBlock(block: string): boolean {
  const trimmed = block.trim();
  return (
    /^(```|~~~)/.test(trimmed) ||
    /^\|.*\|$/m.test(trimmed) ||
    /^!\[[^\]]*\]\([^)]+\)$/.test(trimmed)
  );
}

function buildCoverPageMarkdown(file: TFile): string {
  return `# ${file.basename}\n\n${file.path}\n\nUse the left and right arrow keys to turn pages.`;
}

function clampNumber(
  value: string,
  min: number,
  max: number,
  fallback: number,
): number {
  const parsed = Number.parseInt(value, 10);

  if (Number.isNaN(parsed)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, parsed));
}

function normalizeFolderPath(value: string): string {
  return value.trim().replace(/^\/+|\/+$/g, "");
}

function getLeafFilePath(leaf: WorkspaceLeaf | null | undefined): string | null {
  const view = leaf?.view;

  if (view instanceof MarkdownView) {
    return view.file?.path ?? null;
  }

  if (view instanceof BookModeView) {
    return view.getFile()?.path ?? null;
  }

  return null;
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  return Boolean(target.closest("input, textarea, [contenteditable='true']"));
}
