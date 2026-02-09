import fs from 'fs';
import path from 'path';
import { DASHBOARD_ENABLED } from './config.js';

// ANSI escape sequences
const ALT_SCREEN_ON = '\x1b[?1049h';
const ALT_SCREEN_OFF = '\x1b[?1049l';
const CURSOR_HIDE = '\x1b[?25l';
const CURSOR_SHOW = '\x1b[?25h';
const MOVE_HOME = '\x1b[H';
const CLEAR_BELOW = '\x1b[J';
const WRAP_OFF = '\x1b[?7l';    // Disable auto-wrap (overflow truncated, not wrapped)
const WRAP_ON = '\x1b[?7h';     // Re-enable auto-wrap
const SYNC_START = '\x1b[?2026h'; // Synchronized output start (batch screen updates)
const SYNC_END = '\x1b[?2026l';   // Synchronized output end

const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';

// Box-drawing characters
const H = '\u2500';
const V = '\u2502';
const TL = '\u250c';
const TR = '\u2510';
const BL = '\u2514';
const BR = '\u2518';
const ML = '\u251c';
const MR = '\u2524';

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g;

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'reconnecting';
export type GroupStatus = 'idle' | 'running' | 'queued';

interface GroupDisplay {
  name: string;
  folder: string;
  status: GroupStatus;
}

interface DashboardState {
  agentName: string;
  maxAgents: number;
  waStatus: ConnectionStatus;
  groups: Map<string, GroupDisplay>;
  activeAgents: number;
  messageCount: number;
  startTime: number;
  inputBuffer: string;
  cursorPos: number;
  inputMode: boolean;
}

type InputCallback = (input: string) => void;
let inputCallback: InputCallback | null = null;

const MAX_THINKING_LINES = 500;
const RENDER_THROTTLE_MS = 50; // Max ~20fps to reduce flicker
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const thinkingBuffer: string[] = [];
let active = false;
let renderTimer: ReturnType<typeof setTimeout> | null = null;
let lastRenderTime = 0;
let uptimeTimer: ReturnType<typeof setInterval> | null = null;
let logFileStream: fs.WriteStream | null = null;
let spinnerText: string | null = null;
let spinnerFrame = 0;
let spinnerTimer: ReturnType<typeof setInterval> | null = null;
let streamingLine: string | null = null;

const originalConsole = {
  log: console.log,
  warn: console.warn,
  error: console.error,
};

const state: DashboardState = {
  agentName: '',
  maxAgents: 1,
  waStatus: 'connecting',
  groups: new Map(),
  activeAgents: 0,
  messageCount: 0,
  startTime: Date.now(),
  inputBuffer: '',
  cursorPos: 0,
  inputMode: false,
};

// --- Public API ---

export function initDashboard(opts: { agentName: string; maxAgents: number }): void {
  if (!DASHBOARD_ENABLED) return;

  state.agentName = opts.agentName;
  state.maxAgents = opts.maxAgents;
  state.startTime = Date.now();
  active = true;

  // Ensure logs directory exists and open log file
  const logsDir = path.join(process.cwd(), 'logs');
  fs.mkdirSync(logsDir, { recursive: true });
  logFileStream = fs.createWriteStream(path.join(logsDir, 'nanoclaw.log'), { flags: 'a' });

  // Enter alternate screen buffer
  process.stdout.write(ALT_SCREEN_ON + CURSOR_HIDE);

  // Consume stdin so keyboard input doesn't leak onto screen.
  // Raw mode disables terminal signal handling, so we catch Ctrl+C manually.
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', handleInput);
  }

  // Safety net: restore terminal on exit
  process.once('exit', destroyDashboard);

  // Ensure log file is closed on process termination
  process.once('beforeExit', () => {
    if (logFileStream && !logFileStream.closed) {
      logFileStream.end();
    }
  });

  // Handle resize
  process.stdout.on('resize', scheduleRender);

  // Uptime refresh every 30s
  uptimeTimer = setInterval(scheduleRender, 30000);

  // Monkey-patch console to write to log file only (no dashboard display)
  console.log = (...args: unknown[]) => writeLogFile(args.map(String).join(' '));
  console.warn = (...args: unknown[]) => writeLogFile(`[WARN] ${args.map(String).join(' ')}`);
  console.error = (...args: unknown[]) => writeLogFile(`[ERR] ${args.map(String).join(' ')}`);

  render();
}

