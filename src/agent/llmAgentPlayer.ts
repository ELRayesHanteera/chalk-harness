import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import {
  AgentPlayer,
  ChalkMarkInstruction,
  ChalkTourStep,
  ChunkSessionItem,
  CodeChunk,
  MockReplResult,
} from '../types/protocol.js';
import { CHALK_CONVERSATIONAL_TONE, LlmClient } from './llmClient.js';

const ChalkMarkSchema = z.object({
  filePath: z.string().min(1),
  startLine: z.number().int().min(1),
  endLine: z.number().int().min(1),
  color: z.enum(['green', 'amber', 'blue', 'red']),
  label: z.string().optional(),
  openInSplitView: z.boolean().optional(),
});

const ChalkTourStepSchema = z.object({
  primaryMark: ChalkMarkSchema,
  referenceMark: ChalkMarkSchema.optional(),
  explanationMarkdown: z.string().min(1),
});

const SessionChunkSchema = z.object({
  chunk: z.object({
    id: z.string().min(1),
    stepNumber: z.number().int().min(1),
    chunkIndex: z.number().int().min(1),
    totalChunksInStep: z.number().int().min(1),
    filePath: z.string().min(1),
    startLine: z.number().int().min(1),
    endLine: z.number().int().min(1),
    mode: z.enum(['replace', 'insert', 'append']).optional(),
    code: z.string().min(1),
    summary: z.string().min(1),
  }),
  tourSteps: z.array(ChalkTourStepSchema).optional(),
  edgeMarks: z.array(ChalkMarkSchema).optional(),
  edgeNotes: z.string().optional(),
});

const LlmPlanResponseSchema = z.object({
  chunks: z.array(SessionChunkSchema).min(1),
});

const ExplainResponseSchema = z.object({
  markdown: z.string().min(1),
  tourSteps: z.array(ChalkTourStepSchema).default([]),
});

const EdgeResponseSchema = z.object({
  markdown: z.string().min(1),
  marks: z.array(ChalkMarkSchema).default([]),
});

export interface LlmAgentPlayerOptions {
  workspaceRoot: string;
  llmClient: LlmClient;
  maxChunksPerSession: number;
  onUndoChunk?: (chunkId: string) => Promise<boolean>;
  onRunMockTest?: (chunk: CodeChunk, prompt?: string) => Promise<MockReplResult>;
}

/**
 * Live LLM-backed session driver (Step 4).
 * Reads plan.md + target files, generates schema-validated AST chunks with
 * safety/path guardrails, and serves live /explain and /edge queries.
 */
export class LlmAgentPlayer implements AgentPlayer {
  public readonly name = 'LlmAgentPlayer';

  private items: ChunkSessionItem[] = [];
  private cursor = -1;

  constructor(private readonly options: LlmAgentPlayerOptions) {}

  public async startSession(planPath?: string): Promise<void> {
    const resolvedPlan = this.findPlanFile(planPath);
    if (!resolvedPlan) {
      throw new Error(
        'Could not find plan.md (checked plan.md, PLAN.md, .agents/plans/PLAN.md). Pass a plan path or create plan.md in the workspace.'
      );
    }

    const planText = fs.readFileSync(resolvedPlan, 'utf8').slice(0, 12000);
    const contextSnapshot = this.collectReferencedFiles(planText);

    const userPrompt = [
      `Plan file (${path.relative(this.options.workspaceRoot, resolvedPlan)}):`,
      '```markdown',
      planText,
      '```',
      '',
      contextSnapshot
        ? `Existing workspace files referenced or present:\n${contextSnapshot}`
        : 'No pre-existing target files found; you may create new workspace-relative files.',
      '',
      `Decompose the next concrete implementation slice into at most ${Math.min(
        this.options.maxChunksPerSession,
        6
      )} logical AST chunks (10–35 lines each) so a developer can review each chunk synchronously on the chalkboard.`,
      'Return JSON matching:',
      '{',
      '  "chunks": [',
      '    {',
      '      "chunk": { "id": "step1-chunk1", "stepNumber": 1, "chunkIndex": 1, "totalChunksInStep": 2, "filePath": "relative/path.ts", "startLine": 1, "endLine": 15, "mode": "replace" | "insert" | "append", "code": "...", "summary": "1-sentence summary" },',
      '      "tourSteps": [{ "primaryMark": { "filePath": "...", "startLine": 1, "endLine": 5, "color": "green", "label": "..." }, "referenceMark": { "filePath": "...", "startLine": 1, "endLine": 5, "color": "green", "label": "...", "openInSplitView": true }, "explanationMarkdown": "..." }],',
      '      "edgeMarks": [{ "filePath": "...", "startLine": 4, "endLine": 4, "color": "amber", "label": "..." }],',
      '      "edgeNotes": "Brief edge case note"',
      '    }',
      '  ]',
      '}',
    ].join('\n');

    const response = await this.options.llmClient.completeJson(
      `${CHALK_CONVERSATIONAL_TONE}\nYou are the Main Builder Agent decomposing a plan into small, pedagogical AST code chunks.`,
      userPrompt,
      LlmPlanResponseSchema
    );

    const capped = response.chunks.slice(0, this.options.maxChunksPerSession);
    this.items = capped.map((item) => this.validateAndSanitizeChunkItem(item));
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
      return { markdown: 'No active chunk on the chalkboard yet.', tourSteps: [] };
    }

