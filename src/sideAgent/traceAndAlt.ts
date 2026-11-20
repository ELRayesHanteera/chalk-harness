import { createTwoFilesPatch } from 'diff';
import { z } from 'zod';
import { CHALK_CONVERSATIONAL_TONE, LlmClient } from '../agent/llmClient.js';
import {
  AltProposal,
  CodeChunk,
  GhostTextAnnotation,
  TraceIteration,
  TraceResult,
} from '../types/protocol.js';
import { MockingRepl } from './mockingRepl.js';

const TraceResponseSchema = z.object({
  inputSummary: z.string().min(1),
  iterations: z
    .array(
      z.object({
        iterationLabel: z.string().min(1),
        narrative: z.string().min(1),
        annotations: z.array(
          z.object({
            line: z.number().int().min(1),
            text: z.string().min(1),
            color: z.enum(['green', 'amber', 'blue', 'red']).optional(),
          })
        ),
      })
    )
    .min(1),
  finalOutcome: z.string().min(1),
});

const AltResponseSchema = z.object({
  title: z.string().min(1),
  rationale: z.string().min(1),
  alternativeCode: z.string().min(1),
  tradeOffs: z
    .array(
      z.object({
        dimension: z.string().min(1),
        current: z.string().min(1),
        alternative: z.string().min(1),
      })
    )
    .min(1),
});

/**
 * Phase 2 Engine:
 * - `/trace [inputs?]` -> Live Ghost-Chalk Dry-Run Debugger with loop iteration stepping.
 * - `/alt [prompt?]`   -> Architectural Fork with unified diff, trade-off matrix, and one-click swap.
 */
export class TraceAndAltEngine {
  constructor(
    private readonly llmClient: LlmClient,
    private readonly mockingRepl: MockingRepl
  ) {}

  public async runTrace(
    chunk: CodeChunk,
    fileContent: string,
    prompt: string
  ): Promise<TraceResult> {
    const inputSummary = prompt.trim() || 'default representative inputs';

    if (this.llmClient.isConfigured()) {
      try {
        const numbered = numberFileLines(fileContent);
        const userPrompt = [
          `Dry-run trace of ${chunk.filePath} (active chunk lines ${chunk.startLine}-${chunk.endLine}).`,
          `Inputs to trace: ${inputSummary}`,
          'File with 1-based line numbers:',
          '```',
          numbered,
          '```',
          'Trace execution step by step. For each executed line in the chunk, produce a short Ghost Chalk inline annotation (e.g., "user_id = 42 -> isAuthorized = false").',
          'If there is a loop, return 2–3 iterations in `iterations[]` so the developer can step through them with [< Prev / Next >]. Otherwise return 1 iteration.',
          'Return JSON: { "inputSummary": "...", "iterations": [{ "iterationLabel": "Pass 1", "narrative": "...", "annotations": [{ "line": 12, "text": "...", "color": "blue" | "green" | "amber" | "red" }] }], "finalOutcome": "..." }',
        ].join('\n');

        return await this.llmClient.completeJson(
          `${CHALK_CONVERSATIONAL_TONE}\nYou are performing a crisp symbolic dry-run trace of code.`,
          userPrompt,
          TraceResponseSchema
        );
      } catch {
        // Fall through to deterministic symbolic + REPL trace
      }
    }

    return this.buildDeterministicTrace(chunk, fileContent, inputSummary);
  }

