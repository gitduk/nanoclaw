---
name: x-integration
description: X (Twitter) integration for NanoClaw. Post tweets, like, reply, retweet, and quote. Use for setup, testing, or troubleshooting X functionality. Triggers on "setup x", "x integration", "twitter", "post tweet", "tweet".
---

# X (Twitter) Integration

Browser automation for X interactions via WhatsApp.

> **Compatibility:** NanoClaw v1.0.0 (host-based). Directory structure may change in future versions.

## Features

| Action | Tool | Description |
|--------|------|-------------|
| Post | `x_post` | Publish new tweets |
| Like | `x_like` | Like any tweet |
| Reply | `x_reply` | Reply to tweets |
| Retweet | `x_retweet` | Retweet without comment |
| Quote | `x_quote` | Quote tweet with comment |

## Prerequisites

Before using this skill, ensure:

1. **NanoClaw is installed and running** - WhatsApp connected, service active
2. **Dependencies installed**:
   ```bash
   bun add playwright dotenv-cli
   ```
3. **CHROME_PATH configured** in `.env` (if Chrome is not at default location):
   ```bash
   # Find your Chrome path
   which google-chrome || which chromium-browser || echo "Chrome not found"
   # Add to .env if needed
   CHROME_PATH=/path/to/google-chrome
   ```

## Quick Start

