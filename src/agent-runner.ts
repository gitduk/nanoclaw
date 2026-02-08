/**
 * Agent Runner - Runs agents directly on the host machine
 * Replaces the container-based approach
 */

import path from 'path';
import fs from 'fs';
import { logger } from './logger.js';
import { runAgent, AgentInput, AgentOutput, OnProgressCallback } from './agent/runner.js';
import { PATHS } from './config.js';

export interface RunAgentOptions {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  onProgress?: OnProgressCallback;
}

/**
 * Run an agent for a group
 */
export async function runAgentForGroup(options: RunAgentOptions): Promise<AgentOutput> {
  const { groupFolder, chatJid, isMain } = options;

  logger.info({ group: groupFolder }, 'Running agent');

  // Prepare workspace directory
  const workspaceDir = path.join(PATHS.GROUPS_DIR, groupFolder);
  fs.mkdirSync(workspaceDir, { recursive: true });

  // Load global CLAUDE.md if not main group
  const globalClaudeMdPath = path.join(PATHS.GROUPS_DIR, 'global', 'CLAUDE.md');
  let globalClaudeMd: string | undefined;
  if (!isMain && fs.existsSync(globalClaudeMdPath)) {
    globalClaudeMd = fs.readFileSync(globalClaudeMdPath, 'utf-8');
  }

  // Prepare IPC directory
  const ipcDir = path.join(PATHS.DATA_DIR, 'ipc');
  fs.mkdirSync(path.join(ipcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(ipcDir, 'tasks'), { recursive: true });

  const input: AgentInput = {
    prompt: options.prompt,
    sessionId: options.sessionId,
    groupFolder,
    chatJid,
    isMain,
    isScheduledTask: options.isScheduledTask,
    workspaceDir,
    ipcDir,
    globalClaudeMd
  };

  try {
    const output = await runAgent(input, options.onProgress);

    if (output.status === 'success') {
      logger.info({ group: groupFolder, outputType: output.result?.outputType }, 'Agent completed successfully');
    } else {
      logger.error({ group: groupFolder, error: output.error }, 'Agent error');
    }

    return output;
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logger.error({ group: groupFolder, error: errorMessage }, 'Agent execution failed');

    return {
      status: 'error',
      result: null,
      error: errorMessage
    };
  }
}
