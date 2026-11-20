import * as http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import {
  ChalkMarkInstruction,
  ChalkTourStep,
  CodeChunk,
  DevActionResolution,
  GhostTextAnnotation,
  McpBridgeRequest,
  McpBridgeResponse,
} from '../types/protocol.js';

export interface ChalkMcpHandlers {
  onStreamChunk: (chunk: CodeChunk) => Promise<DevActionResolution>;
  onHighlightTour: (steps: ChalkTourStep[]) => Promise<{ stepsLoaded: number }>;
  onSetGhostText: (
    filePath: string,
    lineAnnotations: GhostTextAnnotation[]
  ) => Promise<{ applied: number }>;
  onClearMarks: () => Promise<{ cleared: boolean }>;
  onReplySideChat: (params: {
    markdown: string;
    marks?: ChalkMarkInstruction[];
    tourSteps?: ChalkTourStep[];
    ghostAnnotations?: GhostTextAnnotation[];
    filePath?: string;
  }) => Promise<{ delivered: boolean }>;
  onAwaitDevAction: () => Promise<DevActionResolution>;
  onStatus: () => { state: string; activeFile?: string; activeChunkId?: string };
}

/**
 * Local MCP Bridge Server embedded inside the VS Code / Antigravity extension.
 * Listens on 127.0.0.1:<port> for WebSocket RPC calls from `stdioProxy.ts`
 * (or any external CLI coding agent: Claude Code, Codex, Cursor, Cline)
 * and serves `GET /health` for liveness checks.
 */
export class ChalkMcpBridgeServer {
  private httpServer: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private runningPort: number | null = null;
  private connectedClients = new Set<WebSocket>();

  constructor(private readonly handlers: ChalkMcpHandlers) {}

  public isRunning(): boolean {
    return this.httpServer !== null && this.runningPort !== null;
  }

  public getPort(): number | null {
    return this.runningPort;
  }

  public getClientCount(): number {
    return this.connectedClients.size;
  }

  public async start(port: number): Promise<number> {
    if (this.httpServer) {
      return this.runningPort ?? port;
    }

    const server = http.createServer((req, res) => {
      if (req.url === '/health' && req.method === 'GET') {
        const status = this.handlers.onStatus();
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            ok: true,
            service: 'chalk-mcp-bridge',
            port: this.runningPort,
            clients: this.connectedClients.size,
            ...status,
          })
        );
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Use WebSocket connection or GET /health' }));
    });

    const wss = new WebSocketServer({ server });

    wss.on('connection', (ws) => {
      this.connectedClients.add(ws);
      ws.on('close', () => {
        this.connectedClients.delete(ws);
      });
      ws.on('message', async (rawData) => {
        await this.handleRawMessage(ws, rawData.toString('utf8'));
      });
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });

    const addr = server.address();
    this.httpServer = server;
    this.wss = wss;
    this.runningPort = typeof addr === 'object' && addr ? addr.port : port;
    return this.runningPort;
  }

  public async stop(): Promise<void> {
    for (const client of this.connectedClients) {
      try {
        client.close();
      } catch {
        // ignore
      }
    }
    this.connectedClients.clear();

    if (this.wss) {
      await new Promise<void>((resolve) => this.wss?.close(() => resolve()));
      this.wss = null;
    }
    if (this.httpServer) {
      await new Promise<void>((resolve) => this.httpServer?.close(() => resolve()));
      this.httpServer = null;
    }
    this.runningPort = null;
  }

  private async handleRawMessage(ws: WebSocket, raw: string): Promise<void> {
    let req: McpBridgeRequest;
    try {
      req = JSON.parse(raw) as McpBridgeRequest;
    } catch {
      this.sendResponse(ws, { id: 'unknown', ok: false, error: 'Malformed JSON payload' });
      return;
    }

    try {
      const result = await this.dispatch(req);
      this.sendResponse(ws, { id: req.id, ok: true, result });
    } catch (err) {
      this.sendResponse(ws, {
        id: req.id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async dispatch(req: McpBridgeRequest): Promise<unknown> {
    switch (req.method) {
      case 'chalk_stream_chunk': {
        const p = req.params;
        const stepNumber = Number(p.stepNumber ?? 1);
        const chunkIndex = Number(p.chunkIndex ?? 1);
        const totalChunksInStep = Number(p.totalChunks ?? p.totalChunksInStep ?? 1);
        const chunk: CodeChunk = {
          id:
            typeof p.id === 'string' && p.id.trim()
              ? p.id.trim()
              : `step${stepNumber}-chunk${chunkIndex}-${Date.now()}`,
          stepNumber,
          chunkIndex,
          totalChunksInStep,
          filePath: String(p.filePath ?? ''),
          startLine: Math.max(1, Number(p.startLine ?? 1)),
          endLine: Math.max(1, Number(p.endLine ?? p.startLine ?? 1)),
          code: String(p.code ?? ''),
          summary: String(p.summary ?? 'Streamed chunk'),
          mode:
            p.mode === 'insert' || p.mode === 'append' || p.mode === 'replace'
              ? p.mode
              : 'replace',
        };
        if (!chunk.filePath) {
          throw new Error('stream_chunk requires a non-empty filePath.');
        }
        return this.handlers.onStreamChunk(chunk);
      }

      case 'chalk_highlight_tour': {
        const steps = Array.isArray(req.params.steps)
          ? (req.params.steps as ChalkTourStep[])
          : [];
        return this.handlers.onHighlightTour(steps);
      }

      case 'chalk_set_ghost_text': {
        const filePath = String(req.params.filePath ?? '');
        const lineAnnotations = Array.isArray(req.params.lineAnnotations)
          ? (req.params.lineAnnotations as GhostTextAnnotation[])
          : [];
        if (!filePath) {
          throw new Error('set_ghost_text requires a non-empty filePath.');
        }
        return this.handlers.onSetGhostText(filePath, lineAnnotations);
      }

      case 'chalk_clear_marks':
        return this.handlers.onClearMarks();

      case 'chalk_reply_side_chat': {
        const markdown = String(req.params.markdown ?? '');
        if (!markdown.trim()) {
          throw new Error('reply_side_chat requires non-empty markdown.');
        }
        return this.handlers.onReplySideChat({
          markdown,
          marks: Array.isArray(req.params.marks)
            ? (req.params.marks as ChalkMarkInstruction[])
            : undefined,
          tourSteps: Array.isArray(req.params.tourSteps)
            ? (req.params.tourSteps as ChalkTourStep[])
            : undefined,
          ghostAnnotations: Array.isArray(req.params.ghostAnnotations)
            ? (req.params.ghostAnnotations as GhostTextAnnotation[])
            : undefined,
          filePath: typeof req.params.filePath === 'string' ? req.params.filePath : undefined,
        });
      }

      case 'chalk_await_dev_action':
        return this.handlers.onAwaitDevAction();

      case 'chalk_status':
        return this.handlers.onStatus();

      default:
        throw new Error(`Unknown Chalk bridge method: ${String((req as { method: unknown }).method)}`);
    }
  }

  private sendResponse(ws: WebSocket, response: McpBridgeResponse): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(response));
    }
  }
}
