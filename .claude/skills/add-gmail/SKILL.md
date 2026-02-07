---
name: add-gmail
description: Add Gmail integration to NanoClaw. Can be configured as a tool (agent reads/sends emails when triggered from WhatsApp) or as a full channel (emails can trigger the agent, schedule tasks, and receive replies). Guides through GCP OAuth setup and implements the integration.
---

# Add Gmail Integration

This skill adds Gmail capabilities to NanoClaw. It can be configured in two modes:

1. **Tool Mode** - Agent can read/send emails, but only when triggered from WhatsApp
2. **Channel Mode** - Emails can trigger the agent, schedule tasks, and receive email replies

## Initial Questions

Ask the user:

> How do you want to use Gmail with NanoClaw?
>
> **Option 1: Tool Mode**
> - Agent can read and send emails when you ask it to
> - Triggered only from WhatsApp (e.g., "@Andy check my email" or "@Andy send an email to...")
> - Simpler setup, no email polling
>
> **Option 2: Channel Mode**
> - Everything in Tool Mode, plus:
> - Emails to a specific address/label trigger the agent
> - Agent replies via email (not WhatsApp)
> - Can schedule tasks via email
> - Requires email polling infrastructure

Store their choice and proceed to the appropriate section.

---

## Prerequisites (Both Modes)

### 1. Check Existing Gmail Setup

First, check if Gmail is already configured:

```bash
ls -la ~/.gmail-mcp/ 2>/dev/null || echo "No Gmail config found"
```

If `credentials.json` exists, skip to "Verify Gmail Access" below.

### 2. Create Gmail Config Directory

```bash
mkdir -p ~/.gmail-mcp
```

### 3. GCP Project Setup

**USER ACTION REQUIRED**

Tell the user:

> I need you to set up Google Cloud OAuth credentials. I'll walk you through it:
>
> 1. Open https://console.cloud.google.com in your browser
> 2. Create a new project (or select existing) - click the project dropdown at the top

Wait for user confirmation, then continue:

> 3. Now enable the Gmail API:
>    - In the left sidebar, go to **APIs & Services → Library**
>    - Search for "Gmail API"
>    - Click on it, then click **Enable**

Wait for user confirmation, then continue:

> 4. Now create OAuth credentials:
>    - Go to **APIs & Services → Credentials** (in the left sidebar)
>    - Click **+ CREATE CREDENTIALS** at the top
>    - Select **OAuth client ID**
>    - If prompted for consent screen, choose "External", fill in app name (e.g., "NanoClaw"), your email, and save
>    - For Application type, select **Desktop app**
>    - Name it anything (e.g., "NanoClaw Gmail")
>    - Click **Create**

Wait for user confirmation, then continue:

> 5. Download the credentials:
>    - Click **DOWNLOAD JSON** on the popup (or find it in the credentials list and click the download icon)
>    - Save it as `gcp-oauth.keys.json`
>
> Where did you save the file? (Give me the full path, or just paste the file contents here)

If user provides a path, copy it:

```bash
cp "/path/user/provided/gcp-oauth.keys.json" ~/.gmail-mcp/gcp-oauth.keys.json
```

If user pastes the JSON content, write it directly:

```bash
cat > ~/.gmail-mcp/gcp-oauth.keys.json << 'EOF'
{paste the JSON here}
EOF
```

Verify the file is valid JSON:

```bash
cat ~/.gmail-mcp/gcp-oauth.keys.json | head -5
```

### 4. OAuth Authorization

**USER ACTION REQUIRED**

Tell the user:

> I'm going to run the Gmail authorization. A browser window will open asking you to sign in to Google and grant access.
>
> **Important:** If you see a warning that the app isn't verified, click "Advanced" then "Go to [app name] (unsafe)" - this is normal for personal OAuth apps.

Run the authorization:

```bash
npx -y @gongrzhe/server-gmail-autoauth-mcp auth
```

If that doesn't work (some versions don't have an auth subcommand), run it and let it prompt:

```bash
timeout 60 npx -y @gongrzhe/server-gmail-autoauth-mcp || true
```

Tell user:
> Complete the authorization in your browser. The window should close automatically when done. Let me know when you've authorized.

### 5. Verify Gmail Access

Check that credentials were saved:

```bash
if [ -f ~/.gmail-mcp/credentials.json ]; then
  echo "Gmail authorization successful!"
  ls -la ~/.gmail-mcp/
else
  echo "ERROR: credentials.json not found - authorization may have failed"
fi
```

