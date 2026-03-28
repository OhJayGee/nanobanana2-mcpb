# TODO

## Multi-Model Support

The server currently hardcodes behavior for `gemini-3.1-flash-image-preview`. To support `gemini-2.5-flash-image` (GA/production, more stable) and `gemini-3-pro-image-preview` (higher quality) as alternatives, the following changes are needed.

### Model capability differences

| Capability | 3.1 Flash (preview) | 2.5 Flash (GA) | 3 Pro (preview) |
|------------|---------------------|-----------------|-----------------|
| Thinking (`thinkingConfig`) | Yes | **No** | Yes |
| Max input images | 14 | **3** | 14 |
| Aspect ratios | 14 (incl 1:4, 4:1, 1:8, 8:1) | 10 | 10 |
| Image size control | 0.5K, 1K, 2K, 4K | Not documented | 1K, 2K, 4K |
| `responseModalities` | `["IMAGE"]` works | Needs `["TEXT","IMAGE"]` | Needs `["TEXT","IMAGE"]` |
| Stability | Preview — intermittent 503s, connection hangs | **GA/stable** | Preview |
| Speed | Fast | Fast | Slower, higher quality |
| Search grounding | Yes | No | Yes |

### Required code changes

1. **Model capability registry** — define per-model config (supported thinking levels, max images, aspect ratios, modalities, size options) rather than hardcoding constants inside `createServer()`

2. **Conditional `thinkingConfig`** — only include in the request body for models that support it; currently always sent in `callGeminiAPI`

3. **Dynamic input validation** — `edit_image` Zod schema currently hardcodes `.max(14)` for images and the full aspect ratio enum; these need to adapt based on the active model

4. **`responseModalities` fix** — send `["TEXT", "IMAGE"]` instead of `["IMAGE"]` for models that require it (2.5 Flash, possibly 3 Pro); the current code sends whichever modality the tool handler specifies

5. **EMA estimates per model** — different models have different latency profiles; the estimate table should be keyed by model as well as size/thinking level

6. **Fallback/retry strategy** — optionally retry on 503/timeout with a different model; needs careful handling since model capabilities differ (can't retry a 14-image edit on 2.5 Flash)

7. **User config** — the `gemini_model` setting already exists in `manifest.json`; consider changing it to a dropdown with known-good values, or adding a separate "fallback model" setting

### Pricing comparison

| Model | Cost per 1K image | $10/month budget |
|-------|-------------------|------------------|
| Nano Banana (2.5 Flash, GA) | ~$0.04 | ~256 images |
| Nano Banana 2 (3.1 Flash, preview) | ~$0.07 | ~149 images |
| Nano Banana Pro (3 Pro, preview) | ~$0.13 | ~74 images |

Failed requests (503s) are not charged.

### Not needed (for Gemini multi-model)

- No endpoint changes — all three models use the same `generateContent` API
- No response parsing changes — all return `inlineData.data` (base64 PNG)
- No auth changes — same `x-goog-api-key` header

---

## Imagen 4 as Alternative Provider

Imagen 4 is available via the same Google AI API key. Three variants confirmed accessible:

| Model ID | Name | Speed |
|----------|------|-------|
| `imagen-4.0-generate-001` | Imagen 4 | Standard |
| `imagen-4.0-ultra-generate-001` | Imagen 4 Ultra | Slow, highest quality |
| `imagen-4.0-fast-generate-001` | Imagen 4 Fast | Fastest |

### Key differences from Gemini Nano Banana models

| | Gemini (current) | Imagen 4 |
|---|---|---|
| API method | `generateContent` | `predict` (different contract) |
| Image editing | Yes (multi-image input) | **No** — text-to-image only |
| Visual DNA / style transfer | Yes (via `visual_dna` param) | No |
| Image description | Yes (`TEXT` modality) | No |
| Auth | `x-goog-api-key` header | Same |
| Response format | `inlineData.data` (base64) | TBD — needs investigation |

### Integration scope

Imagen 4 would only cover `generate_image` — it cannot replace `edit_image`, `extract_visual_dna`, or `describe_image` since those require image input or text output, which Imagen doesn't support.

### Required work

1. **Investigate `predict` API contract** — request/response format differs from `generateContent`; need to determine how prompt, aspect ratio, resolution, and number of outputs are specified

2. **Separate API client** — `callGeminiAPI` is built around `generateContent`; Imagen needs its own client function or a generalized abstraction

3. **Tool routing** — `generate_image` would need to decide which backend to use based on user config or a model selector parameter

4. **Fallback chain** — could use Imagen 4 Fast as a fallback when Gemini preview models return 503, since it only needs to handle generation (not editing)

5. **Pricing investigation** — Imagen 4 pricing not yet confirmed; needs research before committing to it as a default
