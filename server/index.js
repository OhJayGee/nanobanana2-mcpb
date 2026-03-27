import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
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

const HOME_DIR = process.env.HOME || process.env.USERPROFILE || "";
if (!HOME_DIR) {
  throw new Error("Cannot determine home directory: HOME and USERPROFILE are both unset.");
}

// Resolve any unsubstituted home directory placeholders that the MCPB runtime
// may pass through literally (e.g. ${HOME}, $(HOME), ~).
export function resolveHome(p) {
  return p
    .replace(/^\$\{HOME\}/,  HOME_DIR)
    .replace(/^\$\(HOME\)/,  HOME_DIR)
    .replace(/^~/,           HOME_DIR);
}

export function getOutputDir() {
  return resolveHome(process.env.OUTPUT_DIR || join(HOME_DIR, "Desktop", "nanobanana-output"));
}

// ---------------------------------------------------------------------------
// Generation time heuristic
// Estimates in seconds based on image_size × thinking_level combinations.
// Seeded from empirical priors (with +50% margin); auto-improves from real data.
// ---------------------------------------------------------------------------

// EMA alpha: each new observation contributes 25% weight, smoothing out outliers.
const EMA_ALPHA = 0.25;
// Margin factor applied on top of the observed average.
const MARGIN_FACTOR = 1.5;

const ESTIMATE_PRIORS = {
  "0.5K": { minimal: 20,  high: 30  },
  "1K":   { minimal: 30,  high: 45  },
  "2K":   { minimal: 50,  high: 75  },
  "4K":   { minimal: 90,  high: 135 },
};

// estimateTable holds current estimates (priors or learned). Mutated as data arrives.
// sampleCounts tracks how many real observations back each cell.
let estimateTable = JSON.parse(JSON.stringify(ESTIMATE_PRIORS));
let sampleCounts = { "0.5K": {}, "1K": {}, "2K": {}, "4K": {} };

export function getEstimatesFile() {
  return join(getOutputDir(), ".nanobanana-estimates.json");
}

export function loadEstimates() {
  try {
    const raw = JSON.parse(readFileSync(getEstimatesFile(), "utf8"));
    const validSizes = ["0.5K", "1K", "2K", "4K"];
    const validLevels = ["minimal", "high"];
    if (raw.table && typeof raw.table === "object" && !Array.isArray(raw.table)) {
      const allValid = validSizes.every(
        (s) => raw.table[s] && validLevels.every((l) => typeof raw.table[s][l] === "number")
      );
      if (allValid) estimateTable = raw.table;
    }
    if (raw.samples && typeof raw.samples === "object" && !Array.isArray(raw.samples)) {
      sampleCounts = raw.samples;
    }
  } catch {
    // File not found or corrupt — stay with priors, no error needed.
  }
}

export function saveEstimates() {
  try {
    mkdirSync(getOutputDir(), { recursive: true });
    writeFileSync(getEstimatesFile(), JSON.stringify({ table: estimateTable, samples: sampleCounts }, null, 2));
  } catch {
    // Non-fatal — worst case we lose this session's learning.
  }
}

export function recordActualTime(image_size, thinking_level, actualSeconds) {
  if (!estimateTable[image_size]) return;
  const current = estimateTable[image_size][thinking_level];
  if (current === undefined) return;

  const observed = actualSeconds * MARGIN_FACTOR;
  estimateTable[image_size][thinking_level] = Math.round(EMA_ALPHA * observed + (1 - EMA_ALPHA) * current);

  if (!sampleCounts[image_size]) sampleCounts[image_size] = {};
  sampleCounts[image_size][thinking_level] = (sampleCounts[image_size][thinking_level] || 0) + 1;

  saveEstimates();
}

export function estimateSeconds(image_size, thinking_level) {
  return estimateTable[image_size]?.[thinking_level] ?? 45;
}

export function getSampleCount(image_size, thinking_level) {
  return sampleCounts[image_size]?.[thinking_level] || 0;
}

// Load any previously learned estimates on startup.
loadEstimates();

// ---------------------------------------------------------------------------
// Job Queue — tracks async image generation jobs
// ---------------------------------------------------------------------------

