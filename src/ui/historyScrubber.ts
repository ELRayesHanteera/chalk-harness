import * as path from 'node:path';
import * as vscode from 'vscode';
import { CHALK_CONVERSATIONAL_TONE, LlmClient } from '../agent/llmClient.js';
import { ShadowCheckpointManager } from '../git/shadowCheckpoint.js';
import { ChalkMarkInstruction, HistorySnapshot } from '../types/protocol.js';
import { CameraController } from './cameraController.js';
import { ChalkMarkManager } from './chalkMarkManager.js';

/**
 * Phase 3: `/history` File Evolution & Commit Visualizer.
 * Combines `git log -p --follow <file>` with `.git/chalk-snapshots/` into an
 * interactive horizontal timeline scrubber with live Green/Amber Chalk highlights
 * and historical `/explain` architectural evolution Q&A.
 */
export class HistoryScrubberController implements vscode.Disposable {
  private panel: vscode.WebviewPanel | null = null;
  private snapshots: HistorySnapshot[] = [];
  private activeFilePath = '';
  private currentIndex = 0;

  constructor(
    private readonly checkpoints: ShadowCheckpointManager,
    private readonly camera: CameraController,
    private readonly markManager: ChalkMarkManager,
    private readonly llmClient: LlmClient
  ) {}

  /**
   * Open the horizontal timeline scrubber for `filePath` and optionally answer
   * an immediate historical question (e.g., `/history why was this block changed 3 commits ago?`).
   */
  public async open(filePath: string, initialQuestion?: string): Promise<string> {
    this.activeFilePath = filePath;
    this.snapshots = await this.checkpoints.getCombinedFileHistory(filePath, 25);

    if (this.snapshots.length === 0) {
      return `No Git commits or Chalk session snapshots recorded yet for \`${filePath}\`.`;
    }

    this.currentIndex = this.snapshots.length - 1;
    this.ensurePanel();
    await this.selectSnapshot(this.currentIndex);

    let answer = '';
    if (initialQuestion?.trim()) {
      answer = await this.explainEvolution(initialQuestion.trim());
      this.postAnswer(initialQuestion.trim(), answer);
    }

    const gitCount = this.snapshots.filter((s) => s.source === 'git').length;
    const chalkCount = this.snapshots.filter((s) => s.source === 'chalk-snapshot').length;
    const baseSummary = `Opened **File History Scrubber** for \`${path.basename(filePath)}\` (${gitCount} Git commit(s), ${chalkCount} Chalk snapshot(s)). Drag the slider or press **‹ Older / Newer ›** to highlight Green (added) & Amber (modified) blocks.`;
    return answer ? `${baseSummary}\n\n${answer}` : baseSummary;
  }

