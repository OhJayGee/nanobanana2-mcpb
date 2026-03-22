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
