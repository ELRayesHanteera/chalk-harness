# Chalk — Whiteboard Harness for Agents (`chalk-harness`)

> *"Stop rubber-stamping 500-line diffs. Put your coding agent at the chalkboard."*

**Chalk** is a synchronous, pedagogical pair-programming harness for **Antigravity IDE**, **VS Code**, **Cursor**, and any MCP-capable coding agent (**Claude Code**, **Codex**, **Cline**, or custom loops).

Instead of dumping a 500-line multi-file diff at the end of an autonomous loop, Chalk puts your agent at a live chalkboard:

- **Progressive AST Chunk Streaming** — draws code chunk-by-chunk onto the editor with a Blue Chalk focus border and pauses on an inline CodeLens action bar.
- **Visual Chalk Marks & Anti-Whiplash Split-Screen Camera** — Green pointers, Amber edge-case warnings with gutter icons, inline Ghost Chalk value overlays, and `[< Prev / Next >]` cross-file tours that open referenced definitions in `ViewColumn.Beside`.
- **Isolated Ephemeral Side-Chat (`/btw`)** — a hybrid inline anchor + Claude-style side-chat panel where you can ask anything without polluting the Main Builder Agent's context window. Clicking **Continue** *"erases the board"* and squashes only your final code diff + 1-sentence architectural summary back to the main agent for a **Plan Ripple Check**.
- **Shadow Git Checkpoints** — writes per-chunk pre-edit snapshots to `.git/chalk-snapshots/` (never dirtying `git log`) for instant one-click `[ ↩ Undo Chunk ]` and `[ ⚡ Auto-Finish File ]`.
- **Universal MCP Bridge** — works out of the box with Antigravity IDE, Claude Code, Codex, Cursor, and MCP Inspector via `dist/mcp/stdioProxy.js` and `skills/chalk/SKILL.md`.

---

## Quick Start (Antigravity IDE / VS Code / Cursor)

### 1. Build & Test
```bash
npm install
npm run build
npm test
```

### 2. Run in Extension Development Host (F5) — or Install `.vsix`
- **Dev Host:** Open this folder in **Antigravity IDE** (or VS Code / Cursor) and press **F5** (`Run Chalk Extension (Extension Host)`).
- **Package & Install `.vsix`:**
  ```bash
  npm run package
  ```
  Then install the generated `chalk-harness-0.1.0.vsix` via **Extensions → `...` → Install from VSIX...** (or `code --install-extension chalk-harness-0.1.0.vsix`).

### 3. Try the Zero-Token Demo Session
Open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) and run:
- **`Chalk: Run Demo / Mock Session`** — streams a 2-file `AuthService` walkthrough from `mock-session.json` with split-screen `/explain` tours, `/edge` Amber warnings, `/test` auto-mocking, `/trace`, `/alt`, and `Undo Chunk` — no API key required!
- **`Chalk: Start Session from plan.md`** — drives a live multi-provider LLM session (`Anthropic`, `OpenAI / Ollama`, or `Gemini`).

---

## Connecting External Coding Agents via MCP

When Chalk is active in your IDE, it starts a local MCP bridge on `127.0.0.1:7331` (check live status via `GET http://127.0.0.1:7331/health` or click the **Chalk** status bar item → **Copy MCP Config JSON**).

Add this MCP server config to **Antigravity**, **Claude Code**, **Cursor**, **Codex**, or **Cline**:

```json
{
  "mcpServers": {
    "chalk": {
      "command": "node",
      "args": ["/absolute/path/to/chalk-harness/dist/mcp/stdioProxy.js"],
      "env": {
        "CHALK_MCP_PORT": "7331"
      }
    }
  }
}
```

Then load [`skills/chalk/SKILL.md`](skills/chalk/SKILL.md) into your coding agent so it follows the AST-chunking, `stream_chunk` blocking, and **Plan Ripple Check** protocol.

