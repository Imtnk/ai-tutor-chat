# AI Tutor Chat

A zero-build, `<script>`-tag-only AI tutor chat widget. Drop it into any static page to get a floating chat panel with streaming responses, multiple OpenAI-compatible providers, and optional web search — no bundler, no framework, no backend required.

Originally extracted from a study app's embedded tutor feature into a standalone, subject-agnostic widget.

## Features

- **Floating chat panel** — a FAB button that opens a slide-over chat panel from any page.
- **Streaming responses** — real-time token streaming from supported providers.
- **Multiple provider support** — Gemini (free tier), a local OpenAI-compatible server (e.g. Ollama), or any custom OpenAI-compatible endpoint.
- **Web search (optional)** — via a self-hosted SearXNG + nginx CORS proxy (`search-bridge/`), available on the local provider.
- **Subject profiles** — the tutor's scope/personality is just a small config object (a system prompt template); swap it to tutor any subject.
- **Self-contained persistence** — conversation history and provider settings persist in the browser's `localStorage`, namespaced per instance.
- **No build step** — plain classic `<script>` files, safe to serve from any static host.

## Quick start

```bash
git clone <this-repo>
cd ai-tutor-chat
python3 -m http.server 8000
# open http://localhost:8000/demo/index.html
```

**Must be served over `http://localhost`, not `file://`.** Local LLM servers (Ollama, vLLM, etc.) block `file://` origins via CORS.

## Embedding in your own page

```html
<link rel="stylesheet" href="tutor-chat.css">
<script src="tutor-chat.js"></script>
<script src="subjects/example-cc.js"></script>
<script>
  TutorChat.mount(document.body, {
    subject: window.TutorSubjects.exampleCC
  });
</script>
```

`TutorChat.mount(container, config)` builds its own DOM inside `container` and returns `{ open, close, destroy }`.

### `config` options

| Option | Type | Description |
| --- | --- | --- |
| `subject` | `{ name, systemTemplate, contextBuilder? }` | Required. Defines the tutor's name and scope. `systemTemplate` must include a `{{CONTEXT}}` slot. See `subjects/template.js`. |
| `providers` | `{ gemini?, local?, custom? }` | Optional overrides of the built-in provider presets (`baseUrl`, `model`, `needsKey`, `canSearch`). |
| `storageKey` | `string` | Optional. Namespace prefix for localStorage keys (default `"tutorchat"`). Use a unique value if mounting multiple instances on one page. |
| `contextBuilder` | `() => string` | Optional. Returns extra text injected into the `{{CONTEXT}}` slot (e.g. "the user is currently viewing X"). Can also be set on the subject profile itself. |

## Writing a subject profile

Copy `subjects/template.js`, fill in the name and system prompt, and pass it as `subject`. `example-cc.js` (an ISC² Certified in Cybersecurity exam tutor) is included as a full worked example.

## Providers

- **Gemini** — free tier. Get a key at [ai.google.dev](https://ai.google.dev), select "Gemini" in the widget's settings, paste the key.
- **Local** — point at a local OpenAI-compatible server:
  ```bash
  ollama pull qwen3.5:9b
  OLLAMA_ORIGINS="*" ollama serve
  ```
  This is the only provider path with web search enabled. Note: the model only gets a `web_search` tool, not a clock — it doesn't inherently know the current date/time unless a search result reveals it.
- **Custom** — any OpenAI-compatible Base URL (must send CORS headers to be reachable browser-direct).

**Security note:** API keys are stored only in the browser's `localStorage` on the device you configure them on. Don't host a page with a key pre-filled publicly.

## Web search (optional)

Mainstream search APIs (Google CSE, Brave, Tavily, Bing) block browser-direct calls. Web search runs through a self-hosted local search bridge instead — the browser calls `http://localhost`, which you control for CORS; the bridge calls the real search source server-side.

```bash
cd search-bridge
docker compose up -d
# then in the widget settings: Search bridge URL: http://localhost:8888/search?format=json
```

Default bridge is [SearXNG](https://docs.searxng.org/) (self-hosted, no API key, JSON output) behind an nginx CORS proxy. Change `search-bridge/config/settings.yml`'s `secret_key` before exposing this beyond localhost.

## Tests

Open `tests/tutor-chat.test.html` in a browser (via a local server, not `file://`) to run the pure-logic test suite.

## Architecture

- `tutor-chat.js` — provider-agnostic client (streaming + tool-call loop), DOM/panel rendering, and a built-in localStorage-backed store. No dependencies.
- `tutor-chat.css` — self-contained default theme; override the `--tc-*` custom properties to re-theme.
- `subjects/` — subject profile configs (system prompt + scope).
- `search-bridge/` — SearXNG + nginx CORS proxy, docker-compose based.
- `demo/` — a minimal page showing the widget mounted.
- `tests/` — browser-run assertion suite for the pure logic + DOM mounting.

## License

MIT — see [LICENSE](LICENSE).
