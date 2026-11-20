import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { createTwoFilesPatch, diffLines } from 'diff';
import { HistorySnapshot } from '../types/protocol.js';

const execFileAsync = promisify(execFile);

export interface SnapshotRecord {
  chunkId: string;
  filePath: string;
  relativePath: string;
  existedBefore: boolean;
  beforeContent: string;
  afterContent?: string;
  summary: string;
  timestamp: string;
  patchFile: string;
  gitStashRef?: string;
}

/**
 * Lightweight per-chunk Git shadow checkpoint manager.
 * Writes pre-chunk snapshots and unified patches into `.git/chalk-snapshots/`
 * without ever polluting `git log` or the staging area.
 * Also powers Step 8's `/history` file evolution timeline by combining
 * `git log -p --follow` with current-session Chalk snapshots.
 */
export class ShadowCheckpointManager {
  private readonly snapshotDir: string;
  private readonly autoFinishFiles = new Set<string>();
  private readonly snapshotsByChunkId = new Map<string, SnapshotRecord>();

  constructor(private readonly workspaceRoot: string) {
    const gitDir = path.join(workspaceRoot, '.git');
    this.snapshotDir = fs.existsSync(gitDir)
      ? path.join(gitDir, 'chalk-snapshots')
      : path.join(workspaceRoot, '.chalk-snapshots');
  }

  public getSnapshotDir(): string {
    return this.snapshotDir;
  }

  /** Record the exact pre-chunk file state before Chalk streams modifications. */
  public async createPreChunkSnapshot(
    chunkId: string,
    targetFilePath: string,
    summary: string
  ): Promise<SnapshotRecord> {
    fs.mkdirSync(this.snapshotDir, { recursive: true });

    const absPath = path.isAbsolute(targetFilePath)
      ? targetFilePath
      : path.resolve(this.workspaceRoot, targetFilePath);
    const relativePath = path.relative(this.workspaceRoot, absPath).replace(/\\/g, '/');

    const existedBefore = fs.existsSync(absPath);
    const beforeContent = existedBefore ? fs.readFileSync(absPath, 'utf8') : '';

    // Capture a lightweight dangling stash OID if inside a git repo with commits (never modifies git log/stash stack)
    let gitStashRef: string | undefined;
    try {
      const { stdout } = await execFileAsync('git', ['stash', 'create'], {
        cwd: this.workspaceRoot,
        timeout: 4000,
      });
      const trimmed = stdout.trim();
      if (trimmed.length > 0) {
        gitStashRef = trimmed;
      }
    } catch {
      // Not a git repo or no commits yet — fine, file snapshot still guarantees exact undo
    }

    const safeId = sanitizeId(chunkId);
    const patchFile = path.join(this.snapshotDir, `${safeId}.patch`);
    const metaFile = path.join(this.snapshotDir, `${safeId}.meta.json`);

    const record: SnapshotRecord = {
      chunkId,
      filePath: absPath,
      relativePath,
      existedBefore,
      beforeContent,
      summary,
      timestamp: new Date().toISOString(),
      patchFile,
      gitStashRef,
    };

    // Write initial empty patch header + metadata before chunk starts streaming
    fs.writeFileSync(patchFile, `# Chalk pre-chunk snapshot: ${chunkId}\n# File: ${relativePath}\n`, 'utf8');
    fs.writeFileSync(metaFile, JSON.stringify(record, null, 2), 'utf8');
    this.snapshotsByChunkId.set(chunkId, record);

    return record;
  }

