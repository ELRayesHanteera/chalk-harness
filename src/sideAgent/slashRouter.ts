import {
  AgentPlayer,
  AltProposal,
  ChalkMarkInstruction,
  ChalkTourStep,
  CodeChunk,
  MockReplResult,
  ParsedSlashCommand,
  SideChatMessage,
  SlashCommandName,
  TraceResult,
} from '../types/protocol.js';
import { CHALK_CONVERSATIONAL_TONE, ChatMessage, LlmClient } from '../agent/llmClient.js';
import { MockingRepl } from './mockingRepl.js';

/** Exact command grammar specified in PLAN.md */
export const SLASH_COMMAND_REGEX =
  /^\/(explain|edge|test|followme|trace|alt|history)(?:\s+(.*))?$/s;

export function parseSlashCommand(input: string): ParsedSlashCommand | null {
  const trimmed = input.trim();
  const match = trimmed.match(SLASH_COMMAND_REGEX);
  if (!match) {
    return null;
  }
  return {
    command: match[1] as SlashCommandName,
    prompt: (match[2] ?? '').trim(),
    raw: trimmed,
  };
}

export interface SlashExecutionContext {
  chunk: CodeChunk;
  fileContent: string;
  activePlayer?: AgentPlayer | null;
  /** Optional Phase 2 / Phase 3 handlers attached by the session coordinator */
  onTrace?: (chunk: CodeChunk, fileContent: string, prompt: string) => Promise<TraceResult>;
  onAlt?: (chunk: CodeChunk, fileContent: string, prompt: string) => Promise<AltProposal>;
  onHistory?: (filePath: string, prompt: string) => Promise<string>;
}

export interface SlashExecutionOutcome {
  assistantMessage: SideChatMessage;
  tourSteps?: ChalkTourStep[];
  marks?: ChalkMarkInstruction[];
  followMeActive?: boolean;
  followMeCompletionCode?: string;
  traceResult?: TraceResult;
  altProposal?: AltProposal;
}

/**
 * Isolated Ephemeral Side-Agent Router.
 * Holds side-chat history strictly inside the active chunk session and wipes it
 * cleanly whenever `eraseBoard()` is invoked ("Erasing the board").
 */
export class SlashRouter {
  private messages: SideChatMessage[] = [];
  private followMeEnabled = false;
  private lastFollowMeHintBuffer = '';

  constructor(
    private readonly llmClient: LlmClient,
    private readonly mockingRepl: MockingRepl
  ) {}

  public getMessages(): SideChatMessage[] {
    return [...this.messages];
  }

  public isFollowMeActive(): boolean {
    return this.followMeEnabled;
  }

  public setFollowMeActive(active: boolean): void {
    this.followMeEnabled = active;
  }

  /** Wipe ephemeral side-chat history clean ("Erasing the board"). */
  public eraseBoard(): void {
    this.messages = [];
    this.followMeEnabled = false;
    this.lastFollowMeHintBuffer = '';
  }

  public async handleInput(
    rawInput: string,
    ctx: SlashExecutionContext
  ): Promise<SlashExecutionOutcome> {
    const trimmed = rawInput.trim();
    const parsed = parseSlashCommand(trimmed);

    const userMsg: SideChatMessage = {
      id: makeId('u'),
      role: 'user',
      command: parsed?.command,
      contentMarkdown: trimmed,
      timestamp: new Date().toISOString(),
    };
    this.messages.push(userMsg);

    if (!parsed) {
      return this.handleFreeformQuestion(trimmed, ctx);
    }

    switch (parsed.command) {
      case 'explain':
        return this.handleExplain(parsed.prompt, ctx);
      case 'edge':
        return this.handleEdge(parsed.prompt, ctx);
      case 'test':
        return this.handleTest(parsed.prompt, ctx);
      case 'followme':
        return this.handleFollowMe(parsed.prompt, ctx);
      case 'trace':
        return this.handleTrace(parsed.prompt, ctx);
      case 'alt':
        return this.handleAlt(parsed.prompt, ctx);
      case 'history':
        return this.handleHistory(parsed.prompt, ctx);
    }
  }