const jobs = new Map(); // jobId → { status, filePath, prompt, image_size, thinking_level, error, startedAt, estimatedSeconds, completedAt }
const JOB_TTL_MS = 30 * 60 * 1000; // 30 minutes

export function pruneJobs() {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, job] of jobs) {
    // Only prune finished jobs; keep processing jobs regardless of age.
    if (job.status !== "processing" && job.completedAt !== null && job.completedAt < cutoff) {
      jobs.delete(id);
    }
  }
}

export function createJob(jobId, filePath, prompt, estimatedSeconds, image_size, thinking_level) {
  jobs.set(jobId, { status: "processing", filePath, prompt, image_size, thinking_level, error: null, startedAt: Date.now(), estimatedSeconds, completedAt: null });
}

export function completeJob(jobId) {
  const job = jobs.get(jobId);
  if (job) {
    job.status = "complete";
    job.completedAt = Date.now();
    const actualSeconds = (job.completedAt - job.startedAt) / 1000;
    recordActualTime(job.image_size, job.thinking_level, actualSeconds);
  }
}

export function failJob(jobId, error) {
  const job = jobs.get(jobId);
  if (job) {
    job.status = "failed";
    job.error = error;
    job.completedAt = Date.now();
  }
}

export function getJob(jobId) {
  return jobs.get(jobId) || null;
}

export function getAllJobs() {
  return Object.fromEntries(jobs);
}

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

export function isValidTemplateName(name) {
  return /^[a-zA-Z0-9_-]+$/.test(name);
}

const ALLOWED_IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp", "gif", "bmp", "tiff", "tif", "heic", "heif", "avif"]);

export function assertPathAllowed(p) {
  const abs = resolve(p);
  const ext = abs.toLowerCase().split(".").pop();
  if (!ALLOWED_IMAGE_EXTENSIONS.has(ext)) {
    throw new Error(`Access denied: only image files are allowed (jpg, png, webp, etc.). Got: ${p}`);
  }
}

export async function loadImageParts(imagePaths) {
  if (!imagePaths || imagePaths.length === 0) {
    throw new Error("at least one image path is required");
  }
  if (imagePaths.length > 14) {
    throw new Error("Maximum 14 images allowed");
  }
  return Promise.all(
    imagePaths.map(async (imgPath) => {
      assertPathAllowed(imgPath);
      if (!existsSync(imgPath)) {
        throw new Error(`Image file not found: ${imgPath}`);
      }
      const buffer = await readFile(imgPath);
      return {
        inlineData: {
          mimeType: detectMimeType(imgPath),
          data: buffer.toString("base64"),
        },
      };
    })
  );
}