Test the connection by listing labels (quick sanity check):

```bash
npx -y @gongrzhe/server-gmail-autoauth-mcp 2>&1 | grep -i "label\|auth\|error" | head -5
```

If you see errors, troubleshoot before continuing.

---

## Tool Mode Implementation

### Step 1: Install Gmail MCP Package

Add the Gmail MCP package:

```bash
bun add @gongrzhe/server-gmail-autoauth-mcp
```

### Step 2: Update .mcp.json

Add Gmail MCP server to `.mcp.json`:

```json
{
  "mcpServers": {
    "nanoclaw": { ... existing config ... },
    "gmail": {
      "type": "stdio",
      "command": "npx",
      "args": ["@gongrzhe/server-gmail-autoauth-mcp"]
    }
  }
}
```

### Step 3: Update Group Memory

Add Gmail usage instructions to `groups/main/CLAUDE.md`:

Find the "## What You Can Do" section and add:

```markdown
- Check and send emails using your Gmail account (e.g., "check my email" or "send an email to...")
```

Then add a new section after "## What You Can Do":

```markdown
## Gmail

You have access to your Gmail account. You can:
- Read emails from your inbox
- Search for specific emails
- Send emails
- Manage labels

**Examples:**
- "What are my latest emails?"
- "Send an email to john@example.com saying [message]"
- "Check emails from last week"
- "Find emails with 'project' in the subject"

The Gmail MCP server provides tools for all common email operations.
```

### Step 4: Rebuild and Test

Rebuild the main app:

```bash
bun run build
```

Restart the service:

```bash
pkill -f "dist/index.js"
nohup bun start > logs/nanoclaw.log 2>&1 &
```

Wait for it to start:

```bash
sleep 3
pgrep -f "dist/index.js"
```

### Step 5: Test Integration

Tell the user to test:
> Send a message to your assistant: `@[YourAssistantName] what are my latest emails?`
>
> The assistant should retrieve and summarize your recent emails.

Check logs:
```bash
tail -20 logs/nanoclaw.log
```

Look for any MCP or authentication errors.

---

## Channel Mode Implementation

**Channel Mode is more complex and requires additional infrastructure (email polling).** This is recommended only if you want emails to be able to trigger the agent.

Channel Mode requires implementing an email polling system and additional group configuration. For initial setup, **Tool Mode is recommended**.

If you want to implement Channel Mode later, you would need:
1. Email polling service (check Gmail API periodically)
2. Separate email group context
3. Email-to-WhatsApp forwarding (optional)
4. Email reply routing back to Gmail

This is beyond the scope of this basic integration guide.

---

## Testing & Troubleshooting

### Test Tool Mode

```bash
# Check Gmail MCP is loaded
tail -50 logs/nanoclaw.log | grep -i "gmail\|mcp"

# Send test message via WhatsApp
# User does this through their WhatsApp chat
```

### Common Issues

**Gmail MCP not found:**
- Verify package is installed: `bun list @gongrzhe/server-gmail-autoauth-mcp`
- Check .mcp.json configuration
- Rebuild: `bun run build`
- Restart service

**OAuth credentials missing:**
- Check `~/.gmail-mcp/credentials.json` exists
- Run authorization again: `npx -y @gongrzhe/server-gmail-autoauth-mcp auth`
- Verify file has valid JSON

**No response to email requests:**
- Check that Gmail MCP tools are available to the agent
- Verify MCP server is starting without errors
- Check logs for MCP initialization messages

### View Activity

Check email-related operations:

```bash
# Check logs for Gmail activity
grep -i "gmail\|email" logs/nanoclaw.log | tail -20

# Check if MCP server is running
ps aux | grep "gmail-autoauth-mcp"
```

---

## Removing Gmail Integration

To remove Gmail integration:

1. Remove package: `bun remove @gongrzhe/server-gmail-autoauth-mcp`
2. Remove from `.mcp.json` (delete the gmail server config)
3. Remove Gmail section from `groups/main/CLAUDE.md`
4. Rebuild: `bun run build`
5. Restart: `pkill -f "dist/index.js" && nohup bun start > logs/nanoclaw.log 2>&1 &`

Optional: Keep credentials for future reuse:
```bash
# Keep ~/.gmail-mcp/ for later
ls -la ~/.gmail-mcp/
```

Or delete if you won't need them:
```bash
rm -rf ~/.gmail-mcp/
```