  /**
   * Mode A of `/followme` (Model Coaches Dev): called by a debounced
   * `workspace.onDidChangeTextDocument` listener as the dev edits code live.
   */
  public async coachLiveEdit(
    chunk: CodeChunk,
    currentFileContent: string
  ): Promise<SideChatMessage | null> {
    if (!this.followMeEnabled) {
      return null;
    }
    if (currentFileContent === this.lastFollowMeHintBuffer) {
      return null;
    }
    this.lastFollowMeHintBuffer = currentFileContent;

    let coachingText: string;
    if (this.llmClient.isConfigured()) {
      try {
        coachingText = await this.llmClient.completeText(
          `${CHALK_CONVERSATIONAL_TONE}\nYou are in /followme Mode A (live coaching). The developer just edited code inside the active chunk. Give ONE short, helpful, non-intrusive nudge (syntax tip, edge-case reminder, or affirmation in <= 2 sentences).`,
          [
            {
              role: 'user',
              content: `File: ${chunk.filePath} (lines ${chunk.startLine}-${chunk.endLine})\nCurrent buffer:\n\`\`\`\n${currentFileContent.slice(0, 3500)}\n\`\`\``,
            },
          ],
          { maxTokens: 140, temperature: 0.25 }
        );
      } catch (err) {
        coachingText = `Live coaching paused (${(err as Error).message}).`;
      }
    } else {
      const todoCount = (currentFileContent.match(/\bTODO\b/g) ?? []).length;
      coachingText =
        todoCount > 0
          ? `Spotted ${todoCount} \`TODO\` marker(s) in your edit — type \`/followme finish my stub\` if you'd like Chalk to complete the implementation from your structure.`
          : `Nice edit on \`${chunk.filePath}\` — run \`/test\` anytime to sanity-check your changes in the Mocking REPL, or click **Continue** when ready to squash this diff back to the main agent.`;
    }

    const msg: SideChatMessage = {
      id: makeId('a'),
      role: 'assistant',
      command: 'followme',
      contentMarkdown: coachingText,
      timestamp: new Date().toISOString(),
    };
    this.messages.push(msg);
    return msg;
  }

  private async handleExplain(
    prompt: string,
    ctx: SlashExecutionContext
  ): Promise<SlashExecutionOutcome> {
    let markdown = '';
    let tourSteps: ChalkTourStep[] = [];

    if (ctx.activePlayer && (!prompt || !this.llmClient.isConfigured())) {
      const res = await ctx.activePlayer.explain(prompt);
      markdown = res.markdown;
      tourSteps = res.tourSteps;
    } else if (this.llmClient.isConfigured()) {
      const numbered = numberLines(ctx.fileContent);
      const reply = await this.llmClient.completeText(
        CHALK_CONVERSATIONAL_TONE,
        [
          ...this.toLlmHistory(),
          {
            role: 'user',
            content: [
              `Active chunk: ${ctx.chunk.filePath} (lines ${ctx.chunk.startLine}-${ctx.chunk.endLine})`,
              `Summary: ${ctx.chunk.summary}`,
              '```',
              numbered,
              '```',
              prompt
                ? `Explain specifically: ${prompt}`
                : 'Explain the intuition, data flow, and why each piece lives here.',
            ].join('\n'),
          },
        ],
        { maxTokens: 600 }
      );
      markdown = reply;
      tourSteps = [
        {
          primaryMark: {
            filePath: ctx.chunk.filePath,
            startLine: ctx.chunk.startLine,
            endLine: ctx.chunk.endLine,
            color: 'green',
            label: prompt ? prompt.slice(0, 40) : 'Focused chunk',
          },
          explanationMarkdown: reply,
        },
      ];
    } else {
      markdown = `**${ctx.chunk.filePath}** (lines ${ctx.chunk.startLine}–${ctx.chunk.endLine}): ${ctx.chunk.summary}\n\n*(Connect an LLM API key in \`chalk.llm.apiKey\` for custom natural-language deep-dives.)*`;
      tourSteps = [
        {
          primaryMark: {
            filePath: ctx.chunk.filePath,
            startLine: ctx.chunk.startLine,
            endLine: ctx.chunk.endLine,
            color: 'green',
            label: 'Active chunk',
          },
          explanationMarkdown: ctx.chunk.summary,
        },
      ];
    }

    const assistantMessage: SideChatMessage = {
      id: makeId('a'),
      role: 'assistant',
      command: 'explain',
      contentMarkdown: markdown,
      timestamp: new Date().toISOString(),
      tourSteps,
    };
    this.messages.push(assistantMessage);
    return { assistantMessage, tourSteps };
  }

