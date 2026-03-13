/**
 * Klapp Integration - Host-side IPC Handler
 *
 * Handles klapp_* IPC messages from container agents.
 * Spawns read-messages.ts as a subprocess and writes results back.
 */

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import pino from 'pino';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: { target: 'pino-pretty', options: { colorize: true } },
});

interface SkillResult {
  success: boolean;
  message: string;
  messages?: unknown[];
}

async function runScript(script: string, args: object = {}): Promise<SkillResult> {
  const scriptPath = path.join(process.cwd(), '.claude', 'skills', 'klapp', 'scripts', `${script}.ts`);

  return new Promise((resolve) => {
    const proc = spawn('npx', ['tsx', scriptPath], {
      cwd: process.cwd(),
      env: { ...process.env, NANOCLAW_ROOT: process.cwd() },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.stdin.write(JSON.stringify(args));
    proc.stdin.end();

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      resolve({ success: false, message: 'Klapp script timed out (120s)' });
    }, 120_000);

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (stderr) logger.debug({ script, stderr: stderr.slice(0, 500) }, 'Klapp script stderr');
      try {
        const lines = stdout.trim().split('\n');
        const result = JSON.parse(lines[lines.length - 1]);
        resolve(result);
      } catch {
        if (code !== 0) {
          resolve({ success: false, message: `Klapp script exited ${code}. ${stderr.slice(0, 300)}` });
        } else {
          resolve({ success: false, message: `Failed to parse output: ${stdout.slice(0, 200)}` });
        }
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({ success: false, message: `Failed to spawn klapp script: ${err.message}` });
    });
  });
}

function writeResult(dataDir: string, sourceGroup: string, requestId: string, result: SkillResult): void {
  const dir = path.join(dataDir, 'ipc', sourceGroup, 'klapp_results');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${requestId}.json`), JSON.stringify(result));
}

/**
 * Handle klapp_* IPC messages.
 * @returns true if the message was handled, false otherwise.
 */
export async function handleKlappIpc(
  data: Record<string, unknown>,
  sourceGroup: string,
  _isMain: boolean,
  dataDir: string,
): Promise<boolean> {
  const type = data.type as string;
  if (!type?.startsWith('klapp_')) return false;

  const requestId = data.requestId as string;
  if (!requestId) {
    logger.warn({ type }, 'Klapp IPC blocked: missing requestId');
    return true;
  }

  logger.info({ type, requestId, sourceGroup }, 'Processing Klapp request');

  let result: SkillResult;

  switch (type) {
    case 'klapp_read_messages':
      result = await runScript('read-messages');
      break;

    default:
      return false;
  }

  writeResult(dataDir, sourceGroup, requestId, result);

  if (result.success) {
    logger.info({ type, requestId }, 'Klapp request completed');
  } else {
    logger.error({ type, requestId, message: result.message }, 'Klapp request failed');
  }

  return true;
}
