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

### Not needed

- No endpoint changes — all three models use the same `generateContent` API
- No response parsing changes — all return `inlineData.data` (base64 PNG)
- No auth changes — same `x-goog-api-key` header
