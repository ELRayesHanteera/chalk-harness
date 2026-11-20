/**
 * Shared TypeScript protocol for Chalk — Whiteboard Harness for Agents.
 * Used across the VS Code extension UI, Git Shadow Checkpoints, Agent Players,
 * Side-Agent Slash Router, and Local MCP Bridge Server.
 */

export type ChalkState =
  | 'IDLE'
  | 'SNAPSHOT_PRE_CHUNK'
  | 'DRAWING_CHUNK'
  | 'AWAITING_DEV_ACTION'
  | 'SIDE_SESSION_ACTIVE'
  | 'ERASING_THE_BOARD'
  | 'PLAN_RIPPLE_CHECK';

export interface CodeChunk {
  id: string;
  stepNumber: number;
  chunkIndex: number;
  totalChunksInStep: number;
  filePath: string;
  /** 1-based inclusive starting line in filePath */
  startLine: number;
  /** 1-based inclusive ending line in filePath (for replacing existing lines, or startLine for pure insertion) */
  endLine: number;
  code: string;
  summary: string;
  /** Optional replacement mode: 'replace' replaces startLine..endLine, 'insert' inserts before startLine, 'append' appends at EOF */
  mode?: 'replace' | 'insert' | 'append';
}

export type ChalkMarkColor = 'green' | 'amber' | 'blue' | 'red';

export interface ChalkMarkInstruction {
  filePath: string;
  /** 1-based inclusive */
  startLine: number;
  /** 1-based inclusive */
  endLine: number;
  color: ChalkMarkColor;
  label?: string;
  openInSplitView?: boolean;
}

export interface GhostTextAnnotation {
  /** 1-based line number */
  line: number;
  text: string;
  color?: ChalkMarkColor;
}

export interface ChalkTourStep {
  primaryMark: ChalkMarkInstruction;
  referenceMark?: ChalkMarkInstruction;
  explanationMarkdown: string;
}

export type DevAction = 'continue' | 'auto_finish_file' | 'undo_chunk';

export interface DevActionResolution {
  action: DevAction;
  codeModified: boolean;
  unifiedDiff?: string;
  decisionSummary?: string;
  chunkId?: string;
  filePath?: string;
}

export type SlashCommandName =
  | 'explain'
  | 'edge'
  | 'test'
  | 'followme'
  | 'trace'
  | 'alt'
  | 'history';

export interface ParsedSlashCommand {
  command: SlashCommandName;
  prompt: string;
  raw: string;
}

export interface SideChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  command?: SlashCommandName;
  contentMarkdown: string;
  timestamp: string;
  /** Optional rich payload attached to assistant messages */
  tourSteps?: ChalkTourStep[];
  edgeMarks?: ChalkMarkInstruction[];
  altProposal?: AltProposal;
  traceResult?: TraceResult;
  testOutput?: MockReplResult;
}

export interface MockReplResult {
  passed: boolean;
  inputsUsed: string;
  mocksGenerated: string[];
  stdout: string;
  returnValue?: string;
  error?: string;
  durationMs: number;
}

export interface TraceIteration {
  iterationLabel: string;
  annotations: GhostTextAnnotation[];
  narrative: string;
}

export interface TraceResult {
  inputSummary: string;
  iterations: TraceIteration[];
  finalOutcome: string;
}

export interface TradeOffRow {
  dimension: 'Complexity' | 'Memory / Speed' | 'Readability' | string;
  current: string;
  alternative: string;
}

export interface AltProposal {
  title: string;
  rationale: string;
  alternativeCode: string;
  unifiedDiff: string;
  tradeOffs: TradeOffRow[];
}

export interface HistorySnapshot {
  id: string;
  source: 'git' | 'chalk-snapshot';
  label: string;
  timestamp: string;
  author?: string;
  summary: string;
  content: string;
  diffFromPrevious?: string;
  changedLines?: { added: number[]; modified: number[] };
}

export interface ChunkSessionItem {
  chunk: CodeChunk;
  tourSteps?: ChalkTourStep[];
  edgeMarks?: ChalkMarkInstruction[];
  edgeNotes?: string;
  testSuggestion?: string;
}

/**
 * UI-agnostic driver interface (Step 4).
 * CodeLens, camera transitions, and undo depend only on this interface.
 */
export interface AgentPlayer {
  readonly name: string;
  startSession(planPath?: string): Promise<void>;
  nextChunk(): Promise<ChunkSessionItem | null>;
  prevChunk(): Promise<ChunkSessionItem | null>;
  explain(prompt?: string): Promise<{ markdown: string; tourSteps: ChalkTourStep[] }>;
  edge(prompt?: string): Promise<{ markdown: string; marks: ChalkMarkInstruction[] }>;
  test(prompt?: string): Promise<MockReplResult>;
  undoChunk(): Promise<boolean>;
  hasMoreChunks(): boolean;
  getCurrentChunk(): CodeChunk | null;
}

/** JSON-RPC style messages over local WebSocket between stdioProxy and VS Code Extension */
export interface McpBridgeRequest {
  id: string;
  method:
    | 'chalk_stream_chunk'
    | 'chalk_highlight_tour'
    | 'chalk_set_ghost_text'
    | 'chalk_clear_marks'
    | 'chalk_status';
  params: Record<string, unknown>;
}

export interface McpBridgeResponse {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}