export function destroyDashboard(): void {
  if (!active) return;
  active = false;

  if (uptimeTimer) {
    clearInterval(uptimeTimer);
    uptimeTimer = null;
  }
  if (renderTimer) {
    clearTimeout(renderTimer);
    renderTimer = null;
  }
  if (spinnerTimer) {
    clearInterval(spinnerTimer);
    spinnerTimer = null;
  }

  // Restore console
  console.log = originalConsole.log;
  console.warn = originalConsole.warn;
  console.error = originalConsole.error;

  // Restore stdin
  if (process.stdin.isTTY && process.stdin.isRaw) {
    process.stdin.setRawMode(false);
    process.stdin.pause();
  }

  process.stdout.off('resize', scheduleRender);
  process.stdout.write(CURSOR_SHOW + ALT_SCREEN_OFF);

  logFileStream?.end();
  logFileStream = null;
}

export function isDashboardActive(): boolean {
  return active;
}

export function setConnectionStatus(status: ConnectionStatus): void {
  state.waStatus = status;
  scheduleRender();
}

export function setGroups(groups: Record<string, { name: string; folder: string }>): void {
  // Preserve existing statuses
  const existing = new Map(state.groups);
  state.groups.clear();
  for (const [jid, g] of Object.entries(groups)) {
    const prev = existing.get(jid);
    state.groups.set(jid, {
      name: g.name,
      folder: g.folder,
      status: prev?.status ?? 'idle',
    });
  }
  scheduleRender();
}

export function setGroupStatus(jid: string, status: GroupStatus): void {
  const group = state.groups.get(jid);
  if (group) {
    group.status = status;
    scheduleRender();
  }
}

export function incrementMessages(count = 1): void {
  state.messageCount += count;
  scheduleRender();
}

export function setActiveAgents(count: number): void {
  state.activeAgents = count;
  scheduleRender();
}

export function setInputCallback(callback: InputCallback): void {
  inputCallback = callback;
}

export function enableInputMode(): void {
  state.inputMode = true;
  scheduleRender();
}

export function disableInputMode(): void {
  state.inputMode = false;
  state.inputBuffer = '';
  state.cursorPos = 0;
  scheduleRender();
}

export function setThinkingIndicator(text: string | null): void {
  if (text) {
    spinnerText = text;
    spinnerFrame = 0;
    if (!spinnerTimer) {
      spinnerTimer = setInterval(() => {
        spinnerFrame = (spinnerFrame + 1) % SPINNER_FRAMES.length;
        scheduleRender();
      }, 80);
    }
  } else {
    spinnerText = null;
    if (spinnerTimer) {
      clearInterval(spinnerTimer);
      spinnerTimer = null;
    }
  }
  scheduleRender();
}

export function setStreamingLine(line: string | null): void {
  streamingLine = line;
  scheduleRender();
}

function handleInput(data: Buffer): void {
  // Ctrl+C
  if (data[0] === 0x03) {
    process.kill(process.pid, 'SIGINT');
    return;
  }

  // Ctrl+D (toggle input mode)
  if (data[0] === 0x04) {
    state.inputMode = !state.inputMode;
    if (!state.inputMode) {
      state.inputBuffer = '';
      state.cursorPos = 0;
    }
    scheduleRender();
    return;
  }

  if (!state.inputMode) return;

  const str = data.toString('utf8');

  // Enter key
  if (str === '\r' || str === '\n') {
    if (state.inputBuffer.trim() && inputCallback) {
      inputCallback(state.inputBuffer.trim());
    }
    state.inputBuffer = '';
    state.cursorPos = 0;
    scheduleRender();
    return;
  }

  // Backspace
  if (data[0] === 0x7f || data[0] === 0x08) {
    if (state.cursorPos > 0) {
      state.inputBuffer =
        state.inputBuffer.slice(0, state.cursorPos - 1) +
        state.inputBuffer.slice(state.cursorPos);
      state.cursorPos--;
      scheduleRender();
    }
    return;
  }

  // Arrow keys
  if (data[0] === 0x1b && data[1] === 0x5b) {
    if (data[2] === 0x44) { // Left arrow
      if (state.cursorPos > 0) {
        state.cursorPos--;
        scheduleRender();
      }
      return;
    }
    if (data[2] === 0x43) { // Right arrow
      if (state.cursorPos < state.inputBuffer.length) {
        state.cursorPos++;
        scheduleRender();
      }
      return;
    }
    return;
  }

  // Regular characters
  if (str.length > 0 && str.charCodeAt(0) >= 32) {
    state.inputBuffer =
      state.inputBuffer.slice(0, state.cursorPos) +
      str +
      state.inputBuffer.slice(state.cursorPos);
    state.cursorPos += str.length;
    scheduleRender();
  }
}