```bash
# 1. Setup authentication (interactive)
bun .claude/skills/x-integration/scripts/setup.ts
# Verify: data/x-auth.json should exist after successful login

# 2. Rebuild host and restart service
bun run build
pkill -f "dist/index.js"
nohup bun start > logs/nanoclaw.log 2>&1 &

# 3. Verify service is running
sleep 3
pgrep -f "dist/index.js" && echo "Service running" || echo "Service failed"
```

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CHROME_PATH` | `/usr/bin/google-chrome` (Linux) or `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` (macOS) | Chrome executable path |
| `NANOCLAW_ROOT` | `process.cwd()` | Project root directory |
| `LOG_LEVEL` | `info` | Logging level (debug, info, warn, error) |

Set in `.env` file:

```bash
# .env
CHROME_PATH=/path/to/google-chrome
LOG_LEVEL=debug
```

### Configuration File

Edit `.claude/skills/x-integration/lib/config.ts` to modify defaults:

```typescript
export const config = {
    // Browser viewport
    viewport: { width: 1280, height: 800 },

    // Timeouts (milliseconds)
    timeouts: {
        navigation: 30000,    // Page navigation
        elementWait: 5000,    // Wait for element
        afterClick: 1000,     // Delay after click
        afterFill: 1000,      // Delay after form fill
        afterSubmit: 3000,    // Delay after submit
        pageLoad: 3000,       // Initial page load
    },

    // Tweet limits
    limits: {
        tweetMaxLength: 280,
    },
};
```

### Data Directories

Paths relative to project root:

| Path | Purpose | Git |
|------|---------|-----|
| `data/x-browser-profile/` | Chrome profile with X session | Ignored |
| `data/x-auth.json` | Auth state marker | Ignored |
| `logs/nanoclaw.log` | Service logs (contains X operation logs) | Ignored |

## Architecture

```
Host Process
─────────────────────────────────────────────────────
src/index.ts                       src/agent/runner.ts
    │                                      │
    │ routes WhatsApp messages             │ runs Claude Agent SDK
    │ manages IPC for X tasks              │ with MCP servers
    │                                      │
    └── processTaskIpc()
        └── .claude/skills/x-integration/host.ts
            └── spawn subprocess → scripts/*.ts
                └── Playwright → Chrome → X Website
```

### Why This Design?

- **API is expensive** - X official API requires paid subscription ($100+/month) for posting
- **Bot browsers get blocked** - X detects and bans headless browsers and common automation fingerprints
- **Must use user's real browser** - Uses the user's actual Chrome on host with real browser fingerprint to avoid detection
- **One-time authorization** - User logs in manually once, session persists in Chrome profile for future use

### File Structure

```
.claude/skills/x-integration/
├── SKILL.md          # This documentation
├── host.ts           # Host-side IPC handler
├── agent.ts          # MCP tool definitions
├── lib/
│   ├── config.ts     # Centralized configuration
│   └── browser.ts    # Playwright utilities
└── scripts/
    ├── setup.ts      # Interactive login
    ├── post.ts       # Post tweet
    ├── like.ts       # Like tweet
    ├── reply.ts      # Reply to tweet
    ├── retweet.ts    # Retweet
    └── quote.ts      # Quote tweet
```

## Setup Instructions

### 1. Install Dependencies

```bash
bun add playwright dotenv-cli
```

### 2. Configure Chrome Path (if needed)

Find your Chrome installation:

```bash
# macOS
which "Google Chrome" || mdfind "kMDItemCFBundleIdentifier == 'com.google.Chrome'" | head -1

# Linux
which google-chrome || which chromium-browser

# Windows (WSL)
which google-chrome || which chromium
```

Add to `.env`:

```bash
CHROME_PATH=/path/to/google-chrome
```

### 3. Setup X Authentication

Run the interactive setup script:

```bash
bun .claude/skills/x-integration/scripts/setup.ts
```

This will:
1. Open a Chromium browser
2. Navigate to X.com
3. Prompt you to log in manually
4. Save your session to `data/x-browser-profile/`
5. Create `data/x-auth.json` marker file

### 4. Register X Operations with Agent

Add X tool usage to `groups/main/CLAUDE.md`:

```markdown
## X (Twitter) Integration

You can post, like, reply, retweet, and quote on X. Available operations:

- `x_post: {tweet_text}` - Post a new tweet
- `x_like: {tweet_url}` - Like a tweet
- `x_reply: {tweet_url, reply_text}` - Reply to a tweet
- `x_retweet: {tweet_url}` - Retweet without comment
- `x_quote: {tweet_url, quote_text}` - Quote tweet with comment

**Examples:**
- "Post this to X: Check out NanoClaw!"
- "Like this tweet: [URL]"
- "Reply to [URL] saying 'Great work!'"

Operations are performed through the user's real X account with proper browser simulation.
```

### 5. Rebuild and Restart

```bash
bun run build
pkill -f "dist/index.js"
nohup bun start > logs/nanoclaw.log 2>&1 &
sleep 3
pgrep -f "dist/index.js"
```

## Usage Examples

From WhatsApp, users can ask:

```
@YourAssistant post this to X: "Just launched NanoClaw! Check it out."

@YourAssistant like this tweet: https://x.com/user/status/1234567890

@YourAssistant reply to https://x.com/user/status/1234567890 saying "Thanks for sharing!"

@YourAssistant retweet https://x.com/user/status/1234567890

@YourAssistant quote tweet https://x.com/user/status/1234567890 with "This is great because..."
```

## Troubleshooting

### Authentication Issues

**Setup script hangs or doesn't open browser:**

```bash
# Check if Chrome path is correct
$CHROME_PATH --version

# Try with explicit path
CHROME_PATH=/path/to/chrome bun .claude/skills/x-integration/scripts/setup.ts
```

**Sessions expire or login required repeatedly:**

```bash
# Check browser profile exists
ls -la data/x-browser-profile/

# Clear old profile if corrupted
rm -rf data/x-browser-profile/
rm -f data/x-auth.json

# Re-run setup
bun .claude/skills/x-integration/scripts/setup.ts
```

### Operation Failures

**"X operation timed out":**

```bash
# Check Chrome is running properly
ps aux | grep chrome

# Increase timeouts in lib/config.ts
# Check X website is responsive
curl -I https://x.com
```

**"Element not found" errors:**

```bash
# Check X website still has same selectors (they change periodically)
# Check logs for more details
tail -50 logs/nanoclaw.log | grep -i "x_\|twitter\|error"
```

**Chrome crashes or process exits:**

```bash
# Check for errors in logs
grep -i "crash\|error" logs/nanoclaw.log

# Try reinstalling Playwright
bun remove playwright
bun add playwright
```

### Debugging

Enable verbose logging:

```bash
# Set LOG_LEVEL in .env
echo "LOG_LEVEL=debug" >> .env

# Restart service
pkill -f "dist/index.js"
nohup bun start > logs/nanoclaw.log 2>&1 &

# Watch logs
tail -f logs/nanoclaw.log
```

Check X operations directly:

```bash
# Test posting (requires auth setup)
bun .claude/skills/x-integration/scripts/post.ts "Test tweet"

# View recent operations in logs
grep "x_post\|x_like\|x_reply" logs/nanoclaw.log | tail -20
```

## Performance Considerations

- **Browser startup time:** ~3-5 seconds per operation (first operation may be slower)
- **Network delays:** X rate-limiting may cause operations to queue
- **Session freshness:** Browser profile is reused; session persists across service restarts

Optimize by:
- Batching multiple operations into single X interaction when possible
- Using scheduler for bulk operations over time
- Reducing LOG_LEVEL to `warn` in production

## Limitations

- **Rate limiting:** X applies rate limits to all actions; bulk operations may fail
- **Captchas:** Complex interactions may require manual intervention
- **API changes:** X changes selectors and DOM structure periodically; scripts may break
- **Account safety:** Using automation carries risk of temporary restrictions; use responsibly

## Removing X Integration

To remove X integration:

1. Uninstall packages: `bun remove playwright dotenv-cli`
2. Remove X section from `groups/main/CLAUDE.md`
3. Keep browser profile for future reuse:
   ```bash
   # Optional: Remove everything
   rm -rf data/x-browser-profile/ data/x-auth.json
   ```
4. Rebuild: `bun run build`
5. Restart: `pkill -f "dist/index.js" && nohup bun start > logs/nanoclaw.log 2>&1 &`

## Support

For issues, check:
- `.claude/skills/x-integration/lib/browser.ts` - Browser automation logic
- `.claude/skills/x-integration/scripts/` - Individual operation scripts
- `logs/nanoclaw.log` - Service logs with X operation details
