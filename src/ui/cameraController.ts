import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { ChalkMarkInstruction, ChalkTourStep } from '../types/protocol.js';
import { ChalkMarkManager } from './chalkMarkManager.js';

export interface TourState {
  active: boolean;
  steps: ChalkTourStep[];
  currentIndex: number;
}

/**
 * Anti-Whiplash Viewport Engine & Interactive Step-Through Tour Player.
 * Smoothly focuses chunks, opens cross-file references in Split View (ViewColumn.Beside)
 * without clobbering the developer's active tab, and manages [< Prev / Next >] navigation.
 */
export class CameraController implements vscode.Disposable {
  private tourSteps: ChalkTourStep[] = [];
  private tourIndex = -1;
  private onTourChangeCallback?: (state: TourState) => void;
  private openedSplitUris = new Set<string>();
  private readonly statusBarItem: vscode.StatusBarItem;

  constructor(private readonly markManager: ChalkMarkManager) {
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      90
    );
    this.statusBarItem.command = 'chalk.tourNext';
  }

  public getWorkspaceRoot(): string {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (folder) {
      return folder.uri.fsPath;
    }
    return process.cwd();
  }

  /** Resolve a workspace-relative or absolute path into a vscode.Uri. */
  public resolveUri(filePath: string): vscode.Uri {
    if (path.isAbsolute(filePath)) {
      return vscode.Uri.file(filePath);
    }
    return vscode.Uri.file(path.resolve(this.getWorkspaceRoot(), filePath));
  }

  /** Ensure a file exists on disk (creating parent dirs if needed) and open it in an editor. */
  public async openOrCreateDocument(
    filePath: string,
    options?: { viewColumn?: vscode.ViewColumn; preserveFocus?: boolean; createIfMissing?: boolean }
  ): Promise<vscode.TextEditor> {
    const uri = this.resolveUri(filePath);
    if (options?.createIfMissing && !fs.existsSync(uri.fsPath)) {
      fs.mkdirSync(path.dirname(uri.fsPath), { recursive: true });
      fs.writeFileSync(uri.fsPath, '', 'utf8');
    }

    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc, {
      viewColumn: options?.viewColumn ?? vscode.ViewColumn.One,
      preserveFocus: options?.preserveFocus ?? false,
      preview: false,
    });
    return editor;
  }

  /**
   * Anti-whiplash viewport focus: reveals the line range centered only if outside viewport.
   */
  public async focusChunk(
    filePath: string,
    startLine: number,
    endLine: number,
    options?: { viewColumn?: vscode.ViewColumn; preserveFocus?: boolean; createIfMissing?: boolean }
  ): Promise<vscode.TextEditor> {
    const editor = await this.openOrCreateDocument(filePath, options);
    this.revealLines(editor, startLine, endLine);
    return editor;
  }

  public revealLines(editor: vscode.TextEditor, startLine: number, endLine: number): void {
    const maxLine = Math.max(0, editor.document.lineCount - 1);
    const start = Math.max(0, Math.min(startLine - 1, maxLine));
    const end = Math.max(start, Math.min(endLine - 1, maxLine));
    const range = new vscode.Range(start, 0, end, editor.document.lineAt(end).text.length);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }

  public onTourChange(cb: (state: TourState) => void): void {
    this.onTourChangeCallback = cb;
  }

  public getTourState(): TourState {
    return {
      active: this.tourSteps.length > 0 && this.tourIndex >= 0,
      steps: this.tourSteps,
      currentIndex: this.tourIndex,
    };
  }

  /** Start an interactive Chalk Tour ([< Prev] [Next >]) with optional split-view references. */
  public async startTour(steps: ChalkTourStep[]): Promise<void> {
    if (!steps || steps.length === 0) {
      return;
    }
    this.tourSteps = steps;
    this.tourIndex = 0;
    this.openedSplitUris.clear();
    await vscode.commands.executeCommand('setContext', 'chalk.tourActive', true);
    await this.renderCurrentTourStep();
  }

  public async nextStep(): Promise<ChalkTourStep | null> {
    if (this.tourSteps.length === 0) {
      return null;
    }
    if (this.tourIndex + 1 < this.tourSteps.length) {
      this.tourIndex += 1;
      await this.renderCurrentTourStep();
      return this.tourSteps[this.tourIndex];
    }
    // Reached end of tour — stay on last step and let user know
    vscode.window.setStatusBarMessage('$(check) Chalk Tour: reached final step', 2500);
    return this.tourSteps[this.tourIndex];
  }

  public async prevStep(): Promise<ChalkTourStep | null> {
    if (this.tourSteps.length === 0) {
      return null;
    }
    if (this.tourIndex > 0) {
      this.tourIndex -= 1;
      await this.renderCurrentTourStep();
      return this.tourSteps[this.tourIndex];
    }
    return this.tourSteps[0];
  }

  public async goToStep(index: number): Promise<ChalkTourStep | null> {
    if (index < 0 || index >= this.tourSteps.length) {
      return null;
    }
    this.tourIndex = index;
    await this.renderCurrentTourStep();
    return this.tourSteps[this.tourIndex];
  }

  public async stopTour(closeSplitRefs = true): Promise<void> {
    this.tourSteps = [];
    this.tourIndex = -1;
    await vscode.commands.executeCommand('setContext', 'chalk.tourActive', false);
    this.statusBarItem.hide();
    this.markManager.clearMarks(true);

    if (closeSplitRefs && this.openedSplitUris.size > 0) {
      await this.cleanupSplitEditors();
    }
    this.openedSplitUris.clear();
    this.emitTourState();
  }

  private async renderCurrentTourStep(): Promise<void> {
    const step = this.tourSteps[this.tourIndex];
    if (!step) {
      return;
    }

    const marks: ChalkMarkInstruction[] = [step.primaryMark];
    if (step.referenceMark) {
      marks.push(step.referenceMark);
    }

    // 1. Focus primary mark in primary column
    await this.focusChunk(
      step.primaryMark.filePath,
      step.primaryMark.startLine,
      step.primaryMark.endLine,
      { viewColumn: vscode.ViewColumn.One, preserveFocus: false }
    );

    // 2. If there is a cross-file reference mark, open it in ViewColumn.Beside without stealing focus
    if (step.referenceMark) {
      const refUri = this.resolveUri(step.referenceMark.filePath);
      const primaryUri = this.resolveUri(step.primaryMark.filePath);
      const isCrossFile = refUri.toString() !== primaryUri.toString();

      if (fs.existsSync(refUri.fsPath)) {
        if (isCrossFile && step.referenceMark.openInSplitView !== false) {
          this.openedSplitUris.add(refUri.toString());
          await this.focusChunk(
            step.referenceMark.filePath,
            step.referenceMark.startLine,
            step.referenceMark.endLine,
            { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }
          );
        } else if (!isCrossFile) {
          // Same-file reference: just mark it without splitting
        }
      }
    }

    // 3. Apply green/color Chalk Marks across both editors
    this.markManager.applyMarks(marks, (fp) => this.resolveUri(fp), false);

    // 4. Update status bar indicator
    this.statusBarItem.text = `$(compass) Chalk Tour ${this.tourIndex + 1}/${this.tourSteps.length} (Next ▸)`;
    this.statusBarItem.tooltip = step.explanationMarkdown;
    this.statusBarItem.show();

    this.emitTourState();
  }

  private async cleanupSplitEditors(): Promise<void> {
    try {
      for (const group of vscode.window.tabGroups.all) {
        // Only close tabs in secondary columns that Chalk opened during the tour
        if (group.viewColumn === vscode.ViewColumn.One) {
          continue;
        }
        for (const tab of group.tabs) {
          const input = tab.input;
          if (
            input instanceof vscode.TabInputText &&
            this.openedSplitUris.has(input.uri.toString())
          ) {
            await vscode.window.tabGroups.close(tab, true);
          }
        }
      }
    } catch {
      // Best-effort cleanup; never fail user flow if tab was already closed
    }
  }

  private emitTourState(): void {
    this.onTourChangeCallback?.(this.getTourState());
  }

  public dispose(): void {
    this.statusBarItem.dispose();
  }
}
