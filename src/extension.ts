import * as path from 'node:path';
import * as vscode from 'vscode';
import { LlmAgentPlayer } from './agent/llmAgentPlayer.js';
import { ChatMessage, LlmClient, LlmConfig, LlmProvider } from './agent/llmClient.js';
import { ShadowCheckpointManager } from './git/shadowCheckpoint.js';
import { ChalkMcpBridgeServer } from './mcp/server.js';
import { MockAgentPlayer } from './mock/mockAgentPlayer.js';
import { BoardEraserSquasher } from './sideAgent/boardEraserSquasher.js';
import { MockingRepl } from './sideAgent/mockingRepl.js';
import { SlashRouter } from './sideAgent/slashRouter.js';
import { TraceAndAltEngine } from './sideAgent/traceAndAlt.js';
import {
  AgentPlayer,
  AltProposal,
  ChalkState,
  ChalkTourStep,
  CodeChunk,
  DevAction,
  DevActionResolution,
  GhostTextAnnotation,
  TraceResult,
} from './types/protocol.js';
import { ActionBarCodeLensProvider } from './ui/actionBarCodeLens.js';
import { CameraController } from './ui/cameraController.js';
import { ChalkMarkManager } from './ui/chalkMarkManager.js';
import { HistoryScrubberController } from './ui/historyScrubber.js';
import { InlineWidgetController } from './ui/inlineWidgetController.js';
import { ChunkStreamer } from './ui/streamer.js';

interface ActiveChunkSession {
  chunk: CodeChunk;
  uri: vscode.Uri;
  startLine: number;
  endLine: number;
  bufferAfterDraw: string;
  resolveAction?: (resolution: DevActionResolution) => void;
}

/**
 * Central Chalk Coordinator managing the strict chunk lifecycle state machine:
 * IDLE -> SNAPSHOT_PRE_CHUNK -> DRAWING_CHUNK -> AWAITING_DEV_ACTION
 *      -> SIDE_SESSION_ACTIVE (optional) -> ERASING_THE_BOARD -> PLAN_RIPPLE_CHECK
 */
class ChalkCoordinator implements vscode.Disposable {
  private state: ChalkState = 'IDLE';
  private activeSession: ActiveChunkSession | null = null;
  private activePlayer: AgentPlayer | null = null;

  private readonly markManager: ChalkMarkManager;
  private readonly camera: CameraController;
  private readonly streamer: ChunkStreamer;
  private readonly codeLens: ActionBarCodeLensProvider;
  private readonly checkpoints: ShadowCheckpointManager;
  private readonly llmClient: LlmClient;
  private readonly mockingRepl: MockingRepl;
  private readonly traceAndAlt: TraceAndAltEngine;
  private readonly squasher: BoardEraserSquasher;
  private readonly slashRouter: SlashRouter;
  private readonly inlineWidget: InlineWidgetController;
  private readonly historyScrubber: HistoryScrubberController;
  private readonly mcpBridge: ChalkMcpBridgeServer;
  private readonly statusBar: vscode.StatusBarItem;
  private readonly disposables: vscode.Disposable[] = [];

  private followMeDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private activeTrace: { result: TraceResult; index: number; uri: vscode.Uri } | null = null;
  private ideLmModelLabel: string | null = null;

