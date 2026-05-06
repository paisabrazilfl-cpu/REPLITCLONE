# Replit Clone

A fully functional browser-based IDE built with vanilla HTML/CSS/JS and powered by the Claude AI API.

## Live Demo
Open `index.html` directly in any modern browser — no build step, no server required.

## Features

- **Multi-file editor** — File tree sidebar, tabbed editing, per-file state tracking
- **Live JS execution** — Run JavaScript in the browser console with `console.log` capture
- **AI Assistant** — Claude-powered sidebar chat, context-aware of your current file and code
- **Tab management** — Open, close, and switch between multiple files
- **Line numbers** — Synced scrolling line number gutter
- **New file creation** — Add files dynamically via the `+` button
- **Status bar** — Language detection, cursor position (Ln/Col), run status
- **Keyboard shortcuts** — `Tab` for indent, `Ctrl+Enter` to run

## File Support

| Extension | Action |
|-----------|--------|
| `.js` | Executes in browser sandbox, captures console output |
| `.html` | Reports parse success (open Web View tab) |
| `.css` | Counts CSS rules |
| `.md` | Word/line count |
| `.py` | Warns: Python requires WASM runtime |

## Stack

- **Zero dependencies** — Pure HTML, CSS, JavaScript
- **AI** — Anthropic Claude API (`claude-sonnet-4-20250514`)
- **No build step** — Just open and run

## Usage

```bash
git clone https://github.com/paisabrazilfl-cpu/REPLITCLONE.git
cd REPLITCLONE
open index.html   # macOS
# or just drag index.html into your browser
```

## AI Assistant Setup

The AI assistant calls the Anthropic API directly from the browser. To use it:
1. Click `✦ AI` in the top bar
2. Ask anything about your code
3. The assistant has context of your current file and code

> Note: The API key must be configured server-side or via a proxy for production use. This demo uses the Claude.ai artifact API bridge.

## License

MIT
