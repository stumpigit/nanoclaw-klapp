/**
 * Klapp Integration - MCP Tool Definitions (Container/Agent Side)
 *
 * Defines the klapp_read_messages tool available to agents inside containers.
 * Communicates with the host via IPC file system.
 *
 * This file is compiled inside the container (copied during Docker build).
 * @ts-ignore comments are needed because SDK is only available in the container.
 */

// @ts-ignore - SDK available in container environment only
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';

const IPC_DIR = '/workspace/ipc';
const TASKS_DIR = path.join(IPC_DIR, 'tasks');
const RESULTS_DIR = path.join(IPC_DIR, 'klapp_results');

function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);
  const tmp = `${filepath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, filepath);
  return filename;
}

async function waitForResult(requestId: string, maxWait = 90_000): Promise<{ success: boolean; message: string; messages?: unknown[] }> {
  const resultFile = path.join(RESULTS_DIR, `${requestId}.json`);
  const poll = 1000;
  let elapsed = 0;

  while (elapsed < maxWait) {
    if (fs.existsSync(resultFile)) {
      try {
        const result = JSON.parse(fs.readFileSync(resultFile, 'utf-8'));
        fs.unlinkSync(resultFile);
        return result;
      } catch (err) {
        return { success: false, message: `Failed to read result: ${err}` };
      }
    }
    await new Promise((r) => setTimeout(r, poll));
    elapsed += poll;
  }

  return { success: false, message: 'Klapp request timed out (90s)' };
}

export interface KlappToolsContext {
  groupFolder: string;
  isMain: boolean;
}

export function createKlappTools(ctx: KlappToolsContext) {
  const { groupFolder } = ctx;

  return [
    tool(
      'klapp_read_messages',
      `Read messages from Klapp (klapp.mobi school communication platform).

Logs into Klapp using stored credentials and returns recent messages from the inbox.
Screenshots are saved to data/klapp-screenshots/ for debugging if anything goes wrong.`,
      {
        limit: z.number().int().min(1).max(50).default(20).describe('Maximum number of messages to return'),
      },
      async (_args: { limit?: number }) => {
        const requestId = `klapp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

        writeIpcFile(TASKS_DIR, {
          type: 'klapp_read_messages',
          requestId,
          groupFolder,
          timestamp: new Date().toISOString(),
        });

        const result = await waitForResult(requestId);

        if (!result.success) {
          return {
            content: [{ type: 'text', text: `Klapp error: ${result.message}` }],
            isError: true,
          };
        }

        const messages = result.messages ?? [];
        if (messages.length === 0) {
          return { content: [{ type: 'text', text: 'No messages found in Klapp inbox.' }] };
        }

        const formatted = messages
          .map((m: unknown, i: number) => {
            const msg = m as { sender?: string; subject?: string; preview?: string; date?: string; isRead?: boolean };
            return `[${i + 1}] From: ${msg.sender || '?'}\n    Subject: ${msg.subject || '?'}\n    ${msg.preview || ''}\n    ${msg.date ? new Date(msg.date).toLocaleString() : ''}`;
          })
          .join('\n\n');

        return {
          content: [{ type: 'text', text: `Klapp messages (${messages.length}):\n\n${formatted}` }],
        };
      },
    ),
  ];
}
