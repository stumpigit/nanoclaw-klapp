#!/usr/bin/env npx tsx
/**
 * Klapp - Read Messages Script
 *
 * Logs into klapp.mobi using Playwright, intercepts the REST API response
 * for messages (GET /v4/messages/parent), then fetches full content for each
 * message via GET /v4/messages/parent/{id}.
 *
 * Output: last line of stdout is the JSON result.
 */

import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import type { Page } from 'playwright';

const ROOT = process.env.NANOCLAW_ROOT || process.cwd();
const PROFILE_DIR = path.join(ROOT, 'data', 'klapp-browser-profile');
const SCREENSHOTS_DIR = path.join(ROOT, 'data', 'klapp-screenshots');
const APP_URL = 'https://klapp.mobi';
const API_BASE = 'https://api.klapp.mobi';
const MESSAGES_API_PATH = '/v4/messages/parent';

export interface KlappMessage {
  id: string;
  sender: string;
  subject: string;
  preview: string;
  content: string;
  date: string;
  isRead: boolean;
  hasFiles: boolean;
}

interface ScriptResult {
  success: boolean;
  messages?: KlappMessage[];
  message: string;
}

function loadCredentials(): { username: string; password: string } {
  const p = path.join(ROOT, 'groups', 'global', 'secrets.env');
  const env: Record<string, string> = {};
  for (const line of fs.readFileSync(p, 'utf-8').split('\n')) {
    const t = line.trim();
    if (t && !t.startsWith('#')) {
      const eq = t.indexOf('=');
      if (eq > 0) env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
    }
  }
  const { KLAPP_USERNAME: username, KLAPP_PASSWORD: password } = env;
  if (!username || !password) throw new Error('KLAPP_USERNAME or KLAPP_PASSWORD not found in groups/global/secrets.env');
  return { username, password };
}

async function screenshot(page: Page, name: string): Promise<void> {
  try {
    fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, `${name}.png`) });
  } catch { /* ignore */ }
}

async function onLoginPage(page: Page): Promise<boolean> {
  return await page.locator('input[type="password"]').count().then(c => c > 0).catch(() => false);
}

/**
 * Set a Flutter web input value by activating its editing session first.
 */
