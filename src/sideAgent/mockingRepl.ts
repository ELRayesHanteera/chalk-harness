import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { transform as sucraseTransform, Transform } from 'sucrase';
import { CHALK_CONVERSATIONAL_TONE, LlmClient } from '../agent/llmClient.js';
import { CodeChunk, MockReplResult } from '../types/protocol.js';

function transpileToCjs(code: string, ext: string): string {
  const transforms: Transform[] = ['imports'];
  if (ext === '.ts' || ext === '.tsx') {
    transforms.push('typescript');
  }
  if (ext === '.tsx' || ext === '.jsx') {
    transforms.push('jsx');
  }
  return sucraseTransform(code, { transforms }).code;
}

/**
 * Solves the "Untestable Half-File" problem.
 * Inspects imports in the active TS/JS file/chunk, auto-generates recursive in-memory
 * Proxy mocks for any unbuilt modules or dependencies not yet written on disk, transpiles
 * via esbuild, and runs a baseline or prompt-targeted micro-test inside a time-bounded VM.
 */
export class MockingRepl {
  constructor(
    private readonly workspaceRoot: string,
    private readonly llmClient?: LlmClient
  ) {}

  public async runTest(params: {
    chunk: CodeChunk;
    fileContent: string;
    prompt?: string;
  }): Promise<MockReplResult> {
    const started = Date.now();
    const ext = path.extname(params.chunk.filePath).toLowerCase();

    if (!['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)) {
      return {
        passed: false,
        inputsUsed: params.prompt || 'baseline sanity check',
        mocksGenerated: [],
        stdout: '',
        error: `Inline Mocking REPL currently executes JS/TS chunks directly (got ${ext || 'unknown'}). Use /trace for symbolic walkthrough on other languages.`,
        durationMs: Date.now() - started,
      };
    }

    const mocksGenerated = new Set<string>();
    const logs: string[] = [];

    try {
      const transpiledCode = transpileToCjs(params.fileContent, ext);

      const chunkAbsDir = path.dirname(
        path.isAbsolute(params.chunk.filePath)
          ? params.chunk.filePath
          : path.resolve(this.workspaceRoot, params.chunk.filePath)
      );

      // Load module inside isolated VM with auto-mocking require()
      const exportsObj = this.executeCommonJsInVm(
        transpiledCode,
        chunkAbsDir,
        mocksGenerated,
        logs
      );

      // Build either a targeted harness (from prompt) or an automatic baseline probe
      let harnessCode: string;
      let inputsUsed: string;

      if (params.prompt?.trim() && this.llmClient?.isConfigured()) {
        inputsUsed = params.prompt.trim();
        harnessCode = await this.generateLlmMicroTest(
          params.chunk,
          params.fileContent,
          params.prompt.trim()
        );
      } else {
        inputsUsed = params.prompt?.trim()
          ? `targeted heuristic: ${params.prompt.trim()}`
          : 'auto baseline sanity check';
        harnessCode = buildDefaultHarness(params.prompt?.trim());
      }

      const transpiledHarnessCode = transpileToCjs(harnessCode, '.ts');

      const harnessModule = { exports: {} as Record<string, unknown> };
      const sandbox = {
        module: harnessModule,
        exports: harnessModule.exports,
        targetModule: exportsObj,
        createAutoMock,
        console: {
          log: (...args: unknown[]) => logs.push(args.map(formatVal).join(' ')),
          warn: (...args: unknown[]) => logs.push(`[warn] ${args.map(formatVal).join(' ')}`),
          error: (...args: unknown[]) => logs.push(`[error] ${args.map(formatVal).join(' ')}`),
        },
      };

      const script = new vm.Script(transpiledHarnessCode, { filename: 'chalk-mock-harness.js' });
      const rawReturn = script.runInNewContext(sandbox, { timeout: 2500 });
      const finalReturn =
        typeof harnessModule.exports.run === 'function'
          ? await Promise.resolve(
              (harnessModule.exports.run as (mod: Record<string, unknown>) => unknown)(exportsObj)
            )
          : rawReturn;

      return {
        passed: true,
        inputsUsed,
        mocksGenerated: Array.from(mocksGenerated),
        stdout: logs.join('\n'),
        returnValue: formatVal(finalReturn),
        durationMs: Date.now() - started,
      };
    } catch (err) {
      return {
        passed: false,
        inputsUsed: params.prompt?.trim() || 'auto baseline sanity check',
        mocksGenerated: Array.from(mocksGenerated),
        stdout: logs.join('\n'),
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - started,
      };
    }
  }

  private executeCommonJsInVm(
    cjsCode: string,
    baseDir: string,
    mocksGenerated: Set<string>,
    logs: string[]
  ): Record<string, unknown> {
    const mod = { exports: {} as Record<string, unknown> };

    const customRequire = (specifier: string): unknown => {
      // Try resolving local sibling TS/JS files first (e.g., './userTypes')
      if (specifier.startsWith('.')) {
        const candidates = [
          path.resolve(baseDir, specifier),
          path.resolve(baseDir, `${specifier}.ts`),
          path.resolve(baseDir, `${specifier}.js`),
          path.resolve(baseDir, specifier, 'index.ts'),
          path.resolve(baseDir, specifier, 'index.js'),
        ];
        const existing = candidates.find((c) => fs.existsSync(c) && fs.statSync(c).isFile());
        if (existing) {
          const src = fs.readFileSync(existing, 'utf8');
          const outCode = transpileToCjs(src, path.extname(existing).toLowerCase());
          return this.executeCommonJsInVm(outCode, path.dirname(existing), mocksGenerated, logs);
        }
      }

      // Unbuilt or external dependency -> auto-generate recursive stub proxy!
      mocksGenerated.add(specifier);
      return createAutoMock(specifier);
    };

    const sandbox = {
      module: mod,
      exports: mod.exports,
      require: customRequire,
      console: {
        log: (...args: unknown[]) => logs.push(args.map(formatVal).join(' ')),
        warn: (...args: unknown[]) => logs.push(`[warn] ${args.map(formatVal).join(' ')}`),
        error: (...args: unknown[]) => logs.push(`[error] ${args.map(formatVal).join(' ')}`),
      },
      Date,
      Math,
      JSON,
      Map,
      Set,
      Promise,
      Error,
      TypeError,
      RangeError,
      RegExp,
      Array,
      Object,
      Number,
      String,
      Boolean,
      setTimeout,
      clearTimeout,
    };

    const script = new vm.Script(cjsCode, { filename: 'chalk-chunk-module.js' });
    script.runInNewContext(sandbox, { timeout: 2500 });
    return mod.exports;
  }

  private async generateLlmMicroTest(
    chunk: CodeChunk,
    fileContent: string,
    prompt: string
  ): Promise<string> {
    if (!this.llmClient) {
      return buildDefaultHarness(prompt);
    }
    try {
      const text = await this.llmClient.completeText(
        `${CHALK_CONVERSATIONAL_TONE}\nWrite a tiny TypeScript/JS micro-test harness exporting \`exports.run = (targetModule) => { ... }\`. Use \`createAutoMock('dep')\` for any missing constructor dependencies. Return ONLY raw code, no markdown fences.`,
        [
          {
            role: 'user',
            content: [
              `File: ${chunk.filePath}`,
              fileContent.slice(0, 3500),
              `Developer test request: "${prompt}"`,
              'Log key intermediate values with console.log and return the final result object.',
            ].join('\n\n'),
          },
        ],
        { maxTokens: 500, temperature: 0.1 }
      );
      const cleaned = text
        .replace(/^```(?:ts|typescript|js|javascript)?\s*/i, '')
        .replace(/```\s*$/i, '')
        .trim();
      if (cleaned.includes('exports.run')) {
        return cleaned;
      }
    } catch {
      // Fallback to deterministic harness
    }
    return buildDefaultHarness(prompt);
  }
}

/**
 * Recursive Proxy mock that allows calling any unbuilt method, constructing any
 * unbuilt class, or reading nested properties without crashing half-written code.
 */
export function createAutoMock(name: string): unknown {
  const fn = function AutoMockFn(..._args: unknown[]) {
    return createAutoMock(`${name}()`);
  };
  return new Proxy(fn, {
    get(_target, prop) {
      if (prop === '__esModule') {
        return true;
      }
      if (prop === 'then') {
        return undefined; // Avoid falsely behaving like a thenable Promise
      }
      if (prop === Symbol.toPrimitive) {
        return () => `[Mock:${name}]`;
      }
      return createAutoMock(`${name}.${String(prop)}`);
    },
    construct(_target, _args) {
      return createAutoMock(`new ${name}`) as object;
    },
  });
}

function buildDefaultHarness(prompt?: string): string {
  const emptyBias = Boolean(prompt && /\b(empty|null|undefined|blank|missing)\b/i.test(prompt));
  return `
exports.run = function(mod) {
  const keys = Object.keys(mod);
  console.log('Exported symbols:', keys.length ? keys.join(', ') : '(types/interfaces only)');
  const results = {};
  const sampleArg = ${emptyBias ? '""' : '"sample-token"'};

  for (const key of keys) {
    const val = mod[key];
    if (typeof val !== 'function') {
      results[key] = typeof val;
      continue;
    }

    // Try instantiating as a class if it has prototype methods
    const protoMethods = val.prototype
      ? Object.getOwnPropertyNames(val.prototype).filter((m) => m !== 'constructor' && typeof val.prototype[m] === 'function')
      : [];

    if (protoMethods.length > 0) {
      const depMock = createAutoMock(key + 'Dependency');
      const instance = new val(depMock);
      results[key] = {};
      for (const m of protoMethods) {
        try {
          const out = instance[m](sampleArg);
          console.log(key + '.' + m + '(' + JSON.stringify(sampleArg) + ') =>', JSON.stringify(out));
          results[key][m] = out;
        } catch (e) {
          console.log(key + '.' + m + ' threw:', e.message);
          results[key][m] = { threw: e.message };
        }
      }
    } else {
      try {
        const out = val(sampleArg);
        console.log(key + '(' + JSON.stringify(sampleArg) + ') =>', JSON.stringify(out));
        results[key] = out;
      } catch (e) {
        console.log(key + ' threw:', e.message);
        results[key] = { threw: e.message };
      }
    }
  }
  return results;
};
`;
}

function formatVal(v: unknown): string {
  if (typeof v === 'string') {
    return v;
  }
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}