  constructor(private readonly extensionContext: vscode.ExtensionContext) {
    const workspaceRoot = this.getWorkspaceRoot();

    this.markManager = new ChalkMarkManager();
    this.camera = new CameraController(this.markManager);
    this.streamer = new ChunkStreamer(this.camera, this.markManager);
    this.codeLens = new ActionBarCodeLensProvider();
    this.checkpoints = new ShadowCheckpointManager(workspaceRoot);
    this.llmClient = new LlmClient(
      () => this.readLlmConfig(),
      {
        isAvailable: () => this.ideLmModelLabel !== null,
        describe: () => `IDE Language Model (${this.ideLmModelLabel ?? 'vscode.lm'})`,
        complete: (systemPrompt, messages) =>
          this.completeWithIdeLanguageModel(systemPrompt, messages),
      }
    );
    this.mockingRepl = new MockingRepl(workspaceRoot, this.llmClient);
    this.traceAndAlt = new TraceAndAltEngine(this.llmClient, this.mockingRepl);
    this.squasher = new BoardEraserSquasher(this.llmClient);
    this.slashRouter = new SlashRouter(this.llmClient, this.mockingRepl);
    this.historyScrubber = new HistoryScrubberController(
      this.checkpoints,
      this.camera,
      this.markManager,
      this.llmClient
    );

    this.inlineWidget = new InlineWidgetController({
      onSendMessage: (input) => this.handleSideChatInput(input),
      onContinue: () => this.resolveDevAction('continue'),
      onUndo: () => this.resolveDevAction('undo_chunk'),
      onAutoFinish: () => this.resolveDevAction('auto_finish_file'),
      onTourPrev: async () => {
        await this.camera.prevStep();
      },
      onTourNext: async () => {
        await this.camera.nextStep();
      },
      onTourStop: async () => {
        await this.camera.stopTour(true);
      },
      onSwapAlt: (proposal) => this.applyAlternativeChunk(proposal),
      onApplyFollowMeCode: (code) => this.replaceActiveChunkBuffer(code, 'Applied /followme completion'),
      onStepTrace: (delta) => this.stepTraceIteration(delta),
    });

    this.camera.onTourChange((tourState) => {
      this.inlineWidget.setTourState(tourState);
      this.refreshActionBar();
    });

    this.mcpBridge = new ChalkMcpBridgeServer({
      onStreamChunk: (chunk) => this.presentChunkAndAwaitResolution(chunk),
      onHighlightTour: async (steps) => {
        await this.camera.startTour(steps);
        return { stepsLoaded: steps.length };
      },
      onSetGhostText: async (filePath, lineAnnotations) => {
        const uri = this.camera.resolveUri(filePath);
        await this.camera.openOrCreateDocument(filePath, { preserveFocus: true });
        this.markManager.setGhostText(uri, lineAnnotations);
        return { applied: lineAnnotations.length };
      },
      onClearMarks: async () => {
        this.markManager.clearMarks(true);
        return { cleared: true };
      },
      onStatus: () => ({
        state: this.state,
        activeFile: this.activeSession?.chunk.filePath,
        activeChunkId: this.activeSession?.chunk.id,
      }),
    });

    this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 95);
    this.statusBar.command = 'chalk.mcpStatus';
    this.updateStatusBar();
    this.statusBar.show();

