---
name: debug
description: Debug agent issues. Use when things aren't working, agent fails, authentication problems, or to understand how the agent system works. Covers logs, environment variables, IPC, and common issues.
---

# NanoClaw Agent Debugging

This guide covers debugging the agent execution system running directly on the host machine.

## Architecture Overview

```
Host Process
─────────────────────────────────────────────────────
src/index.ts                       src/agent/runner.ts
    │                                      │
    │ routes WhatsApp messages             │ runs Claude Agent SDK
    │ manages group queues                 │ with MCP servers
    │                                      │
    ├── groups/{folder}/              Working directory for agent
    ├── data/ipc/{folder}/            Inter-process communication
    └── store/messages.db             Message history & state
```

**Important:** Each group has its own isolated agent session and working directory. Sessions persist in the SQLite database.

## Log Locations

| Log | Location | Content |
|-----|----------|---------|
| **Main app logs** | `logs/nanoclaw.log` | WhatsApp connection, routing, agent invocation |
| **Main app errors** | `logs/nanoclaw.error.log` | Host-side errors |
| **Agent logs** | Inline in main logs | Agent SDK output, tool usage |
| **Claude sessions** | SQLite database | Session IDs and conversation history |

## Enabling Debug Logging

Set `LOG_LEVEL=debug` for verbose output:

```bash
# For development
LOG_LEVEL=debug bun run dev

# For service (update service config to add LOG_LEVEL=debug)
```

Debug level shows:
- Full agent configuration
- Session management details
- Real-time agent execution

## Common Issues

### 1. "Agent execution failed"

**Check the main log file** in `logs/nanoclaw.log`

Common causes:

#### Missing Authentication
```
Invalid API key · Please run /login
```
**Fix:** Ensure `.env` file exists with either OAuth token or API key:
```bash
cat .env  # Should show one of:
# CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...  (subscription)
# ANTHROPIC_API_KEY=sk-ant-api03-...        (pay-per-use)
```

#### Invalid API Key Format
```
Authentication error
```
**Fix:** Verify your API key format and that it's not expired:
```bash
# Check first/last characters
grep "ANTHROPIC_API_KEY" .env
grep "CLAUDE_CODE_OAUTH_TOKEN" .env
```

### 2. Environment Variables Not Working

Environment variables are loaded from `.env` at startup.

To verify env vars are configured:
```bash
cat .env
```

Key variables:
- `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` - Required for Claude API access
- `LOG_LEVEL` - Set to `debug` for verbose logging
- `ANTHROPIC_BASE_URL` - Optional, for proxying requests

### 3. Agent Not Responding to Messages

**Check trigger pattern:**
- Group chats: Messages must start with trigger word (default: `@Andy`)
- Main channel: No prefix needed (all messages processed)
- Solo chats with `requiresTrigger: false`: No prefix needed

**Verify group is registered:**
```bash
sqlite3 store/messages.db "SELECT jid, name, folder, trigger_pattern, requires_trigger FROM registered_groups"
```

**Check recent logs:**
```bash
tail -f logs/nanoclaw.log
```

Look for:
- Message received events
- Trigger pattern matches
- Agent execution starts

### 4. Session Issues

Sessions are managed per-group in the SQLite database.

**Check sessions:**
```bash
sqlite3 store/messages.db "SELECT * FROM sessions"
```

**Clear sessions for a group:**
```bash
sqlite3 store/messages.db "DELETE FROM sessions WHERE group_folder = 'main'"
```

**Clear all sessions:**
```bash
sqlite3 store/messages.db "DELETE FROM sessions"
```

To verify session continuity, check logs for the same session ID across messages:
```bash
grep "Session" logs/nanoclaw.log | tail -10
```

### 5. Permission Issues

The agent runs as the same user as the NanoClaw process.

**Check working directory permissions:**
```bash
ls -la groups/*/
```

All group directories should be writable by the current user.

### 6. MCP Server Failures

If an MCP server fails to start, the agent may exit. Check the logs for MCP initialization errors.

**Check MCP configuration:**
```bash
cat .mcp.json
```

**Test MCP servers manually:**
Use the Claude Code CLI to test if MCP servers are working:
```bash
claude -p "test MCP" --dangerously-skip-permissions
```

## IPC Debugging

The agent communicates back to the host via files in `data/ipc/`:

```bash
# Check pending messages
ls -la data/ipc/messages/

# Check pending task operations
ls -la data/ipc/tasks/

# Read a specific IPC file
cat data/ipc/messages/*.json

# Check available groups (main channel only)
cat data/ipc/main/available_groups.json

# Check current tasks snapshot
cat data/ipc/{groupFolder}/current_tasks.json
```