/** Write a line to the log file only (no dashboard display). */
function writeLogFile(line: string): void {
  if (!logFileStream) return;
  for (const l of line.split('\n')) {
    if (l.trim()) {
      logFileStream.write(l + '\n');
    }
  }
}

/** Write pino/console output to log file only. */
export function pushLogLine(line: string): void {
  if (!active) return;
  writeLogFile(line);
}

/** Push a line to the thinking display and log file. */
export function pushThinkingLine(line: string): void {
  if (!active) return;
  const width = (process.stdout.columns || 80) - 6;  // Account for box borders and padding
  for (const l of line.split('\n')) {
    if (l.trim()) {
      // Wrap long lines
      const wrapped = wrapText(l, width);
      for (const w of wrapped) {
        thinkingBuffer.push(w);
      }
      logFileStream?.write(l + '\n');
    } else {
      // Allow blank separator lines
      thinkingBuffer.push('');
    }
  }
  if (thinkingBuffer.length >= MAX_THINKING_LINES) {
    thinkingBuffer.splice(0, thinkingBuffer.length - MAX_THINKING_LINES);
  }
  scheduleRender();
}

/** Wrap text to fit within maxWidth display columns. */
function wrapText(text: string, maxWidth: number): string[] {
  if (visibleLength(text) <= maxWidth) return [text];
  const lines: string[] = [];
  let remaining = text;
  while (visibleLength(remaining) > maxWidth) {
    // Find break point that fits within maxWidth
    let width = 0;
    let breakIdx = 0;
    let lastSpaceIdx = -1;
    for (const char of remaining) {
      const code = char.codePointAt(0) || 0;
      const charWidth = isWideChar(code) ? 2 : 1;
      if (width + charWidth > maxWidth) break;
      if (char === ' ') lastSpaceIdx = breakIdx;
      width += charWidth;
      breakIdx += char.length;
    }
    // Prefer breaking at space
    const actualBreak = lastSpaceIdx > 0 ? lastSpaceIdx : breakIdx;
    lines.push(remaining.slice(0, actualBreak));
    remaining = remaining.slice(actualBreak).trimStart();
  }
  if (remaining) lines.push(remaining);
  return lines;
}

// --- Rendering ---

function scheduleRender(): void {
  if (!active || renderTimer) return;
  const now = Date.now();
  const elapsed = now - lastRenderTime;
  if (elapsed >= RENDER_THROTTLE_MS) {
    // Enough time passed — render immediately on next tick
    renderTimer = setTimeout(() => {
      renderTimer = null;
      if (active) render();
    }, 0);
  } else {
    // Too soon — defer to hit the throttle interval
    renderTimer = setTimeout(() => {
      renderTimer = null;
      if (active) render();
    }, RENDER_THROTTLE_MS - elapsed);
  }
}

