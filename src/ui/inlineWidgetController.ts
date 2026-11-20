import * as vscode from 'vscode';
import {
  AltProposal,
  CodeChunk,
  SideChatMessage,
} from '../types/protocol.js';
import { TourState } from './cameraController.js';

export interface InlineWidgetCallbacks {
  onSendMessage: (input: string) => Promise<void>;
  onContinue: () => Promise<void>;
  onUndo: () => Promise<void>;
  onAutoFinish: () => Promise<void>;
  onTourPrev: () => Promise<void>;
  onTourNext: () => Promise<void>;
  onTourStop: () => Promise<void>;
  onSwapAlt: (proposal: AltProposal) => Promise<void>;
  onApplyFollowMeCode: (code: string) => Promise<void>;
  onStepTrace: (delta: number) => void;
}

interface InlineComment extends vscode.Comment {
  id: string;
}

/**
 * Hybrid On-Demand Inline Side-Chat Widget:
 * 1) Anchors a lightweight collapsed CommentThread directly at `chunk.endLine`
 *    so the developer always sees an inline entry point on the exact chunk boundary.
 * 2) Opens a rich, Claude-style editorial Webview chat panel (`ViewColumn.Beside`)
 *    for natural conversational side-chat, slash-command chips, tour controls,
 *    `/alt` trade-off matrices + one-click swap, and `/trace` iteration stepping.
 */
export class InlineWidgetController implements vscode.Disposable {
  private readonly commentController: vscode.CommentController;
  private activeThread: vscode.CommentThread | null = null;
  private panel: vscode.WebviewPanel | null = null;

  private activeChunk: CodeChunk | null = null;
  private messages: SideChatMessage[] = [];
  private tourState: TourState = { active: false, steps: [], currentIndex: -1 };
  private followMeActive = false;
  private pendingFollowMeCode: string | null = null;
  private lastAltProposal: AltProposal | null = null;
  private traceMeta: { index: number; total: number; label: string } | null = null;
  private isBusy = false;

  constructor(private readonly callbacks: InlineWidgetCallbacks) {
    this.commentController = vscode.comments.createCommentController(
      'chalk-inline-anchor',
      'Chalk Side-Channel (/btw)'
    );
    this.commentController.commentingRangeProvider = {
      provideCommentingRanges: (document: vscode.TextDocument) => {
        if (!this.activeChunk) {
          return [];
        }
        const line = Math.max(0, Math.min(this.activeChunk.endLine - 1, document.lineCount - 1));
        return [new vscode.Range(line, 0, line, 0)];
      },
    };
  }

  /** Anchor a collapsed native inline thread at `chunk.endLine` (zero clutter by default). */
  public anchorToChunk(uri: vscode.Uri, chunk: CodeChunk, endLine: number): void {
    this.activeChunk = { ...chunk, endLine };
    this.disposeThread();

    const lineZero = Math.max(0, endLine - 1);
    const introComment: InlineComment = {
      id: `anchor-${chunk.id}`,
      body: new vscode.MarkdownString(
        `**Chalk · Step ${chunk.stepNumber} (${chunk.chunkIndex}/${chunk.totalChunksInStep})** — ${chunk.summary}\n\n` +
          `[Open Side-Chat](command:chalk.openInlineWidget) · ` +
          `[/explain](command:chalk.runSlashCommand?${encodeURIComponent(JSON.stringify(['/explain']))}) · ` +
          `[/edge](command:chalk.runSlashCommand?${encodeURIComponent(JSON.stringify(['/edge']))}) · ` +
          `[/test](command:chalk.runSlashCommand?${encodeURIComponent(JSON.stringify(['/test']))}) · ` +
          `[Continue](command:chalk.continue)`
      ),
      mode: vscode.CommentMode.Preview,
      author: { name: 'Chalk' },
    };
    (introComment.body as vscode.MarkdownString).isTrusted = true;

    const thread = this.commentController.createCommentThread(
      uri,
      new vscode.Range(lineZero, 0, lineZero, 0),
      [introComment]
    );
    thread.label = `Chalk · ${chunk.summary.slice(0, 60)}`;
    thread.canReply = false;
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
    this.activeThread = thread;

    this.syncPanel();
  }