**IPC file types:**
- `messages/*.json` - Agent writes: outgoing WhatsApp messages
- `tasks/*.json` - Agent writes: task operations (schedule, pause, resume, cancel, refresh_groups)
- `current_tasks.json` - Host writes: read-only snapshot of scheduled tasks
- `available_groups.json` - Host writes: read-only list of WhatsApp groups (main only)

## Database Debugging

The SQLite database stores all state:

```bash
# Check registered groups
sqlite3 store/messages.db "SELECT * FROM registered_groups"

# Check scheduled tasks
sqlite3 store/messages.db "SELECT id, group_folder, prompt, status, next_run FROM scheduled_tasks"

# Check recent messages
sqlite3 store/messages.db "SELECT timestamp, chat_jid, sender_name, content FROM messages ORDER BY timestamp DESC LIMIT 20"

# Check task run history
sqlite3 store/messages.db "SELECT task_id, run_at, status, error FROM task_run_logs ORDER BY run_at DESC LIMIT 10"
```

## Rebuilding After Changes

```bash
# Rebuild TypeScript
bun run build

# Restart the service (if using nohup)
pkill -f "node dist/index.js"
nohup bun start > logs/nanoclaw.log 2>&1 &

# Or if using systemd/launchd
# systemctl restart nanoclaw
# launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

## Quick Diagnostic Script

Run this to check common issues:

```bash
echo "=== Checking NanoClaw Setup ==="

echo -e "\n1. Authentication configured?"
[ -f .env ] && (grep -q "CLAUDE_CODE_OAUTH_TOKEN=sk-" .env || grep -q "ANTHROPIC_API_KEY=sk-" .env) && echo "✓ OK" || echo "✗ MISSING - add CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY to .env"

echo -e "\n2. Groups directory?"
ls -la groups/ 2>/dev/null && echo "✓ OK" || echo "✗ MISSING - run setup"

echo -e "\n3. Database exists?"
[ -f store/messages.db ] && echo "✓ OK" || echo "✗ MISSING - will be created on first run"

echo -e "\n4. Main channel registered?"
sqlite3 store/messages.db "SELECT COUNT(*) FROM registered_groups WHERE folder = 'main'" 2>/dev/null | grep -q "1" && echo "✓ OK" || echo "✗ MISSING - run setup"

echo -e "\n5. Recent logs?"
[ -f logs/nanoclaw.log ] && echo "✓ OK - Last 5 lines:" && tail -5 logs/nanoclaw.log || echo "✗ No logs yet"

echo -e "\n6. Process running?"
pgrep -f "dist/index.js" >/dev/null && echo "✓ OK - PID: $(pgrep -f 'dist/index.js')" || echo "✗ Not running"

echo -e "\n7. Recent errors?"
[ -f logs/nanoclaw.error.log ] && [ -s logs/nanoclaw.error.log ] && echo "⚠ CHECK - errors found:" && tail -5 logs/nanoclaw.error.log || echo "✓ No recent errors"
```

## Agent SDK Options

The agent runner uses these Claude Agent SDK options:

```typescript
query({
  prompt: input.prompt,
  options: {
    cwd: workspaceDir,  // groups/{folder}
    allowedTools: ['Bash', 'Read', 'Write', 'Edit', ...],
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    settingSources: ['project'],
    mcpServers: { ... }
  }
})
```

**Important:** `allowDangerouslySkipPermissions: true` is required when using `permissionMode: 'bypassPermissions'`.

## Troubleshooting WhatsApp Connection

**QR code not displaying:**
- Run `bun run auth` in the foreground (not as a background process)
- The QR code is multi-line ASCII art that needs a full terminal window

**"Already authenticated" but not connecting:**
- Check if auth files exist: `ls -la store/auth/`
- Try clearing auth and re-authenticating:
  ```bash
  rm -rf store/auth
  bun run auth
  ```

**Connection keeps dropping:**
- Check logs for disconnection reasons
- WhatsApp may require re-authentication periodically
- Ensure stable internet connection

## Performance Issues

**Agent responses slow:**
- Check if multiple agents are running simultaneously (queue congestion)
- Review `groups/{folder}/CLAUDE.md` for overly complex instructions
- Check network latency to Anthropic API

**High memory usage:**
- Clear old sessions: `sqlite3 store/messages.db "DELETE FROM sessions WHERE group_folder NOT IN (SELECT folder FROM registered_groups)"`
- Truncate old messages: `sqlite3 store/messages.db "DELETE FROM messages WHERE timestamp < date('now', '-30 days')"`

**Disk space:**
```bash
# Check database size
ls -lh store/messages.db

# Check log sizes
du -h logs/

# Rotate logs if needed
mv logs/nanoclaw.log logs/nanoclaw.log.old
mv logs/nanoclaw.error.log logs/nanoclaw.error.log.old
```
