# Architecture

## Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js >= 18 (ships with Claude Desktop) |
| Protocol | MCP (Model Context Protocol) via stdio transport |
| Framework | `@modelcontextprotocol/sdk` — server, tool registration, JSON-RPC |
| Validation | `zod` v3 — tool input schemas |
| HTTP | Node.js built-in `fetch` — Gemini API calls |
| Bundling | `esbuild` — single-file ESM bundle for distribution |
| Distribution | MCPB (MCP Bundle) — `.mcpb` zip with manifest v0.4 |
| Testing | Node.js built-in `node:test` + `node:assert` — zero test dependencies |
| Security scanning | Semgrep (203 community rules) |

### Dependencies

**Production (2):** `@modelcontextprotocol/sdk`, `zod`
**Dev (1):** `esbuild`
**Everything else** is Node.js built-ins: `fs`, `fs/promises`, `path`, `crypto`, `url`, `os`

---

## System Architecture

```mermaid
graph TD
    CD[Claude Desktop / Cowork] -->|MCP stdio JSON-RPC| S[MCP Server<br/>server/index.js]
    S -->|HTTPS POST<br/>x-goog-api-key header| G[Gemini API<br/>generativelanguage.googleapis.com]
    S -->|write images| FS[Output Directory<br/>~/Desktop/nanobanana-output/]
    S -->|read images| ANY[User filesystem<br/>any path with image extension + valid magic bytes]
    S -->|read| T[assets/templates/<br/>8 Visual DNA presets]
    S -->|read/write| E[.nanobanana-estimates.json<br/>EMA timing data]

    subgraph "server/index.js"
        direction TB
        CF[createServer<br/>factory function]
        CF --> Tools
        Tools[Tool Handlers<br/>generate_image · edit_image · check_generation<br/>extract_visual_dna · describe_image<br/>list_templates · get_template]
        Tools --> Security[Security Layer<br/>assertPathAllowed · validateImageBuffer<br/>realpathSync · statSync size check]
        Tools --> Queue[Job Queue<br/>in-memory Map · MAX_CONCURRENT_JOBS=5]
        Tools --> API[callGeminiAPI<br/>HTTP client · error classifier · sanitized errors]
        Queue --> Heuristic[EMA Heuristic<br/>auto-improving time estimates]
    end
```

### Project Structure

```
nanobananaMCPB/
├── manifest.json              # MCPB manifest v0.4 — identity, config, tool declarations
├── icon.png                   # Extension icon
├── server/
│   └── index.js               # Entire server — tools, API client, security, job queue
├── assets/
│   └── templates/             # 8 Visual DNA style presets (.json)
├── test/
│   ├── server.test.js         # Unit tests (87 tests)
│   ├── e2e.test.js            # MCP end-to-end via InMemoryTransport (17 tests)
│   ├── integration.test.js    # File-level integration (5 tests)
│   └── live.test.js           # Real Gemini API tests (10 tests, opt-in)
├── dist/
│   └── index.js               # esbuild bundle (production entry point)
├── ARCHITECTURE.md
├── TESTING.md
├── EXAMPLES.md
├── PRIVACY.md
└── README.md
```

---

## Data Flow

### Image Generation

```mermaid
sequenceDiagram
    participant C as Claude (MCP Client)
    participant S as MCP Server
    participant G as Gemini API
    participant FS as Filesystem

    C->>S: generate_image(prompt, size, level)
    S->>S: activeJobCount >= 5? reject
    S->>S: validate visual_dna (max 20 keys, 500 chars)
    S->>S: ensureOutputDir()
    S->>S: createJob(jobId) — reserve slot
    S-->>C: job_id + output_path + estimate<br/>(returns in <1ms)

    note over S,G: fire-and-forget (background)
    S->>G: POST /generateContent<br/>x-goog-api-key header
    G-->>S: image data (base64)
    S->>FS: writeFileSync(filePath, buffer)
    S->>S: completeJob → recordActualTime → saveEstimates

    note over C: waits ~estimate seconds
    C->>S: check_generation(job_id)
    S-->>C: status: complete, file size, actual time
```

### Image Editing

