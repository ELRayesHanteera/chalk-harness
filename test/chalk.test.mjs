import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import {
  LlmClient,
  resolveLlmProvider,
  tryExtractJson,
} from '../out/agent/llmClient.js';
import { ShadowCheckpointManager } from '../out/git/shadowCheckpoint.js';
import { ChalkMcpBridgeServer } from '../out/mcp/server.js';
import { MockAgentPlayer } from '../out/mock/mockAgentPlayer.js';
import { BoardEraserSquasher } from '../out/sideAgent/boardEraserSquasher.js';
import { MockingRepl } from '../out/sideAgent/mockingRepl.js';
import { parseSlashCommand, SlashRouter } from '../out/sideAgent/slashRouter.js';
import { TraceAndAltEngine } from '../out/sideAgent/traceAndAlt.js';

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('ShadowCheckpointManager creates snapshots, reverts modified & newly created files, and builds combined Git+Chalk history', async () => {
  const tmp = makeTempDir('chalk-ckpt-');
  try {
    // Initialize a real git repo in temp dir
    execFileSync('git', ['init'], { cwd: tmp, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@chalk.dev'], { cwd: tmp });
    execFileSync('git', ['config', 'user.name', 'Chalk Test'], { cwd: tmp });

    const existingFile = path.join(tmp, 'service.ts');
    fs.writeFileSync(existingFile, 'export const version = 1;\n', 'utf8');
    execFileSync('git', ['add', 'service.ts'], { cwd: tmp });
    execFileSync('git', ['commit', '-m', 'initial service'], { cwd: tmp, stdio: 'ignore' });

    const mgr = new ShadowCheckpointManager(tmp);

    // 1. Snapshot & revert modified existing file
    const snap1 = await mgr.createPreChunkSnapshot('chunk-1', 'service.ts', 'bump version to 2');
    assert.equal(snap1.existedBefore, true);
    assert.ok(fs.existsSync(snap1.patchFile));

    const modifiedText = 'export const version = 2;\nexport const ok = true;\n';
    fs.writeFileSync(existingFile, modifiedText, 'utf8');
    mgr.recordPostChunkState('chunk-1', modifiedText);

    const patchBody = fs.readFileSync(snap1.patchFile, 'utf8');
    assert.match(patchBody, /\+export const version = 2;/);

    // Combined history should contain 1 git commit + 1 chalk snapshot
    const history = await mgr.getCombinedFileHistory('service.ts');
    assert.equal(history.length, 2);
    assert.equal(history[0].source, 'git');
    assert.equal(history[1].source, 'chalk-snapshot');
    assert.ok(history[1].changedLines.added.length > 0 || history[1].changedLines.modified.length > 0);

    // Revert restores exact original content
    mgr.revertChunk('chunk-1');
    assert.equal(fs.readFileSync(existingFile, 'utf8'), 'export const version = 1;\n');

    // 2. Snapshot & revert brand-new file (deletes it on revert)
    const newFile = path.join(tmp, 'brandNew.ts');
    await mgr.createPreChunkSnapshot('chunk-new', 'brandNew.ts', 'create new file');
    fs.writeFileSync(newFile, 'export const created = true;\n', 'utf8');
    assert.equal(fs.existsSync(newFile), true);
    mgr.revertChunk('chunk-new');
    assert.equal(fs.existsSync(newFile), false);

    // 3. Auto-Finish escape hatch tracking
    assert.equal(mgr.shouldAutoFinish('service.ts'), false);
    mgr.enableAutoFinish('service.ts');
    assert.equal(mgr.shouldAutoFinish('service.ts'), true);
    mgr.clearAutoFinish('service.ts');
    assert.equal(mgr.shouldAutoFinish('service.ts'), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('BoardEraserSquasher detects unchanged vs modified buffers and computes unified diff + summary', async () => {
  const squasher = new BoardEraserSquasher();

  const unchanged = await squasher.squash({
    filePath: 'auth.ts',
    initialBufferAfterDraw: 'const a = 1;\n',
    currentBuffer: 'const a = 1;\n',
    sideChatTranscript: [],
  });
  assert.equal(unchanged.codeModified, false);

  const modified = await squasher.squash({
    filePath: 'auth.ts',
    initialBufferAfterDraw: 'export function check(x: string) {\n  return Boolean(x);\n}\n',
    currentBuffer:
      'export function check(x: string) {\n  if (!x.trim()) return false;\n  return true;\n}\n',
    sideChatTranscript: [],
  });
  assert.equal(modified.codeModified, true);
  assert.match(modified.unifiedDiff ?? '', /\+  if \(!x\.trim\(\)\) return false;/);
  assert.match(modified.decisionSummary ?? '', /auth\.ts/);
});

test('MockingRepl solves Untestable Half-File by auto-mocking unbuilt imports and executing TS in VM', async () => {
  const tmp = makeTempDir('chalk-repl-');
  try {
    const repl = new MockingRepl(tmp);
    const halfWrittenTs = `
import { futureAuditLogger } from './notYetBuiltLogger';

export class GuardService {
  check(token: string): { ok: boolean; reason?: string } {
    futureAuditLogger.record(token);
    if (!token) {
      return { ok: false, reason: 'missing_token' };
    }
    return { ok: true };
  }
}
`;
    const result = await repl.runTest({
      chunk: {
        id: 'c1',
        stepNumber: 1,
        chunkIndex: 1,
        totalChunksInStep: 1,
        filePath: 'guard.ts',
        startLine: 1,
        endLine: 12,
        code: halfWrittenTs,
        summary: 'GuardService check',
      },
      fileContent: halfWrittenTs,
      prompt: 'empty token',
    });

    assert.equal(result.passed, true, result.error);
    assert.deepEqual(result.mocksGenerated, ['./notYetBuiltLogger']);
    assert.match(result.returnValue ?? '', /missing_token/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('SlashRouter parses all 7 slash commands, runs /trace & /alt, and wipes memory on eraseBoard()', async () => {
  assert.deepEqual(parseSlashCommand('/explain why line 12?'), {
    command: 'explain',
    prompt: 'why line 12?',
    raw: '/explain why line 12?',
  });
  assert.equal(parseSlashCommand('/edge')?.command, 'edge');
  assert.equal(parseSlashCommand('/test focus on empty payload')?.command, 'test');
  assert.equal(parseSlashCommand('/followme')?.command, 'followme');
  assert.equal(parseSlashCommand('/trace user_id=42, role="guest"')?.command, 'trace');
  assert.equal(parseSlashCommand('/alt functional pipeline')?.command, 'alt');
  assert.equal(parseSlashCommand('/history why changed?')?.command, 'history');
  assert.equal(parseSlashCommand('plain question without slash'), null);

  const offlineLlm = new LlmClient(() => ({
    provider: 'auto',
    apiKey: '',
    maxTokensPerChunk: 800,
    maxChunksPerSession: 10,
  }));
  const repl = new MockingRepl(process.cwd(), offlineLlm);
  const traceAndAlt = new TraceAndAltEngine(offlineLlm, repl);
  const router = new SlashRouter(offlineLlm, repl);

  const chunk = {
    id: 'step1-chunk1',
    stepNumber: 1,
    chunkIndex: 1,
    totalChunksInStep: 1,
    filePath: 'sample.ts',
    startLine: 1,
    endLine: 6,
    code: 'export function allow(role: string) {\n  if (!role) return false;\n  const ok = role === "admin";\n  return ok;\n}',
    summary: 'Role check',
  };

  const traceOut = await router.handleInput('/trace role=""', {
    chunk,
    fileContent: chunk.code,
    onTrace: (c, content, p) => traceAndAlt.runTrace(c, content, p),
  });
  assert.ok(traceOut.traceResult);
  assert.ok(traceOut.traceResult.iterations[0].annotations.length > 0);

  const altOut = await router.handleInput('/alt lookup map', {
    chunk,
    fileContent: chunk.code,
    onAlt: (c, content, p) => traceAndAlt.generateAlternative(c, content, p),
  });
  assert.ok(altOut.altProposal);
  assert.equal(altOut.altProposal.tradeOffs.length, 3);
  assert.match(altOut.altProposal.unifiedDiff, /Alternative/);

  assert.ok(router.getMessages().length >= 4);
  router.eraseBoard();
  assert.equal(router.getMessages().length, 0);
});

test('LlmClient extracts JSON cleanly and retries once on malformed output', async () => {
  assert.deepEqual(tryExtractJson('```json\n{"ok": true}\n```'), {
    ok: true,
    value: { ok: true },
  });
  assert.equal(
    resolveLlmProvider({
      provider: 'openai',
      baseUrl: 'http://localhost:11434/v1',
      maxTokensPerChunk: 500,
      maxChunksPerSession: 5,
    })?.provider,
    'openai'
  );

  // Mock global fetch to fail JSON validation once, then succeed on retry
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    const text = calls === 1 ? 'not valid json at all' : '{"count": 3}';
    return new Response(
      JSON.stringify({ choices: [{ message: { content: text } }] }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  };

  try {
    const client = new LlmClient(() => ({
      provider: 'openai',
      apiKey: 'test-key',
      model: 'gpt-4o-mini',
      maxTokensPerChunk: 400,
      maxChunksPerSession: 5,
    }));
    const out = await client.completeJson(
      'system',
      'user',
      z.object({ count: z.number() })
    );
    assert.deepEqual(out, { count: 3 });
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('MockAgentPlayer loads mock-session.json deterministically', async () => {
  const player = new MockAgentPlayer(process.cwd(), process.cwd());
  await player.startSession();
  assert.equal(player.hasMoreChunks(), true);
  const first = await player.nextChunk();
  assert.ok(first);
  assert.equal(first.chunk.id, 'step1-chunk1');
  const exp = await player.explain();
  assert.ok(exp.tourSteps.length > 0);
});

test('End-to-End MCP Protocol: StdioClient -> dist/mcp/stdioProxy.js -> ChalkMcpBridgeServer', async () => {
  const receivedCalls = [];

  const bridge = new ChalkMcpBridgeServer({
    onStreamChunk: async (chunk) => {
      receivedCalls.push({ tool: 'stream_chunk', chunk });
      // Simulate blocking while developer reviews & tweaks the chunk
      await new Promise((r) => setTimeout(r, 60));
      return {
        action: 'continue',
        codeModified: true,
        unifiedDiff: '--- a/demo.ts\n+++ b/demo.ts\n@@ -1 +1 @@\n-const x = 1;\n+const x = 2;\n',
        decisionSummary: 'Developer updated x from 1 to 2.',
        chunkId: chunk.id,
        filePath: chunk.filePath,
      };
    },
    onHighlightTour: async (steps) => {
      receivedCalls.push({ tool: 'highlight_tour', count: steps.length });
      return { stepsLoaded: steps.length };
    },
    onSetGhostText: async (filePath, lineAnnotations) => {
      receivedCalls.push({ tool: 'set_ghost_text', filePath, count: lineAnnotations.length });
      return { applied: lineAnnotations.length };
    },
    onClearMarks: async () => {
      receivedCalls.push({ tool: 'clear_marks' });
      return { cleared: true };
    },
    onStatus: () => ({ state: 'IDLE' }),
  });

  const port = await bridge.start(0);

  // Verify HTTP /health endpoint
  const healthRes = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(healthRes.status, 200);
  const healthJson = await healthRes.json();
  assert.equal(healthJson.ok, true);
  assert.equal(healthJson.service, 'chalk-mcp-bridge');

  // Spawn real bundled stdio proxy over StdioClientTransport
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve(process.cwd(), 'dist/mcp/stdioProxy.js'), '--port', String(port)],
  });
  const client = new Client({ name: 'chalk-e2e-test', version: '0.1.0' });

  try {
    await client.connect(transport);

    const toolsRes = await client.listTools();
    const names = toolsRes.tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      'clear_marks',
      'highlight_tour',
      'set_ghost_text',
      'stream_chunk',
    ]);

    // 1. Blocking stream_chunk round-trip
    const streamRes = await client.callTool({
      name: 'stream_chunk',
      arguments: {
        stepNumber: 1,
        chunkIndex: 1,
        totalChunks: 2,
        filePath: 'demo.ts',
        startLine: 1,
        endLine: 3,
        code: 'export const x = 1;',
        summary: 'Initialize x',
      },
    });
    const parsedStream = JSON.parse(streamRes.content[0].text);
    assert.equal(parsedStream.action, 'continue');
    assert.equal(parsedStream.codeModified, true);
    assert.match(parsedStream.decisionSummary, /x from 1 to 2/);

    // 2. highlight_tour
    const tourRes = await client.callTool({
      name: 'highlight_tour',
      arguments: {
        steps: [
          {
            primaryMark: { filePath: 'demo.ts', startLine: 1, endLine: 1, color: 'green', label: 'Entry' },
            explanationMarkdown: 'Starts here.',
          },
        ],
      },
    });
    assert.deepEqual(JSON.parse(tourRes.content[0].text), { stepsLoaded: 1 });

    // 3. set_ghost_text
    const ghostRes = await client.callTool({
      name: 'set_ghost_text',
      arguments: {
        filePath: 'demo.ts',
        lineAnnotations: [{ line: 1, text: 'x = 2', color: 'blue' }],
      },
    });
    assert.deepEqual(JSON.parse(ghostRes.content[0].text), { applied: 1 });

    // 4. clear_marks
    const clearRes = await client.callTool({ name: 'clear_marks', arguments: {} });
    assert.deepEqual(JSON.parse(clearRes.content[0].text), { cleared: true });

    assert.equal(receivedCalls.length, 4);
  } finally {
    await client.close();
    await bridge.stop();
  }
});