  public async generateAlternative(
    chunk: CodeChunk,
    fileContent: string,
    prompt: string
  ): Promise<AltProposal> {
    const chunkLines = extractChunkSlice(fileContent, chunk.startLine, chunk.endLine);
    const direction =
      prompt.trim() || 'cleaner, more idiomatic alternative with clear trade-offs';

    if (this.llmClient.isConfigured()) {
      try {
        const userPrompt = [
          `Active chunk in ${chunk.filePath} (lines ${chunk.startLine}-${chunk.endLine}):`,
          '```',
          chunkLines,
          '```',
          `Alternative requested: ${direction}`,
          'Return JSON with:',
          '- title: short descriptive title',
          '- rationale: 2-sentence comparison explaining when to prefer this alternative',
          '- alternativeCode: exact drop-in replacement code for lines startLine..endLine (no markdown fences)',
          '- tradeOffs: array of 3 rows for dimensions "Complexity", "Memory / Speed", and "Readability" with concise "current" and "alternative" columns.',
        ].join('\n');

        const result = await this.llmClient.completeJson(
          `${CHALK_CONVERSATIONAL_TONE}\nGenerate a clean drop-in architectural alternative for the active chunk.`,
          userPrompt,
          AltResponseSchema
        );

        const unifiedDiff = createTwoFilesPatch(
          `a/${chunk.filePath} (current)`,
          `b/${chunk.filePath} (alt)`,
          chunkLines,
          result.alternativeCode,
          `L${chunk.startLine}-L${chunk.endLine}`,
          result.title
        );

        return {
          title: result.title,
          rationale: result.rationale,
          alternativeCode: result.alternativeCode,
          unifiedDiff,
          tradeOffs: result.tradeOffs,
        };
      } catch {
        // Fall through to deterministic structural alternative
      }
    }

    return this.buildDeterministicAlt(chunk, chunkLines, direction);
  }

