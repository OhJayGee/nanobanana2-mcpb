import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync, existsSync, mkdirSync, writeFileSync, appendFileSync, readdirSync, statSync, realpathSync } from "node:fs";
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
if (!/^[a-zA-Z0-9._-]+$/.test(GEMINI_MODEL)) {
  throw new Error(`Invalid GEMINI_MODEL value: ${GEMINI_MODEL}`);
}
const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models";
// Strip EXIF/IPTC metadata from JPEG images before sending to Gemini API.
// Enabled by default; set STRIP_METADATA=false to disable.
const STRIP_METADATA = process.env.STRIP_METADATA !== "false";
// Background API calls (fire-and-forget) use their own timeout via AbortController.
// Without this, a hung Gemini connection would leave a job stuck in "processing" forever.
const API_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes max per API call
// Debug logging: set NANOBANANA_DEBUG=1 to write timestamped API call lifecycle
// to OUTPUT_DIR/.nanobanana-debug.log. View with: tail -f ~/Desktop/nanobanana-output/.nanobanana-debug.log
const DEBUG = !!process.env.NANOBANANA_DEBUG && process.env.NANOBANANA_DEBUG !== "false";
function debug(jobId, ...args) {
  if (!DEBUG) return;
  const ts = new Date().toISOString().slice(0, 23);
  const line = `${ts} [${jobId}] ${args.join(" ")}\n`;
  try {
    const logPath = join(getOutputDir(), ".nanobanana-debug.log");
    mkdirSync(getOutputDir(), { recursive: true });
    appendFileSync(logPath, line);
  } catch {
    // Fall back to stderr if output dir is not writable
    process.stderr.write(`[nanobanana] ${line}`);
  }
}

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
        (s) => raw.table[s] && validLevels.every((l) => typeof raw.table[s][l] === "number" && isFinite(raw.table[s][l]) && raw.table[s][l] > 0)
      );
      if (allValid) estimateTable = raw.table;
    }
    if (raw.samples && typeof raw.samples === "object" && !Array.isArray(raw.samples)) {
      const samplesValid = validSizes.every(
        (s) => !raw.samples[s] || (typeof raw.samples[s] === "object" && !Array.isArray(raw.samples[s]) &&
          validLevels.every((l) => raw.samples[s][l] === undefined || (typeof raw.samples[s][l] === "number" && isFinite(raw.samples[s][l]) && raw.samples[s][l] >= 0)))
      );
      if (samplesValid) sampleCounts = raw.samples;
    }
  } catch {
    // File not found or corrupt — stay with priors, no error needed.
  }
}