function render(): void {
  const width = process.stdout.columns || 80;
  const height = process.stdout.rows || 24;
  const innerW = width - 2; // space inside box borders
  const buf: string[] = [];

  // Header section
  buf.push(boxTop(width, ' NanoClaw '));
  buf.push(boxRow(innerW, twoCol(
    `  Agent: ${BOLD}${state.agentName}${RESET}`,
    `WhatsApp: ${statusIcon(state.waStatus)}  `,
    innerW
  )));
  buf.push(boxRow(innerW, twoCol(
    `  Groups: ${BOLD}${state.groups.size}${RESET}`,
    `Uptime: ${formatUptime()}  `,
    innerW
  )));
  buf.push(boxRow(innerW, twoCol(
    `  Messages: ${BOLD}${state.messageCount}${RESET}`,
    `Active Agents: ${BOLD}${state.activeAgents}/${state.maxAgents}${RESET}  `,
    innerW
  )));

  // Groups section
  buf.push(boxMid(width, ' Groups '));
  if (state.groups.size === 0) {
    buf.push(boxRow(innerW, `  ${DIM}No groups registered${RESET}`));
  } else {
    // Cap group rows to avoid overflowing the terminal
    const maxGroupRows = Math.max(1, height - 10);
    let rendered = 0;
    for (const [, group] of state.groups) {
      if (rendered >= maxGroupRows) {
        buf.push(boxRow(innerW, `  ${DIM}... and ${state.groups.size - rendered} more${RESET}`));
        break;
      }
      const icon = groupIcon(group.status);
      buf.push(boxRow(innerW, twoCol(
        `  ${icon} ${group.name}`,
        `${group.status}  `,
        innerW
      )));
      rendered++;
    }
  }

  // Thinking section
  buf.push(boxMid(width, ` ${state.agentName} `));
  const inputLines = state.inputMode ? 3 : 0; // Input box takes 3 lines when active
  const chromeLines = buf.length + 1 + inputLines; // +1 for bottom border
  const thinkingHeight = Math.max(1, height - chromeLines);

  if (thinkingBuffer.length === 0 && !spinnerText && !streamingLine) {
    buf.push(boxRow(innerW, `  ${DIM}Waiting for messages...${RESET}`));
    for (let i = 1; i < thinkingHeight; i++) {
      buf.push(boxRow(innerW, ''));
    }
  } else {
    const visibleLines = thinkingBuffer.slice(-thinkingHeight);
    for (const line of visibleLines) {
      buf.push(boxRow(innerW, `  ${truncate(line, innerW - 2)}`));
    }
    let usedLines = visibleLines.length;
    // Real-time streaming line (current incomplete text from agent)
    if (streamingLine && usedLines < thinkingHeight) {
      buf.push(boxRow(innerW, `  ${truncate(streamingLine, innerW - 2)}`));
      usedLines++;
    }
    // Animated spinner while agent is thinking
    if (spinnerText && usedLines < thinkingHeight) {
      buf.push(boxRow(innerW, `  ${DIM}${SPINNER_FRAMES[spinnerFrame]} ${spinnerText}${RESET}`));
      usedLines++;
    }
    for (let i = usedLines; i < thinkingHeight; i++) {
      buf.push(boxRow(innerW, ''));
    }
  }

  // Input box (if enabled)
  if (state.inputMode) {
    buf.push(boxMid(width, ' Input '));
    const prompt = '> ';
    const displayText = state.inputBuffer;
    const cursorIndicator = state.inputMode ? '█' : '';
    const beforeCursor = displayText.slice(0, state.cursorPos);
    const afterCursor = displayText.slice(state.cursorPos);
    const inputLine = `  ${prompt}${beforeCursor}${cursorIndicator}${afterCursor}`;
    buf.push(boxRow(innerW, truncate(inputLine, innerW)));
    buf.push(boxRow(innerW, `  ${DIM}Ctrl+D: toggle input | Enter: send | Ctrl+C: exit${RESET}`));
  }

  buf.push(boxBottom(width));

  // Synchronized output prevents flicker; auto-wrap off prevents overflow from
  // emoji/CJK width miscalculation pushing the status bar off-screen.
  process.stdout.write(
    SYNC_START + WRAP_OFF + MOVE_HOME + buf.join('\n') + CLEAR_BELOW + WRAP_ON + SYNC_END
  );
  lastRenderTime = Date.now();
}

// --- Helpers ---

function stripAnsi(str: string): string {
  return str.replace(ANSI_RE, '');
}

function visibleLength(str: string): number {
  const plain = stripAnsi(str);
  let width = 0;
  for (const char of plain) {
    const code = char.codePointAt(0) || 0;
    width += isWideChar(code) ? 2 : 1;
  }
  return width;
}

