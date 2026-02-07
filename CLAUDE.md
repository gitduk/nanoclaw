# NanoClaw

Personal Claude assistant. See [README.md](README.md) for philosophy and setup. See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) for architecture decisions.

## Quick Context

Single Node.js process that connects to WhatsApp, routes messages to Claude Agent SDK running **directly on the host machine** (no containers). Each group has isolated filesystem and memory.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Main app: WhatsApp connection, message routing, IPC |
| `src/config.ts` | Trigger pattern, paths, intervals |
| `src/agent-runner.ts` | Runs agents directly on host |
| `src/agent/runner.ts` | Agent execution logic using Claude Agent SDK |
| `src/agent/ipc-mcp.ts` | IPC-based MCP server for agent communication |
| `src/task-scheduler.ts` | Runs scheduled tasks |
| `src/db.ts` | SQLite operations |
| `groups/{name}/CLAUDE.md` | Per-group memory (isolated) |

## Skills

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time installation, authentication, service configuration |
| `/customize` | Adding channels, integrations, changing behavior |
| `/debug` | Agent issues, logs, troubleshooting |

## Development

Run commands directly—don't tell the user to run them.

```bash
bun run dev          # Run with hot reload
bun run build        # Compile TypeScript
```

Service management:
```bash
# Start service
nohup bun start > logs/nanoclaw.log 2>&1 &

# Stop service
pkill -f "node dist/index.js"

# View logs
tail -f logs/nanoclaw.log
```
