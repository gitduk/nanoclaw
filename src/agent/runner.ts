/**
 * NanoClaw Agent Runner
 * Runs agent directly on the host machine (no container)
 */

import fs from 'fs';
import path from 'path';
import { query, HookCallback, PreCompactHookInput } from '@anthropic-ai/claude-agent-sdk';
import { createIpcMcp } from './ipc-mcp.js';

export interface AgentInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  workspaceDir: string;  // Path to the group's workspace directory
  ipcDir: string;        // Path to IPC directory
  globalClaudeMd?: string; // Optional global CLAUDE.md content
}

export interface AgentResponse {
  outputType: 'message' | 'log';
  userMessage?: string;
  internalLog?: string;
}

export interface AgentOutput {
  status: 'success' | 'error';
  result: AgentResponse | null;
  newSessionId?: string;
  error?: string;
}

export type OnProgressCallback = (event: AgentProgressEvent) => void;

export interface ToolEventData {
  name: string;
  filePath?: string;
  command?: string;
  description?: string;
  pattern?: string;
  query?: string;
  url?: string;
  oldString?: string;  // Edit only
  newString?: string;  // Edit only
}

export interface AgentProgressEvent {
  type: 'text' | 'text_streaming' | 'tool_use' | 'tool_summary';
  text: string;
  tool?: ToolEventData;
}

function isNoiseText(text: string): boolean {
  return !text.trim();
}

interface SessionEntry {
  sessionId: string;
  fullPath: string;
  summary: string;
  firstPrompt: string;
}

interface SessionsIndex {
  entries: SessionEntry[];
}

function getSessionSummary(sessionId: string, transcriptPath: string): string | null {
  // sessions-index.json is in the same directory as the transcript
  const projectDir = path.dirname(transcriptPath);
  const indexPath = path.join(projectDir, 'sessions-index.json');

  if (!fs.existsSync(indexPath)) {
    return null;
  }

  try {
    const index: SessionsIndex = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
    const entry = index.entries.find(e => e.sessionId === sessionId);
    if (entry?.summary) {
      return entry.summary;
    }
  } catch (err) {
    // Ignore errors
  }

  return null;
}

/**
 * Archive the full transcript to conversations/ before compaction.
 */
function createPreCompactHook(workspaceDir: string): HookCallback {
  return async (input, _toolUseId, _context) => {
    const preCompact = input as PreCompactHookInput;
    const transcriptPath = preCompact.transcript_path;
    const sessionId = preCompact.session_id;

    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
      return {};
    }

    try {
      const content = fs.readFileSync(transcriptPath, 'utf-8');
      const messages = parseTranscript(content);

      if (messages.length === 0) {
        return {};
      }

      const summary = getSessionSummary(sessionId, transcriptPath);
      const name = summary ? sanitizeFilename(summary) : generateFallbackName();

      const conversationsDir = path.join(workspaceDir, 'conversations');
      fs.mkdirSync(conversationsDir, { recursive: true });

      const date = new Date().toISOString().split('T')[0];
      const filename = `${date}-${name}.md`;
      const filePath = path.join(conversationsDir, filename);

      const markdown = formatTranscriptMarkdown(messages, summary);
      fs.writeFileSync(filePath, markdown);
    } catch (err) {
      // Ignore errors
    }

    return {};
  };
}

function sanitizeFilename(summary: string): string {
  return summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

function generateFallbackName(): string {
  const time = new Date();
  return `conversation-${time.getHours().toString().padStart(2, '0')}${time.getMinutes().toString().padStart(2, '0')}`;
}

interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
}

function parseTranscript(content: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'user' && entry.message?.content) {
        const text = typeof entry.message.content === 'string'
          ? entry.message.content
          : entry.message.content.map((c: { text?: string }) => c.text || '').join('');
        if (text) messages.push({ role: 'user', content: text });
      } else if (entry.type === 'assistant' && entry.message?.content) {
        const textParts = entry.message.content
          .filter((c: { type: string }) => c.type === 'text')
          .map((c: { text: string }) => c.text);
        const text = textParts.join('');
        if (text) messages.push({ role: 'assistant', content: text });
      }
    } catch {
      // Ignore parse errors
    }
  }

  return messages;
}