```mermaid
sequenceDiagram
    participant C as Claude
    participant S as MCP Server
    participant G as Gemini API

    C->>S: edit_image(images, prompt)
    S->>S: activeJobCount >= 5? reject
    S->>S: createJob — reserve slot before I/O

    note over S: loadImageParts (security chain)
    S->>S: assertPathAllowed(literal path) — extension check
    S->>S: realpathSync — resolve symlinks
    S->>S: assertPathAllowed(real path) — extension of target
    S->>S: statSync — reject if > 20 MB
    S->>S: readFile — async read
    S->>S: validateImageBuffer — magic bytes check

    S-->>C: job_id + output_path

    note over S,G: fire-and-forget
    S->>G: POST (base64 images + prompt)
    G-->>S: edited image
    S->>S: writeFileSync → completeJob
```

**Key difference from generate:** The job slot is reserved *before* `loadImageParts` (which awaits file I/O) to prevent race conditions in the concurrent job limit.

### Analysis Tools (extract_visual_dna, describe_image)

```mermaid
flowchart LR
    A[images array] --> B[loadImageParts<br/>security chain]
    B --> C[base64 inlineData]
    C --> D[callGeminiAPI<br/>modalities: TEXT]
    D --> E[text response<br/>returned inline to client]
```

These are synchronous (not fire-and-forget) — the tool blocks until the API responds. Results go directly into context for chaining, not saved to files.

### Template Flow

```mermaid
flowchart LR
    A[get_template name] --> B{isValidTemplateName<br/>^a-zA-Z0-9_-+$}
    B -->|invalid| C[Error: Invalid template name]
    B -->|valid| D[join getTemplateDir, name.json]
    D --> E{exists?}
    E -->|no| F[Error: Template not found]
    E -->|yes| G[readFileSync → return JSON]
```

---

## Async Generation Architecture

Image generation takes 10–135 seconds. The MCP client imposes a ~60s timeout. The server returns immediately and runs the API call in the background.

### Job State Machine

```mermaid
stateDiagram-v2
    [*] --> processing : createJob()
    processing --> complete : completeJob()<br/>writes file, records actual time
    processing --> failed : failJob(error)<br/>Gemini error, write failure, or validation error
    complete --> [*] : pruneJobs()<br/>after 30 min TTL
    failed --> [*] : pruneJobs()<br/>after 30 min TTL

    note right of processing
        never pruned while processing
        null completedAt guarded
    end note
```

### Concurrency

- **MAX_CONCURRENT_JOBS = 5** — checked before `createJob`, rejected with error if exceeded
- **No locking needed** — Node.js single-threaded event loop; Promise `.then()` callbacks are microtasks processed sequentially
- **Unique filenames** — date + slug + 6-byte random hex prevents collisions across parallel jobs
- **Lazy pruning** — `pruneJobs()` runs on every `check_generation` call, removing settled jobs older than 30 minutes

---

## EMA Time Heuristic

The server estimates generation time per `image_size x thinking_level` so Claude can wait an informed interval before polling.

### Prior Estimates (seconds, includes 1.5x margin)

|          | `minimal` | `high` |
|----------|-----------|--------|
| **0.5K** | 20        | 30     |
| **1K**   | 30        | 45     |
| **2K**   | 50        | 75     |
| **4K**   | 90        | 135    |

### Self-Improvement

```mermaid
flowchart LR
    A[Job completes<br/>actual = 38s] --> B[observed = 38 x 1.5<br/>= 57s]
    B --> C[new = 0.25 x 57 + 0.75 x 45<br/>= 48s]
    C --> D[save to<br/>.nanobanana-estimates.json]
    D --> E[next generation<br/>uses 48s estimate]
```

- **Alpha = 0.25** — each observation contributes 25% weight, smoothing outliers
- **Margin = 1.5x** — estimates target 150% of actual (overestimate is less disruptive than a missed poll)
- **Persists across restarts** — 8-cell table written to `OUTPUT_DIR/.nanobanana-estimates.json`
- **Schema-validated on load** — all sizes/levels must be numbers; `sampleCounts` also validated

---

## Security Architecture

### Image Loading Pipeline

Every image path passes through four checks before any bytes are read or sent:

```mermaid
flowchart TD
    A[user-supplied path] --> B{extension allowlist<br/>jpg/jpeg/png/webp/gif/bmp/tiff/tif/heic/heif/avif}
    B -->|rejected| X1[Access denied]
    B -->|passed| C[realpathSync<br/>resolve symlinks]
    C -->|ENOENT| X2[File not found]
    C -->|resolved| D{extension of REAL path<br/>same allowlist}
    D -->|rejected| X3[Access denied<br/>symlink to non-image]
    D -->|passed| E{statSync<br/>size <= 20 MB?}
    E -->|too large| X4[File too large]
    E -->|ok| F[readFile async]
    F --> G{validateImageBuffer<br/>magic bytes check}
    G -->|invalid| X5[Not valid image data]
    G -->|valid| H[base64 encode<br/>send to API]
```

