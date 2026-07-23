# Pi Sol mid-turn guard

Temporary local extension for Pi 0.80.6/0.80.7.

When a successful `gpt-5.6-sol` tool turn reports more than 250,000 tokens and no owner message is queued, the extension stops the low-level loop at `shouldStopAfterTurn`. After Pi settles, it uses Pi's normal compaction path and sends one hidden continuation message. A process-wide prototype wrapper routes through a `sessionId` registry so concurrent Pi runtimes keep independent guard state.

Installed at:

```text
~/.pi/agent/extensions/sol-mid-turn-guard/index.ts
```

After installation, run `/reload`. The footer shows `Sol guard 250k`; `/sol-guard-status` reports its state.

Minimal validation:

```bash
npm run smoke
```

Rollback:

```bash
rm -rf ~/.pi/agent/extensions/sol-mid-turn-guard
```

Then run `/reload`. No project or global `settings.json` changes are required.
