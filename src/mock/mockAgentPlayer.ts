import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  AgentPlayer,
  ChalkMarkInstruction,
  ChalkTourStep,
  ChunkSessionItem,
  CodeChunk,
  MockReplResult,
} from '../types/protocol.js';

interface MockSessionFile {
  title: string;
  description?: string;
  chunks: ChunkSessionItem[];
}

/**
 * Zero-token deterministic UI replay harness driven by `mock-session.json`.
 * Lets developers verify chunk streaming, CodeLens, split-screen tours, /edge,
 * /test, and Undo Chunk in Extension Development Host (F5) without any API key.
 */
export class MockAgentPlayer implements AgentPlayer {
  public readonly name = 'MockAgentPlayer';

  private items: ChunkSessionItem[] = [];
  private cursor = -1;

  constructor(
    private readonly workspaceRoot: string,
    private readonly extensionRoot: string,
    private readonly callbacks?: {
      onUndoChunk?: (chunkId: string) => Promise<boolean>;
      onRunMockTest?: (chunk: CodeChunk, prompt?: string) => Promise<MockReplResult>;
    }
  ) {}

  public async startSession(sessionFilePath?: string): Promise<void> {
    const candidates = [
      sessionFilePath,
      path.join(this.workspaceRoot, 'mock-session.json'),
      path.join(this.extensionRoot, 'mock-session.json'),
    ].filter((p): p is string => Boolean(p));

    const found = candidates.find((p) => fs.existsSync(p));
    if (!found) {
      throw new Error('Could not locate mock-session.json.');
    }

    const parsed = JSON.parse(fs.readFileSync(found, 'utf8')) as MockSessionFile;
    if (!Array.isArray(parsed.chunks) || parsed.chunks.length === 0) {
      throw new Error('mock-session.json has no chunks.');
    }

    this.items = parsed.chunks;
    this.cursor = -1;
  }

  public async nextChunk(): Promise<ChunkSessionItem | null> {
    if (this.cursor + 1 >= this.items.length) {
      return null;
    }
    this.cursor += 1;
    return this.items[this.cursor];
  }

  public async prevChunk(): Promise<ChunkSessionItem | null> {
    if (this.cursor <= 0) {
      return null;
    }
    this.cursor -= 1;
    return this.items[this.cursor];
  }

  public hasMoreChunks(): boolean {
    return this.cursor + 1 < this.items.length;
  }

  public getCurrentChunk(): CodeChunk | null {
    return this.cursor >= 0 && this.cursor < this.items.length
      ? this.items[this.cursor].chunk
      : null;
  }

  public getCurrentItem(): ChunkSessionItem | null {
    return this.cursor >= 0 && this.cursor < this.items.length
      ? this.items[this.cursor]
      : null;
  }

  public async explain(
    prompt?: string
  ): Promise<{ markdown: string; tourSteps: ChalkTourStep[] }> {
    const item = this.getCurrentItem();
    if (!item) {
      return { markdown: 'No active chunk loaded.', tourSteps: [] };
    }
    const steps = item.tourSteps ?? [];
    const header = prompt?.trim()
      ? `Focusing on **"${prompt.trim()}"** in \`${item.chunk.filePath}\`:\n\n`
      : '';
    const body =
      steps.length > 0
        ? steps.map((s, idx) => `**${idx + 1}.** ${s.explanationMarkdown}`).join('\n\n')
        : item.chunk.summary;
    return { markdown: `${header}${body}`, tourSteps: steps };
  }

  public async edge(
    prompt?: string
  ): Promise<{ markdown: string; marks: ChalkMarkInstruction[] }> {
    const item = this.getCurrentItem();
    if (!item) {
      return { markdown: 'No active chunk loaded.', marks: [] };
    }
    const marks = item.edgeMarks ?? [];
    const note = item.edgeNotes ?? 'No edge-case notes recorded for this chunk.';
    const prefix = prompt?.trim() ? `Failure-mode trace for **"${prompt.trim()}"**:\n\n` : '';
    return { markdown: `${prefix}${note}`, marks };
  }

  public async test(prompt?: string): Promise<MockReplResult> {
    const chunk = this.getCurrentChunk();
    if (!chunk) {
      return {
        passed: false,
        inputsUsed: 'none',
        mocksGenerated: [],
        stdout: '',
        error: 'No active chunk loaded.',
        durationMs: 0,
      };
    }
    if (this.callbacks?.onRunMockTest) {
      return this.callbacks.onRunMockTest(chunk, prompt);
    }
    return {
      passed: true,
      inputsUsed: prompt || 'default baseline',
      mocksGenerated: [],
      stdout: 'Mock session sanity test passed.',
      durationMs: 1,
    };
  }

  public async undoChunk(): Promise<boolean> {
    const chunk = this.getCurrentChunk();
    if (!chunk || !this.callbacks?.onUndoChunk) {
      return false;
    }
    return this.callbacks.onUndoChunk(chunk.id);
  }
}
