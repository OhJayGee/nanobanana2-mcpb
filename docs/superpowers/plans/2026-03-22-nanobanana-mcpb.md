# Nanobanana MCPB Extension Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an MCPB extension that exposes nanobanana image generation/editing capabilities as MCP tools for Claude Desktop and Claude Cowork.

**Architecture:** Single-file Node.js MCP server (`server/index.js`) communicating via stdio transport. All 6 tools share one internal `callGeminiAPI()` function that POSTs to the Gemini API. Images save to a user-configured output directory. Bundled as an `.mcpb` zip archive with manifest v0.4.

**Tech Stack:** Node.js >= 18, `@modelcontextprotocol/sdk`, `zod` (v3), built-in `fetch`/`fs`/`path`/`crypto`

**Spec:** `docs/superpowers/specs/2026-03-22-nanobanana-mcpb-design.md`

---

## File Structure

| File | Responsibility |
|------|----------------|
| `manifest.json` | MCPB manifest v0.4 — identity, server config, user_config, tool declarations, compatibility |
| `package.json` | NPM dependencies and metadata |
| `server/index.js` | MCP server — all 6 tool registrations + Gemini API client |
| `assets/templates/cinematic_fujifilm.json` | Pre-built Visual DNA template |
| `assets/templates/blueprint_3d.json` | Pre-built Visual DNA template |
| `test/server.test.js` | Unit tests for helpers + API client |
| `test/integration.test.js` | Integration tests for templates + loadImageParts validation |

---

### Task 1: Project Scaffolding

**Files:**
- Create: `package.json`
- Create: `manifest.json`
- Create: `assets/templates/cinematic_fujifilm.json`
- Create: `assets/templates/blueprint_3d.json`
- Create: `.gitignore`

- [ ] **Step 1: Create .gitignore**

```
node_modules/
*.mcpb
```

- [ ] **Step 2: Create package.json**

```json
{
  "name": "nanobanana-mcpb",
  "version": "1.0.0",
  "description": "Nanobanana Image Studio — MCP Bundle for Claude Desktop",
  "type": "module",
  "private": true,
  "scripts": {
    "test": "NODE_NO_WARNINGS=1 NANOBANANA_TEST=1 node --test test/*.test.js",
    "pack": "npx @anthropic-ai/mcpb pack",
    "validate": "npx @anthropic-ai/mcpb validate"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.12.0",
    "zod": "^3.25.0"
  }
}
```

Note: `NANOBANANA_TEST=1` env var prevents server startup during tests.

- [ ] **Step 3: Install dependencies**

Run: `cd /Users/olv/SRC/nanobananaMCPB && npm install`
Expected: `node_modules/` created with SDK and zod

- [ ] **Step 4: Create manifest.json**

```json
{
  "$schema": "https://raw.githubusercontent.com/anthropics/mcpb/main/schemas/mcpb-manifest-v0.4.schema.json",
  "manifest_version": "0.4",
  "name": "nanobanana",
  "version": "1.0.0",
  "display_name": "Nanobanana Image Studio",
  "description": "Generate, edit, and analyze images using Nano Banana 2 (gemini-3.1-flash-image-preview)",
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
      "description": "Your Google AI Studio API key for Nano Banana 2",
      "sensitive": true,
      "required": true
    },
    "output_directory": {
      "type": "directory",
      "title": "Output Directory",
      "description": "Where generated and edited images are saved",
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

- [ ] **Step 5: Copy template files from nanobanana**

```bash
mkdir -p assets/templates
cp /Users/olv/SRC/nanobanana/nanobanana-cli/skills/nanobanana/assets/templates/cinematic_fujifilm.json assets/templates/
cp /Users/olv/SRC/nanobanana/nanobanana-cli/skills/nanobanana/assets/templates/blueprint_3d.json assets/templates/
```

- [ ] **Step 6: Initialize git and commit**

```bash
cd /Users/olv/SRC/nanobananaMCPB
git init
git add .gitignore package.json package-lock.json manifest.json assets/
git commit -m "feat: scaffold MCPB project with manifest and templates"
```

---

### Task 2: Helper Functions + Tests

**Files:**
- Create: `server/index.js` (helpers only — server wiring comes in Task 4)
- Create: `test/server.test.js`

- [ ] **Step 1: Write failing tests for helper functions**

Create `test/server.test.js`:

```javascript
import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
// Imports will be added in Step 4 once the module exists

