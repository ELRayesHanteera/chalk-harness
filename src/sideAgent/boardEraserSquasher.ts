import { createTwoFilesPatch, diffLines } from 'diff';
import { CHALK_CONVERSATIONAL_TONE, LlmClient } from '../agent/llmClient.js';
import { SideChatMessage } from '../types/protocol.js';

export interface SquashResult {
  codeModified: boolean;
  unifiedDiff?: string;
  decisionSummary?: string;
}

/**
 * "Erasing the Board" — Context Squasher.
 * Compares the file buffer immediately after DRAWING_CHUNK with the current buffer
 * when the developer clicks [ Continue ]. If modified, computes a compact unified diff
 * plus a 1-sentence architectural summary so the Main Builder Agent receives only the
 * final outcome without any noisy side-chat history.
 */
export class BoardEraserSquasher {
  constructor(private readonly llmClient?: LlmClient) {}

  public async squash(params: {
    filePath: string;
    initialBufferAfterDraw: string;
    currentBuffer: string;
    sideChatTranscript: SideChatMessage[];
  }): Promise<SquashResult> {
    const before = params.initialBufferAfterDraw.replace(/\r\n/g, '\n');
    const after = params.currentBuffer.replace(/\r\n/g, '\n');

    if (before === after) {
      return { codeModified: false };
    }

    const unifiedDiff = createTwoFilesPatch(
      `a/${params.filePath}`,
      `b/${params.filePath}`,
      before,
      after,
      'after-chalk-draw',
      'dev-modified'
    );

    const decisionSummary = await this.summarizeChange(
      params.filePath,
      unifiedDiff,
      before,
      after,
      params.sideChatTranscript
    );

    return {
      codeModified: true,
      unifiedDiff,
      decisionSummary,
    };
  }

  private async summarizeChange(
    filePath: string,
    unifiedDiff: string,
    before: string,
    after: string,
    transcript: SideChatMessage[]
  ): Promise<string> {
    // Try concise LLM summary when configured
    if (this.llmClient?.isConfigured()) {
      try {
        const recentNotes = transcript
          .slice(-4)
          .map((m) => `${m.role}: ${m.contentMarkdown.slice(0, 220)}`)
          .join('\n');

        const prompt = [
          `File modified during side-session: ${filePath}`,
          'Unified diff:',
          '```diff',
          unifiedDiff.slice(0, 4000),
          '```',
          recentNotes ? `Side-chat context:\n${recentNotes}` : '',
          'Write ONE crisp sentence (<= 30 words) summarizing the architectural or behavioral change for the Main Builder Agent so it can run a Plan Ripple Check.',
        ].join('\n');

        const text = await this.llmClient.completeText(
          `${CHALK_CONVERSATIONAL_TONE}\nSummarize code modifications into a single factual sentence.`,
          [{ role: 'user', content: prompt }],
          { maxTokens: 120, temperature: 0.1 }
        );
        const oneLine = text.replace(/\s+/g, ' ').trim();
        if (oneLine) {
          return oneLine;
        }
      } catch {
        // Fall through to deterministic summary
      }
    }

    return buildDeterministicSummary(filePath, before, after);
  }
}

export function buildDeterministicSummary(
  filePath: string,
  before: string,
  after: string
): string {
  const parts = diffLines(before, after);
  let added = 0;
  let removed = 0;
  const touchedSymbols = new Set<string>();

  for (const part of parts) {
    const count = part.count ?? part.value.split('\n').length - 1;
    if (part.added) {
      added += count;
      for (const m of part.value.matchAll(
        /\b(?:function|class|interface|type|const|let|async)\s+([A-Za-z_]\w*)/g
      )) {
        touchedSymbols.add(m[1]);
      }
    } else if (part.removed) {
      removed += count;
    }
  }

  const symbolNote =
    touchedSymbols.size > 0
      ? ` touching ${Array.from(touchedSymbols).slice(0, 4).join(', ')}`
      : '';
  return `Developer modified ${filePath} (+${added}/-${removed} lines${symbolNote}) during side-session; check downstream signatures and plan contracts.`;
}
