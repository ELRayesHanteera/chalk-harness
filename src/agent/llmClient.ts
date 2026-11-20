import { z } from 'zod';

export type LlmProvider = 'auto' | 'anthropic' | 'openai' | 'gemini';

export interface LlmConfig {
  provider: LlmProvider;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  maxTokensPerChunk: number;
  maxChunksPerSession: number;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ResolvedProvider {
  provider: Exclude<LlmProvider, 'auto'>;
  model: string;
  apiKey: string;
  baseUrl: string;
}

export const CHALK_CONVERSATIONAL_TONE = [
  'You are Chalk, a sharp, warm, human pair-programming partner standing at a chalkboard next to the developer.',
  'Tone: natural, direct, conversational, and insightful — like a thoughtful senior engineer explaining their design choices clearly.',
  'Rules:',
  '- Keep replies crisp and scannable inside an inline side-panel. Never pad with filler or repeat the code verbatim.',
  '- Focus relentlessly on *why* things live where they do, how data flows across files, and what could break.',
  '- Reference exact line numbers and symbol names when pointing at code.',
].join('\n');

const DEFAULT_MODELS: Record<Exclude<LlmProvider, 'auto'>, string> = {
  anthropic: 'claude-3-5-haiku-latest',
  openai: 'gpt-4o-mini',
  gemini: 'gemini-2.5-flash',
};

const DEFAULT_BASE_URLS: Record<Exclude<LlmProvider, 'auto'>, string> = {
  anthropic: 'https://api.anthropic.com/v1',
  openai: 'https://api.openai.com/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta',
};

/**
 * Resolve active provider, model, API key, and base URL from config + env vars.
 * Returns null if no credentials are configured (allowing graceful offline/mock fallback).
 */
export function resolveLlmProvider(config: LlmConfig): ResolvedProvider | null {
  const explicitKey = (config.apiKey ?? '').trim();
  const anthropicKey = explicitKey || process.env.ANTHROPIC_API_KEY || '';
  const openaiKey = explicitKey || process.env.OPENAI_API_KEY || '';
  const geminiKey =
    explicitKey || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';

  let chosen: Exclude<LlmProvider, 'auto'> | null = null;

  if (config.provider === 'auto') {
    if (anthropicKey) {
      chosen = 'anthropic';
    } else if (geminiKey) {
      chosen = 'gemini';
    } else if (openaiKey || config.baseUrl) {
      chosen = 'openai';
    }
  } else {
    chosen = config.provider;
  }

  if (!chosen) {
    return null;
  }

  const keyByProvider: Record<Exclude<LlmProvider, 'auto'>, string> = {
    anthropic: anthropicKey,
    openai: openaiKey,
    gemini: geminiKey,
  };

  const apiKey = keyByProvider[chosen];
  const baseUrl = (config.baseUrl ?? '').trim() || DEFAULT_BASE_URLS[chosen];

  // Allow keyless local OpenAI-compatible servers (e.g., Ollama / vLLM) when custom baseUrl is set
  const isCustomLocalOpenAi =
    chosen === 'openai' && Boolean((config.baseUrl ?? '').trim());
  if (!apiKey && !isCustomLocalOpenAi) {
    return null;
  }

  const model = (config.model ?? '').trim() || DEFAULT_MODELS[chosen];

  return {
    provider: chosen,
    model,
    apiKey: apiKey || 'local-no-key',
    baseUrl: baseUrl.replace(/\/+$/, ''),
  };
}

export type IdeLmFallbackHandler = (
  systemPrompt: string,
  messages: ChatMessage[],
  options?: { maxTokens?: number; temperature?: number }
) => Promise<string | null>;

/**
 * Multi-provider LLM client (Anthropic, OpenAI / OpenAI-compatible, Gemini, plus
 * optional IDE-native `vscode.lm` fallback) using built-in fetch with strict Zod
 * JSON schema validation and 1-retry recovery.
 */
export class LlmClient {
  constructor(
    private readonly getConfig: () => LlmConfig,
    private readonly ideLmFallback?: {
      isAvailable: () => boolean;
      complete: IdeLmFallbackHandler;
      describe: () => string;
    }
  ) {}

  public isConfigured(): boolean {
    return (
      resolveLlmProvider(this.getConfig()) !== null ||
      Boolean(this.ideLmFallback?.isAvailable())
    );
  }

  public describeProvider(): string {
    const resolved = resolveLlmProvider(this.getConfig());
    if (resolved) {
      return `${resolved.provider} (${resolved.model})`;
    }
    if (this.ideLmFallback?.isAvailable()) {
      return this.ideLmFallback.describe();
    }
    return 'Not configured (set chalk.llm.apiKey or ANTHROPIC_API_KEY / GEMINI_API_KEY / OPENAI_API_KEY)';
  }

