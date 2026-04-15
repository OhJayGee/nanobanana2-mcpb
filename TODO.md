# TODO

## Current State (as of 2026-04-13)

**Version:** 1.5.0
**Tests:** 122 passing (unit + e2e + integration)
**Production reliability:** 68% success rate over 87 API calls (59 OK, 4 × 503, 23 timeouts)

The primary issue is `gemini-3.1-flash-image-preview` instability — intermittent 503s and silent hangs causing ~30% failure rate. The throttle (max 2 concurrent, 10s±2s stagger) prevents burst drops but can't fix server-side overload.

---

## Priority 1: gemini-2.5-flash-image Fallback

The only GA (non-preview) Gemini image model. Same `generateContent` API. Cheapest option.

### Verified via live API testing (2026-04-13)

- `responseModalities: ["IMAGE"]` works (contrary to earlier research that said it needs `["TEXT","IMAGE"]`)
- Aspect ratio via `generationConfig.imageConfig.aspectRatio` works — tested 16:9, got 1344x768
- No `thinkingConfig` support — must be omitted from request body
- Our current code passes aspect ratio via prompt text (`jsonPrompt.aspect_ratio`), not `imageConfig` — the 2.5 model ignores it in prompt text and returns 1024x1024 square

### Model capability comparison (verified)

| Capability | 3.1 Flash (preview, current) | 2.5 Flash (GA) | 3 Pro (preview) |
|------------|------------------------------|-----------------|-----------------|
| Thinking (`thinkingConfig`) | Yes | **No — must omit** | Yes |
| Max input images | 14 | **3** | 14 |
| Aspect ratio via prompt text | Works | **Ignored** | TBD |
| Aspect ratio via `imageConfig` | TBD (API hung during test) | **Works** | TBD |
| Image size via prompt text | Works | TBD | TBD |
| `responseModalities` | `["IMAGE"]` works | `["IMAGE"]` works | TBD |
| Stability | 68% success rate | **GA/stable** | Preview |
| Cost per 1K image | ~$0.07 | **~$0.04** | ~$0.13 |
| Display name | Nano Banana 2 | Nano Banana | Nano Banana Pro |

### Required code changes for 2.5 Flash support

1. **Conditional `thinkingConfig`** — only include for models that support it
   ```js
   // In callGeminiAPI, check model before adding thinkingConfig
   if (supportsThinking(GEMINI_MODEL)) {
     body.generationConfig.thinkingConfig = { includeThoughts, thinkingLevel };
   }
   ```

2. **Aspect ratio via `imageConfig`** — currently passed in prompt text which 2.5 ignores. Move to `generationConfig.imageConfig.aspectRatio` (works on 2.5, needs testing on 3.1)
   ```js
   body.generationConfig.imageConfig = { aspectRatio: aspect_ratio };
   ```

3. **Max input images** — lower from 14 to 3 when using 2.5 Flash

4. **Thinking level parameter** — hide from tool schema when model doesn't support thinking, or accept but ignore

5. **Image size** — test whether 2.5 supports size control via prompt text or `imageConfig`

6. **EMA estimates per model** — key the estimate table by model

### Simplest viable implementation

Just make `callGeminiAPI` model-aware:
- If model contains "2.5": omit `thinkingConfig`, use `imageConfig` for aspect ratio
- If model contains "3": include `thinkingConfig`, use `imageConfig` for aspect ratio (needs verification)
- Keep everything else the same

User selects model via the existing `gemini_model` setting in Claude Desktop.

---

## Priority 2: Aspect Ratio Fix (All Models)

Our current code passes aspect ratio as text in the prompt:
```js
const jsonPrompt = { content: prompt, aspect_ratio, image_size };
const parts = [{ text: JSON.stringify(jsonPrompt) }];
```

This relies on the model interpreting the JSON — it works on 3.1 Flash but is ignored by 2.5 Flash. The proper API way is:
```js
body.generationConfig.imageConfig = { aspectRatio: "16:9" };
```

This should be fixed for all models regardless of multi-model support. Needs testing on 3.1 Flash (the API hung during our test, so unverified).

---

## Priority 3: Imagen 4 as Alternative Provider

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

Imagen 4 would only cover `generate_image` — it cannot replace `edit_image`, `extract_visual_dna`, or `describe_image` since those require image input or text output.

### Required work

1. **Investigate `predict` API contract** — request/response format, aspect ratio, resolution, output count
2. **Separate API client** — `callGeminiAPI` is built around `generateContent`
3. **Tool routing** — `generate_image` selects backend based on user config
4. **Fallback chain** — Imagen 4 Fast as fallback when Gemini returns 503
5. **Pricing investigation** — Imagen 4 pricing not yet confirmed

---

## Production Stats

### Reliability by day (v1.4.3+ with throttle)

| Date | Total | OK | 503 | Timeout | Rate |
|------|-------|----|-----|---------|------|
| Apr 4 | 5 | 5 | 0 | 0 | 100% |
| Apr 5 | 5 | 3 | 0 | 2 | 60% |
| Apr 6 | 12 | 6 | 1 | 5 | 50% |
| Apr 7 | 6 | 5 | 0 | 1 | 83% |
| Apr 8 | 8 | 6 | 0 | 2 | 75% |
| Apr 9 | 5 | 5 | 0 | 0 | 100% |
| Apr 10 | 6 | 5 | 0 | 0 | 83% |
| Apr 11 | 6 | 5 | 0 | 1 | 83% |
| Apr 12 | 5 | 5 | 0 | 0 | 100% |
| Apr 13 | 5 | 2 | 0 | 3 | 40% |

### Failure pattern

- Most usage at 05:00-07:00 local (EU morning) — this is when failures are highest
- 09:00 local has 100% success (small sample)
- Preview model has unpredictable latency: 13s to 536s for successful calls
- Failed requests are either 503 ("high demand") or silent hangs (no response within 300s)
- The throttle (max 2 concurrent, 10s±2s stagger) eliminated burst-related drops but can't fix server-side overload

### GCP monitoring

- Cloud Logging enabled on `gen-lang-client-0387154380`
- Cloud Monitoring dashboard: [Nanobanana API Usage](https://console.cloud.google.com/monitoring/dashboards/builder/6803850b-0f78-4a41-8f67-7ed5e20fdf48?project=gen-lang-client-0387154380)
- BigQuery billing export configured (dataset: `billing_export`) — tables should be populated
