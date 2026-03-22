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

export function ensureOutputDir() {
  mkdirSync(OUTPUT_DIR, { recursive: true });
}