  /**
   * Update the snapshot once a chunk finishes drawing so `.git/chalk-snapshots/<chunkId>.patch`
   * contains the exact unified diff and `/history` can replay the chunk.
   */
  public recordPostChunkState(chunkId: string, afterContent: string): SnapshotRecord | null {
    const record = this.loadRecord(chunkId);
    if (!record) {
      return null;
    }

    record.afterContent = afterContent;
    const patch = createTwoFilesPatch(
      `a/${record.relativePath}`,
      `b/${record.relativePath}`,
      record.beforeContent,
      afterContent,
      'pre-chunk',
      `chunk:${chunkId}`
    );

    fs.mkdirSync(this.snapshotDir, { recursive: true });
    fs.writeFileSync(record.patchFile, patch, 'utf8');
    const metaFile = path.join(this.snapshotDir, `${sanitizeId(chunkId)}.meta.json`);
    fs.writeFileSync(metaFile, JSON.stringify(record, null, 2), 'utf8');
    this.snapshotsByChunkId.set(chunkId, record);
    return record;
  }

  /**
   * Revert the target file to its exact pre-chunk snapshot.
   * Returns the restored record (including `beforeContent` so the active TextEditor can be synced).
   */
  public revertChunk(chunkId: string): SnapshotRecord | null {
    const record = this.loadRecord(chunkId);
    if (!record) {
      return null;
    }

    if (record.existedBefore) {
      fs.mkdirSync(path.dirname(record.filePath), { recursive: true });
      fs.writeFileSync(record.filePath, record.beforeContent, 'utf8');
    } else if (fs.existsSync(record.filePath)) {
      fs.unlinkSync(record.filePath);
    }

    return record;
  }