export function saveEstimates() {
  try {
    mkdirSync(getOutputDir(), { recursive: true });
    writeFileSync(getEstimatesFile(), JSON.stringify({ table: estimateTable, samples: sampleCounts }, null, 2));
  } catch (err) {
    process.stderr.write(`[nanobanana] Warning: failed to save estimates: ${err.message}\n`);
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
const MAX_CONCURRENT_JOBS = 5;
const MAX_TOTAL_JOBS = 100; // hard cap on Map size to prevent unbounded growth
const MAX_IMAGE_BYTES = 20 * 1024 * 1024; // 20 MB per image

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

export function activeJobCount() {
  let count = 0;
  for (const job of jobs.values()) {
    if (job.status === "processing") count++;
  }
  return count;
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
    throw new Error(`Access denied: only image files are allowed (jpg, png, webp, etc.). Got: ${abs}`);
  }
}

export function validateImageBuffer(buffer, imgPath) {
  if (buffer.length < 4) {
    throw new Error(`File too small to be a valid image: ${imgPath}`);
  }
  const isPNG  = buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47;
  const isJPEG = buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF;
  const isWebP = buffer.length >= 12 && buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
                 buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50;
  const isGIF  = buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38;
  const isBMP  = buffer[0] === 0x42 && buffer[1] === 0x4D;
  const isTIFF = (buffer[0] === 0x49 && buffer[1] === 0x49 && buffer[2] === 0x2A && buffer[3] === 0x00) ||
                 (buffer[0] === 0x4D && buffer[1] === 0x4D && buffer[2] === 0x00 && buffer[3] === 0x2A);
  // HEIF/HEIC/AVIF: ISO BMFF format with "ftyp" box at offset 4, then a known image brand at offset 8
  const HEIF_BRANDS = new Set(["heic", "heix", "hevc", "mif1", "msf1", "avif", "avis"]);
  const isFtyp = buffer.length >= 12 && buffer[4] === 0x66 && buffer[5] === 0x74 && buffer[6] === 0x79 && buffer[7] === 0x70;
  const brand = isFtyp ? String.fromCharCode(buffer[8], buffer[9], buffer[10], buffer[11]) : "";
  const isHEIF = isFtyp && HEIF_BRANDS.has(brand);

  if (!isPNG && !isJPEG && !isWebP && !isGIF && !isBMP && !isTIFF && !isHEIF) {
    throw new Error(`Access denied: file does not contain valid image data: ${imgPath}`);
  }
}

// Strip EXIF (APP1), IPTC (APP13), and comment (COM) segments from JPEG buffers.
// Non-JPEG buffers are returned unchanged. Preserves all image data and rendering-
// relevant segments (APP0/JFIF, DQT, SOF, DHT, SOS, ICC/APP2).
const JPEG_STRIP_MARKERS = new Set([0xE1, 0xED, 0xFE]); // APP1, APP13, COM

export function stripJpegMetadata(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xFF || buffer[1] !== 0xD8) return buffer;

  const parts = [buffer.subarray(0, 2)]; // SOI
  let offset = 2;

  while (offset < buffer.length - 1) {
    if (buffer[offset] !== 0xFF) break;
    const marker = buffer[offset + 1];

    // SOI or EOI — 2-byte markers with no length field
    if (marker === 0xD8 || marker === 0xD9) {
      parts.push(buffer.subarray(offset, offset + 2));
      offset += 2;
      continue;
    }

    // SOS (start of scan) — copy everything from here to EOF (compressed image data)
    if (marker === 0xDA) {
      parts.push(buffer.subarray(offset));
      break;
    }

    // RST markers (D0-D7) — 2-byte, no length
    if (marker >= 0xD0 && marker <= 0xD7) {
      parts.push(buffer.subarray(offset, offset + 2));
      offset += 2;
      continue;
    }

    // All other markers: FF XX LL LL [data]
    if (offset + 3 >= buffer.length) break;
    const segLength = buffer.readUInt16BE(offset + 2);
    const segEnd = offset + 2 + segLength;
    if (segEnd > buffer.length) break; // malformed — stop parsing

    if (JPEG_STRIP_MARKERS.has(marker)) {
      offset = segEnd; // skip this segment
    } else {
      parts.push(buffer.subarray(offset, segEnd)); // keep
      offset = segEnd;
    }
  }

  return Buffer.concat(parts);
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
      // Check extension of the literal path
      assertPathAllowed(imgPath);
      // Resolve symlinks and verify the real target also has an image extension
      let realPath;
      try {
        realPath = realpathSync(imgPath);
      } catch (err) {
        if (err.code === "ENOENT") throw new Error(`Image file not found: ${imgPath}`);
        throw err;
      }
      assertPathAllowed(realPath);
      // Reject non-regular files (FIFOs, device files, directories)
      const stat = statSync(realPath);
      if (!stat.isFile()) {
        throw new Error(`Access denied: not a regular file: ${imgPath}`);
      }
      if (stat.size > MAX_IMAGE_BYTES) {
        throw new Error(`Image file too large: ${imgPath} (${(stat.size / 1024 / 1024).toFixed(1)} MB, max ${MAX_IMAGE_BYTES / 1024 / 1024} MB)`);
      }
      const buffer = await readFile(realPath);
      // Post-read size check guards against TOCTOU file swap
      if (buffer.length > MAX_IMAGE_BYTES) {
        throw new Error(`Image file too large after read: ${imgPath} (${(buffer.length / 1024 / 1024).toFixed(1)} MB)`);
      }
      // Validate magic bytes to prevent non-image file exfiltration
      validateImageBuffer(buffer, imgPath);
      // Strip EXIF/IPTC metadata from JPEG images if enabled
      const finalBuffer = STRIP_METADATA ? stripJpegMetadata(buffer) : buffer;
      return {
        inlineData: {
          mimeType: detectMimeType(imgPath),
          data: finalBuffer.toString("base64"),
        },
      };
    })
  );
}

function ensureOutputDir() {
  mkdirSync(getOutputDir(), { recursive: true });
}

// ---------------------------------------------------------------------------
// Gemini API Client (exported for testing)
// ---------------------------------------------------------------------------

