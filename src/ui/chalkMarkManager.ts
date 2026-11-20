import * as vscode from 'vscode';
import {
  ChalkMarkColor,
  ChalkMarkInstruction,
  GhostTextAnnotation,
} from '../types/protocol.js';

function svgDataUri(svg: string): vscode.Uri {
  return vscode.Uri.parse(`data:image/svg+xml;utf8,${encodeURIComponent(svg)}`);
}

const AMBER_GUTTER_ICON = svgDataUri(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16">` +
    `<path fill="#f59e0b" d="M8 1.5L14.8 13.5H1.2L8 1.5z"/>` +
    `<rect x="7.3" y="5.5" width="1.4" height="4.2" fill="#1e1e1e"/>` +
    `<circle cx="8" cy="11.4" r="0.9" fill="#1e1e1e"/>` +
    `</svg>`
);

const GREEN_GUTTER_ICON = svgDataUri(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16">` +
    `<circle cx="8" cy="8" r="5" fill="#22c55e"/>` +
    `</svg>`
);

interface ActiveChunkState {
  uriString: string;
  startLine: number;
  endLine: number;
  summary?: string;
}

/**
 * Manages all visual Chalk Marks (Blue/Green/Amber/Red) and inline Ghost Chalk
 * annotations across visible TextEditors.
 */
export class ChalkMarkManager implements vscode.Disposable {
  private readonly activeChunkBorder: vscode.TextEditorDecorationType;
  private readonly greenChalkPointer: vscode.TextEditorDecorationType;
  private readonly amberChalkWarning: vscode.TextEditorDecorationType;
  private readonly redChalkAlert: vscode.TextEditorDecorationType;
  private readonly ghostChalkDecoration: vscode.TextEditorDecorationType;

