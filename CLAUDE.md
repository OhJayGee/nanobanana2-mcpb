# CLAUDE.md

## Project

Nanobanana Image Studio — MCPB extension for Claude Desktop that wraps Google's Gemini image generation models as MCP tools.

## Quick Reference

```bash
npm test          # 122 tests (unit + e2e + integration)
npm run scan      # Semgrep security scan
npm run build     # esbuild → dist/index.js
npm run pack      # Build + pack .mcpb
npm run validate  # Validate manifest.json
```

## Architecture

Single-file server at `server/index.js` exporting `createServer()` factory. See [ARCHITECTURE.md](ARCHITECTURE.md) for diagrams and data flows.

- **7 MCP tools:** generate_image, edit_image, check_generation, extract_visual_dna, describe_image, list_templates, get_template
- **Async job queue** with fire-and-forget pattern, 5-minute AbortController timeout
- **API throttle:** max 2 concurrent fetches, 10s ±2s stagger delay
- **Security:** extension allowlist + symlink resolution + magic bytes + file size limit + FIFO rejection
- **EXIF stripping** for JPEG before API upload (configurable)
- **Debug logging** to `OUTPUT_DIR/.nanobanana-debug.log` (configurable)
- **EMA-based time estimates** with persistence

## Testing

4 test layers — see [TESTING.md](TESTING.md) for details:
- `test/server.test.js` — unit tests (97)
- `test/e2e.test.js` — MCP end-to-end via InMemoryTransport (18)
- `test/integration.test.js` — file-level integration (5)
- `test/live.test.js` — real Gemini API (10, opt-in: `NANOBANANA_LIVE_TEST=1`)

## Version Bumping

Three files must be updated together:
- `package.json` → `version`
- `manifest.json` → `version`
- `server/index.js` → `version` in `createServer()` McpServer constructor

## Current Work

See [TODO.md](TODO.md) for:
- **Priority 1:** `gemini-2.5-flash-image` fallback (GA model, same API, needs conditional thinkingConfig + imageConfig for aspect ratio)
- **Priority 2:** Aspect ratio fix (move from prompt text to `generationConfig.imageConfig`)
- **Priority 3:** Imagen 4 as alternative provider (different API contract)
- **Production stats** and reliability data

## Key Findings

- The `gemini-3.1-flash-image-preview` model has ~68% success rate with intermittent 503s and silent hangs
- Aspect ratio via prompt text works on 3.1 Flash but is ignored by 2.5 Flash — must use `generationConfig.imageConfig.aspectRatio`
- `imageConfig` field name (camelCase) works; `image_generation_config` and `imageGenerationConfig` do not
- The MCPB runtime passes boolean config values as string `"true"`/`"false"` via env vars
- Cloud Monitoring dashboard and BigQuery billing export are configured on GCP project `gen-lang-client-0387154380`
