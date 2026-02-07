# Add Parallel AI Integration

Adds Parallel AI MCP integration to NanoClaw for advanced web research capabilities.

## What This Adds

- **Quick Search** - Fast web lookups using Parallel Search API (free to use)
- **Deep Research** - Comprehensive analysis using Parallel Task API (asks permission)
- **Non-blocking Design** - Uses NanoClaw scheduler for result polling

## Prerequisites

User must have:
1. Parallel AI API key from https://platform.parallel.ai
2. NanoClaw already set up and running

## Implementation Steps

Run all steps automatically. Only pause for user input when explicitly needed.

### 1. Get Parallel AI API Key

Ask the user:
> Do you have a Parallel AI API key, or should I help you get one?

**If they have one:**
Ask them to provide it.

**If they need one:**
Tell them:
> 1. Go to https://platform.parallel.ai
> 2. Sign up or log in
> 3. Navigate to API Keys section
> 4. Create a new API key
> 5. Copy the key and paste it here

Wait for the API key.

### 2. Add API Key to Environment

Add `PARALLEL_API_KEY` to `.env`:

```bash
# Check if .env exists, create if not
if [ ! -f .env ]; then
    touch .env
fi

# Add PARALLEL_API_KEY if not already present
if ! grep -q "PARALLEL_API_KEY=" .env; then
    echo "PARALLEL_API_KEY=${API_KEY_FROM_USER}" >> .env
    echo "✓ Added PARALLEL_API_KEY to .env"
else
    # Update existing key
    sed -i.bak "s/^PARALLEL_API_KEY=.*/PARALLEL_API_KEY=${API_KEY_FROM_USER}/" .env
    echo "✓ Updated PARALLEL_API_KEY in .env"
fi
```

Verify:
```bash
grep "PARALLEL_API_KEY" .env | head -c 50
```

### 3. Configure MCP Servers in Agent Runner

Update `src/agent-runner.ts`:

Find where the agent is configured and ensure `PARALLEL_API_KEY` environment variable is passed through. The agent runner should already pass environment variables from `.env`.

Verify the environment variable is accessible:
```bash
grep "PARALLEL_API_KEY" .env
```

### 4. Build and Test

Rebuild the main app:

```bash
bun run build
```

Restart the service:
```bash
pkill -f "dist/index.js"
nohup bun start > logs/nanoclaw.log 2>&1 &
```

Or if using systemd:
```bash
sudo systemctl restart nanoclaw
```

Verify it's running:
```bash
sleep 2
pgrep -f "dist/index.js"
```

### 5. Add Usage Instructions to CLAUDE.md

Add Parallel AI usage instructions to `groups/main/CLAUDE.md`:

Find the "## What You Can Do" section and add after the existing bullet points:
```markdown
- Use Parallel AI for web research and deep learning tasks
```

Then add a new section after "## What You Can Do":
```markdown
## Web Research Tools

You have access to Parallel AI research tools:

### Quick Web Search
**When to use:** Freely use for factual lookups, current events, definitions, recent information, or verifying facts.

**Examples:**
- "Who invented the transistor?"
- "What's the latest news about quantum computing?"
- "When was the UN founded?"
- "What are the top programming languages in 2026?"

**Speed:** Fast (2-5 seconds)
**Cost:** Low
**Permission:** Not needed - use whenever it helps answer the question

### Deep Research
**When to use:** Comprehensive analysis, learning about complex topics, comparing concepts, historical overviews, or structured research.

**Examples:**
- "Explain the development of quantum mechanics from 1900-1930"
- "Compare the literary styles of Hemingway and Faulkner"
- "Research the evolution of jazz from bebop to fusion"
- "Analyze the causes of the French Revolution"

**Speed:** Slower (1-20 minutes depending on depth)
**Cost:** Higher (varies by processor tier)
**Permission:** ALWAYS ask the user first before using this tool

**How to ask permission:**
```
I can do deep research on [topic] using Parallel's Task API. This will take
2-5 minutes and provide comprehensive analysis with citations. Should I proceed?
```

**After permission - use scheduler for long-running tasks:**

1. Create the task using Parallel Task API
2. Create a polling scheduled task to check the task status
3. Send results when ready
4. Exit immediately - scheduler handles the rest

### Choosing Between Them

**Use Search when:**
- Question needs a quick fact or recent information
- Simple definition or clarification
- Verifying specific details
- Current events or news

**Use Deep Research (with permission) when:**
- User wants to learn about a complex topic
- Question requires analysis or comparison
- Historical context or evolution of concepts
- Structured, comprehensive understanding needed
- User explicitly asks to "research" or "explain in depth"

**Default behavior:** Prefer search for most questions. Only suggest deep research when the topic genuinely requires comprehensive analysis.
```

### 6. Test Integration

Tell the user to test:
> Send a message to your assistant: `@[YourAssistantName] what's the latest news about AI?`
>
> The assistant should use Parallel Search API to find current information.
>
> Then try: `@[YourAssistantName] can you research the history of artificial intelligence?`
>
> The assistant should ask for permission before using the Task API.

Check logs to verify integration is working:
```bash
tail -20 logs/nanoclaw.log
```

## Troubleshooting

**API key not working:**
- Verify PARALLEL_API_KEY is set in .env: `grep PARALLEL_API_KEY .env`
- Check the key format matches what Parallel AI provides
- Restart the service after adding the key

**MCP tools not available:**
- Ensure environment variable is loaded: `echo $PARALLEL_API_KEY` in agent context
- Check that agent runner passes environment variables correctly
- Verify logs for any MCP initialization errors

**Task polling not working:**
- Verify scheduled task was created: `sqlite3 store/messages.db "SELECT * FROM scheduled_tasks"`
- Check task runs: `tail -f logs/nanoclaw.log | grep "scheduled task"`
- Ensure task prompt includes proper tool names

## Uninstalling

To remove Parallel AI integration:

1. Remove from .env: `sed -i.bak '/PARALLEL_API_KEY/d' .env`
2. Remove Web Research Tools section from groups/main/CLAUDE.md
3. Rebuild: `bun run build`
4. Restart: `pkill -f "dist/index.js" && nohup bun start > logs/nanoclaw.log 2>&1 &`