    // Zero-arg fast path if precomputed tourSteps exist and user didn't ask a custom question
    if (!prompt?.trim() && item.tourSteps && item.tourSteps.length > 0) {
      const overview = item.tourSteps
        .map((s, i) => `**${i + 1}.** ${s.explanationMarkdown}`)
        .join('\n\n');
      return { markdown: overview, tourSteps: item.tourSteps };
    }

    const fileContent = this.readFileWithLineNumbers(item.chunk.filePath);
    const question = prompt?.trim()
      ? `The developer asks: "${prompt.trim()}"`
      : 'Walk the developer through how this chunk works, why it lives here, and how it connects to referenced files.';

    const userPrompt = [
      `Active chunk: ${item.chunk.filePath} (lines ${item.chunk.startLine}-${item.chunk.endLine})`,
      `Summary: ${item.chunk.summary}`,
      'Current file contents with 1-based line numbers:',
      '```',
      fileContent,
      '```',
      question,
      'Return JSON: { "markdown": "Warm, crisp explanation", "tourSteps": [{ "primaryMark": { "filePath": "...", "startLine": 1, "endLine": 5, "color": "green", "label": "..." }, "referenceMark": optional, "explanationMarkdown": "..." }] }',
    ].join('\n');

    const result = await this.options.llmClient.completeJson(
      CHALK_CONVERSATIONAL_TONE,
      userPrompt,
      ExplainResponseSchema
    );
    return {
      markdown: result.markdown,
      tourSteps: result.tourSteps.map((s) => this.sanitizeTourStep(s)),
    };
  }

  public async edge(
    prompt?: string
  ): Promise<{ markdown: string; marks: ChalkMarkInstruction[] }> {
    const item = this.getCurrentItem();
    if (!item) {
      return { markdown: 'No active chunk on the chalkboard yet.', marks: [] };
    }

    if (!prompt?.trim() && item.edgeMarks && item.edgeMarks.length > 0 && item.edgeNotes) {
      return { markdown: item.edgeNotes, marks: item.edgeMarks };
    }

    const fileContent = this.readFileWithLineNumbers(item.chunk.filePath);
    const focus = prompt?.trim()
      ? `Trace this specific failure mode: "${prompt.trim()}"`
      : 'Audit this chunk for boundary conditions, null hazards, race/concurrency bugs, or unhandled exceptions.';

    const userPrompt = [
      `Active chunk: ${item.chunk.filePath} (lines ${item.chunk.startLine}-${item.chunk.endLine})`,
      '```',
      fileContent,
      '```',
      focus,
      'Return JSON: { "markdown": "Concise edge-case audit", "marks": [{ "filePath": "...", "startLine": 1, "endLine": 2, "color": "amber", "label": "short hazard label" }] }',
    ].join('\n');

    const result = await this.options.llmClient.completeJson(
      CHALK_CONVERSATIONAL_TONE,
      userPrompt,
      EdgeResponseSchema
    );
    return {
      markdown: result.markdown,
      marks: result.marks.map((m) => this.sanitizeMark(m)),
    };
  }

  public async test(prompt?: string): Promise<MockReplResult> {
    const chunk = this.getCurrentChunk();
    if (!chunk) {
      return {
        passed: false,
        inputsUsed: 'none',
        mocksGenerated: [],
        stdout: '',
        error: 'No active chunk to test.',
        durationMs: 0,
      };
    }
    if (this.options.onRunMockTest) {
      return this.options.onRunMockTest(chunk, prompt);
    }
    return {
      passed: true,
      inputsUsed: prompt || 'default baseline',
      mocksGenerated: [],
      stdout: 'Mocking REPL handler not attached.',
      durationMs: 0,
    };
  }

  public async undoChunk(): Promise<boolean> {
    const chunk = this.getCurrentChunk();
    if (!chunk) {
      return false;
    }
    if (this.options.onUndoChunk) {
      return this.options.onUndoChunk(chunk.id);
    }
    return false;
  }

  private findPlanFile(explicitPath?: string): string | null {
    const candidates = explicitPath
      ? [
          path.isAbsolute(explicitPath)
            ? explicitPath
            : path.resolve(this.options.workspaceRoot, explicitPath),
        ]
      : [
          path.join(this.options.workspaceRoot, 'plan.md'),
          path.join(this.options.workspaceRoot, 'PLAN.md'),
          path.join(this.options.workspaceRoot, '.agents', 'plans', 'PLAN.md'),
        ];

    for (const candidate of candidates) {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return candidate;
      }
    }
    return null;
  }

  private collectReferencedFiles(planText: string): string {
    // Extract file-like paths mentioned in plan.md (e.g., src/foo.ts, authService.ts)
    const matches = new Set<string>();
    const regex = /\b([\w./-]+\.(?:ts|tsx|js|jsx|py|go|rs|json))\b/g;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(planText)) !== null) {
      matches.add(m[1]);
      if (matches.size >= 6) {
        break;
      }
    }

    const snippets: string[] = [];
    for (const rel of matches) {
      const safe = this.safeWorkspacePath(rel);
      if (safe && fs.existsSync(safe) && fs.statSync(safe).isFile()) {
        const content = fs.readFileSync(safe, 'utf8').slice(0, 2500);
        snippets.push(`### ${rel}\n\`\`\`\n${content}\n\`\`\``);
      }
    }
    return snippets.join('\n\n');
  }

  private validateAndSanitizeChunkItem(item: ChunkSessionItem): ChunkSessionItem {
    const safeAbs = this.safeWorkspacePath(item.chunk.filePath);
    if (!safeAbs) {
      throw new Error(
        `Safety guardrail blocked unsafe file path outside workspace: ${item.chunk.filePath}`
      );
    }

    // Clamp line ranges to valid bounds if file already exists
    let startLine = Math.max(1, item.chunk.startLine);
    let endLine = Math.max(startLine, item.chunk.endLine);
    if (fs.existsSync(safeAbs)) {
      const existingLines = Math.max(1, fs.readFileSync(safeAbs, 'utf8').split('\n').length);
      if (item.chunk.mode !== 'append') {
        startLine = Math.min(startLine, existingLines + 1);
        endLine = Math.max(startLine, Math.min(endLine, existingLines + 1));
      }
    }

    return {
      ...item,
      chunk: {
        ...item.chunk,
        filePath: path.relative(this.options.workspaceRoot, safeAbs).replace(/\\/g, '/'),
        startLine,
        endLine,
      },
      tourSteps: item.tourSteps?.map((s) => this.sanitizeTourStep(s)),
      edgeMarks: item.edgeMarks?.map((m) => this.sanitizeMark(m)),
    };
  }

  private sanitizeTourStep(step: ChalkTourStep): ChalkTourStep {
    return {
      primaryMark: this.sanitizeMark(step.primaryMark),
      referenceMark: step.referenceMark ? this.sanitizeMark(step.referenceMark) : undefined,
      explanationMarkdown: step.explanationMarkdown,
    };
  }

  private sanitizeMark(mark: ChalkMarkInstruction): ChalkMarkInstruction {
    const startLine = Math.max(1, mark.startLine);
    const endLine = Math.max(startLine, mark.endLine);
    return { ...mark, startLine, endLine };
  }

  private safeWorkspacePath(filePath: string): string | null {
    const root = path.resolve(this.options.workspaceRoot);
    const resolved = path.resolve(root, filePath);
    const rel = path.relative(root, resolved);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      return null;
    }
    return resolved;
  }

  private readFileWithLineNumbers(filePath: string): string {
    const safe = this.safeWorkspacePath(filePath);
    if (!safe || !fs.existsSync(safe)) {
      return '(file does not exist on disk yet)';
    }
    return fs
      .readFileSync(safe, 'utf8')
      .split('\n')
      .slice(0, 200)
      .map((line, i) => `${i + 1}: ${line}`)
      .join('\n');
  }
}