function formatTranscriptMarkdown(messages: ParsedMessage[], title?: string | null): string {
  const now = new Date();
  const formatDateTime = (d: Date) => d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  });

  const lines: string[] = [];
  lines.push(`# ${title || 'Conversation'}`);
  lines.push('');
  lines.push(`Archived: ${formatDateTime(now)}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const msg of messages) {
    const sender = msg.role === 'user' ? 'User' : 'Andy';
    const content = msg.content.length > 2000
      ? msg.content.slice(0, 2000) + '...'
      : msg.content;
    lines.push(`**${sender}**: ${content}`);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Run the agent with the given input
 */
export async function runAgent(input: AgentInput, onProgress?: OnProgressCallback): Promise<AgentOutput> {
  const ipcMcp = createIpcMcp({
    chatJid: input.chatJid,
    groupFolder: input.groupFolder,
    isMain: input.isMain,
    ipcDir: input.ipcDir
  });

  let result: AgentResponse | null = null;
  let newSessionId: string | undefined;
  let textBuffer = '';  // Accumulate streaming text
  let currentToolName = '';  // Current tool being called
  let currentToolInput = '';  // Accumulate tool input JSON

  // Add context for scheduled tasks
  let prompt = input.prompt;
  if (input.isScheduledTask) {
    prompt = `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n${input.prompt}`;
  }

  try {
    const model = process.env.CLAUDE_MODEL || 'claude-sonnet-4.5';

    const AGENT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('Agent execution timeout')), AGENT_TIMEOUT_MS);
    });

    await Promise.race([
      (async () => {
        for await (const message of query({
          prompt,
          options: {
            executable: 'node',  // Force Node.js (not Bun) to avoid "Bun is not defined" error
            model,
            cwd: input.workspaceDir,
            resume: input.sessionId,
            systemPrompt: input.globalClaudeMd
              ? { type: 'preset' as const, preset: 'claude_code' as const, append: input.globalClaudeMd }
              : undefined,
            allowedTools: [
              'Bash',
              'Read', 'Write', 'Edit', 'Glob', 'Grep',
              'WebSearch', 'WebFetch',
              'mcp__nanoclaw__*'
            ],
            permissionMode: 'bypassPermissions',
            allowDangerouslySkipPermissions: true,
            includePartialMessages: true,  // Enable streaming events for real-time progress
            settingSources: ['project'],
            mcpServers: {
              nanoclaw: ipcMcp
            },
            hooks: {
              PreCompact: [{ hooks: [createPreCompactHook(input.workspaceDir)] }]
            }
          }
        })) {
      if (message.type === 'system' && message.subtype === 'init') {
        newSessionId = message.session_id;
      }

      // Stream progress events to dashboard
      if (onProgress) {
        if (message.type === 'stream_event') {
          const event = (message as any).event;
          // Handle tool use start
          if (event?.type === 'content_block_start' && event?.content_block?.type === 'tool_use') {
            currentToolName = event.content_block.name || '';
            currentToolInput = '';
          }
          // Handle streaming text deltas - flush complete lines, stream incomplete line in real-time
          else if (event?.type === 'content_block_delta' && event?.delta?.type === 'text_delta') {
            textBuffer += event.delta.text || '';
            // Flush complete lines (before last newline)
            const lines = textBuffer.split('\n');
            for (let i = 0; i < lines.length - 1; i++) {
              const line = lines[i].trim();
              if (line && !isNoiseText(line)) {
                onProgress({ type: 'text', text: line });
              }
            }
            textBuffer = lines[lines.length - 1];
            // Stream the incomplete line in real-time for live display
            if (textBuffer.trim()) {
              onProgress({ type: 'text_streaming', text: textBuffer });
            }
          }
          // Handle tool input JSON accumulation
          else if (event?.type === 'content_block_delta' && event?.delta?.type === 'input_json_delta') {
            currentToolInput += event.delta.partial_json || '';
          }
          // Handle content block end - flush text or emit tool info
          else if (event?.type === 'content_block_stop') {
            // Flush remaining text
            if (textBuffer.trim() && !isNoiseText(textBuffer)) {
              onProgress({ type: 'text', text: textBuffer.trim() });
            }
            textBuffer = '';
            // Emit tool with parsed input summary and structured data
            if (currentToolName) {
              let toolSummary = currentToolName;
              let toolData: ToolEventData = { name: currentToolName };
              try {
                const input = JSON.parse(currentToolInput || '{}');
                if (currentToolName === 'Read' && input.file_path) {
                  toolSummary = `Read ${input.file_path}`;
                  toolData = { name: 'Read', filePath: input.file_path };
                } else if (currentToolName === 'Bash' && input.command) {
                  const cmd = input.command.split('\n')[0];
                  toolSummary = `$ ${cmd.length > 60 ? cmd.slice(0, 60) + '...' : cmd}`;
                  toolData = { name: 'Bash', command: input.command, description: input.description };
                } else if (currentToolName === 'Grep' && input.pattern) {
                  toolSummary = `Grep "${input.pattern}"${input.path ? ` in ${input.path}` : ''}`;
                  toolData = { name: 'Grep', pattern: input.pattern, filePath: input.path };
                } else if (currentToolName === 'Glob' && input.pattern) {
                  toolSummary = `Glob ${input.pattern}`;
                  toolData = { name: 'Glob', pattern: input.pattern, filePath: input.path };
                } else if (currentToolName === 'Edit' && input.file_path) {
                  toolSummary = `Edit ${input.file_path}`;
                  toolData = {
                    name: 'Edit',
                    filePath: input.file_path,
                    oldString: input.old_string,
                    newString: input.new_string,
                  };
                } else if (currentToolName === 'Write' && input.file_path) {
                  toolSummary = `Write ${input.file_path}`;
                  toolData = { name: 'Write', filePath: input.file_path };
                } else if (currentToolName === 'WebSearch' && input.query) {
                  toolSummary = `Search: ${input.query}`;
                  toolData = { name: 'WebSearch', query: input.query };
                } else if (currentToolName === 'WebFetch' && input.url) {
                  toolSummary = `Fetch: ${input.url}`;
                  toolData = { name: 'WebFetch', url: input.url };
                } else if (currentToolName === 'TodoWrite') {
                  toolSummary = 'TodoWrite';
                } else if (currentToolName.startsWith('mcp__nanoclaw__')) {
                  toolSummary = currentToolName.replace('mcp__nanoclaw__', '');
                  toolData = { name: toolSummary };
                }
              } catch {
                // Keep just tool name if JSON parse fails
              }
              onProgress({ type: 'tool_use', text: toolSummary, tool: toolData });
            }
            currentToolName = '';
            currentToolInput = '';
          }
        } else if (message.type === 'tool_use_summary') {
          const summary = (message as any).summary as string;
          if (summary) {
            onProgress({ type: 'tool_summary', text: summary });
          }
        }
      }

      if (message.type === 'result') {
        if (message.subtype === 'success') {
          const textResult = 'result' in message ? (message as { result?: string }).result : null;
          if (textResult?.trim()) {
            result = { outputType: 'message', userMessage: textResult };
          } else {
            result = { outputType: 'log' };
          }
        }
      }
    }
      })(),
      timeoutPromise
    ]);

    return {
      status: 'success',
      result: result ?? { outputType: 'log' },
      newSessionId
    };

  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    return {
      status: 'error',
      result: null,
      newSessionId,
      error: errorMessage
    };
  }
}