  private async handleEdge(
    prompt: string,
    ctx: SlashExecutionContext
  ): Promise<SlashExecutionOutcome> {
    let markdown = '';
    let marks: ChalkMarkInstruction[] = [];

    if (ctx.activePlayer && (!prompt || !this.llmClient.isConfigured())) {
      const res = await ctx.activePlayer.edge(prompt);
      markdown = res.markdown;
      marks = res.marks;
    } else if (this.llmClient.isConfigured()) {
      const numbered = numberLines(ctx.fileContent);
      markdown = await this.llmClient.completeText(
        CHALK_CONVERSATIONAL_TONE,
        [
          ...this.toLlmHistory(),
          {
            role: 'user',
            content: [
              `Edge-case audit on ${ctx.chunk.filePath} (lines ${ctx.chunk.startLine}-${ctx.chunk.endLine}):`,
              '```',
              numbered,
              '```',
              prompt
                ? `Trace this specific failure scenario: ${prompt}`
                : 'Find boundary conditions, null/undefined hazards, concurrency/race issues, or unhandled exceptions. Cite exact line numbers.',
            ].join('\n'),
          },
        ],
        { maxTokens: 550 }
      );
      marks = extractLineMarksFromText(markdown, ctx.chunk, 'amber');
    } else {
      markdown = `Static edge-case scan on **${ctx.chunk.filePath}**: check null/empty inputs, error propagation, and boundary values across lines ${ctx.chunk.startLine}–${ctx.chunk.endLine}.`;
      marks = [
        {
          filePath: ctx.chunk.filePath,
          startLine: ctx.chunk.startLine,
          endLine: ctx.chunk.endLine,
          color: 'amber',
          label: 'Review boundary & error handling',
        },
      ];
    }

    const assistantMessage: SideChatMessage = {
      id: makeId('a'),
      role: 'assistant',
      command: 'edge',
      contentMarkdown: markdown,
      timestamp: new Date().toISOString(),
      edgeMarks: marks,
    };
    this.messages.push(assistantMessage);
    return { assistantMessage, marks };
  }