describe("slugify", () => {
  it("lowercases and replaces non-alphanumeric with hyphens", () => {
    const input = "A Cyberpunk Forest!";
    const expected = "a-cyberpunk-forest";
    const result = slugify(input);
    assert.equal(result, expected);
  });

  it("truncates to 40 chars", () => {
    const input = "a".repeat(60);
    const result = slugify(input);
    assert.ok(result.length <= 40);
  });

  it("collapses consecutive hyphens", () => {
    const result = slugify("hello---world");
    assert.equal(result, "hello-world");
  });

  it("strips leading and trailing hyphens", () => {
    const result = slugify("--hello--");
    assert.equal(result, "hello");
  });

  it("handles truncation that lands on a hyphen", () => {
    // 39 a's + "!b" → slug is "aaa...aaa-b", slice(0,40) could cut mid-hyphen
    const input = "a".repeat(39) + " b";
    const result = slugify(input);
    assert.ok(!result.endsWith("-"), "should not end with hyphen");
    assert.ok(result.length <= 40);
  });
});

describe("detectMimeType", () => {
  it("returns image/png for .png", () => {
    assert.equal(detectMimeType("photo.png"), "image/png");
  });

  it("returns image/png for .PNG (case insensitive)", () => {
    assert.equal(detectMimeType("photo.PNG"), "image/png");
  });

  it("returns image/webp for .webp", () => {
    assert.equal(detectMimeType("photo.webp"), "image/webp");
  });

  it("defaults to image/jpeg", () => {
    assert.equal(detectMimeType("photo.jpg"), "image/jpeg");
    assert.equal(detectMimeType("photo.bmp"), "image/jpeg");
  });
});

