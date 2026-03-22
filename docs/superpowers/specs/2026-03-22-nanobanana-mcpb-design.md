# Nanobanana MCPB Extension — Design Spec

## Overview

A Node.js-based MCPB (MCP Bundle) extension that re-implements the nanobanana Rust CLI as a set of MCP tools for Claude Desktop and Claude Cowork. The extension exposes image generation, editing, visual DNA extraction, and description capabilities via Google's Nano Banana 2 model (`gemini-3.1-flash-image-preview`).

## Motivation

The existing nanobanana-cli is a Rust binary invoked from the command line. Repackaging its functionality as an MCPB extension enables:

- Single-click installation in Claude Desktop/Cowork
- Autonomous multi-step workflows (e.g., generate images then compose emails)
- User-configurable API key and output directory via Claude Desktop's settings UI
- No external binary dependency — pure Node.js using built-in `fetch`

## Architecture

### Approach

Single-file MCP server (`server/index.js`) containing all tool registrations and Gemini API client logic. Mirrors the simplicity of the original 336-line Rust CLI.

### Bundle Structure

```
nanobananaMCPB/
├── manifest.json              # MCPB manifest (v0.3)
├── icon.png                   # Extension icon (512x512)
├── server/
│   └── index.js               # MCP server — all tools + Gemini client
├── assets/
│   └── templates/
│       ├── cinematic_fujifilm.json
│       └── blueprint_3d.json
├── node_modules/              # Bundled deps (@modelcontextprotocol/sdk, zod)
└── package.json
```

### Dependencies

- `@modelcontextprotocol/sdk` — MCP server framework
- `zod` (v3) — input schema validation
- Node.js built-in `fetch` (>= 18) — HTTP client (replaces reqwest)
- Node.js built-in `fs`, `path`, `Buffer` — file I/O and base64 (replaces Rust crates)

No other dependencies. The Gemini API interaction is straightforward HTTP POST with JSON body.

### Runtime Requirements

- Node.js >= 18 (ships with Claude Desktop)
- macOS (darwin) and Windows (win32)

## Manifest

```json
{
  "manifest_version": "0.4",
  "name": "nanobanana",
  "version": "1.0.0",
  "display_name": "Nanobanana Image Studio",
  "description": "Generate, edit, and analyze images using Nano Banana 2",
  "author": { "name": "OhJayGee" },
  "license": "MIT",
  "server": {
    "type": "node",
    "entry_point": "server/index.js",
    "mcp_config": {
      "command": "node",
      "args": ["${__dirname}/server/index.js"],
      "env": {
        "GEMINI_API_KEY": "${user_config.gemini_api_key}",
        "OUTPUT_DIR": "${user_config.output_directory}"
      }
    }
  },
  "user_config": {
    "gemini_api_key": {
      "type": "string",
      "title": "Gemini API Key",
      "description": "Your Google AI Studio API key",
      "sensitive": true,
      "required": true
    },
    "output_directory": {
      "type": "directory",
      "title": "Output Directory",
      "description": "Where generated images are saved",
      "required": true,
      "default": "${HOME}/Desktop/nanobanana-output"
    }
  },
  "tools": [
    { "name": "generate_image", "description": "Generate an image from a text prompt with optional style, visual DNA, aspect ratio, and resolution controls" },
    { "name": "edit_image", "description": "Edit existing image(s) with a text instruction while preserving unmentioned elements" },
    { "name": "extract_visual_dna", "description": "Extract visual DNA from image(s) as structured JSON (style, scene, subject, camera, lighting, materials, colors)" },
    { "name": "describe_image", "description": "Generate a detailed text description of image(s)" },
    { "name": "list_templates", "description": "List available pre-built Visual DNA style templates" },
    { "name": "get_template", "description": "Get the JSON contents of a Visual DNA style template" }
  ],
  "compatibility": {
    "claude_desktop": ">=1.0.0",
    "platforms": ["darwin", "win32"],
    "runtimes": { "node": ">=18.0.0" }
  }
}
```

### Design Decisions

- **Gemini provider only** — no Vertex AI. Keeps user_config to one API key. Vertex support can be added later as an optional provider toggle.
- **API key via user_config with `sensitive: true`** — Claude Desktop stores it securely and auto-generates the settings UI.
- **Output directory via user_config** — user picks at install time. Server creates it on first use if it doesn't exist.

### Deviations from Rust CLI