  private ensurePanel(): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside, false);
      this.syncState();
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      'chalkHistoryScrubber',
      'Chalk — File Evolution Scrubber (/history)',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
      { enableScripts: true, retainContextWhenHidden: true }
    );

    this.panel.webview.html = getScrubberHtml();
    this.panel.webview.onDidReceiveMessage(
      async (msg: { type: string; index?: number; question?: string }) => {
        if (msg.type === 'select' && typeof msg.index === 'number') {
          await this.selectSnapshot(msg.index);
        } else if (msg.type === 'older') {
          await this.selectSnapshot(Math.max(0, this.currentIndex - 1));
        } else if (msg.type === 'newer') {
          await this.selectSnapshot(Math.min(this.snapshots.length - 1, this.currentIndex + 1));
        } else if (msg.type === 'explain' && msg.question?.trim()) {
          this.postBusy(true);
          const ans = await this.explainEvolution(msg.question.trim());
          this.postBusy(false);
          this.postAnswer(msg.question.trim(), ans);
        }
      }
    );

    this.panel.onDidDispose(() => {
      this.panel = null;
      this.markManager.clearMarks(true);
    });
  }

  private async selectSnapshot(index: number): Promise<void> {
    if (this.snapshots.length === 0) {
      return;
    }
    this.currentIndex = Math.max(0, Math.min(index, this.snapshots.length - 1));
    const snap = this.snapshots[this.currentIndex];

    // Apply Green (added) & Amber (modified) Chalk Marks onto the active file editor
    const marks = buildHistoryMarks(this.activeFilePath, snap);
    if (marks.length > 0) {
      const first = marks[0];
      await this.camera.focusChunk(this.activeFilePath, first.startLine, first.endLine, {
        viewColumn: vscode.ViewColumn.One,
        preserveFocus: true,
      });
      this.markManager.applyMarks(marks, (fp) => this.camera.resolveUri(fp), false);
    } else {
      this.markManager.clearMarks(true);
    }

    // Show inline Ghost Chalk commit/chunk summary on line 1
    const uri = this.camera.resolveUri(this.activeFilePath);
    this.markManager.setGhostText(uri, [
      {
        line: marks[0]?.startLine ?? 1,
        text: `[${snap.source === 'git' ? snap.id : snap.label}] ${snap.summary}`,
        color: snap.source === 'git' ? 'green' : 'amber',
      },
    ]);

    this.syncState();
  }

  private async explainEvolution(question: string): Promise<string> {
    const active = this.snapshots[this.currentIndex];
    const recentDiffs = this.snapshots
      .slice(Math.max(0, this.currentIndex - 4), this.currentIndex + 1)
      .map(
        (s, idx) =>
          `### Snapshot ${idx + 1}: ${s.label} (${s.timestamp})\nSummary: ${s.summary}\n\`\`\`diff\n${(s.diffFromPrevious ?? '').slice(0, 1400)}\n\`\`\``
      )
      .join('\n\n');

    if (this.llmClient.isConfigured()) {
      try {
        return await this.llmClient.completeText(
          `${CHALK_CONVERSATIONAL_TONE}\nExplain the historical architectural evolution of this file from the commit/snapshot diffs below.`,
          [
            {
              role: 'user',
              content: [
                `File: ${this.activeFilePath}`,
                `Selected snapshot: ${active.label}`,
                recentDiffs,
                `Developer question: ${question}`,
              ].join('\n\n'),
            },
          ],
          { maxTokens: 550 }
        );
      } catch (err) {
        return `Could not query LLM (${(err as Error).message}). Showing commit metadata instead: **${active.label}** — ${active.summary}`;
      }
    }

    return `**${active.label}** (${active.author ?? 'unknown'}, ${active.timestamp}):\n${active.summary}\n\n*(Configure \`chalk.llm.apiKey\` for natural-language historical evolution explanations across commits.)*`;
  }

  private syncState(): void {
    if (!this.panel) {
      return;
    }
    void this.panel.webview.postMessage({
      type: 'state',
      payload: {
        filePath: this.activeFilePath,
        currentIndex: this.currentIndex,
        snapshots: this.snapshots.map((s) => ({
          id: s.id,
          source: s.source,
          label: s.label,
          timestamp: s.timestamp,
          author: s.author,
          summary: s.summary,
          diff: (s.diffFromPrevious ?? '').slice(0, 8000),
          addedCount: s.changedLines?.added.length ?? 0,
          modifiedCount: s.changedLines?.modified.length ?? 0,
        })),
      },
    });
  }

  private postBusy(busy: boolean): void {
    void this.panel?.webview.postMessage({ type: 'busy', busy });
  }

  private postAnswer(question: string, answer: string): void {
    void this.panel?.webview.postMessage({ type: 'answer', question, answer });
  }

  public dispose(): void {
    this.panel?.dispose();
    this.panel = null;
  }
}

function buildHistoryMarks(
  filePath: string,
  snap: HistorySnapshot
): ChalkMarkInstruction[] {
  const marks: ChalkMarkInstruction[] = [];
  const addedRanges = collapseLineNumbersToRanges(snap.changedLines?.added ?? []);
  const modRanges = collapseLineNumbersToRanges(snap.changedLines?.modified ?? []);

  for (const [start, end] of addedRanges.slice(0, 6)) {
    marks.push({
      filePath,
      startLine: start,
      endLine: end,
      color: 'green',
      label: `Added in ${snap.id}`,
    });
  }
  for (const [start, end] of modRanges.slice(0, 6)) {
    marks.push({
      filePath,
      startLine: start,
      endLine: end,
      color: 'amber',
      label: `Modified in ${snap.id}`,
    });
  }
  return marks;
}

export function collapseLineNumbersToRanges(lines: number[]): Array<[number, number]> {
  if (lines.length === 0) {
    return [];
  }
  const sorted = Array.from(new Set(lines)).sort((a, b) => a - b);
  const ranges: Array<[number, number]> = [];
  let start = sorted[0];
  let prev = sorted[0];

  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === prev + 1) {
      prev = sorted[i];
    } else {
      ranges.push([start, prev]);
      start = sorted[i];
      prev = sorted[i];
    }
  }
  ranges.push([start, prev]);
  return ranges;
}

