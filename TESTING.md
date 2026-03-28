# Nanobanana MCPB — Test Documentation

## Running Tests

```bash
npm test                    # Unit, e2e, and integration tests (120 tests, mocked API)
npm run scan                # Semgrep security scan (203 rules)

# Live integration tests (real Gemini API, requires API key)
NANOBANANA_LIVE_TEST=1 NANOBANANA_TEST=1 node --test test/live.test.js
```

Uses Node.js native `node:test` runner. No test framework dependencies.

The `NANOBANANA_TEST=1` env var prevents the MCP server from auto-starting via stdio during test imports.

**Current state:** 120 tests, 22 suites, 0 failures. 10 additional live tests (skipped unless `NANOBANANA_LIVE_TEST=1`).

---

## Test Structure

```
test/
├── server.test.js       # Unit tests — helpers, security, job queue, API client (97 tests)
├── e2e.test.js           # End-to-end MCP tests via InMemoryTransport (18 tests)
├── integration.test.js   # File-level integration — templates, loadImageParts (5 tests)
└── live.test.js          # Live Gemini API tests — real generation (10 tests, opt-in)
```

### Test layers

| Layer | File | What it tests | API mocked? |
|-------|------|---------------|-------------|
| Unit | `server.test.js` | Exported functions in isolation | Yes (`globalThis.fetch`) |
| E2E | `e2e.test.js` | Full MCP protocol: Client → InMemoryTransport → McpServer → tool handlers | Yes |
| Integration | `integration.test.js` | Real files on disk (templates, image validation) | N/A |
| Live | `live.test.js` | Real Gemini API — actual image generation, editing, analysis | No |

---

## E2E Test Harness

The e2e tests use the MCP SDK's `InMemoryTransport` to wire a real `Client` directly to the server in-process — no subprocess, no stdio:

```js
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../server/index.js";

const server = createServer();
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
const client = new Client({ name: "test", version: "1.0.0" });
await client.connect(clientTransport);

// Call any tool end-to-end
const result = await client.callTool({ name: "list_templates", arguments: {} });
```

This exercises the full stack: JSON-RPC serialization, Zod schema validation, tool dispatch, job queue, file I/O, and response formatting. The only mock is `globalThis.fetch` for the Gemini API.

### E2E coverage (17 tests)

| Tool | Tests |
|------|-------|
| Tool listing | Verifies all 7 tools registered |
| `generate_image` | Full queue → poll → complete flow; API failure recorded on job; `visual_dna` key count and value length limits |
| `edit_image` | Valid image input; non-image path rejected; fake-image-content rejected (magic bytes); EXIF stripped from JPEG before API upload |
| `check_generation` | Unknown job_id; list-all-jobs |
| `extract_visual_dna` | Structured JSON response from mocked API |
| `describe_image` | Text response from mocked API |
| `list_templates` | Returns known template names |
| `get_template` | Valid template; invalid name; nonexistent template |

---

## Live Integration Tests

Run against the real Gemini API. Requires `GEMINI_API_KEY` in environment. Skipped by default.

```bash
NANOBANANA_LIVE_TEST=1 NANOBANANA_TEST=1 node --test test/live.test.js
```

The tests follow the server's async architecture:

```
Phase 1: Queue jobs (instant)     — tests MCP dispatch + job creation
Phase 2: Poll until settled       — single loop, best-effort, non-fatal on timeout
Phase 3: Verify + analyze         — validate images on disk, run edit/describe/DNA tools
```

### Live test suite (10 tests)

| Phase | Test | What it verifies |
|-------|------|-----------------|
| 1 | Queue rubber duck (0.5K) | `generate_image` returns `job_id` + `output_path` |
| 1 | Queue styled coffee (1K) | `generate_image` with `style` parameter |
| 1 | Queue red circle (0.5K) | Source image for the edit test |
| 2 | Poll all jobs | All 3 jobs reach terminal state (complete/failed) |
| 3 | Verify duck PNG | File exists, > 1 KB, valid PNG magic bytes |
| 3 | Verify coffee PNG | File exists, > 5 KB |
| 3 | Edit red circle | `edit_image` on a real generated image, poll for completion |
| 3 | Describe duck | `describe_image` returns substantial text description |
| 3 | Extract coffee DNA | `extract_visual_dna` returns parseable JSON with style/lighting/camera fields |
| 3 | List all jobs | `check_generation` lists all jobs from the session |