- **"colors" field added to Visual DNA extraction** — the Rust CLI prompt extracts 6 fields (style, scene, subject, camera, lighting, materials). This extension adds "colors" as a 7th field, matching the DNA examples already produced by the model (e.g., `dna.json` in the nanobanana repo includes colors).
- **Text output returned inline, not saved to file** — the Rust CLI writes all output (including text from `--describe` and `--extract-dna`) to `--output` file. In MCP context, text results are returned directly as tool response content since Claude uses them in-context for chaining.
- **No `visual_dna` file path support** — the Rust CLI accepts `--visual-dna` as either a JSON string or a file path. In MCP context, Claude passes the object directly from a previous `extract_visual_dna` call or `get_template` result. File path indirection is unnecessary.
- **Input validation via enums** — the Rust CLI accepts freeform strings for `aspect_ratio` and `image_size`. This extension validates them as enums for better error messages and tool discoverability. Supported values come from the Gemini API documentation.

### Out of Scope (Deferred)

- **Vertex AI provider** — requires 3 additional env vars (`GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION`, `GCP_ACCESS_TOKEN`) and a different auth flow. Can be added as a future `provider` toggle in user_config.
- **Batch processing** — the nanobanana skill includes `batch_generate.js`. Not needed for MCP since Claude orchestrates multi-image workflows natively.
- **CLI binary bundling** — no Rust binary is included. All functionality is reimplemented in Node.js.

## Tools

### generate_image

Generate an image from a text prompt.

**Input Schema:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `prompt` | string | yes | — | Text description of the image to generate |
| `style` | string | no | — | Artistic style instruction |
| `visual_dna` | object | no | — | Visual DNA JSON to guide style consistency |
| `aspect_ratio` | enum | no | "1:1" | One of: 1:1, 16:9, 9:16, 4:3, 3:4, 21:9, 4:5, 5:4, 1:4, 4:1, 1:8, 8:1, 2:3, 3:2 |
| `image_size` | enum | no | "1K" | Resolution tier: 0.5K, 1K, 2K, 4K |
| `thinking_level` | enum | no | "high" | Reasoning depth: minimal, medium, high |

**Behavior:**

1. Build structured JSON prompt: `{ content, aspect_ratio, image_size, style?, visual_dna? }`
2. Call Gemini API with `responseModalities: ["IMAGE"]`
3. Decode base64 image from response
4. Generate filename: `{YYYY-MM-DD}-{slugified-prompt-first-40-chars}-{6-char-hex}.png`
5. Save to `OUTPUT_DIR/`
6. Return file path and metadata as text

**Output:**
```
Image saved to /Users/.../nanobanana-output/2026-03-22-cyberpunk-forest-a1b2c3.png
Prompt: A cyberpunk forest
Aspect: 16:9 | Size: 2K | Thinking: high
```

### edit_image

Edit existing image(s) with a text instruction.

**Input Schema:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `images` | string[] | yes | — | File paths to input images (1-14) |
| `prompt` | string | yes | — | Edit instruction |
| `aspect_ratio` | enum | no | "1:1" | Output aspect ratio |
| `image_size` | enum | no | "1K" | Output resolution |
| `thinking_level` | enum | no | "high" | Reasoning depth |

**Behavior:**

1. Read each image from disk, base64-encode
2. Detect MIME type from extension (`.png` → `image/png`, `.webp` → `image/webp`, else `image/jpeg`)
3. Build request with image parts + text prompt
4. Call Gemini API with `responseModalities: ["IMAGE"]`
5. Save and return same as `generate_image`

### extract_visual_dna

Extract the visual DNA from image(s) as structured JSON.

**Input Schema:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `images` | string[] | yes | File paths to analyze (1-14) |

**Behavior:**

1. Read and encode images
2. Call Gemini API with `responseModalities: ["TEXT"]`, `includeThoughts: false`
3. Prompt: "Analyze the provided image(s) and extract their core visual DNA into a structured JSON object. Include fields for: style, scene, subject, camera, lighting, materials, colors. ONLY output the raw JSON without markdown code blocks."
4. Return raw JSON text directly (no file save — small structured data for in-context use)

**Output:** Raw Visual DNA JSON as text content.

### describe_image

Generate a detailed text description of image(s).

**Input Schema:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `images` | string[] | yes | File paths to describe (1-14) |

**Behavior:**