  private async handleTest(
    prompt: string,
    ctx: SlashExecutionContext
  ): Promise<SlashExecutionOutcome> {
    const result: MockReplResult = await this.mockingRepl.runTest({
      chunk: ctx.chunk,
      fileContent: ctx.fileContent,
      prompt: prompt || undefined,
    });

    const lines = [
      result.passed
        ? `**Mocking REPL Passed** (${result.durationMs}ms)`
        : `**Mocking REPL Failed** (${result.durationMs}ms)`,
      `- **Inputs:** \`${result.inputsUsed}\``,
      `- **Auto-mocked dependencies:** ${
        result.mocksGenerated.length > 0
          ? result.mocksGenerated.map((m) => `\`${m}\``).join(', ')
          : 'none needed'
      }`,
    ];
    if (result.stdout) {
      lines.push('', '**Output:**', '```text', result.stdout, '```');
    }
    if (result.returnValue !== undefined) {
      lines.push('', '**Return Value:**', '```json', result.returnValue, '```');
    }
    if (result.error) {
      lines.push('', `**Error:** \`${result.error}\``);
    }

    const assistantMessage: SideChatMessage = {
      id: makeId('a'),
      role: 'assistant',
      command: 'test',
      contentMarkdown: lines.join('\n'),
      timestamp: new Date().toISOString(),
      testOutput: result,
    };
    this.messages.push(assistantMessage);
    return { assistantMessage };
  }

  private async handleFollowMe(
    prompt: string,
    ctx: SlashExecutionContext
  ): Promise<SlashExecutionOutcome> {
    // Toggle off explicitly
    if (/^(off|stop|end|disable)$/i.test(prompt)) {
      this.followMeEnabled = false;
      const assistantMessage: SideChatMessage = {
        id: makeId('a'),
        role: 'assistant',
        command: 'followme',
        contentMarkdown:
          'Live coaching paused. Edit freely or click **Continue** to squash your diff back to the main agent.',
        timestamp: new Date().toISOString(),
      };
      this.messages.push(assistantMessage);
      return { assistantMessage, followMeActive: false };
    }

    this.followMeEnabled = true;
    this.lastFollowMeHintBuffer = ctx.fileContent;

    // Mode B (Dev Coaches Model): user gave a structural prompt / completion instruction
    if (prompt.length > 0) {
      let completionCode: string | undefined;
      let markdown: string;

      if (this.llmClient.isConfigured()) {
        const raw = await this.llmClient.completeText(
          `${CHALK_CONVERSATIONAL_TONE}\nYou are in /followme Mode B (Dev Coaches Model). Follow the developer's exact structure/pseudo-code/signatures in the file and produce the completed replacement for lines ${ctx.chunk.startLine}-${ctx.chunk.endLine}. Return the completed code inside a single fenced code block followed by 1 concise sentence explaining what you filled in.`,
          [
            {
              role: 'user',
              content: [
                `File: ${ctx.chunk.filePath}`,
                'Current file buffer:',
                '```',
                ctx.fileContent.slice(0, 4500),
                '```',
                `Developer direction: ${prompt}`,
              ].join('\n'),
            },
          ],
          { maxTokens: 900 }
        );
        const fence = raw.match(/```[\w-]*\n([\s\S]*?)```/);
        if (fence) {
          completionCode = fence[1].trimEnd();
        }
        markdown = raw;
      } else {
        markdown = `**/followme Mode B active** — recorded your structural guidance: *"${prompt}"*.\n\nEdit the stub directly in the editor (or configure an LLM API key so Chalk can auto-complete your stub in one click).`;
      }

      const assistantMessage: SideChatMessage = {
        id: makeId('a'),
        role: 'assistant',
        command: 'followme',
        contentMarkdown: markdown,
        timestamp: new Date().toISOString(),
      };
      this.messages.push(assistantMessage);
      return {
        assistantMessage,
        followMeActive: true,
        followMeCompletionCode: completionCode,
      };
    }

    // Mode A (Model Coaches Dev): activate live debounced buffer coaching
    const assistantMessage: SideChatMessage = {
      id: makeId('a'),
      role: 'assistant',
      command: 'followme',
      contentMarkdown:
        '**/followme Live Coaching Active (Mode A & B):**\n- **Edit directly** in the editor and I will drop concise, real-time hints as you type.\n- Or write a quick stub/pseudo-code and run `/followme <your pattern>` to have me complete the chunk following your exact structure.\n- Run `/followme stop` to turn off live hints.',
      timestamp: new Date().toISOString(),
    };
    this.messages.push(assistantMessage);
    return { assistantMessage, followMeActive: true };
  }

  private async handleTrace(
    prompt: string,
    ctx: SlashExecutionContext
  ): Promise<SlashExecutionOutcome> {
    if (!ctx.onTrace) {
      const assistantMessage: SideChatMessage = {
        id: makeId('a'),
        role: 'assistant',
        command: 'trace',
        contentMarkdown: 'Dry-run `/trace` engine is not registered yet.',
        timestamp: new Date().toISOString(),
      };
      this.messages.push(assistantMessage);
      return { assistantMessage };
    }

    const traceResult = await ctx.onTrace(ctx.chunk, ctx.fileContent, prompt);
    const firstIter = traceResult.iterations[0];
    const summaryLines = [
      `**Ghost-Chalk Trace** — Inputs: \`${traceResult.inputSummary}\``,
      '',
      firstIter ? firstIter.narrative : '',
      '',
      `**Outcome:** ${traceResult.finalOutcome}`,
      traceResult.iterations.length > 1
        ? `\n*${traceResult.iterations.length} execution states captured — use **[ < Prev ] [ Next > ]** to step through loop iterations.*`
        : '',
    ];

    const assistantMessage: SideChatMessage = {
      id: makeId('a'),
      role: 'assistant',
      command: 'trace',
      contentMarkdown: summaryLines.filter(Boolean).join('\n'),
      timestamp: new Date().toISOString(),
      traceResult,
    };
    this.messages.push(assistantMessage);
    return { assistantMessage, traceResult };
  }

  private async handleAlt(
    prompt: string,
    ctx: SlashExecutionContext
  ): Promise<SlashExecutionOutcome> {
    if (!ctx.onAlt) {
      const assistantMessage: SideChatMessage = {
        id: makeId('a'),
        role: 'assistant',
        command: 'alt',
        contentMarkdown: 'Architectural `/alt` engine is not registered yet.',
        timestamp: new Date().toISOString(),
      };
      this.messages.push(assistantMessage);
      return { assistantMessage };
    }

    const altProposal = await ctx.onAlt(ctx.chunk, ctx.fileContent, prompt);
    const assistantMessage: SideChatMessage = {
      id: makeId('a'),
      role: 'assistant',
      command: 'alt',
      contentMarkdown: `**Alternative: ${altProposal.title}**\n\n${altProposal.rationale}`,
      timestamp: new Date().toISOString(),
      altProposal,
    };
    this.messages.push(assistantMessage);
    return { assistantMessage, altProposal };
  }

  private async handleHistory(
    prompt: string,
    ctx: SlashExecutionContext
  ): Promise<SlashExecutionOutcome> {
    const summary = ctx.onHistory
      ? await ctx.onHistory(ctx.chunk.filePath, prompt)
      : 'History scrubber is not registered yet.';

    const assistantMessage: SideChatMessage = {
      id: makeId('a'),
      role: 'assistant',
      command: 'history',
      contentMarkdown: summary,
      timestamp: new Date().toISOString(),
    };
    this.messages.push(assistantMessage);
    return { assistantMessage };
  }

  private async handleFreeformQuestion(
    question: string,
    ctx: SlashExecutionContext
  ): Promise<SlashExecutionOutcome> {
    let reply: string;
    if (this.llmClient.isConfigured()) {
      reply = await this.llmClient.completeText(
        CHALK_CONVERSATIONAL_TONE,
        [
          ...this.toLlmHistory().slice(0, -1),
          {
            role: 'user',
            content: [
              `Active chunk: ${ctx.chunk.filePath} (lines ${ctx.chunk.startLine}-${ctx.chunk.endLine})`,
              '```',
              numberLines(ctx.fileContent),
              '```',
              `Question: ${question}`,
            ].join('\n'),
          },
        ],
        { maxTokens: 550 }
      );
    } else {
      reply = `Got your question about **${ctx.chunk.filePath}**: *"${question}"*.\n\nTry \`/explain\`, \`/edge\`, \`/test\`, \`/trace\`, \`/alt\`, or \`/history\`, or configure \`chalk.llm.apiKey\` for live conversational Q&A.`;
    }

    const assistantMessage: SideChatMessage = {
      id: makeId('a'),
      role: 'assistant',
      contentMarkdown: reply,
      timestamp: new Date().toISOString(),
    };
    this.messages.push(assistantMessage);
    return { assistantMessage };
  }

  private toLlmHistory(): ChatMessage[] {
    return this.messages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .slice(-8)
      .map((m) => ({
        role: m.role === 'user' ? 'user' : 'assistant',
        content: m.contentMarkdown,
      }));
  }
}

