---
name: setup
description: Run initial NanoClaw setup. Use when user wants to install dependencies, authenticate WhatsApp, register their main channel, or start the background services. Triggers on "setup", "install", "configure nanoclaw", or first-time setup requests.
---

# NanoClaw Setup

Run all commands automatically. Only pause when user action is required (scanning QR codes).

**UX Note:** When asking the user questions, prefer using the `AskUserQuestion` tool instead of just outputting text. This integrates with Claude's built-in question/answer system for a better experience.

## 1. Install Dependencies

```bash
bun install
```

## 2. Configure Claude Authentication

Ask the user:
> Do you want to use your **Claude subscription** (Pro/Max) or an **Anthropic API key**?

### Option 1: Claude Subscription (Recommended)

Tell the user:
> Open another terminal window and run:
> ```
> claude setup-token
> ```
> A browser window will open for you to log in. Once authenticated, the token will be displayed in your terminal. Either:
> 1. Paste it here and I'll add it to `.env` for you, or
> 2. Add it to `.env` yourself as `CLAUDE_CODE_OAUTH_TOKEN=<your-token>`

If they give you the token, add it to `.env`:

```bash
echo "CLAUDE_CODE_OAUTH_TOKEN=<token>" > .env
```

### Option 2: API Key

Ask if they have an existing key to copy or need to create one.

**Copy existing:**
```bash
grep "^ANTHROPIC_API_KEY=" /path/to/source/.env > .env
```

**Create new:**
```bash
echo 'ANTHROPIC_API_KEY=' > .env
```

Tell the user to add their key from https://console.anthropic.com/

**Verify:**
```bash
KEY=$(grep "^ANTHROPIC_API_KEY=" .env | cut -d= -f2)
[ -n "$KEY" ] && echo "API key configured: ${KEY:0:10}...${KEY: -4}" || echo "Missing"
```

## 3. Build the Project

```bash
bun run build
```

## 4. WhatsApp Authentication

**USER ACTION REQUIRED**

**IMPORTANT:** Run this command in the **foreground**. The QR code is multi-line ASCII art that must be displayed in full. Do NOT run in background or truncate the output.

Tell the user:
> A QR code will appear below. On your phone:
> 1. Open WhatsApp
> 2. Tap **Settings → Linked Devices → Link a Device**
> 3. Scan the QR code

Run with a long Bash tool timeout (120000ms) so the user has time to scan. Do NOT use the `timeout` shell command.

```bash
bun run auth
```

Wait for the script to output "Successfully authenticated" then continue.

If it says "Already authenticated", skip to the next step.

## 5. Configure Assistant Name and Main Channel

This step configures three things at once: the trigger word, the main channel type, and the main channel selection.

### 5a. Ask for trigger word

Ask the user:
> What trigger word do you want to use? (default: `Andy`)
>
> In group chats, messages starting with `@TriggerWord` will be sent to Claude.
> In your main channel (and optionally solo chats), no prefix is needed — all messages are processed.

Store their choice for use in the steps below.

### 5b. Explain security model and ask about main channel type

**Use the AskUserQuestion tool** to present this:

> **Important: Your "main" channel is your admin control portal.**
>
> The main channel has elevated privileges:
> - Can see messages from ALL other registered groups
> - Can manage and delete tasks across all groups
> - Can write to global memory that all groups can read
> - Has read-write access to the entire NanoClaw project
>
> **Recommendation:** Use your personal "Message Yourself" chat or a solo WhatsApp group as your main channel. This ensures only you have admin control.
>
> **Question:** Which setup will you use for your main channel?
>
> Options:
> 1. Personal chat (Message Yourself) - Recommended
> 2. Solo WhatsApp group (just me)
> 3. Group with other people (I understand the security implications)

If they choose option 3, ask a follow-up:

> You've chosen a group with other people. This means everyone in that group will have admin privileges over NanoClaw.
>
> Are you sure you want to proceed? The other members will be able to:
> - Read messages from your other registered chats
> - Schedule and manage tasks
> - Access any directories you've mounted
>
> Options:
> 1. Yes, I understand and want to proceed
> 2. No, let me use a personal chat or solo group instead

### 5c. Register the main channel

First build, then start the app briefly to connect to WhatsApp and sync group metadata. Use the Bash tool's timeout parameter (15000ms) — do NOT use the `timeout` shell command. The app will be killed when the timeout fires, which is expected.

```bash
bun run build
```

Then run briefly (set Bash tool timeout to 15000ms):
```bash
bun run dev
```

**For personal chat** (they chose option 1):

Personal chats are NOT synced to the database on startup — only groups are. Instead, ask the user for their phone number (with country code, no + or spaces, e.g. `14155551234`), then construct the JID as `{number}@s.whatsapp.net`.

**For group** (they chose option 2 or 3):

Groups are synced on startup via `groupFetchAllParticipating`. Query the database for recent groups:
```bash
sqlite3 store/messages.db "SELECT jid, name FROM chats WHERE jid LIKE '%@g.us' AND jid != '__group_sync__' ORDER BY last_message_time DESC LIMIT 40"
```