export async function callGeminiAPI({ parts, modalities, thinkingLevel, includeThoughts, signal }) {
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

  const fetchStart = Date.now();
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
  const headersMs = Date.now() - fetchStart;

  if (!response.ok) {
    let message = `Gemini API error (${response.status})`;
    try {
      const errorBody = await response.json();
      if (errorBody?.error?.message) message += `: ${errorBody.error.message}`;
    } catch {
      // Could not parse error body — use generic message
    }
    if (DEBUG) debug("api", `${response.status} error after ${(headersMs / 1000).toFixed(1)}s — ${message}`);
    throw new Error(message);
  }

  const data = await response.json();
  const totalMs = Date.now() - fetchStart;
  if (DEBUG) {
    const bodyMs = totalMs - headersMs;
    debug("api", `${modalities.join("+")} ${response.status} — headers: ${(headersMs / 1000).toFixed(1)}s, body: ${(bodyMs / 1000).toFixed(1)}s, total: ${(totalMs / 1000).toFixed(1)}s`);
  }

  if (data.error) {
    const msg = typeof data.error.message === "string" ? data.error.message : "unknown error";
    throw new Error(`Gemini API error: ${msg}`);
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

export function createServer() {
  const server = new McpServer({
    name: "nanobanana",
    version: "1.4.3",
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
        prompt: z.string().max(10000).describe("Text description of the image to generate"),
        style: z.string().max(2000).optional().describe("Artistic style instruction"),
        visual_dna: z.record(z.string()).optional().describe("Visual DNA JSON object to guide style consistency"),
        aspect_ratio: z.enum(ASPECT_RATIOS).default("1:1").describe("Output aspect ratio"),
        image_size: z.enum(IMAGE_SIZES).default("1K").describe("Resolution tier"),
        thinking_level: z.enum(THINKING_LEVELS).default("high").describe("Reasoning depth: minimal (fastest, still uses some reasoning), high (complex scenes, text in images, precise adherence)"),
      },
    },
    async ({ prompt, style, visual_dna, aspect_ratio, image_size, thinking_level }, ctx) => {
      try {
        pruneJobs();
        if (activeJobCount() >= MAX_CONCURRENT_JOBS) {
          throw new Error(`Too many concurrent jobs (${MAX_CONCURRENT_JOBS} max). Wait for existing jobs to finish.`);
        }
        if (jobs.size >= MAX_TOTAL_JOBS) {
          throw new Error(`Job history full (${MAX_TOTAL_JOBS} max). Call check_generation to view and clear old jobs.`);
        }
        if (visual_dna) {
          const entries = Object.entries(visual_dna);
          if (entries.length > 20) throw new Error("visual_dna: too many keys (max 20)");
          for (const [k, v] of entries) {
            if (k.length > 100) throw new Error("visual_dna: key too long (max 100 characters)");
            if (v.length > 500) throw new Error("visual_dna: value too long (max 500 characters)");
          }
        }

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

        // Fire-and-forget with timeout: abort if Gemini doesn't respond within API_TIMEOUT_MS.
        // Without this, a hung connection would leave the job stuck in "processing" forever.
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
        debug(jobId, `generate → ${image_size}/${thinking_level}, prompt="${prompt.slice(0, 60)}"`);
        callGeminiAPI({
          parts,
          modalities: ["IMAGE"],
          thinkingLevel: thinking_level,
          includeThoughts: true,
          signal: controller.signal,
        }).then((result) => {
          clearTimeout(timeout);
          debug(jobId, `API returned ${result.data.length} bytes`);
          writeFileSync(filePath, result.data);
          debug(jobId, `wrote ${filePath}`);
          completeJob(jobId);
          debug(jobId, `complete`);
        }).catch((err) => {
          clearTimeout(timeout);
          const msg = err.name === "AbortError" ? `Generation timed out after ${API_TIMEOUT_MS / 1000}s — the Gemini API did not respond. Try again or use a simpler prompt.` : err.message;
          debug(jobId, `FAILED: ${msg}`);
          failJob(jobId, msg);
        });

        try { await ctx?.mcpReq?.log("info", `Queued image generation: "${prompt.slice(0, 60)}..." → ${filePath} (est. ~${estimated}s)`); } catch { /* non-fatal */ }

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
        prompt: z.string().max(10000).describe("Edit instruction"),
        aspect_ratio: z.enum(ASPECT_RATIOS).default("1:1").describe("Output aspect ratio"),
        image_size: z.enum(IMAGE_SIZES).default("1K").describe("Resolution tier"),
        thinking_level: z.enum(THINKING_LEVELS).default("high").describe("Reasoning depth: minimal (fastest, still uses some reasoning), high (complex scenes, text in images, precise adherence)"),
      },
    },
    async ({ images, prompt, aspect_ratio, image_size, thinking_level }, ctx) => {
      try {
        pruneJobs();
        if (activeJobCount() >= MAX_CONCURRENT_JOBS) {
          throw new Error(`Too many concurrent jobs (${MAX_CONCURRENT_JOBS} max). Wait for existing jobs to finish.`);
        }
        if (jobs.size >= MAX_TOTAL_JOBS) {
          throw new Error(`Job history full (${MAX_TOTAL_JOBS} max). Call check_generation to view and clear old jobs.`);
        }

        // Reserve job slot immediately (before any await) to prevent race conditions
        ensureOutputDir();
        const filename = generateFilename(prompt);
        const filePath = join(getOutputDir(), filename);
        const jobId = randomBytes(6).toString("hex");
        const estimated = estimateSeconds(image_size, thinking_level);
        createJob(jobId, filePath, prompt, estimated, image_size, thinking_level);

        // Validate images (may await). If validation fails, mark job as failed.
        let imageParts;
        try {
          debug(jobId, `loading ${images.length} image(s): ${images.map(p => p.split("/").pop()).join(", ")}`);
          imageParts = await loadImageParts(images);
          debug(jobId, `images loaded, total parts: ${imageParts.length}`);
        } catch (err) {
          debug(jobId, `image load FAILED: ${err.message}`);
          failJob(jobId, err.message);
          throw err;
        }

        const jsonPrompt = { content: prompt, aspect_ratio, image_size };
        const parts = [...imageParts, { text: JSON.stringify(jsonPrompt) }];

        // Fire-and-forget with timeout: abort if Gemini doesn't respond within API_TIMEOUT_MS.
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
        debug(jobId, `edit → ${image_size}/${thinking_level}, prompt="${prompt.slice(0, 60)}"`);
        callGeminiAPI({
          parts,
          modalities: ["IMAGE"],
          thinkingLevel: thinking_level,
          includeThoughts: true,
          signal: controller.signal,
        }).then((result) => {
          clearTimeout(timeout);
          debug(jobId, `API returned ${result.data.length} bytes`);
          writeFileSync(filePath, result.data);
          debug(jobId, `wrote ${filePath}`);
          completeJob(jobId);
          debug(jobId, `complete`);
        }).catch((err) => {
          clearTimeout(timeout);
          const msg = err.name === "AbortError" ? `Generation timed out after ${API_TIMEOUT_MS / 1000}s — the Gemini API did not respond. Try again or use a simpler prompt.` : err.message;
          debug(jobId, `FAILED: ${msg}`);
          failJob(jobId, msg);
        });

        try { await ctx?.mcpReq?.log("info", `Queued image edit: "${prompt.slice(0, 60)}..." → ${filePath} (est. ~${estimated}s)`); } catch { /* non-fatal */ }

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
        debug("dna", `extract_visual_dna called with ${images.length} image(s)`);
        const imageParts = await loadImageParts(images);
        const extractPrompt = "Analyze the provided image(s) and extract their core visual DNA into a structured JSON object. Include fields for: style, scene, subject, camera, lighting, materials, colors. ONLY output the raw JSON without markdown code blocks.";
        const parts = [...imageParts, { text: extractPrompt }];

        try { await ctx?.mcpReq?.log("info", `Extracting visual DNA from ${images.length} image(s)...`); } catch { /* non-fatal */ }
        debug("dna", `calling Gemini API...`);
        const result = await callGeminiAPI({
          parts,
          modalities: ["TEXT"],
          thinkingLevel: "minimal",
          includeThoughts: false,
        });
        debug("dna", `complete, ${result.data.length} chars returned`);

        return { content: [{ type: "text", text: result.data }] };
      } catch (err) {
        debug("dna", `FAILED: ${err.message}`);
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
        debug("desc", `describe_image called with ${images.length} image(s)`);
        const imageParts = await loadImageParts(images);
        const parts = [...imageParts, { text: "Provide a highly detailed, comprehensive description of the provided image(s)." }];

        try { await ctx?.mcpReq?.log("info", `Describing ${images.length} image(s)...`); } catch { /* non-fatal */ }
        debug("desc", `calling Gemini API...`);
        const result = await callGeminiAPI({
          parts,
          modalities: ["TEXT"],
          thinkingLevel: "minimal",
          includeThoughts: false,
        });
        debug("desc", `complete, ${result.data.length} chars returned`);

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

  return server;
}

if (!process.env.NANOBANANA_TEST) {
  // Always write a one-line startup probe so we can verify env vars are reaching the server
  try {
    mkdirSync(getOutputDir(), { recursive: true });
    appendFileSync(join(getOutputDir(), ".nanobanana-debug.log"),
      `${new Date().toISOString().slice(0, 23)} [init] server v1.4.3 starting — DEBUG=${process.env.NANOBANANA_DEBUG ?? "(unset)"}, STRIP_METADATA=${process.env.STRIP_METADATA ?? "(unset)"}, MODEL=${GEMINI_MODEL}\n`);
  } catch { /* non-fatal */ }
  if (DEBUG) {
    debug("init", `debug logging active — log file: ${join(getOutputDir(), ".nanobanana-debug.log")}`);
  }
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