describe("generateFilename", () => {
  it("produces YYYY-MM-DD-slug-hex.png format", () => {
    const name = generateFilename("A cool image");
    assert.match(name, /^\d{4}-\d{2}-\d{2}-a-cool-image-[0-9a-f]{6}\.png$/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/olv/SRC/nanobananaMCPB && npm test`
Expected: FAIL — `slugify`, `detectMimeType`, `generateFilename` not defined

- [ ] **Step 3: Implement helper functions in server/index.js**

Create `server/index.js`:

```javascript
import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const GEMINI_MODEL = "gemini-3.1-flash-image-preview";
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
const API_TIMEOUT_MS = 60_000;

const OUTPUT_DIR = process.env.OUTPUT_DIR || join(process.env.HOME || "", "Desktop", "nanobanana-output");

// ---------------------------------------------------------------------------
// Helpers (exported for testing)
// ---------------------------------------------------------------------------

export function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
}

export function detectMimeType(filePath) {
  const ext = filePath.toLowerCase().split(".").pop();
  if (ext === "png") return "image/png";
  if (ext === "webp") return "image/webp";
  return "image/jpeg";
}

export function generateFilename(prompt) {
  const date = new Date().toISOString().slice(0, 10);
  const slug = slugify(prompt);
  const hex = randomBytes(3).toString("hex");
  return `${date}-${slug}-${hex}.png`;
}

export function getTemplateDir() {
  return join(__dirname, "..", "assets", "templates");
}

export function loadImageParts(imagePaths) {
  if (!imagePaths || imagePaths.length === 0) {
    throw new Error("At least one image path is required");
  }
  if (imagePaths.length > 14) {
    throw new Error("Maximum 14 images allowed");
  }
  return imagePaths.map((imgPath) => {
    if (!existsSync(imgPath)) {
      throw new Error(`Image file not found: ${imgPath}`);
    }
    const buffer = readFileSync(imgPath);
    return {
      inlineData: {
        mimeType: detectMimeType(imgPath),
        data: buffer.toString("base64"),
      },
    };
  });
}

function ensureOutputDir() {
  mkdirSync(OUTPUT_DIR, { recursive: true });
}
```

This is the initial file with all helpers. The API client (Task 3) and server wiring (Task 4+) will be appended below these.

- [ ] **Step 4: Update test to import helpers**

Replace the comment at the top of `test/server.test.js` with:

```javascript
import { slugify, detectMimeType, generateFilename } from "../server/index.js";
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd /Users/olv/SRC/nanobananaMCPB && npm test`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add server/index.js test/server.test.js
git commit -m "feat: add helper functions with tests (slugify, MIME detection, filename generation)"
```

---

### Task 3: Gemini API Client

**Files:**
- Modify: `server/index.js` — add `callGeminiAPI()` function
- Modify: `test/server.test.js` — add API client tests (mocked fetch)

- [ ] **Step 1: Write failing tests for callGeminiAPI**

Add to `test/server.test.js` (update import line first):

```javascript
import { slugify, detectMimeType, generateFilename, callGeminiAPI } from "../server/index.js";
```

Then add test suite:

```javascript
describe("callGeminiAPI", () => {
  it("throws if GEMINI_API_KEY is not set", async () => {
    const origKey = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    try {
      await assert.rejects(
        () => callGeminiAPI({ parts: [{ text: "test" }], modalities: ["TEXT"], thinkingLevel: "minimal", includeThoughts: false }),
        { message: /GEMINI_API_KEY/ }
      );
    } finally {
      if (origKey) process.env.GEMINI_API_KEY = origKey;
    }
  });

  it("constructs correct request body structure", async () => {
    const origFetch = globalThis.fetch;
    let capturedBody;
    globalThis.fetch = async (url, opts) => {
      capturedBody = JSON.parse(opts.body);
      return {
        ok: true,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: "hello" }] } }]
        })
      };
    };
    process.env.GEMINI_API_KEY = "test-key";

    try {
      await callGeminiAPI({
        parts: [{ text: "test prompt" }],
        modalities: ["TEXT"],
        thinkingLevel: "high",
        includeThoughts: true
      });

      assert.deepEqual(capturedBody.contents, [{ parts: [{ text: "test prompt" }] }]);
      assert.deepEqual(capturedBody.generationConfig.responseModalities, ["TEXT"]);
      assert.equal(capturedBody.generationConfig.candidateCount, 1);
      assert.equal(capturedBody.generationConfig.thinkingConfig.thinkingLevel, "high");
      assert.equal(capturedBody.generationConfig.thinkingConfig.includeThoughts, true);
    } finally {
      globalThis.fetch = origFetch;
      delete process.env.GEMINI_API_KEY;
    }
  });

  it("returns text data for TEXT modality", async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: "extracted DNA" }] } }]
      })
    });
    process.env.GEMINI_API_KEY = "test-key";

    try {
      const result = await callGeminiAPI({
        parts: [{ text: "test" }],
        modalities: ["TEXT"],
        thinkingLevel: "minimal",
        includeThoughts: false
      });
      assert.equal(result.type, "text");
      assert.equal(result.data, "extracted DNA");
    } finally {
      globalThis.fetch = origFetch;
      delete process.env.GEMINI_API_KEY;
    }
  });

  it("returns image buffer for IMAGE modality", async () => {
    const origFetch = globalThis.fetch;
    const fakeBase64 = Buffer.from("fake-png-data").toString("base64");
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: fakeBase64 } }] } }]
      })
    });
    process.env.GEMINI_API_KEY = "test-key";

    try {
      const result = await callGeminiAPI({
        parts: [{ text: "test" }],
        modalities: ["IMAGE"],
        thinkingLevel: "high",
        includeThoughts: true
      });
      assert.equal(result.type, "image");
      assert.ok(Buffer.isBuffer(result.data));
      assert.equal(result.data.toString(), "fake-png-data");
    } finally {
      globalThis.fetch = origFetch;
      delete process.env.GEMINI_API_KEY;
    }
  });

  it("throws on non-2xx API response", async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: false,
      status: 400,
      text: async () => '{"error":{"message":"Bad request"}}'
    });
    process.env.GEMINI_API_KEY = "test-key";

    try {
      await assert.rejects(
        () => callGeminiAPI({
          parts: [{ text: "test" }],
          modalities: ["TEXT"],
          thinkingLevel: "minimal",
          includeThoughts: false
        }),
        { message: /400/ }
      );
    } finally {
      globalThis.fetch = origFetch;
      delete process.env.GEMINI_API_KEY;
    }
  });
});
```

- [ ] **Step 2: Run tests to verify new tests fail**

Run: `cd /Users/olv/SRC/nanobananaMCPB && npm test`
Expected: New tests FAIL — `callGeminiAPI` not exported

- [ ] **Step 3: Implement callGeminiAPI**

Add to `server/index.js` after the helpers section:

```javascript
// ---------------------------------------------------------------------------
// Gemini API Client (exported for testing)
// ---------------------------------------------------------------------------

export async function callGeminiAPI({ parts, modalities, thinkingLevel, includeThoughts }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY environment variable is not set. Configure it in the extension settings.");
  }

  const body = {
    contents: [{ parts }],
    generationConfig: {
      responseModalities: modalities,
      candidateCount: 1,
      thinkingConfig: {
        includeThoughts,
        thinkingLevel,
      },
    },
  };

  const response = await fetch(`${GEMINI_ENDPOINT}?key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gemini API error (${response.status}): ${errorText}`);
  }

  const data = await response.json();

  if (data.error) {
    throw new Error(`Gemini API error: ${data.error.message}`);
  }

  const candidates = data.candidates;
  if (!candidates || candidates.length === 0) {
    throw new Error("Gemini API returned no candidates");
  }

  const candidate = candidates[0];

  if (modalities.includes("IMAGE")) {
    const imagePart = candidate.content.parts.find((p) => p.inlineData);
    if (!imagePart) {
      throw new Error("No image data in Gemini API response");
    }
    return { type: "image", data: Buffer.from(imagePart.inlineData.data, "base64") };
  }

  const textPart = candidate.content.parts.find((p) => p.text);
  if (!textPart) {
    throw new Error("No text data in Gemini API response");
  }
  return { type: "text", data: textPart.text };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/olv/SRC/nanobananaMCPB && npm test`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add server/index.js test/server.test.js
git commit -m "feat: add Gemini API client with 60s timeout and error handling"
```

---

### Task 4: MCP Server Wiring + All 6 Tools

**Files:**
- Modify: `server/index.js` — add MCP server setup + all 6 tool registrations

- [ ] **Step 1: Add MCP server initialization and all tools**

Add to the bottom of `server/index.js`:

```javascript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// ---------------------------------------------------------------------------
// MCP Server (only starts when not in test mode)
// ---------------------------------------------------------------------------

if (!process.env.NANOBANANA_TEST) {
  const server = new McpServer({
    name: "nanobanana",
    version: "1.0.0",
  });

  const ASPECT_RATIOS = ["1:1", "16:9", "9:16", "4:3", "3:4", "21:9", "4:5", "5:4", "1:4", "4:1", "1:8", "8:1", "2:3", "3:2"];
  const IMAGE_SIZES = ["0.5K", "1K", "2K", "4K"];
  const THINKING_LEVELS = ["minimal", "medium", "high"];

  // --- generate_image ---
  server.registerTool(
    "generate_image",
    {
      title: "Generate Image",
      description: "Generate an image from a text prompt with optional style, visual DNA, aspect ratio, and resolution controls",
      inputSchema: {
        prompt: z.string().describe("Text description of the image to generate"),
        style: z.string().optional().describe("Artistic style instruction"),
        visual_dna: z.record(z.string()).optional().describe("Visual DNA JSON object to guide style consistency"),
        aspect_ratio: z.enum(ASPECT_RATIOS).default("1:1").describe("Output aspect ratio"),
        image_size: z.enum(IMAGE_SIZES).default("1K").describe("Resolution tier"),
        thinking_level: z.enum(THINKING_LEVELS).default("high").describe("Reasoning depth"),
      },
    },
    async ({ prompt, style, visual_dna, aspect_ratio, image_size, thinking_level }) => {
      try {
        const jsonPrompt = { content: prompt, aspect_ratio, image_size };
        if (style) jsonPrompt.style = style;
        if (visual_dna) jsonPrompt.visual_dna = visual_dna;

        const parts = [{ text: JSON.stringify(jsonPrompt) }];

        const result = await callGeminiAPI({
          parts,
          modalities: ["IMAGE"],
          thinkingLevel: thinking_level,
          includeThoughts: true,
        });

        ensureOutputDir();
        const filename = generateFilename(prompt);
        const filePath = join(OUTPUT_DIR, filename);
        writeFileSync(filePath, result.data);

        return {
          content: [{
            type: "text",
            text: `Image saved to ${filePath}\nPrompt: ${prompt}\nAspect: ${aspect_ratio} | Size: ${image_size} | Thinking: ${thinking_level}`,
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // --- edit_image ---
  server.registerTool(
    "edit_image",
    {
      title: "Edit Image",
      description: "Edit existing image(s) with a text instruction while preserving unmentioned elements",
      inputSchema: {
        images: z.array(z.string()).min(1).max(14).describe("File paths to input images"),
        prompt: z.string().describe("Edit instruction"),
        aspect_ratio: z.enum(ASPECT_RATIOS).default("1:1").describe("Output aspect ratio"),
        image_size: z.enum(IMAGE_SIZES).default("1K").describe("Resolution tier"),
        thinking_level: z.enum(THINKING_LEVELS).default("high").describe("Reasoning depth"),
      },
    },
    async ({ images, prompt, aspect_ratio, image_size, thinking_level }) => {
      try {
        const imageParts = loadImageParts(images);
        const jsonPrompt = { content: prompt, aspect_ratio, image_size };
        const parts = [...imageParts, { text: JSON.stringify(jsonPrompt) }];

        const result = await callGeminiAPI({
          parts,
          modalities: ["IMAGE"],
          thinkingLevel: thinking_level,
          includeThoughts: true,
        });

        ensureOutputDir();
        const filename = generateFilename(prompt);
        const filePath = join(OUTPUT_DIR, filename);
        writeFileSync(filePath, result.data);

        return {
          content: [{
            type: "text",
            text: `Edited image saved to ${filePath}\nInstruction: ${prompt}\nSource images: ${images.join(", ")}\nAspect: ${aspect_ratio} | Size: ${image_size} | Thinking: ${thinking_level}`,
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // --- extract_visual_dna ---
  server.registerTool(
    "extract_visual_dna",
    {
      title: "Extract Visual DNA",
      description: "Extract visual DNA from image(s) as structured JSON (style, scene, subject, camera, lighting, materials, colors)",
      inputSchema: {
        images: z.array(z.string()).min(1).max(14).describe("File paths to images to analyze"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ images }) => {
      try {
        const imageParts = loadImageParts(images);
        const extractPrompt = "Analyze the provided image(s) and extract their core visual DNA into a structured JSON object. Include fields for: style, scene, subject, camera, lighting, materials, colors. ONLY output the raw JSON without markdown code blocks.";
        const parts = [...imageParts, { text: extractPrompt }];

        const result = await callGeminiAPI({
          parts,
          modalities: ["TEXT"],
          thinkingLevel: "minimal",
          includeThoughts: false,
        });

        return { content: [{ type: "text", text: result.data }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // --- describe_image ---
  server.registerTool(
    "describe_image",
    {
      title: "Describe Image",
      description: "Generate a detailed text description of image(s)",
      inputSchema: {
        images: z.array(z.string()).min(1).max(14).describe("File paths to images to describe"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ images }) => {
      try {
        const imageParts = loadImageParts(images);
        const parts = [...imageParts, { text: "Provide a highly detailed, comprehensive description of the provided image(s)." }];

        const result = await callGeminiAPI({
          parts,
          modalities: ["TEXT"],
          thinkingLevel: "minimal",
          includeThoughts: false,
        });

        return { content: [{ type: "text", text: result.data }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // --- list_templates ---
  server.registerTool(
    "list_templates",
    {
      title: "List Templates",
      description: "List available pre-built Visual DNA style templates",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        const templateDir = getTemplateDir();
        const files = readdirSync(templateDir).filter((f) => f.endsWith(".json"));
        const summaries = files.map((f) => {
          const name = f.replace(".json", "");
          const content = JSON.parse(readFileSync(join(templateDir, f), "utf8"));
          return `- ${name}: ${content.style || "No style description"}`;
        });

        return {
          content: [{
            type: "text",
            text: `Available templates:\n${summaries.join("\n")}`,
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // --- get_template ---
  server.registerTool(
    "get_template",
    {
      title: "Get Template",
      description: "Get the JSON contents of a Visual DNA style template",
      inputSchema: {
        name: z.string().describe('Template name (e.g., "cinematic_fujifilm")'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ name }) => {
      try {
        if (name.includes("/") || name.includes("\\") || name.includes("..")) {
          throw new Error("Invalid template name");
        }
        const templatePath = join(getTemplateDir(), `${name}.json`);
        if (!existsSync(templatePath)) {
          throw new Error(`Template not found: ${name}`);
        }
        const content = readFileSync(templatePath, "utf8");
        return { content: [{ type: "text", text: content }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // --- Start server ---
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
```

Note: All imports (`McpServer`, `StdioServerTransport`, `z`) must be at the top of the file alongside the existing imports. Move them there when adding this code.

- [ ] **Step 2: Verify tests still pass**

Run: `cd /Users/olv/SRC/nanobananaMCPB && npm test`
Expected: All existing tests PASS (server doesn't start because `NANOBANANA_TEST=1` is set in test script)

- [ ] **Step 3: Commit**

```bash
git add server/index.js
git commit -m "feat: add MCP server with all 6 tools (generate, edit, extract DNA, describe, templates)"
```

---

### Task 5: Integration Tests

**Files:**
- Create: `test/integration.test.js`

- [ ] **Step 1: Write integration tests**

Create `test/integration.test.js`:

```javascript
import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { loadImageParts, getTemplateDir } from "../server/index.js";

describe("integration: template files exist", () => {
  it("templates directory has at least 2 templates", () => {
    const dir = getTemplateDir();
    assert.ok(existsSync(dir), "templates dir exists");
    const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    assert.ok(files.length >= 2, `expected >= 2 templates, got ${files.length}`);
  });

  it("each template is valid JSON with a style field", () => {
    const dir = getTemplateDir();
    const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    for (const f of files) {
      const content = JSON.parse(readFileSync(join(dir, f), "utf8"));
      assert.ok(content.style, `${f} missing style field`);
    }
  });
});

describe("integration: loadImageParts validation", () => {
  it("throws on empty array", () => {
    assert.throws(() => loadImageParts([]), { message: /at least one/ });
  });

  it("throws on non-existent file", () => {
    assert.throws(() => loadImageParts(["/nonexistent/fake.png"]), { message: /not found/ });
  });

  it("throws on more than 14 images", () => {
    const paths = Array(15).fill("/fake.png");
    assert.throws(() => loadImageParts(paths), { message: /14/ });
  });
});
```

- [ ] **Step 2: Run all tests**

Run: `cd /Users/olv/SRC/nanobananaMCPB && npm test`
Expected: All tests PASS

- [ ] **Step 3: Commit**

```bash
git add test/integration.test.js
git commit -m "feat: add integration tests for templates and image validation"
```

---

### Task 6: Pack and Validate

**Files:**
- No new files — validation and packaging

- [ ] **Step 1: Validate manifest**

Run: `cd /Users/olv/SRC/nanobananaMCPB && npx @anthropic-ai/mcpb validate`
Expected: Manifest valid (or install mcpb CLI first: `npm install -g @anthropic-ai/mcpb`)

- [ ] **Step 2: Test with MCP inspector**

Run: `cd /Users/olv/SRC/nanobananaMCPB && GEMINI_API_KEY=test OUTPUT_DIR=/tmp/nanobanana-test npx @modelcontextprotocol/inspector node server/index.js`
Expected: Inspector connects, shows 6 tools with correct schemas

- [ ] **Step 3: Pack the bundle**

Run: `cd /Users/olv/SRC/nanobananaMCPB && npx @anthropic-ai/mcpb pack`
Expected: `.mcpb` file created in project directory

- [ ] **Step 4: Verify bundle contents**

Run: `cd /Users/olv/SRC/nanobananaMCPB && unzip -l *.mcpb | head -30`
Expected: Contains `manifest.json`, `server/index.js`, `node_modules/`, `assets/templates/`

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: validate and pack MCPB bundle"
```