Show only the **10 most recent** group names to the user and ask them to pick one. If they say their group isn't in the list, show the next batch from the results you already have. If they tell you the group name directly, look it up:
```bash
sqlite3 store/messages.db "SELECT jid, name FROM chats WHERE name LIKE '%GROUP_NAME%' AND jid LIKE '%@g.us'"
```

### 5d. Write the configuration

Once you have the JID, configure it. Use the assistant name from step 5a.

For personal chats (solo, no prefix needed), set `requiresTrigger` to `false`. Update the database directly using the setRegisteredGroup function in the code, or use this script:

```bash
sqlite3 store/messages.db << EOF
INSERT OR REPLACE INTO registered_groups (jid, name, folder, trigger_pattern, added_at, requires_trigger)
VALUES ('PHONE@s.whatsapp.net', 'main', 'main', '@ASSISTANT_NAME', '$(date -u +"%Y-%m-%dT%H:%M:%SZ")', 0);
EOF
```

For groups, keep `requiresTrigger` as `1` (true):

```bash
sqlite3 store/messages.db << EOF
INSERT OR REPLACE INTO registered_groups (jid, name, folder, trigger_pattern, added_at, requires_trigger)
VALUES ('GROUP_JID@g.us', 'main', 'main', '@ASSISTANT_NAME', '$(date -u +"%Y-%m-%dT%H:%M:%SZ")', 1);
EOF
```

Ensure the groups folder exists:
```bash
mkdir -p groups/main/logs
```

If the user chose a name other than `Andy`, also update:
1. `groups/global/CLAUDE.md` - Change "# Andy" and "You are Andy" to the new name
2. `groups/main/CLAUDE.md` - Same changes at the top

## 6. Start the Service

### For Development

```bash
bun run dev
```

### For Production (Linux with systemd)

Create a systemd service file:

```bash
sudo tee /etc/systemd/system/nanoclaw.service > /dev/null << EOF
[Unit]
Description=NanoClaw Personal Assistant
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$(whoami)
WorkingDirectory=$(pwd)
ExecStart=$(which bun) start
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF
```

Then:
```bash
sudo systemctl daemon-reload
sudo systemctl enable nanoclaw
sudo systemctl start nanoclaw
```

Check status:
```bash
sudo systemctl status nanoclaw
```

### For Production (macOS with launchd)

Generate the plist file with correct paths automatically:

```bash
NODE_PATH=$(which node)
PROJECT_PATH=$(pwd)
HOME_PATH=$HOME

cat > ~/Library/LaunchAgents/com.nanoclaw.plist << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.nanoclaw</string>
    <key>ProgramArguments</key>
    <array>
        <string>${NODE_PATH}</string>
        <string>${PROJECT_PATH}/dist/index.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${PROJECT_PATH}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin:${HOME_PATH}/.local/bin</string>
        <key>HOME</key>
        <string>${HOME_PATH}</string>
    </dict>
    <key>StandardOutPath</key>
    <string>${PROJECT_PATH}/logs/nanoclaw.log</string>
    <key>StandardErrorPath</key>
    <string>${PROJECT_PATH}/logs/nanoclaw.error.log</string>
</dict>
</plist>
EOF

echo "Created launchd plist with:"
echo "  Node: ${NODE_PATH}"
echo "  Project: ${PROJECT_PATH}"
```

Build and start the service:

```bash
bun run build
mkdir -p logs
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
```

Verify it's running:
```bash
launchctl list | grep nanoclaw
```

## 7. Test

Tell the user (using the assistant name they configured):
> Send `@ASSISTANT_NAME hello` in your registered chat.
>
> **Tip:** In your main channel, you don't need the `@` prefix — just send `hello` and the agent will respond.

Check the logs:
```bash
tail -f logs/nanoclaw.log
```

The user should receive a response in WhatsApp.

## Troubleshooting

**Dependencies won't install:**
- Ensure you have Node.js 20+ and Bun installed
- Try clearing cache: `bun cache rm -a`
- Check disk space

**QR code not appearing:**
- Run `bun run auth` in a new terminal (not in a background process)
- Make sure your terminal is large enough to display the full ASCII art

**No response to messages:**
- Verify the trigger pattern matches (e.g., `@AssistantName` at start of message)
- Main channel doesn't require a prefix — all messages are processed
- Personal/solo chats with `requiresTrigger: false` also don't need a prefix
- Check that the chat JID is in the database: `sqlite3 store/messages.db "SELECT * FROM registered_groups"`
- Check `logs/nanoclaw.log` for errors

**WhatsApp disconnected:**
- The service will show a log message
- Run `bun run auth` to re-authenticate
- Restart the service

**Service won't start:**
- Check `logs/nanoclaw.error.log` for errors
- Verify `.env` file has valid API credentials
- Try running in development mode first: `bun run dev`

## Uninstalling the Service

**macOS:**
```bash
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
```

**Linux (systemd):**
```bash
sudo systemctl stop nanoclaw
sudo systemctl disable nanoclaw
sudo rm /etc/systemd/system/nanoclaw.service
sudo systemctl daemon-reload
```