  private activeChunk: ActiveChunkState | null = null;
  private marksByUri = new Map<string, ChalkMarkInstruction[]>();
  private ghostByUri = new Map<string, GhostTextAnnotation[]>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor() {
    this.activeChunkBorder = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: 'rgba(59, 130, 246, 0.08)',
      borderWidth: '0 0 0 3px',
      borderStyle: 'solid',
      borderColor: 'rgba(96, 165, 250, 0.85)',
      overviewRulerColor: 'rgba(96, 165, 250, 0.85)',
      overviewRulerLane: vscode.OverviewRulerLane.Left,
    });

    this.greenChalkPointer = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: 'rgba(34, 197, 94, 0.14)',
      borderWidth: '0 0 0 3px',
      borderStyle: 'solid',
      borderColor: 'rgba(34, 197, 94, 0.95)',
      gutterIconPath: GREEN_GUTTER_ICON,
      gutterIconSize: '65%',
      overviewRulerColor: '#22c55e',
      overviewRulerLane: vscode.OverviewRulerLane.Center,
    });

    this.amberChalkWarning = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: 'rgba(245, 158, 11, 0.14)',
      borderWidth: '0 0 0 3px',
      borderStyle: 'solid',
      borderColor: 'rgba(245, 158, 11, 0.95)',
      gutterIconPath: AMBER_GUTTER_ICON,
      gutterIconSize: '80%',
      overviewRulerColor: '#f59e0b',
      overviewRulerLane: vscode.OverviewRulerLane.Right,
    });

    this.redChalkAlert = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: 'rgba(239, 68, 68, 0.14)',
      borderWidth: '0 0 0 3px',
      borderStyle: 'solid',
      borderColor: 'rgba(239, 68, 68, 0.95)',
      overviewRulerColor: '#ef4444',
      overviewRulerLane: vscode.OverviewRulerLane.Right,
    });

    this.ghostChalkDecoration = vscode.window.createTextEditorDecorationType({
      after: {
        margin: '0 0 0 1.5em',
        color: 'rgba(148, 163, 184, 0.92)',
        fontStyle: 'italic',
      },
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedOpen,
    });

    // Reapply decorations whenever editors open or become visible
    this.disposables.push(
      vscode.window.onDidChangeVisibleTextEditors((editors) => {
        for (const editor of editors) {
          this.reapplyForEditor(editor);
        }
      })
    );
  }

  /** Set the active Blue Chalk focus border around the currently streaming / paused chunk. */
  public setActiveChunk(
    uri: vscode.Uri,
    startLine: number,
    endLine: number,
    summary?: string
  ): void {
    this.activeChunk = {
      uriString: uri.toString(),
      startLine: Math.max(1, startLine),
      endLine: Math.max(Math.max(1, startLine), endLine),
      summary,
    };
    this.reapplyAllVisible();
  }

  public clearActiveChunk(): void {
    this.activeChunk = null;
    this.reapplyAllVisible();
  }

  /** Apply one or more ChalkMarkInstructions (replaces previous marks of those colors unless append=true). */
  public applyMarks(
    marks: ChalkMarkInstruction[],
    resolveUri: (filePath: string) => vscode.Uri,
    append = false
  ): void {
    if (!append) {
      this.marksByUri.clear();
    }
    for (const mark of marks) {
      const uri = resolveUri(mark.filePath);
      const key = uri.toString();
      const existing = this.marksByUri.get(key) ?? [];
      existing.push(mark);
      this.marksByUri.set(key, existing);
    }
    this.reapplyAllVisible();
  }

  /** Render inline Ghost Chalk annotations (live values, trace states, brief inline callouts). */
  public setGhostText(
    uri: vscode.Uri,
    annotations: GhostTextAnnotation[]
  ): void {
    this.ghostByUri.set(uri.toString(), annotations);
    this.reapplyAllVisible();
  }

  public clearGhostText(uri?: vscode.Uri): void {
    if (uri) {
      this.ghostByUri.delete(uri.toString());
    } else {
      this.ghostByUri.clear();
    }
    this.reapplyAllVisible();
  }

  /** Clear Chalk Marks and Ghost Text, optionally keeping the active Blue Chalk chunk border. */
  public clearMarks(keepActiveChunk = true): void {
    this.marksByUri.clear();
    this.ghostByUri.clear();
    if (!keepActiveChunk) {
      this.activeChunk = null;
    }
    this.reapplyAllVisible();
  }

  public clearAll(): void {
    this.clearMarks(false);
  }

  public reapplyAllVisible(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      this.reapplyForEditor(editor);
    }
  }

  public reapplyForEditor(editor: vscode.TextEditor): void {
    const uriKey = editor.document.uri.toString();
    const maxLine = Math.max(0, editor.document.lineCount - 1);

    // 1. Active Blue Chalk chunk border
    const blueOptions: vscode.DecorationOptions[] = [];
    if (this.activeChunk && this.activeChunk.uriString === uriKey) {
      const start = clampLine(this.activeChunk.startLine - 1, maxLine);
      const end = clampLine(this.activeChunk.endLine - 1, maxLine);
      blueOptions.push({
        range: new vscode.Range(start, 0, end, editor.document.lineAt(end).text.length),
        hoverMessage: this.activeChunk.summary
          ? new vscode.MarkdownString(`**Chalk Active Chunk:** ${this.activeChunk.summary}`)
          : undefined,
      });
    }

    // 2. Color-coded Chalk Marks
    const greenOptions: vscode.DecorationOptions[] = [];
    const amberOptions: vscode.DecorationOptions[] = [];
    const redOptions: vscode.DecorationOptions[] = [];

    const marks = this.marksByUri.get(uriKey) ?? [];
    for (const mark of marks) {
      const start = clampLine(mark.startLine - 1, maxLine);
      const end = clampLine(mark.endLine - 1, maxLine);
      const endLineText = editor.document.lineAt(end).text;
      const option: vscode.DecorationOptions = {
        range: new vscode.Range(start, 0, end, endLineText.length),
        hoverMessage: mark.label
          ? new vscode.MarkdownString(`**Chalk (${mark.color}):** ${mark.label}`)
          : undefined,
      };

      if (mark.label) {
        option.renderOptions = {
          after: {
            contentText: `  ← ${mark.label}`,
            color: colorHex(mark.color),
            fontStyle: 'italic',
            margin: '0 0 0 1.2em',
          },
        };
      }

      switch (mark.color) {
        case 'green':
          greenOptions.push(option);
          break;
        case 'amber':
          amberOptions.push(option);
          break;
        case 'red':
          redOptions.push(option);
          break;
        case 'blue':
          blueOptions.push(option);
          break;
      }
    }

    editor.setDecorations(this.activeChunkBorder, blueOptions);
    editor.setDecorations(this.greenChalkPointer, greenOptions);
    editor.setDecorations(this.amberChalkWarning, amberOptions);
    editor.setDecorations(this.redChalkAlert, redOptions);

    // 3. Inline Ghost Chalk annotations
    const ghostAnnotations = this.ghostByUri.get(uriKey) ?? [];
    const ghostOptions: vscode.DecorationOptions[] = ghostAnnotations.map((ann) => {
      const lineIdx = clampLine(ann.line - 1, maxLine);
      const lineLen = editor.document.lineAt(lineIdx).text.length;
      const text = ann.text.startsWith('//') ? `  ${ann.text}` : `  // ${ann.text}`;
      return {
        range: new vscode.Range(lineIdx, lineLen, lineIdx, lineLen),
        renderOptions: {
          after: {
            contentText: text,
            color: ann.color ? colorHex(ann.color) : 'rgba(148, 163, 184, 0.92)',
            fontStyle: 'italic',
          },
        },
      };
    });
    editor.setDecorations(this.ghostChalkDecoration, ghostOptions);
  }

  public dispose(): void {
    this.activeChunkBorder.dispose();
    this.greenChalkPointer.dispose();
    this.amberChalkWarning.dispose();
    this.redChalkAlert.dispose();
    this.ghostChalkDecoration.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}

function clampLine(zeroBased: number, maxLine: number): number {
  if (zeroBased < 0) {
    return 0;
  }
  if (zeroBased > maxLine) {
    return maxLine;
  }
  return zeroBased;
}

function colorHex(color: ChalkMarkColor): string {
  switch (color) {
    case 'green':
      return '#4ade80';
    case 'amber':
      return '#fbbf24';
    case 'red':
      return '#f87171';
    case 'blue':
      return '#60a5fa';
  }
}