1. Read and encode images
2. Call Gemini API with `responseModalities: ["TEXT"]`, `includeThoughts: false`
3. Prompt: "Provide a highly detailed, comprehensive description of the provided image(s)."
4. Return description text directly

### list_templates

List available pre-built Visual DNA style templates.

**Input Schema:** none

**Behavior:** Read filenames from `assets/templates/` directory (resolved relative to server entry point). Return list of template names (without `.json` extension).

**Output:**
```
Available templates:
- cinematic_fujifilm: Cinematic Fujifilm, highly detailed, film grain
- blueprint_3d: Technical Blueprint, 3D orthographic projection
```

### get_template

Get the JSON contents of a specific template.

**Input Schema:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | yes | Template name (e.g., "cinematic_fujifilm") |

**Behavior:** Read `assets/templates/{name}.json`, return contents as text. Validate the name contains no path separators to prevent directory traversal.

## Gemini API Client

One internal function shared by all image/text tools:

```
callGeminiAPI({ parts, modalities, thinkingLevel, includeThoughts })
  → { type: 'image', data: Buffer } | { type: 'text', data: string }
```

**Request structure** (matches Rust CLI exactly):

```json
{
  "contents": [{ "parts": [...imageParts, { "text": "..." }] }],
  "generationConfig": {
    "responseModalities": ["IMAGE" | "TEXT"],
    "candidateCount": 1,
    "thinkingConfig": {
      "includeThoughts": true|false,
      "thinkingLevel": "minimal"|"medium"|"high"
    }
  }
}
```

**Endpoint:** `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image-preview:generateContent?key={GEMINI_API_KEY}`

**Request headers:**
- `Content-Type: application/json`

**Timeout:** 60 seconds. No automatic retries — surface errors to Claude so it can decide whether to retry.

**Error handling:**
- Missing `GEMINI_API_KEY` → clear error message
- Non-2xx HTTP status → include status code and response body
- No candidates in response → descriptive error
- API error object in response → forward error message
- Image file not found or unreadable → clear error with the failing file path
- Empty `images` array → validation error before API call
- Invalid image file (not a recognized image format) → error with guidance

## File Naming

Generated images are saved with descriptive filenames:

```
{YYYY-MM-DD}-{slug}-{hex}.png
```

- Date prefix for chronological sorting
- Slug: first 40 chars of prompt, lowercased, non-alphanumeric replaced with hyphens, collapsed
- 6-char random hex suffix to prevent collisions
- Always `.png` (Gemini returns PNG)

The output directory is created on first use if it doesn't exist (`fs.mkdirSync({ recursive: true })`).

## Autonomous Workflow Example

```
User: "Create a product announcement email for our new headphones
       with a hero image and lifestyle shot"

Claude Cowork:
  1. generate_image({
       prompt: "Premium wireless headphones floating on dark gradient...",
       aspect_ratio: "16:9",
       image_size: "2K"
     })
     → /Users/.../nanobanana-output/2026-03-22-premium-headphones-a1b2c3.png

  2. generate_image({
       prompt: "Person wearing sleek headphones in modern coffee shop...",
       aspect_ratio: "4:3"
     })
     → /Users/.../nanobanana-output/2026-03-22-headphones-lifestyle-d4e5f6.png

  3. gmail_create_draft({
       subject: "Introducing Our New Premium Headphones",
       body: "<html>...<img src='cid:hero'>...</html>",
       attachments: [".../premium-headphones-a1b2c3.png", ".../headphones-lifestyle-d4e5f6.png"]
     })
```

## Style Consistency Workflow

```
Claude Cowork:
  1. extract_visual_dna({ images: ["/path/to/brand-reference.jpg"] })
     → { "style": "...", "lighting": "...", ... }

  2. generate_image({
       prompt: "Product shot of wireless earbuds",
       visual_dna: { "style": "...", "lighting": "...", ... }
     })
     → consistent brand aesthetic

  3. generate_image({
       prompt: "Lifestyle shot with earbuds",
       visual_dna: { ...same DNA... }
     })
     → same aesthetic, different subject
```

## Testing

- Validate manifest with `mcpb pack --dry-run` (if available) or manual schema check
- Test each tool individually via MCP inspector or Claude Desktop
- Test autonomous workflow end-to-end: generate → use in email draft
- Test error cases: missing API key, invalid image paths, malformed DNA JSON, non-existent template