function getScrubberHtml(): string {
  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Chalk File History Scrubber</title>
<style>
  :root {
    --bg: var(--vscode-editor-background, #191918);
    --surface: var(--vscode-sideBar-background, #21201e);
    --surface-2: var(--vscode-input-background, #2a2926);
    --border: var(--vscode-panel-border, rgba(255,255,255,0.1));
    --fg: var(--vscode-editor-foreground, #eceae4);
    --muted: var(--vscode-descriptionForeground, #9e9b93);
    --accent: #d97757;
    --green: #4ade80;
    --amber: #fbbf24;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--fg);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, sans-serif;
    font-size: 13px;
    display: flex;
    flex-direction: column;
    height: 100vh;
  }
  .scrubber-bar {
    padding: 12px 16px;
    background: var(--surface);
    border-bottom: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .row { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
  .title { font-weight: 600; font-size: 13.5px; }
  .meta { font-size: 12px; color: var(--muted); }
  .slider-wrap { display: flex; align-items: center; gap: 10px; }
  input[type="range"] { flex: 1; accent-color: var(--accent); cursor: pointer; }
  button {
    cursor: pointer;
    border: 1px solid var(--border);
    border-radius: 7px;
    padding: 5px 10px;
    background: var(--surface-2);
    color: var(--fg);
    font-size: 12px;
  }
  button.primary { background: var(--accent); color: #fff; border-color: transparent; }
  .badges { display: flex; gap: 8px; font-size: 11.5px; }
  .badge { padding: 2px 8px; border-radius: 999px; background: var(--surface-2); }
  .badge.green { color: var(--green); }
  .badge.amber { color: var(--amber); }
  .body {
    flex: 1;
    overflow-y: auto;
    padding: 14px 16px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  pre {
    margin: 0;
    padding: 12px;
    border-radius: 8px;
    background: var(--surface);
    border: 1px solid var(--border);
    overflow-x: auto;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 12px;
    line-height: 1.45;
    white-space: pre;
  }
  .answer-card {
    padding: 10px 12px;
    border-radius: 8px;
    background: rgba(217, 119, 87, 0.12);
    border: 1px solid rgba(217, 119, 87, 0.35);
    white-space: pre-wrap;
    line-height: 1.5;
  }
  .ask-bar {
    padding: 10px 16px;
    background: var(--surface);
    border-top: 1px solid var(--border);
    display: flex;
    gap: 8px;
  }
  .ask-bar input {
    flex: 1;
    background: var(--surface-2);
    color: var(--fg);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 7px 10px;
    outline: none;
    font-size: 12.5px;
  }
  .ask-bar input:focus { border-color: var(--accent); }
</style>
</head>
<body>
  <div class="scrubber-bar">
    <div class="row">
      <div class="title" id="fileTitle">File Evolution</div>
      <div class="meta" id="counterLabel">0 / 0</div>
    </div>
    <div class="slider-wrap">
      <button id="olderBtn">‹ Older</button>
      <input type="range" id="slider" min="0" max="0" value="0" />
      <button id="newerBtn">Newer ›</button>
    </div>
    <div class="row">
      <div id="snapSummary" class="meta"></div>
      <div class="badges" id="badges"></div>
    </div>
  </div>

  <div class="body">
    <div id="answerContainer" style="display:none;" class="answer-card"></div>
    <pre id="diffView">Select a snapshot to inspect its diff.</pre>
  </div>

  <div class="ask-bar">
    <input id="questionInput" placeholder="/explain why was this block changed 3 commits ago?" />
    <button class="primary" id="askBtn">Ask Chalk</button>
  </div>

<script>
  const vscode = acquireVsCodeApi();
  const slider = document.getElementById('slider');
  const fileTitle = document.getElementById('fileTitle');
  const counterLabel = document.getElementById('counterLabel');
  const snapSummary = document.getElementById('snapSummary');
  const badges = document.getElementById('badges');
  const diffView = document.getElementById('diffView');
  const answerContainer = document.getElementById('answerContainer');
  const questionInput = document.getElementById('questionInput');

  slider.addEventListener('input', () => {
    vscode.postMessage({ type: 'select', index: Number(slider.value) });
  });
  document.getElementById('olderBtn').addEventListener('click', () => vscode.postMessage({ type: 'older' }));
  document.getElementById('newerBtn').addEventListener('click', () => vscode.postMessage({ type: 'newer' }));

  function ask() {
    const q = questionInput.value.trim();
    if (!q) return;
    vscode.postMessage({ type: 'explain', question: q });
    questionInput.value = '';
  }
  document.getElementById('askBtn').addEventListener('click', ask);
  questionInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') ask();
  });

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg.type === 'state') {
      const { filePath, currentIndex, snapshots } = msg.payload;
      fileTitle.textContent = 'History · ' + filePath;
      slider.max = Math.max(0, snapshots.length - 1);
      slider.value = currentIndex;
      counterLabel.textContent = (currentIndex + 1) + ' / ' + snapshots.length;

      const cur = snapshots[currentIndex];
      if (cur) {
        snapSummary.textContent = cur.label + ' · ' + (cur.author || '') + ' · ' + (cur.timestamp || '').slice(0, 19).replace('T', ' ');
        badges.innerHTML =
          '<span class="badge">' + (cur.source === 'git' ? 'Git Commit' : 'Chalk Snapshot') + '</span>' +
          '<span class="badge green">+' + cur.addedCount + ' added</span>' +
          '<span class="badge amber">~' + cur.modifiedCount + ' modified</span>';
        diffView.textContent = cur.diff || '(initial file or empty diff)';
      }
    } else if (msg.type === 'busy') {
      answerContainer.style.display = 'block';
      answerContainer.textContent = msg.busy ? 'Analyzing historical diffs...' : answerContainer.textContent;
    } else if (msg.type === 'answer') {
      answerContainer.style.display = 'block';
      answerContainer.textContent = 'Q: ' + msg.question + '\\n\\n' + msg.answer;
    }
  });
</script>
</body>
</html>`;
}