async function setFlutterInputValue(page: Page, selector: string, value: string): Promise<void> {
  const input = page.locator(selector).first();
  const box = await input.boundingBox();
  if (!box) throw new Error(`Input not found: ${selector}`);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(600);
  await input.evaluate((el, val) => {
    const input = el as HTMLInputElement;
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    nativeSetter?.call(input, val);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
  await page.waitForTimeout(300);
}

async function login(page: Page, username: string, password: string): Promise<void> {
  await screenshot(page, '01-login-page');
  await setFlutterInputValue(page, 'input[type="text"]', username);
  await setFlutterInputValue(page, 'input[type="password"]', password);
  await screenshot(page, '02-filled');
  const anmeldenBtn = page.locator('flt-semantics[role="button"]').filter({ hasText: /anmelden/i }).first();
  await anmeldenBtn.evaluate(el => (el as HTMLElement).click());
  await page.waitForTimeout(7000);
  await screenshot(page, '03-after-login');
}

function parseMessages(raw: unknown[], limit: number): KlappMessage[] {
  return raw.slice(0, limit).map(m => {
    const msg = m as Record<string, unknown>;
    const fromUser = (msg['from_user'] ?? {}) as Record<string, string>;
    const sender = [fromUser['first_name'], fromUser['last_name']].filter(Boolean).join(' ');
    const createdAt = (msg['created_at'] ?? msg['updated_at'] ?? msg['sent_at'] ?? '') as string;
    const date = createdAt ? new Date(createdAt).toLocaleDateString('de-CH', { day: 'numeric', month: 'long', year: 'numeric' }) : '';
    const rawContent = msg['content'] ?? msg['body'] ?? msg['text'] ?? msg['html_body'] ?? msg['plain_body'] ?? '';
    return {
      id: String(msg['id'] ?? ''),
      sender,
      subject: String(msg['subject'] ?? ''),
      preview: String(msg['preview'] ?? msg['content_preview'] ?? ''),
      content: String(rawContent),
      date,
      isRead: !(msg['has_badge'] ?? false),
      hasFiles: !!(msg['has_files'] ?? false),
    };
  });
}

function extractContent(detail: Record<string, unknown>): string {
  const raw = detail['content'] ?? detail['body'] ?? detail['text'] ??
    detail['html_body'] ?? detail['plain_body'] ?? detail['body_text'] ??
    detail['message'] ?? '';
  // Strip basic HTML tags if present
  return String(raw).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

async function fetchMessageContent(
  page: Page,
  messageId: string,
  authHeaders: Record<string, string>,
): Promise<string> {
  // Detail endpoint: /v4/messages/{id}/parent — body is in replies[0].body
  const url = `${API_BASE}/v4/messages/${messageId}/parent?include_drafts=true`;
  try {
    const response = await page.request.get(url, { headers: authHeaders });
    if (!response.ok()) return '';
    const data = await response.json() as Record<string, unknown>;
    const replies = data.replies as Record<string, unknown>[] | undefined;
    if (replies && replies.length > 0) {
      return extractContent(replies[0]);
    }
  } catch { /* ignore */ }
  return '';
}

async function run(): Promise<ScriptResult> {
  const { username, password } = loadCredentials();
  fs.mkdirSync(PROFILE_DIR, { recursive: true });

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: true,
    args: ['--ignore-certificate-errors', '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  try {
    const page = context.pages()[0] ?? await context.newPage();
    await page.setViewportSize({ width: 1280, height: 720 });

    // Capture auth headers from any klapp API request
    const authHeaders: Record<string, string> = {};
    context.on('request', (req) => {
      if (req.url().includes('api.klapp.mobi')) {
        const h = req.headers();
        // Capture all API request headers so per-message fetches include app-specific headers
        // (app-model, user-role, app-version, etc.) that the server requires
        for (const [key, value] of Object.entries(h)) {
          authHeaders[key] = value;
        }
      }
    });

    // Set up response interception for the messages list
    let messagesPromise: Promise<KlappMessage[]> | null = null;
    context.on('response', async (response) => {
      if (response.url().includes('api.klapp.mobi') && response.url().includes(MESSAGES_API_PATH) && !response.url().includes('/badge/') && !response.url().match(/\/parent\/[^/]+$/)) {
        if (!messagesPromise) {
          messagesPromise = response.json().then(data => parseMessages(Array.isArray(data) ? data : [], 20)).catch(() => []);
        }
      }
    });

    await page.goto(APP_URL, { waitUntil: 'networkidle', timeout: 30000 });

    await page.waitForFunction(
      () => document.querySelector('input') !== null || document.querySelectorAll('*').length > 200,
      { timeout: 20000 },
    ).catch(() => null);
    await page.waitForTimeout(1500);

    if (await onLoginPage(page)) {
      await login(page, username, password);
      if (await onLoginPage(page)) {
        await screenshot(page, 'login-failed');
        return { success: false, message: 'Login failed — still on login page. Check credentials or data/klapp-screenshots/ for debug info.' };
      }
      await page.waitForTimeout(4000);
    }

    // Wait for messages list response
    const messages = await Promise.race([
      messagesPromise ?? Promise.resolve([]),
      new Promise<KlappMessage[]>(resolve => setTimeout(() => resolve([]), 10000)),
    ]);

    if (messages.length === 0) {
      return { success: false, message: 'No messages received from API. Try again or check data/klapp-screenshots/.' };
    }

    // Fetch full content for each message
    // Use captured auth headers if available; cookies are always included via credentials:'include'
    for (const msg of messages) {
      if (!msg.content) {
        msg.content = await fetchMessageContent(page, msg.id, authHeaders);
      }
    }

    return { success: true, messages, message: `Found ${messages.length} messages` };
  } finally {
    await context.close();
  }
}

run()
  .then(result => console.log(JSON.stringify(result)))
  .catch(err => {
    console.log(JSON.stringify({ success: false, message: String(err.message ?? err) }));
    process.exit(1);
  });