function truncate(str: string, maxVisible: number): string {
  if (visibleLength(str) <= maxVisible) return str;
  const plain = stripAnsi(str);
  let width = 0;
  let i = 0;
  for (const char of plain) {
    const code = char.codePointAt(0) || 0;
    const charWidth = isWideChar(code) ? 2 : 1;
    if (width + charWidth + 1 > maxVisible) break;  // +1 for ellipsis
    width += charWidth;
    i += char.length;
  }
  return plain.slice(0, i) + '\u2026';
}

function isWideChar(code: number): boolean {
  return (
    // CJK
    (code >= 0x1100 && code <= 0x115F) ||
    (code >= 0x2E80 && code <= 0x9FFF) ||
    (code >= 0xAC00 && code <= 0xD7AF) ||
    (code >= 0xF900 && code <= 0xFAFF) ||
    (code >= 0xFE10 && code <= 0xFE1F) ||
    (code >= 0xFE30 && code <= 0xFE6F) ||
    (code >= 0xFF00 && code <= 0xFF60) ||
    (code >= 0xFFE0 && code <= 0xFFE6) ||
    (code >= 0x20000 && code <= 0x2FFFF) ||
    // Emoji & symbols that render as 2 columns in terminals
    (code >= 0x2300 && code <= 0x23FF) ||  // Misc technical (⌚⏰ etc.)
    (code >= 0x2600 && code <= 0x27BF) ||  // Misc symbols, Dingbats (☀✅❌ etc.)
    (code >= 0x1F000 && code <= 0x1FAFF)   // All emoji blocks (😊🎉💰🔧 etc.)
  );
}

function boxTop(width: number, title: string): string {
  const titleLen = title.length;
  const right = Math.max(0, width - 3 - titleLen); // -2 corners, -1 leading H
  return `${DIM}${TL}${H}${RESET}${BOLD}${title}${RESET}${DIM}${H.repeat(right)}${TR}${RESET}`;
}

function boxMid(width: number, title: string): string {
  const titleLen = title.length;
  const right = Math.max(0, width - 3 - titleLen); // -2 corners, -1 leading H
  return `${DIM}${ML}${H}${RESET}${BOLD}${title}${RESET}${DIM}${H.repeat(right)}${MR}${RESET}`;
}

function boxBottom(width: number): string {
  return `${DIM}${BL}${H.repeat(width - 2)}${BR}${RESET}`;
}

function boxRow(innerW: number, content: string): string {
  const visLen = visibleLength(content);
  const pad = Math.max(0, innerW - visLen);
  return `${DIM}${V}${RESET}${content}${' '.repeat(pad)}${DIM}${V}${RESET}`;
}

function twoCol(left: string, right: string, totalWidth: number): string {
  const rightLen = visibleLength(right);
  const maxLeft = totalWidth - rightLen - 2;
  const truncLeft = maxLeft < 4 ? left : truncate(left, maxLeft);
  const leftLen = visibleLength(truncLeft);
  const gap = Math.max(2, totalWidth - leftLen - rightLen);
  return `${truncLeft}${' '.repeat(gap)}${right}`;
}

function statusIcon(status: ConnectionStatus): string {
  switch (status) {
    case 'connected': return `${GREEN}● Connected${RESET}`;
    case 'connecting': return `${YELLOW}◌ Connecting${RESET}`;
    case 'reconnecting': return `${YELLOW}⟳ Reconnecting${RESET}`;
    case 'disconnected': return `${RED}● Disconnected${RESET}`;
  }
}

function groupIcon(status: GroupStatus): string {
  switch (status) {
    case 'idle': return `${GREEN}●${RESET}`;
    case 'running': return `${YELLOW}⟳${RESET}`;
    case 'queued': return `${DIM}◌${RESET}`;
  }
}

