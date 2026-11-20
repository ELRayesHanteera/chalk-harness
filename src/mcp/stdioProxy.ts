import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import WebSocket from 'ws';
import { z } from 'zod';
import { McpBridgeRequest, McpBridgeResponse } from '../types/protocol.js';

export const CHALK_PROXY_VERSION = '0.1.0';

function resolveBridgePort(): number {
  const argIdx = process.argv.indexOf('--port');
  if (argIdx !== -1 && process.argv[argIdx + 1]) {
    const parsed = Number(process.argv[argIdx + 1]);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  const envPort = Number(process.env.CHALK_MCP_PORT ?? '7331');
  return Number.isFinite(envPort) && envPort > 0 ? envPort : 7331;
}

/**
 * Sends a single RPC request over localhost WebSocket to the running Chalk VS Code /
 * Antigravity extension bridge and awaits its response (which may legitimately block
 * while the developer reviews a chunk and chats in the inline side-channel).
 */
export function callBridge(
  port: number,
  method: McpBridgeRequest['method'],
  params: Record<string, unknown>
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    let settled = false;

    const finish = (err: Error | null, value?: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      try {
        ws.close();
      } catch {
        // ignore
      }
      if (err) {
        reject(err);
      } else {
        resolve(value);
      }
    };

    ws.once('error', (err) => {
      finish(
        new Error(
          `Could not connect to Chalk IDE bridge on ws://127.0.0.1:${port} (${err.message}). Make sure your IDE (Antigravity / VS Code / Cursor) is open with the chalk-harness extension active.`
        )
      );
    });

    ws.once('open', () => {
      const payload: McpBridgeRequest = { id: requestId, method, params };
      ws.send(JSON.stringify(payload));
    });

    ws.on('message', (data) => {
      try {
        const res = JSON.parse(data.toString('utf8')) as McpBridgeResponse;
        if (res.id !== requestId) {
          return;
        }
        if (res.ok) {
          finish(null, res.result);
        } else {
          finish(new Error(res.error ?? 'Unknown Chalk bridge error'));
        }
      } catch (e) {
        finish(e instanceof Error ? e : new Error(String(e)));
      }
    });

    ws.once('close', () => {
      if (!settled) {
        finish(new Error('Chalk IDE bridge closed connection before resolving tool call.'));
      }
    });
  });
}

const ChalkMarkInputSchema = z.object({
  filePath: z.string().describe('Workspace-relative or absolute file path'),
  startLine: z.number().int().min(1).describe('1-based inclusive start line'),
  endLine: z.number().int().min(1).describe('1-based inclusive end line'),
  color: z.enum(['green', 'amber', 'blue', 'red']).default('green'),
  label: z.string().optional().describe('Short inline Chalk label shown next to the highlight'),
  openInSplitView: z
    .boolean()
    .optional()
    .describe('If true and cross-file, opens this mark in ViewColumn.Beside'),
});

const ChalkTourStepInputSchema = z.object({
  primaryMark: ChalkMarkInputSchema,
  referenceMark: ChalkMarkInputSchema.optional(),
  explanationMarkdown: z.string().describe('Warm, concise explanation for this step'),
});

export function createChalkMcpServer(port: number): McpServer {
  const server = new McpServer({
    name: 'chalk',
    version: CHALK_PROXY_VERSION,
  });

  server.tool(
    'stream_chunk',
    'Draw a logical AST code chunk onto the Chalkboard editor, create a Git shadow checkpoint, and block until the developer clicks Continue, Auto-Finish File, or Undo Chunk. Returns { action, codeModified, unifiedDiff?, decisionSummary? }.',
    {
      stepNumber: z.number().int().min(1).describe('Macro step number from plan.md'),
      chunkIndex: z.number().int().min(1).describe('1-based index of this chunk within the step'),
      totalChunks: z.number().int().min(1).describe('Total chunks planned for this step'),
      filePath: z.string().describe('Workspace-relative target file path'),
      startLine: z.number().int().min(1).describe('1-based start line in target file'),
      endLine: z.number().int().min(1).describe('1-based end line in target file'),
      code: z.string().describe('Code to draw onto the chalkboard'),
      summary: z.string().describe('One-sentence summary of what this chunk builds and why'),
      mode: z
        .enum(['replace', 'insert', 'append'])
        .optional()
        .describe('Edit mode: replace (default), insert before startLine, or append at EOF'),
    },
    async (args) => {
      const result = await callBridge(port, 'chalk_stream_chunk', args);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    'highlight_tour',
    'Launch an interactive Chalk Mark & split-screen camera tour ([< Prev] [Next >]) across one or more files to explain logic and cross-file dependencies.',
    {
      steps: z.array(ChalkTourStepInputSchema).min(1),
    },
    async (args) => {
      const result = await callBridge(port, 'chalk_highlight_tour', args);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    'set_ghost_text',
    'Render inline Ghost Chalk annotations (variable state mutations, trace values, or short inline callouts) at the end of specified lines.',
    {
      filePath: z.string().describe('Workspace-relative or absolute target file path'),
      lineAnnotations: z.array(
        z.object({
          line: z.number().int().min(1).describe('1-based line number'),
          text: z.string().describe('Short ghost annotation text'),
          color: z.enum(['green', 'amber', 'blue', 'red']).optional(),
        })
      ),
    },
    async (args) => {
      const result = await callBridge(port, 'chalk_set_ghost_text', args);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    'clear_marks',
    'Erase all visual Chalk Marks and Ghost Chalk annotations from the editor.',
    {},
    async () => {
      const result = await callBridge(port, 'chalk_clear_marks', {});
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  return server;
}

async function main(): Promise<void> {
  const port = resolveBridgePort();
  const server = createChalkMcpServer(port);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[chalk-mcp-proxy] connected via stdio -> bridge ws://127.0.0.1:${port}`);
}

// Only auto-start stdio server when executed directly as CLI entry point
if (require.main === module) {
  main().catch((err) => {
    console.error('[chalk-mcp-proxy] fatal error:', err);
    process.exit(1);
  });
}
