import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.1-flash-image-preview";
const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models";
// No server-side timeout — let the MCP client (Claude Desktop) manage timeouts.
// Our log notifications keep the client informed that work is in progress.

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
    throw new Error("at least one image path is required");
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

export function ensureOutputDir() {
  mkdirSync(OUTPUT_DIR, { recursive: true });
}

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

  const endpoint = `${GEMINI_BASE_URL}/${GEMINI_MODEL}:generateContent`;

  const response = await fetch(`${endpoint}?key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
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
  const THINKING_LEVELS = ["minimal", "high"];

  // --- generate_image ---
  server.registerTool(
    "generate_image",
    {
      title: "Generate Image",
      description: "Generate an image from a text prompt with optional style, visual DNA, aspect ratio, and resolution controls. Typically takes 10-30 seconds, but can take 90 seconds or more for complex prompts or high resolution.",
      annotations: { readOnlyHint: false, openWorldHint: true },
      inputSchema: {
        prompt: z.string().describe("Text description of the image to generate"),
        style: z.string().optional().describe("Artistic style instruction"),
        visual_dna: z.record(z.string()).optional().describe("Visual DNA JSON object to guide style consistency"),
        aspect_ratio: z.enum(ASPECT_RATIOS).default("1:1").describe("Output aspect ratio"),
        image_size: z.enum(IMAGE_SIZES).default("1K").describe("Resolution tier"),
        thinking_level: z.enum(THINKING_LEVELS).default("high").describe("Reasoning depth: minimal (fastest, still uses some reasoning), high (complex scenes, text in images, precise adherence)"),
      },
    },
    async ({ prompt, style, visual_dna, aspect_ratio, image_size, thinking_level }, ctx) => {
      try {
        const jsonPrompt = { content: prompt, aspect_ratio, image_size };
        if (style) jsonPrompt.style = style;
        if (visual_dna) jsonPrompt.visual_dna = visual_dna;

        const parts = [{ text: JSON.stringify(jsonPrompt) }];

        await ctx.mcpReq.log("info", `Generating image: "${prompt.slice(0, 60)}..." (${image_size}, ${aspect_ratio})`);
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
        await ctx.mcpReq.log("info", `Image saved to ${filePath}`);

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
      description: "Edit existing image(s) with a text instruction while preserving unmentioned elements. Typically takes 10-30 seconds, but can take 90 seconds or more.",
      annotations: { readOnlyHint: false, openWorldHint: true },
      inputSchema: {
        images: z.array(z.string()).min(1).max(14).describe("File paths to input images"),
        prompt: z.string().describe("Edit instruction"),
        aspect_ratio: z.enum(ASPECT_RATIOS).default("1:1").describe("Output aspect ratio"),
        image_size: z.enum(IMAGE_SIZES).default("1K").describe("Resolution tier"),
        thinking_level: z.enum(THINKING_LEVELS).default("high").describe("Reasoning depth: minimal (fastest, still uses some reasoning), high (complex scenes, text in images, precise adherence)"),
      },
    },
    async ({ images, prompt, aspect_ratio, image_size, thinking_level }, ctx) => {
      try {
        const imageParts = loadImageParts(images);
        const jsonPrompt = { content: prompt, aspect_ratio, image_size };
        const parts = [...imageParts, { text: JSON.stringify(jsonPrompt) }];

        await ctx.mcpReq.log("info", `Editing ${images.length} image(s): "${prompt.slice(0, 60)}..."`);
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
        await ctx.mcpReq.log("info", `Edited image saved to ${filePath}`);

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
    async ({ images }, ctx) => {
      try {
        const imageParts = loadImageParts(images);
        const extractPrompt = "Analyze the provided image(s) and extract their core visual DNA into a structured JSON object. Include fields for: style, scene, subject, camera, lighting, materials, colors. ONLY output the raw JSON without markdown code blocks.";
        const parts = [...imageParts, { text: extractPrompt }];

        await ctx.mcpReq.log("info", `Extracting visual DNA from ${images.length} image(s)...`);
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
    async ({ images }, ctx) => {
      try {
        const imageParts = loadImageParts(images);
        const parts = [...imageParts, { text: "Provide a highly detailed, comprehensive description of the provided image(s)." }];

        await ctx.mcpReq.log("info", `Describing ${images.length} image(s)...`);
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