    // Register CodeLens provider across all file documents
    this.disposables.push(
      vscode.languages.registerCodeLensProvider({ scheme: 'file' }, this.codeLens),
      // Debounced buffer listener for /followme Mode A live coaching
      vscode.workspace.onDidChangeTextDocument((event) => this.onDocumentChanged(event))
    );
  }

  public async initialize(): Promise<void> {
    await this.probeIdeLanguageModel();

    const mcpCfg = vscode.workspace.getConfiguration('chalk.mcp');
    if (mcpCfg.get<boolean>('autoStart', true)) {
      const port = mcpCfg.get<number>('port', 7331);
      try {
        await this.mcpBridge.start(port);
        this.updateStatusBar();
      } catch (err) {
        vscode.window.showWarningMessage(
          `Chalk MCP bridge could not bind port ${port}: ${(err as Error).message}`
        );
      }
    }
  }

  public registerCommands(): vscode.Disposable[] {
    return [
      vscode.commands.registerCommand('chalk.startFromPlan', () => this.startLlmSession()),
      vscode.commands.registerCommand('chalk.runSession', () => this.runSessionQuickPick()),
      vscode.commands.registerCommand('chalk.runMockSession', () => this.startMockSession()),
      vscode.commands.registerCommand('chalk.continue', () => this.resolveDevAction('continue')),
      vscode.commands.registerCommand('chalk.undoChunk', () => this.resolveDevAction('undo_chunk')),
      vscode.commands.registerCommand('chalk.autoFinishFile', () =>
        this.resolveDevAction('auto_finish_file')
      ),
      vscode.commands.registerCommand('chalk.openInlineWidget', () => {
        this.enterSideSession();
        this.inlineWidget.openPanel(false);
      }),
      vscode.commands.registerCommand('chalk.runSlashCommand', async (prefill?: string) => {
        let cmd = typeof prefill === 'string' ? prefill : '';
        if (!cmd) {
          cmd =
            (await vscode.window.showInputBox({
              prompt: 'Enter a Chalk slash command or /btw question',
              placeHolder: '/explain, /edge, /test, /followme, /trace, /alt, /history',
            })) ?? '';
        }
        if (cmd.trim()) {
          this.enterSideSession();
          this.inlineWidget.openPanel(false);
          await this.handleSideChatInput(cmd.trim());
        }
      }),
      vscode.commands.registerCommand('chalk.tourPrev', () => {
        if (this.camera.getTourState().active) {
          return this.camera.prevStep();
        }
        if (this.activeTrace) {
          this.stepTraceIteration(-1);
        }
        return null;
      }),
      vscode.commands.registerCommand('chalk.tourNext', () => {
        if (this.camera.getTourState().active) {
          return this.camera.nextStep();
        }
        if (this.activeTrace) {
          this.stepTraceIteration(1);
        }
        return null;
      }),
      vscode.commands.registerCommand('chalk.tourStop', () => this.camera.stopTour(true)),
      vscode.commands.registerCommand('chalk.openHistory', () => this.openHistoryForActiveFile()),
      vscode.commands.registerCommand('chalk.clearMarks', () => {
        this.markManager.clearAll();
        this.activeTrace = null;
        this.inlineWidget.setTraceState(null);
      }),
      vscode.commands.registerCommand('chalk.mcpStatus', () => this.showMcpStatusDialog()),
    ];
  }

  /**
   * Core state machine entry point called by BOTH external MCP agents (`stream_chunk`)
   * and internal standalone players (`LlmAgentPlayer`, `MockAgentPlayer`).
   */
  public async presentChunkAndAwaitResolution(chunk: CodeChunk): Promise<DevActionResolution> {
    // 1. SNAPSHOT_PRE_CHUNK
    await this.setState('SNAPSHOT_PRE_CHUNK');
    await this.checkpoints.createPreChunkSnapshot(chunk.id, chunk.filePath, chunk.summary);

    // 2. DRAWING_CHUNK
    await this.setState('DRAWING_CHUNK');
    const autoFinish = this.checkpoints.shouldAutoFinish(chunk.filePath);
    const streamRes = await this.streamer.streamChunk(chunk, { instant: autoFinish });
    const bufferAfterDraw = streamRes.editor.document.getText();
    this.checkpoints.recordPostChunkState(chunk.id, bufferAfterDraw);

    const actualChunk: CodeChunk = {
      ...chunk,
      startLine: streamRes.actualStartLine,
      endLine: streamRes.actualEndLine,
    };

    // Fast-forward escape hatch: if Auto-Finish is enabled for this file, resolve immediately
    if (autoFinish) {
      await this.setState('IDLE');
      return {
        action: 'auto_finish_file',
        codeModified: false,
        chunkId: actualChunk.id,
        filePath: actualChunk.filePath,
      };
    }

    // 3. AWAITING_DEV_ACTION — block until developer clicks Continue / Auto-Finish / Undo
    await this.setState('AWAITING_DEV_ACTION');
    await vscode.commands.executeCommand('setContext', 'chalk.awaitingAction', true);

    return new Promise<DevActionResolution>((resolve) => {
      this.activeSession = {
        chunk: actualChunk,
        uri: streamRes.editor.document.uri,
        startLine: streamRes.actualStartLine,
        endLine: streamRes.actualEndLine,
        bufferAfterDraw,
        resolveAction: resolve,
      };
      this.inlineWidget.anchorToChunk(
        streamRes.editor.document.uri,
        actualChunk,
        streamRes.actualEndLine
      );
      this.refreshActionBar();
    });
  }

  public async resolveDevAction(action: DevAction): Promise<void> {
    const session = this.activeSession;
    if (!session) {
      vscode.window.showInformationMessage('No active Chalk chunk awaiting action.');
      return;
    }

    if (action === 'undo_chunk') {
      await this.camera.stopTour(true);
      const reverted = this.checkpoints.revertChunk(session.chunk.id);
      if (reverted) {
        await this.syncEditorWithDisk(session.uri, reverted.existedBefore, reverted.beforeContent);
      }
      this.slashRouter.eraseBoard();
      this.inlineWidget.eraseBoard();
      this.markManager.clearAll();
      this.activeTrace = null;
      this.activeSession = null;
      await vscode.commands.executeCommand('setContext', 'chalk.awaitingAction', false);
      this.refreshActionBar();
      await this.setState('IDLE');
      vscode.window.setStatusBarMessage('$(discard) Chalk: Reverted chunk to shadow checkpoint', 3000);

      session.resolveAction?.({
        action: 'undo_chunk',
        codeModified: false,
        chunkId: session.chunk.id,
        filePath: session.chunk.filePath,
        decisionSummary: 'Developer undid chunk; reverted to pre-chunk snapshot.',
      });
      return;
    }

    if (action === 'auto_finish_file') {
      this.checkpoints.enableAutoFinish(session.chunk.filePath);
      this.streamer.finishCurrentImmediately();
    }

    // 4. ERASING_THE_BOARD (Context Squash)
    await this.setState('ERASING_THE_BOARD');
    await this.camera.stopTour(true);

    const doc = await vscode.workspace.openTextDocument(session.uri);
    const currentBuffer = doc.getText();
    const squash = await this.squasher.squash({
      filePath: session.chunk.filePath,
      initialBufferAfterDraw: session.bufferAfterDraw,
      currentBuffer,
      sideChatTranscript: this.slashRouter.getMessages(),
    });

    if (squash.codeModified) {
      this.checkpoints.recordPostChunkState(session.chunk.id, currentBuffer);
    }

    // Wipe side-agent memory clean
    this.slashRouter.eraseBoard();
    this.inlineWidget.eraseBoard();
    this.markManager.clearAll();
    this.activeTrace = null;
    this.activeSession = null;
    await vscode.commands.executeCommand('setContext', 'chalk.awaitingAction', false);
    this.refreshActionBar();

    // 5. PLAN_RIPPLE_CHECK resolution returned to caller (Main Agent or Player loop)
    await this.setState('PLAN_RIPPLE_CHECK');
    const resolution: DevActionResolution = {
      action,
      codeModified: squash.codeModified,
      unifiedDiff: squash.unifiedDiff,
      decisionSummary: squash.decisionSummary,
      chunkId: session.chunk.id,
      filePath: session.chunk.filePath,
    };

    if (squash.codeModified) {
      vscode.window.setStatusBarMessage(
        `$(git-compare) Chalk squashed edit -> Plan Ripple Check: ${squash.decisionSummary ?? ''}`,
        4500
      );
    }

    await this.setState('IDLE');
    session.resolveAction?.(resolution);
  }

  private async runSessionQuickPick(): Promise<void> {
    const choice = await vscode.window.showQuickPick(
      [
        {
          label: '$(sparkle) Start Live LLM Session from plan.md',
          description: this.llmClient.describeProvider(),
          id: 'llm',
        },
        {
          label: '$(play-circle) Run Zero-Token Demo Session (mock-session.json)',
          description: 'Deterministic 2-file AuthService walkthrough',
          id: 'mock',
        },
        {
          label: '$(plug) Show MCP Server Config for External Agents',
          description: 'Claude Code, Antigravity, Cursor, Codex',
          id: 'mcp',
        },
      ],
      { placeHolder: 'Choose how to drive the Chalkboard' }
    );
    if (!choice) {
      return;
    }
    if (choice.id === 'llm') {
      await this.startLlmSession();
    } else if (choice.id === 'mock') {
      await this.startMockSession();
    } else {
      await this.showMcpStatusDialog();
    }
  }

  private async startLlmSession(): Promise<void> {
    if (!this.llmClient.isConfigured()) {
      const pick = await vscode.window.showWarningMessage(
        'No LLM API key configured for LlmAgentPlayer. Set chalk.llm.apiKey (or ANTHROPIC_API_KEY / GEMINI_API_KEY / OPENAI_API_KEY), or run the zero-token Demo Session.',
        'Run Demo Session',
        'Open Settings'
      );
      if (pick === 'Run Demo Session') {
        await this.startMockSession();
      } else if (pick === 'Open Settings') {
        await vscode.commands.executeCommand('workbench.action.openSettings', 'chalk.llm');
      }
      return;
    }

    const cfg = this.readLlmConfig();
    const player = new LlmAgentPlayer({
      workspaceRoot: this.getWorkspaceRoot(),
      llmClient: this.llmClient,
      maxChunksPerSession: cfg.maxChunksPerSession,
      onUndoChunk: async (chunkId) => Boolean(this.checkpoints.revertChunk(chunkId)),
      onRunMockTest: async (chunk, prompt) => {
        const doc = await vscode.workspace.openTextDocument(this.camera.resolveUri(chunk.filePath));
        return this.mockingRepl.runTest({ chunk, fileContent: doc.getText(), prompt });
      },
    });

    await this.drivePlayerLoop(player);
  }

  private async startMockSession(): Promise<void> {
    const player = new MockAgentPlayer(
      this.getWorkspaceRoot(),
      this.extensionContext.extensionPath,
      {
        onUndoChunk: async (chunkId) => Boolean(this.checkpoints.revertChunk(chunkId)),
        onRunMockTest: async (chunk, prompt) => {
          const doc = await vscode.workspace.openTextDocument(this.camera.resolveUri(chunk.filePath));
          return this.mockingRepl.runTest({ chunk, fileContent: doc.getText(), prompt });
        },
      }
    );

    await this.drivePlayerLoop(player);
  }

  private async drivePlayerLoop(player: AgentPlayer): Promise<void> {
    this.activePlayer = player;
    this.checkpoints.clearAutoFinish();

    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Chalk: Preparing ${player.name} session...`,
          cancellable: false,
        },
        async () => {
          await player.startSession();
        }
      );
    } catch (err) {
      vscode.window.showErrorMessage(`Chalk failed to start session: ${(err as Error).message}`);
      this.activePlayer = null;
      return;
    }

    let item = await player.nextChunk();
    while (item) {
      const resolution = await this.presentChunkAndAwaitResolution(item.chunk);
      if (resolution.action === 'undo_chunk') {
        const retry = await vscode.window.showInformationMessage(
          `Chunk "${item.chunk.id}" reverted. Re-draw this chunk, skip to next, or end session?`,
          'Re-draw Chunk',
          'Skip to Next',
          'End Session'
        );
        if (retry === 'Re-draw Chunk') {
          continue;
        }
        if (retry === 'End Session' || !retry) {
          break;
        }
      }
      item = await player.nextChunk();
    }

    this.checkpoints.clearAutoFinish();
    this.activePlayer = null;
    vscode.window.showInformationMessage(`Chalk: ${player.name} session complete!`);
  }

  private enterSideSession(): void {
    if (this.activeSession && this.state === 'AWAITING_DEV_ACTION') {
      void this.setState('SIDE_SESSION_ACTIVE');
      this.refreshActionBar();
    }
  }

  private async handleSideChatInput(input: string): Promise<void> {
    // Allow running /history or ad-hoc slash commands even when no streaming chunk is active
    const targetChunk = this.activeSession?.chunk ?? this.buildAdHocChunkFromActiveEditor();
    if (!targetChunk) {
      vscode.window.showInformationMessage('Open a file or start a Chalk session first.');
      return;
    }

    this.enterSideSession();
    this.inlineWidget.setBusy(true);

    try {
      const doc = await vscode.workspace.openTextDocument(
        this.camera.resolveUri(targetChunk.filePath)
      );
      const outcome = await this.slashRouter.handleInput(input, {
        chunk: targetChunk,
        fileContent: doc.getText(),
        activePlayer: this.activePlayer,
        onTrace: (chunk, content, prompt) => this.traceAndAlt.runTrace(chunk, content, prompt),
        onAlt: (chunk, content, prompt) =>
          this.traceAndAlt.generateAlternative(chunk, content, prompt),
        onHistory: (filePath, prompt) => this.historyScrubber.open(filePath, prompt),
      });

      this.inlineWidget.updateMessages(this.slashRouter.getMessages());

      if (outcome.tourSteps && outcome.tourSteps.length > 0) {
        await this.camera.startTour(outcome.tourSteps);
      }
      if (outcome.marks && outcome.marks.length > 0) {
        this.markManager.applyMarks(outcome.marks, (fp) => this.camera.resolveUri(fp), false);
      }
      if (typeof outcome.followMeActive === 'boolean') {
        this.inlineWidget.setFollowMeState(outcome.followMeActive, outcome.followMeCompletionCode);
      }
      if (outcome.traceResult) {
        this.activeTrace = {
          result: outcome.traceResult,
          index: 0,
          uri: doc.uri,
        };
        this.renderActiveTraceIteration();
      }
    } catch (err) {
      vscode.window.showErrorMessage(`Chalk side-chat error: ${(err as Error).message}`);
    } finally {
      this.inlineWidget.setBusy(false);
    }
  }

  private onDocumentChanged(event: vscode.TextDocumentChangeEvent): void {
    if (!this.activeSession || !this.slashRouter.isFollowMeActive()) {
      return;
    }
    if (event.document.uri.toString() !== this.activeSession.uri.toString()) {
      return;
    }
    if (event.contentChanges.length === 0) {
      return;
    }

    if (this.followMeDebounceTimer) {
      clearTimeout(this.followMeDebounceTimer);
    }
    const chunk = this.activeSession.chunk;
    this.followMeDebounceTimer = setTimeout(async () => {
      const hint = await this.slashRouter.coachLiveEdit(chunk, event.document.getText());
      if (hint) {
        this.inlineWidget.updateMessages(this.slashRouter.getMessages());
      }
    }, 1100);
  }

  private async applyAlternativeChunk(proposal: AltProposal): Promise<void> {
    await this.replaceActiveChunkBuffer(
      proposal.alternativeCode,
      `Swapped chunk with alternative: ${proposal.title}`
    );
  }

  private async replaceActiveChunkBuffer(newCode: string, statusMessage: string): Promise<void> {
    const session = this.activeSession;
    if (!session) {
      return;
    }
    const editor = await this.camera.openOrCreateDocument(session.chunk.filePath, {
      viewColumn: vscode.ViewColumn.One,
      preserveFocus: false,
    });
    const maxLine = Math.max(0, editor.document.lineCount - 1);
    const startZero = Math.max(0, Math.min(session.startLine - 1, maxLine));
    const endZero = Math.max(startZero, Math.min(session.endLine - 1, maxLine));
    const endCol = editor.document.lineAt(endZero).text.length;

    await editor.edit((eb) => {
      eb.replace(new vscode.Range(startZero, 0, endZero, endCol), newCode);
    });
    await editor.document.save();

    const lineCount = newCode.replace(/\r\n/g, '\n').split('\n').length;
    session.endLine = session.startLine + Math.max(0, lineCount - 1);
    session.chunk.endLine = session.endLine;
    this.markManager.setActiveChunk(
      session.uri,
      session.startLine,
      session.endLine,
      session.chunk.summary
    );
    this.refreshActionBar();
    vscode.window.setStatusBarMessage(`$(check) Chalk: ${statusMessage}`, 3000);
  }

  private stepTraceIteration(delta: number): void {
    if (!this.activeTrace) {
      return;
    }
    const total = this.activeTrace.result.iterations.length;
    if (total === 0) {
      return;
    }
    this.activeTrace.index = (this.activeTrace.index + delta + total) % total;
    this.renderActiveTraceIteration();
  }

  private renderActiveTraceIteration(): void {
    if (!this.activeTrace) {
      this.inlineWidget.setTraceState(null);
      return;
    }
    const { result, index, uri } = this.activeTrace;
    const iter = result.iterations[index];
    if (!iter) {
      return;
    }
    this.markManager.setGhostText(uri, iter.annotations);
    this.inlineWidget.setTraceState({
      index,
      total: result.iterations.length,
      label: iter.iterationLabel,
    });
  }

  private async openHistoryForActiveFile(): Promise<void> {
    const filePath =
      this.activeSession?.chunk.filePath ??
      (vscode.window.activeTextEditor?.document.uri.scheme === 'file'
        ? path
            .relative(this.getWorkspaceRoot(), vscode.window.activeTextEditor.document.uri.fsPath)
            .replace(/\\/g, '/')
        : null);

    if (!filePath) {
      vscode.window.showInformationMessage('Open a file first to launch Chalk /history scrubber.');
      return;
    }

    const summary = await this.historyScrubber.open(filePath);
    if (summary.startsWith('No Git commits')) {
      vscode.window.showInformationMessage(summary);
    }
  }

  private async showMcpStatusDialog(): Promise<void> {
    const port = this.mcpBridge.getPort() ?? vscode.workspace.getConfiguration('chalk.mcp').get<number>('port', 7331);
    const proxyPath = path.join(this.extensionContext.extensionPath, 'dist', 'mcp', 'stdioProxy.js');
    const snippet = JSON.stringify(
      {
        mcpServers: {
          chalk: {
            command: 'node',
            args: [proxyPath],
            env: { CHALK_MCP_PORT: String(port) },
          },
        },
      },
      null,
      2
    );

    const status = this.mcpBridge.isRunning()
      ? `Chalk MCP Bridge listening on 127.0.0.1:${port} (${this.mcpBridge.getClientCount()} client(s)) · State: ${this.state}`
      : `Chalk MCP Bridge is stopped.`;

    const action = await vscode.window.showInformationMessage(
      status,
      'Copy MCP Config JSON',
      'Run Demo Session',
      this.mcpBridge.isRunning() ? 'Restart Bridge' : 'Start Bridge'
    );

    if (action === 'Copy MCP Config JSON') {
      await vscode.env.clipboard.writeText(snippet);
      vscode.window.showInformationMessage('Copied Chalk MCP configuration JSON to clipboard.');
    } else if (action === 'Run Demo Session') {
      await this.startMockSession();
    } else if (action === 'Start Bridge' || action === 'Restart Bridge') {
      await this.mcpBridge.stop();
      await this.mcpBridge.start(port);
      this.updateStatusBar();
      vscode.window.showInformationMessage(`Chalk MCP Bridge running on port ${port}.`);
    }
  }

  private buildAdHocChunkFromActiveEditor(): CodeChunk | null {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== 'file') {
      return null;
    }
    const sel = editor.selection;
    const startLine = sel.isEmpty ? 1 : sel.start.line + 1;
    const endLine = sel.isEmpty ? Math.min(editor.document.lineCount, 60) : sel.end.line + 1;
    const rel = path
      .relative(this.getWorkspaceRoot(), editor.document.uri.fsPath)
      .replace(/\\/g, '/');
    return {
      id: `adhoc-${Date.now()}`,
      stepNumber: 1,
      chunkIndex: 1,
      totalChunksInStep: 1,
      filePath: rel,
      startLine,
      endLine,
      code: editor.document.getText(
        new vscode.Range(startLine - 1, 0, endLine - 1, editor.document.lineAt(endLine - 1).text.length)
      ),
      summary: `Active editor view of ${rel}`,
    };
  }

  private async syncEditorWithDisk(
    uri: vscode.Uri,
    existedBefore: boolean,
    beforeContent: string
  ): Promise<void> {
    if (!existedBefore) {
      // Close editor tab if file was deleted on undo
      for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs) {
          if (tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === uri.toString()) {
            await vscode.window.tabGroups.close(tab, true);
          }
        }
      }
      return;
    }

    const openDoc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
    if (openDoc && openDoc.getText() !== beforeContent) {
      const editor = await vscode.window.showTextDocument(openDoc, {
        viewColumn: vscode.ViewColumn.One,
        preserveFocus: false,
      });
      const lastLine = Math.max(0, openDoc.lineCount - 1);
      const fullRange = new vscode.Range(0, 0, lastLine, openDoc.lineAt(lastLine).text.length);
      await editor.edit((eb) => eb.replace(fullRange, beforeContent));
      await openDoc.save();
    }
  }

  private refreshActionBar(): void {
    if (!this.activeSession) {
      this.codeLens.update(null);
      return;
    }
    this.codeLens.update({
      chunk: this.activeSession.chunk,
      uri: this.activeSession.uri,
      startLine: this.activeSession.startLine,
      endLine: this.activeSession.endLine,
      state: this.state,
      tourState: this.camera.getTourState(),
    });
  }

  private async setState(next: ChalkState): Promise<void> {
    this.state = next;
    this.updateStatusBar();
  }

  private updateStatusBar(): void {
    const port = this.mcpBridge.getPort();
    const mcpLabel = port ? `MCP:${port}` : 'MCP:off';
    this.statusBar.text = `$(mortar-board) Chalk (${mcpLabel} · ${this.state})`;
    this.statusBar.tooltip = `Chalk Whiteboard Harness — Click for MCP config & session options`;
  }

  private readLlmConfig(): LlmConfig {
    const cfg = vscode.workspace.getConfiguration('chalk.llm');
    return {
      provider: cfg.get<LlmProvider>('provider', 'auto'),
      model: cfg.get<string>('model', ''),
      apiKey: cfg.get<string>('apiKey', ''),
      baseUrl: cfg.get<string>('baseUrl', ''),
      maxTokensPerChunk: cfg.get<number>('maxTokensPerChunk', 1600),
      maxChunksPerSession: cfg.get<number>('maxChunksPerSession', 25),
    };
  }

  private async probeIdeLanguageModel(): Promise<void> {
    try {
      const vscodeAny = vscode as unknown as {
        lm?: { selectChatModels?: (selector?: Record<string, string>) => Promise<Array<{ id?: string; name?: string }>> };
      };
      if (typeof vscodeAny.lm?.selectChatModels !== 'function') {
        this.ideLmModelLabel = null;
        return;
      }
      const models = await vscodeAny.lm.selectChatModels();
      if (Array.isArray(models) && models.length > 0) {
        this.ideLmModelLabel = models[0].name || models[0].id || 'IDE Chat Model';
      } else {
        this.ideLmModelLabel = null;
      }
    } catch {
      this.ideLmModelLabel = null;
    }
  }

  private async completeWithIdeLanguageModel(
    systemPrompt: string,
    messages: ChatMessage[]
  ): Promise<string | null> {
    try {
      const vscodeAny = vscode as unknown as {
        lm?: {
          selectChatModels?: () => Promise<
            Array<{
              name?: string;
              id?: string;
              sendRequest: (
                msgs: unknown[],
                options: Record<string, unknown>,
                token: vscode.CancellationToken
              ) => Promise<{ text: AsyncIterable<string> }>;
            }>
          >;
        };
        LanguageModelChatMessage?: {
          User: (content: string) => unknown;
          Assistant: (content: string) => unknown;
        };
      };

      if (
        typeof vscodeAny.lm?.selectChatModels !== 'function' ||
        !vscodeAny.LanguageModelChatMessage
      ) {
        return null;
      }

      const models = await vscodeAny.lm.selectChatModels();
      if (!Array.isArray(models) || models.length === 0) {
        this.ideLmModelLabel = null;
        return null;
      }

      const model = models[0];
      this.ideLmModelLabel = model.name || model.id || 'IDE Chat Model';

      const lmMessages: unknown[] = [
        vscodeAny.LanguageModelChatMessage.User(
          `[System Instructions]\n${systemPrompt}`
        ),
        ...messages.map((m) =>
          m.role === 'assistant'
            ? vscodeAny.LanguageModelChatMessage!.Assistant(m.content)
            : vscodeAny.LanguageModelChatMessage!.User(m.content)
        ),
      ];

      const cts = new vscode.CancellationTokenSource();
      const response = await model.sendRequest(lmMessages, {}, cts.token);
      let fullText = '';
      for await (const chunk of response.text) {
        fullText += chunk;
      }
      cts.dispose();
      return fullText.trim() || null;
    } catch {
      return null;
    }
  }

  private getWorkspaceRoot(): string {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
  }

  public dispose(): void {
    if (this.followMeDebounceTimer) {
      clearTimeout(this.followMeDebounceTimer);
    }
    void this.mcpBridge.stop();
    this.markManager.dispose();
    this.camera.dispose();
    this.codeLens.dispose();
    this.inlineWidget.dispose();
    this.historyScrubber.dispose();
    this.statusBar.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}

let coordinator: ChalkCoordinator | null = null;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  coordinator = new ChalkCoordinator(context);
  context.subscriptions.push(coordinator, ...coordinator.registerCommands());
  await coordinator.initialize();
}

export function deactivate(): void {
  coordinator?.dispose();
  coordinator = null;
}