Generated images are kept in a temp directory printed at the end of the run for manual inspection.

---

## Unit Test Suites

### `resolveHome` — 5 tests

Resolves `${HOME}`, `$(HOME)`, and `~` prefixes to the actual home directory. Verifies mid-path occurrences are not replaced.

### `getOutputDir` — 1 test

Verifies lazy evaluation — `OUTPUT_DIR` env var is read at call time, not module load time.

### `slugify` — 5 tests

Converts prompts to filename-safe slugs. Tests lowercasing, truncation (40 chars), hyphen collapsing, and edge cases where truncation lands on a hyphen.

### `detectMimeType` — 4 tests

Extension-based MIME detection. Case-insensitive. Defaults to `image/jpeg` for unknown extensions.

### `generateFilename` — 1 test

Produces `YYYY-MM-DD-slug-hex.png` format, verified by regex.

### `estimateSeconds` — 2 tests

EMA-based generation time estimates. Tests valid positive results for all size/level combinations, and fallback for unknown parameters.

### `job queue` — 6 tests

Full lifecycle: create → complete/fail → prune.

| Test | What it verifies |
|------|-----------------|
| Create, complete, retrieve | All fields set; `completedAt` set on complete |
| Failed jobs | `status: "failed"`, error message, `completedAt` set |
| Unknown job | Returns `null` |
| List all jobs | `getAllJobs()` contains created job |
| Prune old finished jobs | Old complete pruned; recent complete kept; processing kept |
| Null `completedAt` guard | Non-processing job with `completedAt: null` is not pruned |

### `activeJobCount` — 1 test

Counts only `"processing"` jobs. Verified by creating a job (count increments) then completing it (count returns to baseline).

### `job queue edge cases` — 2 tests

`completeJob` and `failJob` on unknown IDs are no-ops.

### `recordActualTime` — 3 tests

EMA update: pushes estimate high, then observes a fast time, verifies estimate decreases. Tests sample count increment and graceful handling of unknown parameters.

### `callGeminiAPI` — 20 tests

Tested exclusively with mocked `globalThis.fetch`. Covers the full error taxonomy:

| Category | Tests |
|----------|-------|
| Authentication | Missing API key; key sent in `x-goog-api-key` header (not URL) |
| Request structure | Body structure matches expected schema |
| Success paths | TEXT modality returns string; IMAGE modality returns Buffer; `FINISH_REASON_UNSPECIFIED` treated as success |
| HTTP errors | Non-2xx with JSON body (extracts `error.message`); non-2xx with non-JSON body (generic message); network error (`fetch` throws) |
| API-level errors | `data.error` on 200 OK; `data.error` with missing `message` field (falls back to "unknown error") |
| Content filtering | `SAFETY` (with category names); `RECITATION`; `MAX_TOKENS`; unexpected `finishReason`; `promptFeedback` block |
| Response validation | IMAGE response missing `inlineData`; TEXT response missing `text` part |

### `isValidTemplateName` — 6 tests

Allowlist regex `^[a-zA-Z0-9_-]+$`. Tests valid names, path traversal (`../../`), slashes, backslashes, dots, spaces, special characters, and empty string.

### `assertPathAllowed` — 3 tests

Extension-based allowlist. Accepts standard image extensions (`.png`, `.jpg`, `.webp`, `.heic`). Rejects non-image files (`/etc/passwd`, `.txt`, `.ssh/id_rsa`) and relative path traversal.

### `validateImageBuffer` — 12 tests

Magic-bytes validation for 7 image formats:

| Format | Magic bytes checked |
|--------|-------------------|
| PNG | `89 50 4E 47` |
| JPEG | `FF D8 FF` |
| WebP | `RIFF....WEBP` (12 bytes) |
| GIF | `GIF8` |
| BMP | `BM` |
| TIFF | `II*\0` (little-endian) or `MM\0*` (big-endian) |
| HEIF/AVIF | `ftyp` at offset 4 + brand (`heic`/`heix`/`hevc`/`mif1`/`msf1`/`avif`/`avis`) at offset 8 |

Also tests: rejection of non-image content, rejection of buffers too small (< 4 bytes), and rejection of `ftyp` with non-image brand (e.g. `isom` MP4).

### `stripJpegMetadata` — 7 tests

