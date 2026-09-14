export interface NodeImage { id: string; dataUrl: string; width: number; height: number; naturalWidth: number; naturalHeight: number }
export interface MindNode { id: string; text: string; children: string[]; collapsed: boolean; images?: NodeImage[] }
export interface MindDocument { format: 'inkmap'; version: 1; id: string; title: string; rootId: string; nodes: Record<string, MindNode>; columnWidths?: Record<string, number> }
export interface RecentFile { path: string; title: string; updatedAt: string }
export interface LibraryEntry { kind: 'folder' | 'map'; path: string; name: string; title?: string; children?: LibraryEntry[]; invalid?: boolean }
export interface LibrarySnapshot { root: string; entries: LibraryEntry[] }
export interface LibraryMutation { library: LibrarySnapshot; session?: Session; notice?: string }
export interface Session { doc: MindDocument | null; path: string; token: string; recent: RecentFile[]; notice?: string }
export interface View { x: number; y: number; scale: number }
export type Theme = 'light' | 'dark';
export interface DesktopAPI {
  initialTheme: Theme;
  getTheme(): Promise<Theme>;
  setTheme(theme: Theme): Promise<Theme>;
  boot(): Promise<Session>;
  save(doc: MindDocument, token: string): Promise<{ path: string }>;
  newDocument(folderPath?: string): Promise<Session>;
  library(): Promise<LibrarySnapshot>;
  createFolder(name: string, parentPath?: string): Promise<LibrarySnapshot>;
  moveLibraryItem(sourcePath: string, targetFolderPath: string): Promise<LibraryMutation>;
  renameLibraryItem(sourcePath: string, name: string): Promise<LibraryMutation>;
  deleteLibraryItem(sourcePath: string): Promise<LibraryMutation>;
  arrangeLibraryItem(sourcePath: string, targetPath: string, position: 'before' | 'after' | 'inside'): Promise<LibraryMutation>;
  onLibraryChange(callback: () => void): () => void;
  open(path?: string): Promise<Session | null>;
  saveAs(doc: MindDocument, token: string): Promise<{ path: string } | null>;
  exportMarkdown(text: string, title: string): Promise<string | null>;
  exportPdf(options: { width: number; height: number; title: string }): Promise<string | null>;
  copy(text: string): Promise<void>;
  copyImage(image: NodeImage): Promise<void>;
  pasteImage(availableWidth?: number): Promise<NodeImage | null>;
  copyBranch(branch: MindDocument): Promise<void>;
  pasteBranch(): Promise<MindDocument | null>;
  pasteText(): Promise<string>;
  reveal(): Promise<void>;
  recent(): Promise<RecentFile[]>;
  onClose(callback: () => void): () => void;
  confirmClose(): void;
  onOpen(callback: (path: string) => void): () => void;
}
declare global { interface Window { inkmap?: DesktopAPI } }