function formatUptime(): string {
  const elapsed = Date.now() - state.startTime;
  const seconds = Math.floor(elapsed / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

// --- Claude Code-style Formatting ---

const CONNECTOR = '\u23bf';  // ⎿
const DIFF_INDENT = '   ';   // 3 spaces to align under tool header text

/**
 * Format a tool call header: ⎿  Read src/config.ts
 * The render function adds 2-space prefix, so on screen it shows: "  ⎿  Read src/config.ts"
 */
export function formatToolHeader(summary: string): string {
  return `${DIM}${CONNECTOR}${RESET}  ${CYAN}${summary}${RESET}`;
}

/**
 * Format Edit diff lines with red (removed) / green (added) coloring.
 * Returns array of formatted strings ready for pushThinkingLine().
 */
export function formatDiffLines(oldStr: string, newStr: string): string[] {
  const oldLines = oldStr ? oldStr.replace(/\n$/, '').split('\n') : [];
  const newLines = newStr ? newStr.replace(/\n$/, '').split('\n') : [];

  // Guard: skip diff for very large edits
  if (oldLines.length > 100 || newLines.length > 100) {
    return [`${DIFF_INDENT}${DIM}(large edit: ${oldLines.length} lines \u2192 ${newLines.length} lines)${RESET}`];
  }

  const diff = computeLineDiff(oldLines, newLines);
  const maxWidth = (process.stdout.columns || 80) - 14;  // account for borders + indent + prefix
  const MAX_DIFF_LINES = 20;
  const lines: string[] = [];
  let displayed = 0;

  for (const entry of diff) {
    if (displayed >= MAX_DIFF_LINES) {
      const remaining = diff.length - displayed;
      if (remaining > 0) {
        lines.push(`${DIFF_INDENT}${DIM}... ${remaining} more lines${RESET}`);
      }
      break;
    }
    const text = truncate(entry.text, maxWidth);
    if (entry.type === 'remove') {
      lines.push(`${DIFF_INDENT}${RED}- ${text}${RESET}`);
    } else if (entry.type === 'add') {
      lines.push(`${DIFF_INDENT}${GREEN}+ ${text}${RESET}`);
    } else if (entry.text === '...') {
      lines.push(`${DIFF_INDENT}${DIM}  ...${RESET}`);
    } else {
      lines.push(`${DIFF_INDENT}${DIM}  ${text}${RESET}`);
    }
    displayed++;
  }

  return lines;
}

/**
 * Format tool result/summary text, indented under the tool block.
 */
export function formatToolResult(summary: string): string[] {
  const maxWidth = (process.stdout.columns || 80) - 14;
  const lines: string[] = [];

  for (const line of summary.split('\n').slice(0, 5)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const text = truncate(trimmed, maxWidth);
    lines.push(`${DIFF_INDENT}${DIM}${text}${RESET}`);
  }

  return lines;
}

// --- LCS Line Diff ---

interface DiffEntry {
  type: 'add' | 'remove' | 'context';
  text: string;
}

function computeLineDiff(oldLines: string[], newLines: string[]): DiffEntry[] {
  const m = oldLines.length;
  const n = newLines.length;

  // Build LCS table
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack to produce diff entries
  const stack: DiffEntry[] = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      stack.push({ type: 'context', text: oldLines[i - 1] });
      i--; j--;
    } else if (i > 0 && (j === 0 || dp[i - 1][j] >= dp[i][j - 1])) {
      stack.push({ type: 'remove', text: oldLines[i - 1] });
      i--;
    } else {
      stack.push({ type: 'add', text: newLines[j - 1] });
      j--;
    }
  }
  stack.reverse();

  // Filter: show only changed lines + 1 line of context around changes
  return filterContext(stack, 1);
}

function filterContext(entries: DiffEntry[], contextLines: number): DiffEntry[] {
  const isChange = entries.map(e => e.type !== 'context');
  const include = new Array(entries.length).fill(false);

  for (let i = 0; i < entries.length; i++) {
    if (isChange[i]) {
      include[i] = true;
      for (let c = 1; c <= contextLines; c++) {
        if (i - c >= 0) include[i - c] = true;
        if (i + c < entries.length) include[i + c] = true;
      }
    }
  }

  // Insert '...' separators between non-contiguous regions
  const result: DiffEntry[] = [];
  let lastIdx = -1;
  for (let i = 0; i < entries.length; i++) {
    if (include[i]) {
      if (lastIdx >= 0 && i - lastIdx > 1) {
        result.push({ type: 'context', text: '...' });
      }
      result.push(entries[i]);
      lastIdx = i;
    }
  }
  return result;
}