  /** Expand / focus the Claude-style side-chat Webview panel. */
  public openPanel(preserveFocus = false): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside, preserveFocus);
      this.syncPanel();
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      'chalkSideChat',
      'Chalk — Side-Chat (/btw)',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      }
    );

    this.panel.webview.html = getWebviewHtml();

    this.panel.webview.onDidReceiveMessage(async (msg: { type: string; text?: string; delta?: number }) => {
      switch (msg.type) {
        case 'send':
          if (msg.text && msg.text.trim()) {
            await this.callbacks.onSendMessage(msg.text.trim());
          }
          break;
        case 'continue':
          await this.callbacks.onContinue();
          break;
        case 'undo':
          await this.callbacks.onUndo();
          break;
        case 'autoFinish':
          await this.callbacks.onAutoFinish();
          break;
        case 'tourPrev':
          await this.callbacks.onTourPrev();
          break;
        case 'tourNext':
          await this.callbacks.onTourNext();
          break;
        case 'tourStop':
          await this.callbacks.onTourStop();
          break;
        case 'swapAlt':
          if (this.lastAltProposal) {
            await this.callbacks.onSwapAlt(this.lastAltProposal);
          }
          break;
        case 'applyFollowMe':
          if (this.pendingFollowMeCode) {
            const code = this.pendingFollowMeCode;
            this.pendingFollowMeCode = null;
            await this.callbacks.onApplyFollowMeCode(code);
            this.syncPanel();
          }
          break;
        case 'traceStep':
          if (typeof msg.delta === 'number') {
            this.callbacks.onStepTrace(msg.delta);
          }
          break;
      }
    });

    this.panel.onDidDispose(() => {
      this.panel = null;
    });

    this.syncPanel();
  }

  public updateMessages(messages: SideChatMessage[]): void {
    this.messages = messages;
    const latestWithAlt = [...messages].reverse().find((m) => m.altProposal);
    this.lastAltProposal = latestWithAlt?.altProposal ?? null;
    this.syncPanel();
  }

  public setBusy(busy: boolean): void {
    this.isBusy = busy;
    this.syncPanel();
  }

  public setTourState(state: TourState): void {
    this.tourState = state;
    this.syncPanel();
  }

  public setFollowMeState(active: boolean, completionCode?: string): void {
    this.followMeActive = active;
    if (completionCode) {
      this.pendingFollowMeCode = completionCode;
    }
    this.syncPanel();
  }

  public setTraceState(meta: { index: number; total: number; label: string } | null): void {
    this.traceMeta = meta;
    this.syncPanel();
  }

  /** Erase board visually when continuing to the next chunk. */
  public eraseBoard(): void {
    this.messages = [];
    this.followMeActive = false;
    this.pendingFollowMeCode = null;
    this.lastAltProposal = null;
    this.traceMeta = null;
    this.isBusy = false;
    this.disposeThread();
    this.syncPanel();
  }

  private syncPanel(): void {
    if (!this.panel) {
      return;
    }
    void this.panel.webview.postMessage({
      type: 'state',
      payload: {
        chunk: this.activeChunk,
        messages: this.messages,
        tour: this.tourState,
        followMeActive: this.followMeActive,
        hasFollowMeCode: Boolean(this.pendingFollowMeCode),
        traceMeta: this.traceMeta,
        isBusy: this.isBusy,
      },
    });
  }

  private disposeThread(): void {
    if (this.activeThread) {
      this.activeThread.dispose();
      this.activeThread = null;
    }
  }

  public dispose(): void {
    this.disposeThread();
    this.panel?.dispose();
    this.commentController.dispose();
  }
}