  public loadRecord(chunkId: string): SnapshotRecord | null {
    const cached = this.snapshotsByChunkId.get(chunkId);
    if (cached) {
      return cached;
    }
    const metaFile = path.join(this.snapshotDir, `${sanitizeId(chunkId)}.meta.json`);
    if (!fs.existsSync(metaFile)) {
      return null;
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(metaFile, 'utf8')) as SnapshotRecord;
      this.snapshotsByChunkId.set(chunkId, parsed);
      return parsed;
    } catch {
      return null;
    }
  }

  /** Escape hatch: Auto-Finish remaining chunks in the current file without pausing. */
  public enableAutoFinish(filePath: string): void {
    this.autoFinishFiles.add(this.normalizeKey(filePath));
  }

  public shouldAutoFinish(filePath: string): boolean {
    return this.autoFinishFiles.has(this.normalizeKey(filePath));
  }

  public clearAutoFinish(filePath?: string): void {
    if (filePath) {
      this.autoFinishFiles.delete(this.normalizeKey(filePath));
    } else {
      this.autoFinishFiles.clear();
    }
  }

  /**
   * List all Chalk session snapshots saved for a specific file, ordered oldest -> newest.
   */
  public listSessionSnapshotsForFile(targetFilePath: string): SnapshotRecord[] {
    if (!fs.existsSync(this.snapshotDir)) {
      return [];
    }
    const targetKey = this.normalizeKey(targetFilePath);
    const records: SnapshotRecord[] = [];

    for (const entry of fs.readdirSync(this.snapshotDir)) {
      if (!entry.endsWith('.meta.json')) {
        continue;
      }
      try {
        const rec = JSON.parse(
          fs.readFileSync(path.join(this.snapshotDir, entry), 'utf8')
        ) as SnapshotRecord;
        if (this.normalizeKey(rec.filePath) === targetKey || this.normalizeKey(rec.relativePath) === targetKey) {
          records.push(rec);
        }
      } catch {
        // Skip corrupt meta files
      }
    }

    return records.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  }

  /**
   * Build a combined temporal timeline (`git log -p --follow` + `.git/chalk-snapshots/`)
   * ordered oldest -> newest for Step 8 (`/history`).
   */
  public async getCombinedFileHistory(
    targetFilePath: string,
    maxGitCommits = 20
  ): Promise<HistorySnapshot[]> {
    const absPath = path.isAbsolute(targetFilePath)
      ? targetFilePath
      : path.resolve(this.workspaceRoot, targetFilePath);
    const relPath = path.relative(this.workspaceRoot, absPath).replace(/\\/g, '/');

    const timeline: HistorySnapshot[] = [];

    // 1. Git commit history via `git log --follow`
    try {
      const { stdout } = await execFileAsync(
        'git',
        [
          'log',
          '--follow',
          `-n`,
          String(maxGitCommits),
          '--format=%H%x1f%aI%x1f%an%x1f%s',
          '--',
          relPath,
        ],
        { cwd: this.workspaceRoot, timeout: 6000 }
      );

      const lines = stdout
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
        .reverse(); // oldest -> newest

      for (const line of lines) {
        const [hash, isoDate, author, subject] = line.split('\x1f');
        if (!hash) {
          continue;
        }
        let content = '';
        let patch = '';
        try {
          const showRes = await execFileAsync('git', ['show', `${hash}:${relPath}`], {
            cwd: this.workspaceRoot,
            timeout: 4000,
          });
          content = showRes.stdout;
        } catch {
          // File may have been renamed in an older commit; try extracting from git log -p
          content = '';
        }

        try {
          const patchRes = await execFileAsync(
            'git',
            ['show', '--format=', '-p', hash, '--', relPath],
            { cwd: this.workspaceRoot, timeout: 4000 }
          );
          patch = patchRes.stdout;
        } catch {
          patch = '';
        }

        timeline.push({
          id: `git:${hash.slice(0, 7)}`,
          source: 'git',
          label: `${hash.slice(0, 7)} — ${subject}`,
          timestamp: isoDate || '',
          author: author || 'unknown',
          summary: subject || hash.slice(0, 7),
          content,
          diffFromPrevious: patch,
        });
      }
    } catch {
      // File may be untracked or workspace has no git commits yet
    }

    // 2. Append Chalk session snapshots for this file
    const sessionSnaps = this.listSessionSnapshotsForFile(absPath);
    for (const snap of sessionSnaps) {
      const content = snap.afterContent ?? snap.beforeContent;
      const patch = createTwoFilesPatch(
        `a/${snap.relativePath}`,
        `b/${snap.relativePath}`,
        snap.beforeContent,
        content,
        'pre-chunk',
        snap.chunkId
      );
      timeline.push({
        id: `chalk:${snap.chunkId}`,
        source: 'chalk-snapshot',
        label: `Chalk · ${snap.chunkId}`,
        timestamp: snap.timestamp,
        author: 'Chalk Session',
        summary: snap.summary,
        content,
        diffFromPrevious: patch,
      });
    }

    // 3. Compute changed line numbers (added / modified) between consecutive snapshots
    for (let i = 0; i < timeline.length; i++) {
      const prevContent = i > 0 ? timeline[i - 1].content : '';
      timeline[i].changedLines = computeChangedLineNumbers(prevContent, timeline[i].content);
    }

    return timeline;
  }

  private normalizeKey(filePath: string): string {
    const abs = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(this.workspaceRoot, filePath);
    return path.normalize(abs).toLowerCase();
  }
}

export function computeChangedLineNumbers(
  before: string,
  after: string
): { added: number[]; modified: number[] } {
  const added: number[] = [];
  const modified: number[] = [];
  const parts = diffLines(before.replace(/\r\n/g, '\n'), after.replace(/\r\n/g, '\n'));

  let currentLine = 1;
  let prevWasRemoved = false;

  for (const part of parts) {
    const count = part.count ?? part.value.split('\n').length - 1;
    if (part.added) {
      for (let i = 0; i < Math.max(1, count); i++) {
        if (prevWasRemoved) {
          modified.push(currentLine + i);
        } else {
          added.push(currentLine + i);
        }
      }
      currentLine += count;
      prevWasRemoved = false;
    } else if (part.removed) {
      prevWasRemoved = true;
    } else {
      currentLine += count;
      prevWasRemoved = false;
    }
  }

  return { added, modified };
}

function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, '_');
}
