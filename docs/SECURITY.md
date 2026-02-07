# NanoClaw Security Model

## Trust Model

| Entity | Trust Level | Rationale |
|--------|-------------|-----------|
| Main group | Trusted | Private self-chat, admin control |
| Non-main groups | Untrusted | Other users may be malicious |
| Host process | Trusted | Runs under user's privileges |
| WhatsApp messages | User input | Potential prompt injection |

## Security Boundaries

### 1. Process Isolation (Primary Boundary)

Agents execute as isolated Node.js processes, providing:
- **Process isolation** - Each agent runs in its own Node.js process
- **Working directory isolation** - Agents run in their group's folder (groups/{name}/)
- **Session isolation** - Each group maintains separate conversation context
- **Filesystem access control** - Only configured paths are accessible

This is the primary security boundary. Agents are limited to:
- Their group's working directory
- Read-only access to global memory (non-main groups)
- Additional mounts as explicitly configured
- MCP servers (for web access, browser automation, etc.)

### 2. Filesystem Access Control

**Accessible Paths:**
- Group folder: `groups/{group-name}/` (read-write)
- Global memory: `groups/global/CLAUDE.md` (read-only for non-main)
- Configured additional mounts (subject to restrictions below)

**Never Accessible:**
- `.env` file (credentials are passed via environment, not as file)
- Project root (except for main group)
- System directories
- Other groups' folders

**Blocked Patterns** (future implementation):
```
.ssh, .gnupg, .aws, .azure, .gcloud, .kube, .docker,
credentials, .env, .netrc, .npmrc, id_rsa, id_ed25519,
private_key, .secret
```

### 3. Session Isolation

Each group has isolated Claude sessions at `data/sessions/{group}/`:
- Groups cannot see other groups' conversation history
- Session data includes full message history and context
- Prevents cross-group information disclosure
- Sessions persist in SQLite database (encrypted at rest recommended for production)

### 4. IPC Authorization

Messages and task operations are verified against group identity:

| Operation | Main Group | Non-Main Group |
|-----------|------------|----------------|
| Send message to own chat | ✓ | ✓ |
| Send message to other chats | ✓ | ✗ |
| Schedule task for self | ✓ | ✓ |
| Schedule task for others | ✓ | ✗ |
| View all tasks | ✓ | Own only |
| Manage other groups | ✓ | ✗ |

### 5. Credential Handling

**Environment Variables Passed to Agents:**
- `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` - Required for Claude API access
- Custom variables from `.env` (if configured)

**NOT Accessible:**
- WhatsApp session (`store/auth/`) - Host only
- Other sensitive `.env` variables - filtered
- Credentials matching blocked patterns

**Credential Filtering:**
Only explicitly allowed environment variables are passed to agents. Other sensitive variables are filtered out at invocation time.

> **Note:** API credentials are passed to agents so they can authenticate with Claude Code. This means agents can theoretically discover these credentials. For production use, consider:
> - Limiting agent capabilities (remove Bash if not needed)
> - Using per-group credentials if integrations require authentication
> - Implementing credential rotation policies
> - Monitoring credential access via logs

## Privilege Comparison

| Capability | Main Group | Non-Main Group |
|------------|------------|----------------|
| Project root access | Full (can modify code) | None |
| Group folder | Read-write | Read-write |
| Global memory | Read-write | Read-only |
| Other groups' folders | Read-only (optional) | None |
| Additional mounts | Configurable | Restricted |
| Network access | Unrestricted | Unrestricted |
| Bash access | Enabled | Enabled |
| MCP tools | All | All |

## Security Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                        UNTRUSTED ZONE                             │
│  WhatsApp Messages (potentially malicious)                        │
└────────────────────────────────┬─────────────────────────────────┘
                                 │
                                 ▼ Validation, trigger check
┌──────────────────────────────────────────────────────────────────┐
│                    Host Process (Trusted)                         │
│  Message Router → Determines Group → Spawns Agent Process        │
└─────────────────────────┬──────────────────────────────────────────┘
                          │
                          ▼ Isolated process per group
┌──────────────────────────────────────────────────────────────────┐
│         Agent Process (Sandbox via Process Isolation)            │
│  Working Directory: groups/{group-name}/                         │
│  Accessible: group folder + configured mounts + MCP servers      │
└──────────────────────────────────────────────────────────────────┘
```

### Defense in Depth

1. **Input Validation** - Trigger pattern check on incoming messages
2. **Process Isolation** - Each agent runs in its own process with separate context
3. **Filesystem Access Control** - Only configured paths are accessible
4. **Session Isolation** - Groups cannot access other groups' data
5. **IPC Authorization** - Operations checked against group identity
6. **Resource Limits** (optional) - Can limit CPU/memory per agent

## Prompt Injection Risks

### Attack Vector

An untrusted group could craft messages to manipulate the agent into:
- Executing unintended commands via Bash
- Reading/modifying files in other groups (if misconfigured)
- Accessing credentials (if mounted as files instead of env vars)
- Scheduling tasks to other groups (if authorization is bypassed)

### Mitigations

1. **Explicit Authorization** - Task operations require explicit tools
2. **Filesystem Isolation** - Groups cannot access each other's folders
3. **Trigger Pattern** - Only messages starting with trigger word are processed
4. **Env-Based Credentials** - Credentials passed as environment variables, not files
5. **Clear Separation** - Non-main groups have limited privileges by default

## Recommended Practices

### For Users

1. **Be cautious with additional mounts** - Only mount directories you trust with that group
2. **Use group isolation** - Keep high-trust and low-trust chats separate
3. **Monitor agent usage** - Check logs for unexpected Bash commands or file access
4. **Limit main group access** - Keep the main channel (self-chat) truly private
5. **Regular backups** - Protect important files from accidental modifications

### For Operators

1. **Restrict Bash** - Consider disabling Bash tool for untrusted groups (via CLAUDE.md)
2. **Audit logs** - Review logs for suspicious activity
3. **Credential rotation** - Periodically rotate API keys
4. **Database encryption** - Encrypt the SQLite database at rest
5. **Network segmentation** - Limit agent network access if possible (via firewall)

## Known Limitations

1. **No OS-level isolation** - Agents run on host with user's privileges
2. **Bash access is powerful** - Agents can execute arbitrary commands within working directory
3. **Env var disclosure** - Agents can access all environment variables
4. **File permissions** - Agents inherit user's file permissions
5. **Network access** - No built-in network restrictions

## Future Improvements

- Per-group mount configuration (currently global)
- Credential isolation per group
- Resource limits (CPU, memory, network)
- Audit logging for all agent actions
- Sandboxing via containers (optional, for high-security deployments)
- Rate limiting on tool usage

## Comparison: Host vs Container Mode

| Aspect | Host Mode | Container Mode (Previous) |
|--------|-----------|--------------------------|
| Isolation Level | Process/filesystem | OS-level |
| Performance | Fast (no VM overhead) | Slower (VM startup) |
| Security | Process-based | Strong (OS isolation) |
| Setup Complexity | Simple | Complex (requires container runtime) |
| Cross-platform | Yes (Linux/macOS) | macOS only (Apple Container) |
| Development | Easier (no build step) | Complex (container builds) |

**Trade-off:** Host mode prioritizes simplicity and performance, while accepting slightly lower isolation guarantees. Use container mode if you need strong OS-level security with untrusted code.
