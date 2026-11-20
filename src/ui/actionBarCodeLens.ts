import * as vscode from 'vscode';
import { ChalkState, CodeChunk } from '../types/protocol.js';
import { TourState } from './cameraController.js';

export interface ActiveActionBarContext {
  chunk: CodeChunk;
  uri: vscode.Uri;
  startLine: number;
  endLine: number;
  state: ChalkState;
  tourState: TourState;
}

/**
 * Renders the non-intrusive inline Chalk Action Bar directly below the active chunk:
 *   [ ▶ Continue ]  [ /explain ]  [ /edge ]  [ /test ]  [ /followme ]  [ ⚡ Auto-Finish File ]  [ ↩ Undo Chunk ]
 * Plus tour navigation controls ([ < Prev ] [ Next > ]) when a Chalk Tour is active.
 */
export class ActionBarCodeLensProvider implements vscode.CodeLensProvider, vscode.Disposable {
  private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
  public readonly onDidChangeCodeLenses = this.onDidChangeEmitter.event;

  private activeContext: ActiveActionBarContext | null = null;

  public update(context: ActiveActionBarContext | null): void {
    this.activeContext = context;
    this.onDidChangeEmitter.fire();
  }

  public provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (!this.activeContext) {
      return [];
    }

    if (document.uri.toString() !== this.activeContext.uri.toString()) {
      return [];
    }

    const { chunk, startLine, endLine, state, tourState } = this.activeContext;
    const maxLine = Math.max(0, document.lineCount - 1);
    const topLine = Math.max(0, Math.min(startLine - 1, maxLine));
    const bottomLine = Math.max(topLine, Math.min(endLine - 1, maxLine));

    const lenses: vscode.CodeLens[] = [];

    // Header badge at chunk start
    const topRange = new vscode.Range(topLine, 0, topLine, 0);
    const statusLabel =
      state === 'DRAWING_CHUNK'
        ? '$(sync~spin) Drawing on board...'
        : state === 'SIDE_SESSION_ACTIVE'
          ? '$(comment-discussion) Side-Chat Active'
          : '$(mortar-board) Chalk';

    lenses.push(
      new vscode.CodeLens(topRange, {
        title: `${statusLabel} · Step ${chunk.stepNumber} (${chunk.chunkIndex}/${chunk.totalChunksInStep}): ${truncate(chunk.summary, 68)}`,
        command: 'chalk.openInlineWidget',
        tooltip: 'Open Chalk Side-Chat Widget for this chunk',
      })
    );

    // Tour controls right at top if a tour is running
    if (tourState.active) {
      lenses.push(
        new vscode.CodeLens(topRange, {
          title: `$(chevron-left) Prev`,
          command: 'chalk.tourPrev',
          tooltip: 'Previous Chalk Tour step (Alt+[)',
        }),
        new vscode.CodeLens(topRange, {
          title: `Next $(chevron-right) (${tourState.currentIndex + 1}/${tourState.steps.length})`,
          command: 'chalk.tourNext',
          tooltip: 'Next Chalk Tour step (Alt+])',
        }),
        new vscode.CodeLens(topRange, {
          title: `$(close) End Tour`,
          command: 'chalk.tourStop',
          tooltip: 'Stop tour and clear highlights',
        })
      );
    }

    // Inline Action Bar anchored at chunk.endLine when awaiting dev action or in side session
    if (state === 'AWAITING_DEV_ACTION' || state === 'SIDE_SESSION_ACTIVE') {
      const barRange = new vscode.Range(bottomLine, 0, bottomLine, 0);

      lenses.push(
        new vscode.CodeLens(barRange, {
          title: '$(play) Continue',
          command: 'chalk.continue',
          tooltip: 'Erase board, squash edits into a diff, and continue to next chunk (Ctrl+Alt+Enter)',
        }),
        new vscode.CodeLens(barRange, {
          title: '/explain',
          command: 'chalk.runSlashCommand',
          arguments: ['/explain'],
          tooltip: 'Launch interactive Chalk Tour explaining this chunk',
        }),
        new vscode.CodeLens(barRange, {
          title: '/edge',
          command: 'chalk.runSlashCommand',
          arguments: ['/edge'],
          tooltip: 'Audit chunk for edge cases, null hazards, and failure modes',
        }),
        new vscode.CodeLens(barRange, {
          title: '/test',
          command: 'chalk.runSlashCommand',
          arguments: ['/test'],
          tooltip: 'Run isolated Mocking REPL test against this chunk',
        }),
        new vscode.CodeLens(barRange, {
          title: '/followme',
          command: 'chalk.runSlashCommand',
          arguments: ['/followme'],
          tooltip: 'Start bidirectional live coding coaching on this chunk',
        }),
        new vscode.CodeLens(barRange, {
          title: '$(comment-discussion) Ask /btw',
          command: 'chalk.openInlineWidget',
          tooltip: 'Open isolated Chalk Side-Chat (/trace, /alt, /history, or any question)',
        }),
        new vscode.CodeLens(barRange, {
          title: '$(zap) Auto-Finish File',
          command: 'chalk.autoFinishFile',
          tooltip: 'Stream remaining chunks in this file without pausing',
        }),
        new vscode.CodeLens(barRange, {
          title: '$(discard) Undo Chunk',
          command: 'chalk.undoChunk',
          tooltip: 'Revert file to pre-chunk Git shadow checkpoint',
        })
      );
    }

    return lenses;
  }

  public dispose(): void {
    this.onDidChangeEmitter.dispose();
  }
}

function truncate(str: string, max: number): string {
  if (str.length <= max) {
    return str;
  }
  return `${str.slice(0, max - 1)}…`;
}
