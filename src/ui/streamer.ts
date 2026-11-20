import * as vscode from 'vscode';
import { CodeChunk } from '../types/protocol.js';
import { ChalkMarkManager } from './chalkMarkManager.js';
import { CameraController } from './cameraController.js';

export interface StreamResult {
  editor: vscode.TextEditor;
  actualStartLine: number;
  actualEndLine: number;
  renderedText: string;
}

export interface StreamOptions {
  /** Override streaming animation (e.g. during Auto-Finish File) */
  instant?: boolean;
  delayMs?: number;
  mode?: 'line' | 'token';
}

/**
 * Streams a CodeChunk progressively onto the active TextEditor ("Drawing on the board")
 * while keeping the active Blue Chalk border synchronized with the growing range.
 */
export class ChunkStreamer {
  private cancelRequested = false;

  constructor(
    private readonly camera: CameraController,
    private readonly markManager: ChalkMarkManager
  ) {}

  /** If called mid-stream, immediately finishes drawing the rest of the active chunk. */
  public finishCurrentImmediately(): void {
    this.cancelRequested = true;
  }

  public async streamChunk(
    chunk: CodeChunk,
    options?: StreamOptions
  ): Promise<StreamResult> {
    this.cancelRequested = false;

    const config = vscode.workspace.getConfiguration('chalk.streaming');
    const enabled = options?.instant ? false : config.get<boolean>('enabled', true);
    const delayMs = options?.delayMs ?? config.get<number>('delayMs', 22);
    const mode = options?.mode ?? config.get<'line' | 'token'>('mode', 'line');

    const editor = await this.camera.openOrCreateDocument(chunk.filePath, {
      viewColumn: vscode.ViewColumn.One,
      preserveFocus: false,
      createIfMissing: true,
    });

    const doc = editor.document;
    const normalizedCode = chunk.code.replace(/\r\n/g, '\n');

    // Compute initial insertion/replacement anchor in 0-based coordinates
    const { replaceRange, insertLineZero } = computeTargetRange(doc, chunk);

    // Clear target range first if replacing existing lines
    if (!replaceRange.isEmpty) {
      await editor.edit(
        (editBuilder) => {
          editBuilder.delete(replaceRange);
        },
        { undoStopBefore: true, undoStopAfter: false }
      );
    }

    const startPos = new vscode.Position(insertLineZero, 0);
    const actualStartLine = insertLineZero + 1;

    if (!enabled || delayMs <= 0) {
      // Instant write (used when streaming disabled or Auto-Finish is active)
      await editor.edit(
        (editBuilder) => {
          editBuilder.insert(startPos, normalizedCode);
        },
        { undoStopBefore: replaceRange.isEmpty, undoStopAfter: true }
      );
      const lineCount = normalizedCode.split('\n').length;
      const actualEndLine = actualStartLine + Math.max(0, lineCount - 1);
      this.markManager.setActiveChunk(doc.uri, actualStartLine, actualEndLine, chunk.summary);
      this.camera.revealLines(editor, actualStartLine, actualEndLine);
      await doc.save();
      return { editor, actualStartLine, actualEndLine, renderedText: normalizedCode };
    }

    // Progressive line or token streaming
    const pieces =
      mode === 'token'
        ? tokenizeForStream(normalizedCode)
        : splitLinesPreservingNewlines(normalizedCode);

    let cursorPos = startPos;
    let drawnLines = 0;

    for (let i = 0; i < pieces.length; i++) {
      if (this.cancelRequested) {
        const remaining = pieces.slice(i).join('');
        if (remaining.length > 0) {
          await editor.edit(
            (eb) => eb.insert(cursorPos, remaining),
            { undoStopBefore: false, undoStopAfter: true }
          );
          cursorPos = advancePosition(cursorPos, remaining);
        }
        break;
      }

      const piece = pieces[i];
      await editor.edit(
        (eb) => eb.insert(cursorPos, piece),
        {
          undoStopBefore: i === 0 && replaceRange.isEmpty,
          undoStopAfter: i === pieces.length - 1,
        }
      );

      cursorPos = advancePosition(cursorPos, piece);
      drawnLines = cursorPos.line - insertLineZero;
      const currentEndLine = actualStartLine + Math.max(0, drawnLines);

      this.markManager.setActiveChunk(doc.uri, actualStartLine, currentEndLine, chunk.summary);
      if (i % 3 === 0 || i === pieces.length - 1) {
        this.camera.revealLines(editor, actualStartLine, currentEndLine);
      }

      if (i < pieces.length - 1) {
        await sleep(delayMs);
      }
    }

    const totalLines = normalizedCode.split('\n').length;
    const actualEndLine = actualStartLine + Math.max(0, totalLines - 1);
    this.markManager.setActiveChunk(doc.uri, actualStartLine, actualEndLine, chunk.summary);
    this.camera.revealLines(editor, actualStartLine, actualEndLine);
    await doc.save();

    return {
      editor,
      actualStartLine,
      actualEndLine,
      renderedText: normalizedCode,
    };
  }
}

function computeTargetRange(
  doc: vscode.TextDocument,
  chunk: CodeChunk
): { replaceRange: vscode.Range; insertLineZero: number } {
  const mode = chunk.mode ?? 'replace';

  // Empty document: always insert at (0, 0)
  if (doc.getText().length === 0) {
    return {
      replaceRange: new vscode.Range(0, 0, 0, 0),
      insertLineZero: 0,
    };
  }

  if (mode === 'append') {
    const lastLine = Math.max(0, doc.lineCount - 1);
    const lastLen = doc.lineAt(lastLine).text.length;
    const pos = new vscode.Position(lastLine, lastLen);
    return {
      replaceRange: new vscode.Range(pos, pos),
      insertLineZero: lastLine,
    };
  }

  const maxLineZero = Math.max(0, doc.lineCount - 1);
  const startZero = Math.max(0, Math.min(chunk.startLine - 1, maxLineZero));

  if (mode === 'insert') {
    const pos = new vscode.Position(startZero, 0);
    return {
      replaceRange: new vscode.Range(pos, pos),
      insertLineZero: startZero,
    };
  }

  // 'replace' mode: replace lines startLine..endLine (clamped to existing document)
  const endZero = Math.max(startZero, Math.min(chunk.endLine - 1, maxLineZero));
  const endCol = doc.lineAt(endZero).text.length;
  return {
    replaceRange: new vscode.Range(startZero, 0, endZero, endCol),
    insertLineZero: startZero,
  };
}

function splitLinesPreservingNewlines(text: string): string[] {
  const rawLines = text.split('\n');
  return rawLines.map((line, idx) => (idx < rawLines.length - 1 ? `${line}\n` : line));
}

function tokenizeForStream(text: string): string[] {
  // Split into compact ~4-token visual bursts so token streaming feels fluid rather than sluggish
  const tokens = text.match(/(\s+|\w+|[^\s\w]+)/g) ?? [text];
  const groups: string[] = [];
  let buf = '';
  for (const tok of tokens) {
    buf += tok;
    if (buf.length >= 12 || tok.includes('\n')) {
      groups.push(buf);
      buf = '';
    }
  }
  if (buf.length > 0) {
    groups.push(buf);
  }
  return groups;
}

function advancePosition(pos: vscode.Position, inserted: string): vscode.Position {
  const parts = inserted.split('\n');
  if (parts.length === 1) {
    return new vscode.Position(pos.line, pos.character + parts[0].length);
  }
  return new vscode.Position(
    pos.line + parts.length - 1,
    parts[parts.length - 1].length
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
