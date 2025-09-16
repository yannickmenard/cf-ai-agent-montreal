# CF AI Agent Template

A minimal full-stack template for building AI agents on Cloudflare.  
It ships a React SPA chat UI, a Cloudflare Worker using the **Agents SDK** (WebSocket sessions), and a few example tools:

- **getWeather** → Open-Meteo forecast with a compact weather widget
- **captureScreenshot** → PNG screenshot using Cloudflare **Browser Rendering** (Puppeteer)
- **convertToPdf** → PDF rendering using Cloudflare **Browser Rendering** (Puppeteer)

The UI shows multi-step tool progress and a tiny inline preview for screenshots/PDFs. Tool outputs are stored, rehydrated on refresh, and downloadable from `/files/:sid/:name`.

---

## Quick Start

### One-Click Deploy:

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/vnikhilbuddhavarapu/cf-ai-agent-template)

### Manual Deploy:

```bash
git clone https://github.com/vnikhilbuddhavarapu/cf-ai-agent-template.git
cd cf-ai-agent-template
npm i
npm run dev
```
- Local dev runs Vite + the Cloudflare plugin for Worker SSR.
- Open the app (usually http://localhost:5173).

### Deploy

```bash
npm run deploy
```

This runs a production build and `wrangler deploy`.

### Cloudflare Bindings

Defined in `wrangler.jsonc`:

- AI – Workers AI binding (for chat + summaries)
- AI_AGENT – Agents SDK binding (manages WS agents)
- agent_sessions – KV for session info
- ASSETS – Static assets / SPA
- BROWSER – Cloudflare Browser Rendering (Puppeteer)
- agent_browser_uploads – R2 bucket used for screenshots/PDF uploads

Make sure these resources exist in your Cloudflare account and the bindings match your `wrangler.jsonc`.

### What’s in the Box

src/                # React SPA
  components/chat/  # Message UI, ToolCard, Weather widget, etc
  agent/wsClient.ts # Tiny client for Agents SDK (WS)
  App.tsx           # Chat app; handles progress + previews

worker/             # Cloudflare Worker (Agents SDK)
  agent.ts          # Your Agent (state, planning, tool orchestration)
  index.ts          # Worker fetch() router (Agents + API + assets)
  session.ts        # /api/session cookie for local dev
  tools/
    getWeather.ts
    captureScreenshot.ts
    convertToPdf.ts

## How it works

### How It Works

#### Sessions & WS
The Worker routes /agents/... to the Agents SDK (routeAgentRequest). The Agent persists a light message log (SQLite via the Agents runtime). The SPA connects over WS and streams assistant deltas.

#### Files & Downloads
Tools upload outputs (PNG/PDF) to R2 under files/:sid/:uuid.ext.
The Worker serves them from /files/:sid/:name with content-disposition: inline, so clicking previews opens in a new tab.

#### Tools & Progress
The Agent emits tool progress events (started → step → done/error).
The SPA renders a compact multi-step ToolCard with a tiny inline preview when finished.

#### Agentic Summaries
After a tool completes, the Agent asks Workers AI to summarize the outcome (1–3 lines). If AI is unavailable, a deterministic fallback line is used.

#### Deterministic System Prompt
A shared SYSTEM_BEHAVIOR prompt is injected for both planning and fallback chat to avoid hallucinated tool calls (e.g., answering “What tools can you use?” without calling any tool).

## Customize

### Add a tool

Create worker/tools/<yourTool>.ts, export a typed Args + Result, and call it from agent.ts. Emit progress steps (emitTool) so the UI can animate. If it outputs a file, write to R2 and return { ok: true, url, r2Key, ... }.

### Change UI

Tweak ToolCard.tsx or add new ToolUI.kinds for your tools. The screenshot/PDF pattern shows how to do progress + preview.

### Model

Switch default model ID in agent.ts or via the UI model picker.