Pure JS JPEG segment parser that removes privacy-sensitive metadata before API upload.

| Test | What it verifies |
|------|-----------------|
| Strips APP1 (EXIF) | GPS coordinates and device info removed from output |
| Strips APP13 + COM | IPTC creator data and software comments removed |
| Preserves image data | SOS marker and compressed data intact, EOI at end |
| Smaller output | Stripped buffer is smaller than original |
| Non-JPEG passthrough | PNG buffer returned by reference (no copy) |
| No-metadata JPEG | JPEG without APP1 handled without error |
| Edge cases | Empty buffer, 1-byte buffer, SOI-only buffer — no crash |

### `loadImageParts` — 9 tests

End-to-end image loading pipeline:

| Test | What it verifies |
|------|-----------------|
| Valid PNG file | Reads file, returns correct mimeType + base64 data |
| Multiple images | Concurrent loading via `Promise.all` |
| Non-image path | Extension check rejects `/etc/passwd` |
| Fake image content | File named `.png` but containing text → magic bytes check rejects |
| Nonexistent file | `realpathSync` throws ENOENT → clean error message |
| Symlink to non-image | Symlink `foo.png → /etc/hosts` → real path extension check rejects |
| Non-regular file | Directory with `.png` name → rejected with "not a regular file" |
| Empty array | Throws "at least one image path" |
| Too many images | > 14 images throws |

### `loadEstimates / saveEstimates` — 9 tests

Persistence layer for EMA timing data. Uses temp directories.

| Test | What it verifies |
|------|-----------------|
| Round-trip | Write fixture → `loadEstimates()` → values match |
| Missing file | Silent no-op |
| Corrupt JSON | Silent no-op |
| Wrong table structure | Missing sizes → table not loaded |
| Non-number table values | `"fast"` instead of number → table not loaded |
| Non-number sample counts | `"lots"` instead of number → samples not loaded |
| Array-typed samples | `samples: [1,2,3]` → samples not loaded |
| NaN table values | `NaN` passes `typeof === "number"` but fails `isFinite` check → rejected |
| Infinity table values | `Infinity` fails `isFinite` check → rejected |

### `integration: template files exist` — 2 tests

Reads real template files from `assets/templates/`. Verifies at least 2 exist and each has a `style` field.

### `integration: loadImageParts validation` — 3 tests

Tests `loadImageParts` argument validation with invalid inputs (empty array, nonexistent file, > 14 images).

---

## Security Testing

### Semgrep

```bash
npm run scan
# equivalent to: semgrep --config=auto server/index.js
```

Runs 203 rules (156 JS-specific + 47 multi-language) from the Semgrep community registry. **Current state:** 0 findings.

Re-run when: new tools are added, file I/O or API logic changes, or dependencies are updated.

### Security-specific unit tests

The test suite includes targeted security tests across multiple suites:

| Attack vector | Test coverage |
|--------------|--------------|
| Path traversal | `isValidTemplateName` rejects `../../`, `/`, `\`; `assertPathAllowed` rejects non-image extensions |
| Arbitrary file read | `loadImageParts` rejects non-image paths, fake image content, symlinks to non-image files |
| API key leakage | `callGeminiAPI` sends key in header not URL; error responses sanitized (no raw body reflection) |
| File exfiltration | `validateImageBuffer` blocks non-image content even with image extension |
| Prototype pollution | `loadEstimates` validates table and sample schemas before assigning to live state |
| DoS / resource exhaustion | `activeJobCount` tracks concurrent jobs (capped at 5 in handlers) |
| Symlink attacks | `loadImageParts` resolves symlinks via `realpathSync` and checks extension of real target |

---

## What Is Not Tested

| Area | Reason |
|------|--------|
| `ensureOutputDir` | Internal function (not exported), called only from tool handlers which are e2e tested |
| `getTemplateDir` | Returns a static path; exercised indirectly by template integration tests |
| `writeFileSync` in fire-and-forget | Tested via e2e (mocked API writes to disk) and live tests (real files) |
| `MAX_IMAGE_BYTES` enforcement | 20 MB threshold; not tested due to impractical file size, but the `statSync` check is trivial |
| `MAX_CONCURRENT_JOBS` enforcement in handlers | Logic is inside tool handlers; `activeJobCount` helper is unit tested |
| MCP protocol edge cases | Handled by the `@modelcontextprotocol/sdk` library |