### Exposed MCP Tools (`chalk`)
| Tool | Purpose |
| --- | --- |
| `stream_chunk` | Snapshots file to `.git/chalk-snapshots/`, streams chunk onto editor, and **blocks** until dev clicks Continue / Auto-Finish / Undo. Returns `{ action, codeModified, unifiedDiff?, decisionSummary? }`. |
| `highlight_tour` | Starts an interactive `[< Prev / Next >]` Chalk Mark & split-screen reference tour across files. |
| `set_ghost_text` | Overlays inline Ghost Chalk annotations (`// value -> state`) at specific line numbers. |
| `clear_marks` | Erases all Chalk Marks and Ghost Chalk overlays from visible editors. |

### Verify with MCP Inspector
```bash
npx @modelcontextprotocol/inspector node dist/mcp/stdioProxy.js
```

---

## Inline Slash Commands

Open the side-chat via CodeLens (**Ask /btw**), `Ctrl+Alt+/`, or `Chalk: Run Slash Command`:

| Command | Behavior |
| --- | --- |
| `/explain [prompt?]` | Runs an interactive `[< Prev / Next >]` Chalk Tour with Green Chalk pointers and cross-file split-view jumps. |
| `/edge [prompt?]` | Audits boundary conditions, null hazards, concurrency bugs, or a specific failure mode with Amber Chalk gutter warnings. |
| `/test [prompt?]` | **Mocking REPL** — solves the *Untestable Half-File* problem by auto-stubbing unbuilt imports in memory, transpiling TS/JS on the fly, and executing a sandboxed micro-test. |
| `/followme [prompt?]` | **Bidirectional Live Coaching**: Mode A drops debounced hints as you edit; Mode B completes code from your pseudo-code/stub with one-click apply (`/followme stop` to disable). |
| `/trace [inputs?]` | **Ghost-Chalk Dry-Run Debugger** — overlays inline variable mutations per line (`// role="guest" -> forbidden`) with `[< Prev State / Next State >]` loop stepping. |
| `/alt [prompt?]` | **Architectural Fork** — generates a drop-in alternative, unified diff, and Complexity / Memory-Speed / Readability trade-off matrix with one-click **[ 🔄 Swap Chunk ]**. |
| `/history [prompt?]` | **File Evolution Scrubber** — combines `git log -p --follow` and `.git/chalk-snapshots/` into a horizontal timeline slider highlighting Green (added) & Amber (modified) blocks, plus historical `/explain` Q&A. |

---

## Configuration Settings

| Setting | Default | Description |
| --- | --- | --- |
| `chalk.llm.provider` | `"auto"` | `auto`, `anthropic`, `openai`, or `gemini`. Auto-detects from `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `OPENAI_API_KEY`. |
| `chalk.llm.model` | `""` | Optional model override (defaults to `claude-3-5-haiku-latest`, `gpt-4o-mini`, or `gemini-2.5-flash`). |
| `chalk.llm.apiKey` | `""` | Optional API key override (reads env vars if blank). |
| `chalk.llm.baseUrl` | `""` | Custom OpenAI-compatible endpoint (e.g. Ollama, OpenRouter, vLLM). |
| `chalk.llm.maxTokensPerChunk` | `1600` | Token guardrail per generated chunk / side-agent turn. |
| `chalk.llm.maxChunksPerSession` | `25` | Chunk cap for standalone `LlmAgentPlayer` sessions. |
| `chalk.streaming.enabled` | `true` | Progressive drawing animation onto the editor buffer. |
| `chalk.streaming.mode` | `"line"` | `"line"` or `"token"` streaming granularity. |
| `chalk.streaming.delayMs` | `22` | Milliseconds between streamed steps. |
| `chalk.mcp.port` | `7331` | Localhost port for the embedded MCP bridge. |
| `chalk.mcp.autoStart` | `true` | Auto-start the MCP bridge when the IDE launches. |