function numberLines(content: string): string {
  return content
    .replace(/\r\n/g, '\n')
    .split('\n')
    .slice(0, 220)
    .map((line, idx) => `${idx + 1}: ${line}`)
    .join('\n');
}

function extractLineMarksFromText(
  text: string,
  chunk: CodeChunk,
  color: 'amber' | 'green'
): ChalkMarkInstruction[] {
  const marks: ChalkMarkInstruction[] = [];
  const matches = text.matchAll(/\blines?\s+(\d+)(?:\s*[-–]\s*(\d+))?/gi);
  const seen = new Set<string>();

  for (const m of matches) {
    const start = Number(m[1]);
    const end = m[2] ? Number(m[2]) : start;
    const key = `${start}-${end}`;
    if (!seen.has(key) && start >= 1) {
      seen.add(key);
      marks.push({
        filePath: chunk.filePath,
        startLine: start,
        endLine: Math.max(start, end),
        color,
        label: color === 'amber' ? 'Edge case callout' : 'Referenced line',
      });
    }
    if (marks.length >= 4) {
      break;
    }
  }

  if (marks.length === 0) {
    marks.push({
      filePath: chunk.filePath,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      color,
      label: color === 'amber' ? 'Audit region' : 'Explained region',
    });
  }
  return marks;
}

function makeId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}