function getWebviewHtml(): string {
  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Chalk Side-Chat</title>
<style>
  :root {
    --bg: var(--vscode-editor-background, #191918);
    --surface: var(--vscode-sideBar-background, #21201e);
    --surface-2: var(--vscode-input-background, #2a2926);
    --border: var(--vscode-panel-border, rgba(255,255,255,0.1));
    --fg: var(--vscode-editor-foreground, #eceae4);
    --muted: var(--vscode-descriptionForeground, #9e9b93);
    --accent: #d97757;
    --accent-soft: rgba(217, 119, 87, 0.16);
    --green: #4ade80;
    --amber: #fbbf24;
    --blue: #60a5fa;
    --radius: 12px;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 0;
    background: var(--bg);
    color: var(--fg);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, sans-serif;
    font-size: 13.5px;
    line-height: 1.55;
    display: flex;
    flex-direction: column;
    height: 100vh;
    overflow: hidden;
  }
  .header {
    padding: 12px 16px;
    background: var(--surface);
    border-bottom: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .header-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 8px;
    font-weight: 600;
    font-size: 13px;
    letter-spacing: 0.01em;
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--accent);
    box-shadow: 0 0 8px var(--accent);
  }
  .pill {
    font-size: 11px;
    padding: 2px 8px;
    border-radius: 999px;
    background: var(--accent-soft);
    color: var(--accent);
    font-weight: 500;
  }
  .pill.green { background: rgba(74, 222, 128, 0.14); color: var(--green); }
  .chunk-meta {
    font-size: 12px;
    color: var(--muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .banner {
    display: none;
    padding: 8px 16px;
    background: rgba(96, 165, 250, 0.1);
    border-bottom: 1px solid var(--border);
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    font-size: 12px;
  }
  .banner.visible { display: flex; }
  .banner-actions { display: flex; gap: 6px; }
  .messages {
    flex: 1;
    overflow-y: auto;
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .empty-state {
    margin: auto;
    max-width: 380px;
    text-align: center;
    color: var(--muted);
    padding: 24px 12px;
  }
  .empty-state h3 {
    margin: 0 0 6px 0;
    color: var(--fg);
    font-weight: 600;
    font-size: 15px;
  }
  .msg {
    display: flex;
    flex-direction: column;
    gap: 6px;
    max-width: 100%;
  }
  .msg.user {
    align-self: flex-end;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 9px 13px;
    max-width: 88%;
  }
  .msg.assistant {
    align-self: flex-start;
    width: 100%;
    padding: 4px 2px;
  }
  .msg-header {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    color: var(--muted);
  }
  .cmd-tag {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 11px;
    padding: 1px 6px;
    border-radius: 5px;
    background: var(--accent-soft);
    color: var(--accent);
  }
  .msg-body {
    word-break: break-word;
  }
  .msg-body p { margin: 0 0 8px 0; }
  .msg-body p:last-child { margin-bottom: 0; }
  .msg-body code {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 12px;
    padding: 1px 5px;
    border-radius: 4px;
    background: var(--surface-2);
  }
  .msg-body pre {
    margin: 8px 0;
    padding: 10px 12px;
    border-radius: 8px;
    background: var(--surface);
    border: 1px solid var(--border);
    overflow-x: auto;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 12px;
    line-height: 1.45;
  }
  .msg-body pre code { padding: 0; background: transparent; }
  .alt-card {
    margin-top: 8px;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--surface);
    padding: 10px 12px;
  }
  .alt-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
    margin: 8px 0;
  }
  .alt-table th, .alt-table td {
    text-align: left;
    padding: 5px 8px;
    border-bottom: 1px solid var(--border);
  }
  .alt-table th { color: var(--muted); font-weight: 500; }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    padding: 8px 16px 0 16px;
  }
  .chip {
    background: var(--surface);
    color: var(--fg);
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: 3px 10px;
    font-size: 11.5px;
    font-family: var(--vscode-editor-font-family, monospace);
    cursor: pointer;
    transition: border-color 0.15s, background 0.15s;
  }
  .chip:hover {
    border-color: var(--accent);
    background: var(--accent-soft);
  }
  .composer {
    padding: 10px 16px 12px 16px;
    background: var(--surface);
    border-top: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .input-row {
    display: flex;
    gap: 8px;
    align-items: flex-end;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 6px 8px;
  }
  .input-row:focus-within {
    border-color: var(--accent);
  }
  textarea {
    flex: 1;
    background: transparent;
    color: var(--fg);
    border: none;
    outline: none;
    resize: none;
    font-family: inherit;
    font-size: 13px;
    min-height: 22px;
    max-height: 110px;
    line-height: 1.45;
  }
  button {
    cursor: pointer;
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 5px 10px;
    font-size: 12px;
    font-weight: 500;
    background: var(--surface-2);
    color: var(--fg);
  }
  button:hover { border-color: var(--accent); }
  button.primary {
    background: var(--accent);
    color: #fff;
    border-color: transparent;
  }
  button.primary:hover { opacity: 0.92; }
  .footer-actions {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    font-size: 11.5px;
    color: var(--muted);
  }
  .footer-btns { display: flex; gap: 6px; flex-wrap: wrap; }
  .thinking {
    font-size: 12px;
    color: var(--accent);
    font-style: italic;
    padding: 2px 0;
  }
</style>
</head>
<body>
  <div class="header">
    <div class="header-top">
      <div class="brand">
        <span class="dot"></span>
        <span>Chalk Side-Chat</span>
        <span class="pill" id="ephemeralBadge">Ephemeral · Erased on Continue</span>
      </div>
      <span class="pill green" id="followMeBadge" style="display:none;">/followme Live</span>
    </div>
    <div class="chunk-meta" id="chunkMeta">Waiting for an active chunk on the chalkboard...</div>
  </div>

  <div class="banner" id="tourBanner">
    <span id="tourLabel">Tour 1/1</span>
    <div class="banner-actions">
      <button id="tourPrevBtn">‹ Prev</button>
      <button id="tourNextBtn">Next ›</button>
      <button id="tourStopBtn">End</button>
    </div>
  </div>

  <div class="banner" id="traceBanner">
    <span id="traceLabel">Trace 1/1</span>
    <div class="banner-actions">
      <button id="tracePrevBtn">‹ Prev State</button>
      <button id="traceNextBtn">Next State ›</button>
    </div>
  </div>

  <div class="messages" id="messages">
    <div class="empty-state">
      <h3>Ask anything about this chunk</h3>
      <p>Side-channel conversations stay completely isolated from the Main Builder Agent. When you click <strong>Continue</strong>, Chalk erases the board and squashes only your final code diff.</p>
    </div>
  </div>

  <div class="chips">
    <button class="chip" data-cmd="/explain">/explain</button>
    <button class="chip" data-cmd="/edge">/edge</button>
    <button class="chip" data-cmd="/test">/test</button>
    <button class="chip" data-cmd="/followme">/followme</button>
    <button class="chip" data-cmd="/trace">/trace</button>
    <button class="chip" data-cmd="/alt">/alt</button>
    <button class="chip" data-cmd="/history">/history</button>
  </div>

  <div class="composer">
    <div id="followMeApplyRow" style="display:none;">
      <button class="primary" id="applyFollowMeBtn">✨ Apply /followme Completion to Chunk</button>
    </div>
    <div class="input-row">
      <textarea id="promptInput" rows="1" placeholder="Ask a /btw question or run /explain, /edge, /test, /trace, /alt..."></textarea>
      <button class="primary" id="sendBtn">Send</button>
    </div>
    <div class="footer-actions">
      <div class="footer-btns">
        <button class="primary" id="continueBtn">▶ Continue &amp; Erase Board</button>
        <button id="autoFinishBtn">⚡ Auto-Finish File</button>
        <button id="undoBtn">↩ Undo Chunk</button>
      </div>
    </div>
  </div>

<script>
  const vscode = acquireVsCodeApi();
  const messagesEl = document.getElementById('messages');
  const chunkMetaEl = document.getElementById('chunkMeta');
  const promptInput = document.getElementById('promptInput');
  const tourBanner = document.getElementById('tourBanner');
  const tourLabel = document.getElementById('tourLabel');
  const traceBanner = document.getElementById('traceBanner');
  const traceLabel = document.getElementById('traceLabel');
  const followMeBadge = document.getElementById('followMeBadge');
  const followMeApplyRow = document.getElementById('followMeApplyRow');

  function sendCurrent() {
    const text = promptInput.value.trim();
    if (!text) return;
    vscode.postMessage({ type: 'send', text });
    promptInput.value = '';
    promptInput.style.height = 'auto';
  }

  document.getElementById('sendBtn').addEventListener('click', sendCurrent);
  promptInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendCurrent();
    }
  });
  promptInput.addEventListener('input', () => {
    promptInput.style.height = 'auto';
    promptInput.style.height = Math.min(promptInput.scrollHeight, 110) + 'px';
  });

  document.querySelectorAll('.chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      const cmd = btn.getAttribute('data-cmd');
      if (promptInput.value.trim().length === 0) {
        vscode.postMessage({ type: 'send', text: cmd });
      } else {
        promptInput.value = cmd + ' ' + promptInput.value;
        promptInput.focus();
      }
    });
  });

  document.getElementById('continueBtn').addEventListener('click', () => vscode.postMessage({ type: 'continue' }));
  document.getElementById('undoBtn').addEventListener('click', () => vscode.postMessage({ type: 'undo' }));
  document.getElementById('autoFinishBtn').addEventListener('click', () => vscode.postMessage({ type: 'autoFinish' }));
  document.getElementById('tourPrevBtn').addEventListener('click', () => vscode.postMessage({ type: 'tourPrev' }));
  document.getElementById('tourNextBtn').addEventListener('click', () => vscode.postMessage({ type: 'tourNext' }));
  document.getElementById('tourStopBtn').addEventListener('click', () => vscode.postMessage({ type: 'tourStop' }));
  document.getElementById('tracePrevBtn').addEventListener('click', () => vscode.postMessage({ type: 'traceStep', delta: -1 }));
  document.getElementById('traceNextBtn').addEventListener('click', () => vscode.postMessage({ type: 'traceStep', delta: 1 }));
  document.getElementById('applyFollowMeBtn').addEventListener('click', () => vscode.postMessage({ type: 'applyFollowMe' }));

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function renderMarkdown(md) {
    let html = escapeHtml(md || '');
    // Fenced code blocks
    html = html.replace(/\`\`\`(?:[\w-]*)\n([\s\S]*?)\`\`\`/g, (_, code) => '<pre><code>' + code + '</code></pre>');
    // Inline code
    html = html.replace(/\`([^\`]+)\`/g, '<code>$1</code>');
    // Bold
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    // Italic
    html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
    // Paragraphs / breaks
    html = html
      .split(/\n\n+/)
      .map((block) => block.startsWith('<pre>') ? block : '<p>' + block.replace(/\n/g, '<br/>') + '</p>')
      .join('');
    return html;
  }

  function renderAltCard(alt) {
    const rows = (alt.tradeOffs || [])
      .map((r) => '<tr><td><strong>' + escapeHtml(r.dimension) + '</strong></td><td>' + escapeHtml(r.current) + '</td><td>' + escapeHtml(r.alternative) + '</td></tr>')
      .join('');
    return '<div class="alt-card">' +
      '<table class="alt-table"><thead><tr><th>Dimension</th><th>Current</th><th>Alternative</th></tr></thead><tbody>' + rows + '</tbody></table>' +
      '<pre><code>' + escapeHtml(alt.unifiedDiff || alt.alternativeCode) + '</code></pre>' +
      '<button class="primary swap-alt-btn">🔄 Swap Chunk</button>' +
      '</div>';
  }

  window.addEventListener('message', (event) => {
    const { type, payload } = event.data;
    if (type !== 'state') return;

    if (payload.chunk) {
      const c = payload.chunk;
      chunkMetaEl.textContent =
        'Step ' + c.stepNumber + ' (' + c.chunkIndex + '/' + c.totalChunksInStep + ') · ' +
        c.filePath + ' (L' + c.startLine + '–L' + c.endLine + ') — ' + c.summary;
    } else {
      chunkMetaEl.textContent = 'No active chunk — start a session or wait for your coding agent via MCP.';
    }

    followMeBadge.style.display = payload.followMeActive ? 'inline-block' : 'none';
    followMeApplyRow.style.display = payload.hasFollowMeCode ? 'block' : 'none';

    if (payload.tour && payload.tour.active) {
      tourBanner.classList.add('visible');
      tourLabel.textContent = 'Chalk Tour · Step ' + (payload.tour.currentIndex + 1) + ' of ' + payload.tour.steps.length;
    } else {
      tourBanner.classList.remove('visible');
    }

    if (payload.traceMeta) {
      traceBanner.classList.add('visible');
      traceLabel.textContent = 'Ghost Trace · ' + payload.traceMeta.label + ' (' + (payload.traceMeta.index + 1) + '/' + payload.traceMeta.total + ')';
    } else {
      traceBanner.classList.remove('visible');
    }

    if (!payload.messages || payload.messages.length === 0) {
      messagesEl.innerHTML =
        '<div class="empty-state"><h3>Ask anything about this chunk</h3>' +
        '<p>Side-channel conversations stay completely isolated from the Main Builder Agent. When you click <strong>Continue</strong>, Chalk erases the board and squashes only your final code diff.</p></div>';
    } else {
      messagesEl.innerHTML = payload.messages.map((m) => {
        const cmdBadge = m.command ? '<span class="cmd-tag">/' + escapeHtml(m.command) + '</span>' : '';
        const header = m.role === 'assistant'
          ? '<div class="msg-header"><strong>Chalk</strong>' + cmdBadge + '</div>'
          : '';
        const altHtml = m.altProposal ? renderAltCard(m.altProposal) : '';
        return '<div class="msg ' + m.role + '">' + header +
          '<div class="msg-body">' + renderMarkdown(m.contentMarkdown) + '</div>' + altHtml + '</div>';
      }).join('');

      messagesEl.querySelectorAll('.swap-alt-btn').forEach((btn) => {
        btn.addEventListener('click', () => vscode.postMessage({ type: 'swapAlt' }));
      });
    }

    if (payload.isBusy) {
      const div = document.createElement('div');
      div.className = 'thinking';
      div.textContent = 'Chalk is thinking...';
      messagesEl.appendChild(div);
    }

    messagesEl.scrollTop = messagesEl.scrollHeight;
  });
</script>
</body>
</html>`;
}