  private async buildDeterministicTrace(
    chunk: CodeChunk,
    fileContent: string,
    inputSummary: string
  ): Promise<TraceResult> {
    const bindings = parseKeyValueBindings(inputSummary);
    const fileLines = fileContent.replace(/\r\n/g, '\n').split('\n');
    const startIdx = Math.max(0, chunk.startLine - 1);
    const endIdx = Math.min(fileLines.length - 1, chunk.endLine - 1);

    // Try running the Mocking REPL to enrich the outcome when JS/TS
    let replOutcome = '';
    try {
      const repl = await this.mockingRepl.runTest({
        chunk,
        fileContent,
        prompt: inputSummary,
      });
      if (repl.passed && repl.returnValue) {
        replOutcome = `Mocking REPL return: ${repl.returnValue.replace(/\s+/g, ' ').slice(0, 120)}`;
      }
    } catch {
      // Ignore REPL errors during symbolic fallback
    }

    const annotations: GhostTextAnnotation[] = [];
    const hasLoop = fileLines
      .slice(startIdx, endIdx + 1)
      .some((l) => /\b(for|while)\s*\(/.test(l));

    for (let i = startIdx; i <= endIdx; i++) {
      const lineNum = i + 1;
      const trimmed = fileLines[i].trim();
      if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('*')) {
        continue;
      }

      if (/\bif\s*\(/.test(trimmed)) {
        const condMatch = trimmed.match(/if\s*\((.+)\)/);
        const cond = condMatch ? condMatch[1].trim() : 'condition';
        const evalHint = evaluateSimpleHint(cond, bindings);
        annotations.push({
          line: lineNum,
          text: `${cond} -> ${evalHint}`,
          color: evalHint.includes('true') ? 'amber' : 'blue',
        });
      } else if (/\b(?:const|let)\s+(\w+)\s*=/.test(trimmed)) {
        const m = trimmed.match(/\b(?:const|let)\s+(\w+)\s*=\s*(.+?);?$/);
        if (m) {
          const val = bindings[m[1]] ?? summarizeExpr(m[2], bindings);
          annotations.push({
            line: lineNum,
            text: `${m[1]} = ${val}`,
            color: 'blue',
          });
        }
      } else if (/\breturn\b/.test(trimmed)) {
        annotations.push({
          line: lineNum,
          text: `returns ${trimmed.replace(/^return\s*/, '').replace(/;$/, '')}`,
          color: 'green',
        });
      } else if (/\bthrow\b/.test(trimmed)) {
        annotations.push({
          line: lineNum,
          text: `throws ${trimmed.replace(/^throw\s*/, '').replace(/;$/, '')}`,
          color: 'red',
        });
      }
    }

    if (annotations.length === 0) {
      annotations.push({
        line: chunk.startLine,
        text: `traced with ${inputSummary}`,
        color: 'blue',
      });
    }

    const iterations: TraceIteration[] = hasLoop
      ? [0, 1].map((idx) => ({
          iterationLabel: `Iteration ${idx + 1}`,
          narrative: `Loop pass #${idx + 1} with inputs \`${inputSummary}\`.`,
          annotations: annotations.map((a) => ({
            ...a,
            text: `[iter ${idx + 1}] ${a.text}`,
          })),
        }))
      : [
          {
            iterationLabel: 'Execution Path',
            narrative: `Traced ${annotations.length} state transition(s) across lines ${chunk.startLine}–${chunk.endLine} for \`${inputSummary}\`.`,
            annotations,
          },
        ];

    return {
      inputSummary,
      iterations,
      finalOutcome:
        replOutcome ||
        `Completed dry-run trace across lines ${chunk.startLine}–${chunk.endLine}.`,
    };
  }

  private buildDeterministicAlt(
    chunk: CodeChunk,
    chunkLines: string,
    direction: string
  ): AltProposal {
    // Produce a clean readable table-driven / documented alternative when offline
    const lines = chunkLines.replace(/\r\n/g, '\n').split('\n');
    const altCode = [
      `// Alternative (${direction})`,
      ...lines.map((l) => l.replace(/\s+$/, '')),
    ].join('\n');

    const unifiedDiff = createTwoFilesPatch(
      `a/${chunk.filePath} (current)`,
      `b/${chunk.filePath} (alt)`,
      chunkLines,
      altCode,
      `L${chunk.startLine}-L${chunk.endLine}`,
      direction
    );

    return {
      title: `Alternative: ${direction}`,
      rationale:
        'Offline preview generated without an active LLM API key. Configure `chalk.llm.apiKey` to synthesize full functional/idiomatic refactors with deep trade-off analysis, or click Swap Chunk to test the live buffer swap and Context Squash loop.',
      alternativeCode: altCode,
      unifiedDiff,
      tradeOffs: [
        {
          dimension: 'Complexity',
          current: 'Imperative branch sequence',
          alternative: 'Annotated / structured variant',
        },
        {
          dimension: 'Memory / Speed',
          current: 'O(1) stack allocations',
          alternative: 'Equivalent runtime profile',
        },
        {
          dimension: 'Readability',
          current: 'Direct inline control flow',
          alternative: 'Explicit intent header for reviewers',
        },
      ],
    };
  }
}

export function parseKeyValueBindings(input: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const match of input.matchAll(/(\w+)\s*=\s*("[^"]*"|'[^']*'|[^,\s]+)/g)) {
    result[match[1]] = match[2];
  }
  return result;
}

function evaluateSimpleHint(cond: string, bindings: Record<string, string>): string {
  for (const [k, v] of Object.entries(bindings)) {
    if (cond.includes(k)) {
      const unquoted = v.replace(/^['"]|['"]$/g, '');
      if (cond.includes(`!${k}`) && (!unquoted || unquoted === 'false' || unquoted === '0')) {
        return `true (${k}=${v})`;
      }
      return `evaluated with ${k}=${v}`;
    }
  }
  return 'checked';
}

function summarizeExpr(expr: string, bindings: Record<string, string>): string {
  let out = expr.trim();
  for (const [k, v] of Object.entries(bindings)) {
    out = out.replace(new RegExp(`\\b${k}\\b`, 'g'), v);
  }
  return out.length > 48 ? `${out.slice(0, 45)}...` : out;
}

function extractChunkSlice(fileContent: string, startLine: number, endLine: number): string {
  const lines = fileContent.replace(/\r\n/g, '\n').split('\n');
  const s = Math.max(0, startLine - 1);
  const e = Math.min(lines.length, Math.max(startLine, endLine));
  return lines.slice(s, e).join('\n');
}

function numberFileLines(content: string): string {
  return content
    .replace(/\r\n/g, '\n')
    .split('\n')
    .slice(0, 220)
    .map((line, i) => `${i + 1}: ${line}`)
    .join('\n');
}
