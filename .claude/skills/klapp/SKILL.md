---
name: klapp
description: Klapp (klapp.mobi) school communication integration. Read messages from the Klapp inbox. Triggers on "klapp", "check klapp", "klapp nachrichten", "klapp messages".
---

# Klapp Integration

Reads messages from [klapp.mobi](https://klapp.mobi) — a Flutter-based school communication platform.

## Architecture

```
Container (agent)
└── mcp__nanoclaw__klapp_read_messages
    └── writes IPC → data/ipc/{group}/tasks/
        ↓
Host (src/ipc.ts → handleKlappIpcInline)
└── spawns .claude/skills/klapp/scripts/read-messages.ts via npx tsx
    └── Playwright (headless Chromium) → klapp.mobi
        └── returns JSON → data/ipc/{group}/klapp_results/{requestId}.json
            ↓
Container polls result → returns formatted messages to user
```

## Credentials

Loaded automatically from `groups/global/secrets.env`:

```env
KLAPP_USERNAME=your@email.com
KLAPP_PASSWORD=yourpassword
```

## Browser Session

A persistent Chromium profile is stored in `data/klapp-browser-profile/` so the session is reused across calls (no repeated logins). Debug screenshots are saved to `data/klapp-screenshots/` if anything goes wrong.

## Usage (via WhatsApp / any channel)

```
@Andy check my klapp messages
@Andy Klapp Nachrichten lesen
@Andy any new messages in klapp?
```

## Files

| File | Purpose |
|------|---------|
| `scripts/read-messages.ts` | Playwright script: login + scrape inbox |
| `host.ts` | Reference copy of host-side IPC handler (actual code is inlined in `src/ipc.ts`) |
| `agent.ts` | Container-side MCP tool definitions (reference; actual tool is in `container/agent-runner/src/ipc-mcp-stdio.ts`) |

## Integration Points (already applied)

**`src/ipc.ts`** — `handleKlappIpcInline` + `runKlappScript` functions handle `klapp_read_messages` IPC type.

**`container/agent-runner/src/ipc-mcp-stdio.ts`** — `klapp_read_messages` MCP tool added.

**`package.json`** — `playwright` dependency added; Chromium downloaded to `~/.cache/ms-playwright/`.

## Troubleshooting

### Login fails / wrong elements clicked

Klapp is a Flutter CanvasKit app — the UI is rendered on canvas with a semantic overlay. Debug screenshots in `data/klapp-screenshots/` show what Playwright sees at each step.

To re-run the login script manually:
```bash
NANOCLAW_ROOT=$(pwd) npx tsx .claude/skills/klapp/scripts/read-messages.ts
```

### Selectors break after Klapp update

Edit the selector arrays in `scripts/read-messages.ts`:
- `userSelectors` — username field
- `passSelectors` / `allTextboxes.nth(1)` — password field
- `submitSelectors` — login button
- `navSelectors` — inbox navigation
- `itemSelectors` — message list items

Check `data/klapp-screenshots/` for the numbered screenshots to see what the page looks like at each step.

### Clear saved session

```bash
rm -rf data/klapp-browser-profile/
```

### Rebuild after changes

```bash
npm run build
systemctl --user restart nanoclaw
```