export function ensureOutputDir() {
  mkdirSync(getOutputDir(), { recursive: true });
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

  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
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
    // promptFeedback is set when the prompt itself is blocked before any candidate is generated
    const blocked = data.promptFeedback?.blockReason;
    if (blocked) {
      throw new Error(`Prompt blocked by Gemini (${blocked}). Try rephrasing or adjusting the content.`);
    }
    throw new Error("Gemini API returned no candidates");
  }

  const candidate = candidates[0];
  const finishReason = candidate.finishReason;

  if (finishReason && finishReason !== "STOP" && finishReason !== "FINISH_REASON_UNSPECIFIED") {
    if (finishReason === "SAFETY") {
      const triggered = (candidate.safetyRatings || [])
        .filter((r) => r.blocked || r.probability === "HIGH" || r.probability === "MEDIUM")
        .map((r) => r.category.replace("HARM_CATEGORY_", "").toLowerCase().replace(/_/g, " "))
        .join(", ");
      const detail = triggered ? ` (${triggered})` : "";
      throw new Error(`Image blocked by Gemini safety filters${detail}. Try a different prompt.`);
    }
    if (finishReason === "RECITATION") {
      throw new Error("Image blocked by Gemini due to potential copyright/recitation policy. Try a more original prompt.");
    }
    if (finishReason === "MAX_TOKENS") {
      throw new Error("Gemini hit its token limit mid-generation. Try a simpler prompt or lower thinking level.");
    }
    throw new Error(`Gemini generation stopped unexpectedly (finishReason: ${finishReason}).`);
  }

  if (modalities.includes("IMAGE")) {
    const imagePart = candidate.content?.parts?.find((p) => p.inlineData);
    if (!imagePart) {
      throw new Error("No image data in Gemini API response");
    }
    return { type: "image", data: Buffer.from(imagePart.inlineData.data, "base64") };
  }

  const textPart = candidate.content?.parts?.find((p) => p.text);
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
      description: "Queue image generation from a text prompt. Returns immediately with a job_id and the planned output file path. The image is generated asynchronously in the background — use check_generation with the job_id to poll for completion. Typical generation time is 10-30 seconds, but can take 90+ seconds for complex prompts or high resolution.",
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
        ensureOutputDir();
        const filename = generateFilename(prompt);
        const filePath = join(getOutputDir(), filename);
        const jobId = randomBytes(6).toString("hex");

        const jsonPrompt = { content: prompt, aspect_ratio, image_size };
        if (style) jsonPrompt.style = style;
        if (visual_dna) jsonPrompt.visual_dna = visual_dna;

        const parts = [{ text: JSON.stringify(jsonPrompt) }];

        const estimated = estimateSeconds(image_size, thinking_level);
        createJob(jobId, filePath, prompt, estimated, image_size, thinking_level);

        // Fire-and-forget: run Gemini API in background
        callGeminiAPI({
          parts,
          modalities: ["IMAGE"],
          thinkingLevel: thinking_level,
          includeThoughts: true,
        }).then((result) => {
          writeFileSync(filePath, result.data);
          completeJob(jobId);
        }).catch((err) => {
          failJob(jobId, err.message);
        });

        await ctx?.mcpReq?.log("info", `Queued image generation: "${prompt.slice(0, 60)}..." → ${filePath} (est. ~${estimated}s)`);

        return {
          content: [{
            type: "text",
            text: `Image generation queued.\njob_id: ${jobId}\noutput_path: ${filePath}\nPrompt: ${prompt}\nAspect: ${aspect_ratio} | Size: ${image_size} | Thinking: ${thinking_level}\n\nEstimated time: ~${estimated}s — check back with check_generation(job_id) after that interval. Re-poll every 15s if still processing.`,
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
      description: "Queue image editing with a text instruction while preserving unmentioned elements. Returns immediately with a job_id and the planned output file path. The edit runs asynchronously — use check_generation with the job_id to poll for completion. Typical time is 10-30 seconds, but can take 90+ seconds.",
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
        // Validate images before queuing (catches bad paths and non-image files early)
        const imageParts = await loadImageParts(images);

        ensureOutputDir();
        const filename = generateFilename(prompt);
        const filePath = join(getOutputDir(), filename);
        const jobId = randomBytes(6).toString("hex");

        const jsonPrompt = { content: prompt, aspect_ratio, image_size };
        const parts = [...imageParts, { text: JSON.stringify(jsonPrompt) }];

        const estimated = estimateSeconds(image_size, thinking_level);
        createJob(jobId, filePath, prompt, estimated, image_size, thinking_level);

        // Fire-and-forget: run Gemini API in background
        callGeminiAPI({
          parts,
          modalities: ["IMAGE"],
          thinkingLevel: thinking_level,
          includeThoughts: true,
        }).then((result) => {
          writeFileSync(filePath, result.data);
          completeJob(jobId);
        }).catch((err) => {
          failJob(jobId, err.message);
        });

        await ctx?.mcpReq?.log("info", `Queued image edit: "${prompt.slice(0, 60)}..." → ${filePath} (est. ~${estimated}s)`);

        return {
          content: [{
            type: "text",
            text: `Image edit queued.\njob_id: ${jobId}\noutput_path: ${filePath}\nInstruction: ${prompt}\nSource images: ${images.join(", ")}\nAspect: ${aspect_ratio} | Size: ${image_size} | Thinking: ${thinking_level}\n\nEstimated time: ~${estimated}s — check back with check_generation(job_id) after that interval. Re-poll every 15s if still processing.`,
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // --- check_generation ---
  server.registerTool(
    "check_generation",
    {
      title: "Check Generation Status",
      description: "Check the status of an async image generation or edit job. Returns status (processing/complete/failed), elapsed time, and file details when complete. Call this after generate_image or edit_image to poll for completion. If no job_id is provided, returns status of all recent jobs.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        job_id: z.string().optional().describe("Job ID returned by generate_image or edit_image. Omit to list all jobs."),
      },
    },
    async ({ job_id }) => {
      pruneJobs();

      // List all jobs
      if (!job_id) {
        const allJobs = getAllJobs();
        const entries = Object.entries(allJobs);
        if (entries.length === 0) {
          return { content: [{ type: "text", text: "No jobs found." }] };
        }
        const lines = entries.map(([id, j]) => {
          const elapsed = j.completedAt
            ? ((j.completedAt - j.startedAt) / 1000).toFixed(1)
            : ((Date.now() - j.startedAt) / 1000).toFixed(1);
          let line = `${id}: ${j.status} (${elapsed}s`;
          if (j.estimatedSeconds && j.status === "processing") {
            const rem = Math.max(0, j.estimatedSeconds - parseFloat(elapsed));
            line += `, ~${rem.toFixed(0)}s remaining`;
          }
          line += `) — ${j.prompt.slice(0, 50)}`;
          if (j.status === "complete") line += ` → ${j.filePath}`;
          if (j.status === "failed") line += ` — Error: ${j.error}`;
          return line;
        });
        return { content: [{ type: "text", text: lines.join("\n") }] };
      }

      // Single job lookup
      const job = getJob(job_id);
      if (!job) {
        return { content: [{ type: "text", text: `No job found with id: ${job_id}` }], isError: true };
      }

      const elapsed = job.completedAt
        ? ((job.completedAt - job.startedAt) / 1000).toFixed(1)
        : ((Date.now() - job.startedAt) / 1000).toFixed(1);
      const estNote = job.estimatedSeconds ? ` (estimated ~${job.estimatedSeconds}s)` : "";

      if (job.status === "complete") {
        let fileInfo = `File: ${job.filePath}`;
        if (existsSync(job.filePath)) {
          const stats = statSync(job.filePath);
          fileInfo += ` (${(stats.size / 1024).toFixed(0)} KB)`;
        }
        const n = getSampleCount(job.image_size, job.thinking_level);
        const learnedNote = n > 0 ? `\nNext estimate for ${job.image_size}/${job.thinking_level}: ~${estimateSeconds(job.image_size, job.thinking_level)}s (based on ${n} observation${n === 1 ? "" : "s"})` : "";
        return {
          content: [{
            type: "text",
            text: `Status: complete\nActual time: ${elapsed}s${estNote}\n${fileInfo}${learnedNote}\nPrompt: ${job.prompt}`,
          }],
        };
      }

      if (job.status === "failed") {
        return {
          content: [{
            type: "text",
            text: `Status: failed\nElapsed: ${elapsed}s${estNote}\nError: ${job.error}\nPrompt: ${job.prompt}`,
          }],
          isError: true,
        };
      }

      const remaining = job.estimatedSeconds
        ? Math.max(0, job.estimatedSeconds - parseFloat(elapsed))
        : null;
      const remainingNote = remaining !== null ? `\nEstimated remaining: ~${remaining.toFixed(0)}s` : "";

      return {
        content: [{
          type: "text",
          text: `Status: processing\nElapsed: ${elapsed}s${estNote}${remainingNote}\nOutput will be saved to: ${job.filePath}\nPrompt: ${job.prompt}`,
        }],
      };
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
        const imageParts = await loadImageParts(images);
        const extractPrompt = "Analyze the provided image(s) and extract their core visual DNA into a structured JSON object. Include fields for: style, scene, subject, camera, lighting, materials, colors. ONLY output the raw JSON without markdown code blocks.";
        const parts = [...imageParts, { text: extractPrompt }];

        await ctx?.mcpReq?.log("info", `Extracting visual DNA from ${images.length} image(s)...`);
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
        const imageParts = await loadImageParts(images);
        const parts = [...imageParts, { text: "Provide a highly detailed, comprehensive description of the provided image(s)." }];

        await ctx?.mcpReq?.log("info", `Describing ${images.length} image(s)...`);
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
        if (!isValidTemplateName(name)) {
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