### Magic Bytes Validation

| Format | Signature |
|--------|-----------|
| PNG | `89 50 4E 47` |
| JPEG | `FF D8 FF` |
| WebP | `RIFF....WEBP` (12 bytes) |
| GIF | `GIF8` |
| BMP | `BM` |
| TIFF | `II*\0` or `MM\0*` |
| HEIF/AVIF | `ftyp` at offset 4 + brand allowlist (`heic`/`heix`/`hevc`/`mif1`/`msf1`/`avif`/`avis`) at offset 8 |

### Other Security Measures

| Concern | Defense |
|---------|---------|
| API key leakage | Sent via `x-goog-api-key` header, never in URL |
| Error body reflection | Gemini error responses sanitized — extracts `error.message` only |
| Template path traversal | `isValidTemplateName` allowlist: `^[a-zA-Z0-9_-]+$` |
| Job queue DoS | `MAX_CONCURRENT_JOBS = 5` |
| `visual_dna` payload | Max 20 keys, 500 chars per value |
| Prototype pollution | `loadEstimates` validates both `table` and `sampleCounts` schemas |
| MCP log failures | `ctx.mcpReq.log` wrapped in try/catch — non-fatal |
| Empty HOME | Throws at startup if `HOME` and `USERPROFILE` both unset |

---

## Error Handling

### Immediate Errors (returned from tool call)

- Concurrent job limit exceeded
- `visual_dna` validation failure
- `loadImageParts` failure (extension, symlink, size, magic bytes, not found)
- Invalid template name / template not found

### Deferred Errors (discovered via polling)

```mermaid
flowchart LR
    A[callGeminiAPI fails<br/>in fire-and-forget] --> B[.catch → failJob<br/>jobId, err.message]
    B --> C[client polls<br/>check_generation]
    C --> D[Status: failed<br/>Error: message]
```

Covers: safety blocks, recitation, max tokens, quota, network errors, disk write failures.

### Gemini Error Classification

```mermaid
flowchart TD
    R[API Response] --> OK{response.ok?}
    OK -->|no| E1[extract error.message from JSON body<br/>or generic status message]
    OK -->|yes| DE{data.error?}
    DE -->|yes| E2[error.message or 'unknown error']
    DE -->|no| NC{candidates?}
    NC -->|empty + promptFeedback| E3[Prompt blocked]
    NC -->|empty| E4[No candidates]
    NC -->|present| FR{finishReason}
    FR -->|STOP / UNSPECIFIED| OK2[extract image or text]
    FR -->|SAFETY| E5[safety filters + category names]
    FR -->|RECITATION| E6[copyright policy]
    FR -->|MAX_TOKENS| E7[token limit]
    FR -->|other| E8[raw finishReason value]
```

---

## Configuration

Configured at install time via Claude Desktop's settings UI. Passed as environment variables by the MCPB runtime.

| Setting | Env var | Default |
|---------|---------|---------|
| Gemini API Key | `GEMINI_API_KEY` | required |
| Output Directory | `OUTPUT_DIR` | `~/Desktop/nanobanana-output` |
| Gemini Model | `GEMINI_MODEL` | `gemini-3.1-flash-image-preview` |
| Strip Image Metadata | `STRIP_METADATA` | `true` |

`OUTPUT_DIR` is evaluated lazily via `getOutputDir()` (not frozen at module load). Supports `${HOME}`, `$(HOME)`, and `~` prefixes that the MCPB runtime may pass through literally.

`STRIP_METADATA` controls automatic JPEG EXIF/IPTC stripping in `loadImageParts`. When enabled (default), APP1 (EXIF), APP13 (IPTC), and COM segments are removed from JPEG buffers before base64 encoding. Non-JPEG formats are passed through unchanged.

---

## Build and Distribution

```bash
npm run build     # esbuild → dist/index.js (ESM, Node.js externals)
npm run pack      # build + pack .mcpb archive
npm run validate  # validate manifest.json against MCPB schema
```

The esbuild bundle:
- Format: ESM (`--format=esm`, matches `"type": "module"`)
- Platform: Node.js (`--platform=node`)
- Externals: all `node:*` built-ins
- Banner: `createRequire` polyfill for CJS dependencies from the SDK

The `.mcpb` file is installed in Claude Desktop via **Settings > Extensions > Advanced settings > Install Extension**.