  public async completeText(
    systemPrompt: string,
    messages: ChatMessage[],
    options?: { maxTokens?: number; temperature?: number }
  ): Promise<string> {
    const config = this.getConfig();
    const resolved = resolveLlmProvider(config);

    if (!resolved) {
      if (this.ideLmFallback) {
        const ideReply = await this.ideLmFallback.complete(systemPrompt, messages, options);
        if (ideReply && ideReply.trim()) {
          return ideReply;
        }
      }
      throw new Error(
        'No LLM API key configured and the IDE did not expose a `vscode.lm` chat model. Set `chalk.llm.apiKey` (or a local Ollama `chalk.llm.baseUrl`) to enable live side-chat.'
      );
    }

    const maxTokens = Math.min(
      options?.maxTokens ?? config.maxTokensPerChunk,
      config.maxTokensPerChunk
    );
    const temperature = options?.temperature ?? 0.2;

    switch (resolved.provider) {
      case 'anthropic':
        return this.callAnthropic(resolved, systemPrompt, messages, maxTokens, temperature);
      case 'openai':
        return this.callOpenAi(resolved, systemPrompt, messages, maxTokens, temperature);
      case 'gemini':
        return this.callGemini(resolved, systemPrompt, messages, maxTokens, temperature);
    }
  }

  /**
   * Call the LLM expecting strict JSON validated against `schema`.
   * Retries once with explicit schema error feedback before surfacing an error.
   */
  public async completeJson<T>(
    systemPrompt: string,
    userPrompt: string,
    schema: z.ZodType<T, z.ZodTypeDef, unknown>,
    options?: { maxTokens?: number }
  ): Promise<T> {
    const jsonSystem = `${systemPrompt}\n\nIMPORTANT: Return ONLY valid JSON matching the requested schema. Do not wrap in commentary.`;
    const history: ChatMessage[] = [{ role: 'user', content: userPrompt }];

    let lastError = '';
    for (let attempt = 0; attempt < 2; attempt++) {
      const raw = await this.completeText(jsonSystem, history, {
        maxTokens: options?.maxTokens,
        temperature: 0.1,
      });

      const parsed = tryExtractJson(raw);
      if (parsed.ok) {
        const validated = schema.safeParse(parsed.value);
        if (validated.success) {
          return validated.data;
        }
        lastError = validated.error.issues
          .map((i) => `${i.path.join('.') || 'root'}: ${i.message}`)
          .join('; ');
      } else {
        lastError = parsed.error;
      }

      if (attempt === 0) {
        history.push({ role: 'assistant', content: raw });
        history.push({
          role: 'user',
          content: `Your JSON output failed schema validation (${lastError}). Please return ONLY corrected valid JSON matching the schema.`,
        });
      }
    }

    throw new Error(`LLM returned invalid structured JSON after retry: ${lastError}`);
  }

  private async callAnthropic(
    resolved: ResolvedProvider,
    systemPrompt: string,
    messages: ChatMessage[],
    maxTokens: number,
    temperature: number
  ): Promise<string> {
    const res = await fetch(`${resolved.baseUrl}/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': resolved.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: resolved.model,
        max_tokens: maxTokens,
        temperature,
        system: systemPrompt,
        messages,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Anthropic API error (${res.status}): ${body.slice(0, 300)}`);
    }

    const data = (await res.json()) as {
      content?: Array<{ type: string; text?: string }>;
    };
    const text = (data.content ?? [])
      .filter((c) => c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text)
      .join('');
    if (!text.trim()) {
      throw new Error('Anthropic API returned an empty response.');
    }
    return text;
  }

  private async callOpenAi(
    resolved: ResolvedProvider,
    systemPrompt: string,
    messages: ChatMessage[],
    maxTokens: number,
    temperature: number
  ): Promise<string> {
    const res = await fetch(`${resolved.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${resolved.apiKey}`,
      },
      body: JSON.stringify({
        model: resolved.model,
        max_tokens: maxTokens,
        temperature,
        messages: [{ role: 'system', content: systemPrompt }, ...messages],
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`OpenAI API error (${res.status}): ${body.slice(0, 300)}`);
    }

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = data.choices?.[0]?.message?.content ?? '';
    if (!text.trim()) {
      throw new Error('OpenAI API returned an empty response.');
    }
    return text;
  }

  private async callGemini(
    resolved: ResolvedProvider,
    systemPrompt: string,
    messages: ChatMessage[],
    maxTokens: number,
    temperature: number
  ): Promise<string> {
    const url = `${resolved.baseUrl}/models/${encodeURIComponent(
      resolved.model
    )}:generateContent?key=${encodeURIComponent(resolved.apiKey)}`;

    const contents = messages.map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents,
        generationConfig: {
          maxOutputTokens: maxTokens,
          temperature,
        },
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Gemini API error (${res.status}): ${body.slice(0, 300)}`);
    }

    const data = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const text = (data.candidates?.[0]?.content?.parts ?? [])
      .map((p) => p.text ?? '')
      .join('');
    if (!text.trim()) {
      throw new Error('Gemini API returned an empty response.');
    }
    return text;
  }
}

export function tryExtractJson(
  raw: string
): { ok: true; value: unknown } | { ok: false; error: string } {
  const trimmed = raw.trim();

  // 1. Direct parse
  try {
    return { ok: true, value: JSON.parse(trimmed) };
  } catch {
    // Continue to fenced block extraction
  }

  // 2. Fenced ```json ... ``` or ``` ... ```
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) {
    try {
      return { ok: true, value: JSON.parse(fenceMatch[1].trim()) };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  // 3. First `{` to last `}` or `[` to last `]`
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try {
      return { ok: true, value: JSON.parse(trimmed.slice(firstBrace, lastBrace + 1)) };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  return { ok: false, error: 'No JSON object found in model response.' };
}
