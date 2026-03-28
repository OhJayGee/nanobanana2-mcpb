import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { mkdirSync, writeFileSync, unlinkSync, existsSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { slugify, detectMimeType, generateFilename, callGeminiAPI, createJob, completeJob, failJob, getJob, getAllJobs, activeJobCount, estimateSeconds, recordActualTime, getSampleCount, pruneJobs, loadEstimates, saveEstimates, getEstimatesFile, isValidTemplateName, loadImageParts, assertPathAllowed, validateImageBuffer, resolveHome, getOutputDir } from "../server/index.js";

describe("getOutputDir", () => {
  it("reflects OUTPUT_DIR env var at call time (lazy evaluation)", () => {
    const origOutputDir = process.env.OUTPUT_DIR;
    process.env.OUTPUT_DIR = "/tmp/nanobanana-lazy-test";
    assert.equal(getOutputDir(), "/tmp/nanobanana-lazy-test");
    process.env.OUTPUT_DIR = origOutputDir || "";
  });
});

describe("resolveHome", () => {
  const home = process.env.HOME || process.env.USERPROFILE || "";

  it("resolves ${HOME} prefix", () => {
    assert.equal(resolveHome("${HOME}/Pictures"), `${home}/Pictures`);
  });

  it("resolves $(HOME) prefix", () => {
    assert.equal(resolveHome("$(HOME)/Pictures"), `${home}/Pictures`);
  });

  it("resolves ~ prefix", () => {
    assert.equal(resolveHome("~/Desktop"), `${home}/Desktop`);
  });

  it("leaves already-resolved absolute paths unchanged", () => {
    assert.equal(resolveHome("/Users/alice/Pictures"), "/Users/alice/Pictures");
  });

  it("only replaces at the start, not mid-path", () => {
    assert.equal(resolveHome("/tmp/${HOME}/foo"), "/tmp/${HOME}/foo");
  });
});

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

describe("estimateSeconds", () => {
  it("returns valid positive estimates for all size/level combinations", () => {
    for (const size of ["0.5K", "1K", "2K", "4K"]) {
      for (const level of ["minimal", "high"]) {
        const val = estimateSeconds(size, level);
        assert.ok(typeof val === "number" && val > 0, `${size}/${level} should be a positive number, got ${val}`);
      }
    }
  });

  it("returns a fallback for unknown params", () => {
    const fallback = estimateSeconds("unknown", "unknown");
    assert.ok(typeof fallback === "number" && fallback > 0);
  });
});

describe("job queue", () => {
  it("creates, completes, and retrieves a job", () => {
    createJob("test-1", "/tmp/test.png", "a cat", 30, "1K", "high");
    const job = getJob("test-1");
    assert.equal(job.status, "processing");
    assert.equal(job.filePath, "/tmp/test.png");
    assert.equal(job.prompt, "a cat");
    assert.equal(job.image_size, "1K");
    assert.equal(job.thinking_level, "high");
    assert.equal(job.estimatedSeconds, 30);
    assert.ok(job.startedAt > 0);
    assert.equal(job.completedAt, null);

    completeJob("test-1");
    const done = getJob("test-1");
    assert.equal(done.status, "complete");
    assert.ok(done.completedAt >= done.startedAt);
  });

  it("tracks failed jobs with completedAt", () => {
    createJob("test-2", "/tmp/fail.png", "bad prompt", 45, "2K", "minimal");
    failJob("test-2", "API error");
    const job = getJob("test-2");
    assert.equal(job.status, "failed");
    assert.equal(job.error, "API error");
    assert.ok(job.completedAt >= job.startedAt);
  });

  it("returns null for unknown job", () => {
    assert.equal(getJob("nonexistent"), null);
  });

  it("lists all jobs", () => {
    createJob("test-3", "/tmp/all.png", "list test", 20, "0.5K", "minimal");
    const all = getAllJobs();
    assert.ok("test-3" in all);
  });

  it("pruneJobs removes old finished jobs but keeps processing jobs", () => {
    createJob("prune-old", "/tmp/old.png", "old finished", 30, "1K", "minimal");
    const job = getJob("prune-old");
    job.status = "complete";
    job.completedAt = Date.now() - 31 * 60 * 1000; // 31 minutes ago

    createJob("prune-processing", "/tmp/proc.png", "still running", 30, "1K", "minimal");
    getJob("prune-processing").startedAt = Date.now() - 31 * 60 * 1000; // old but still processing

    createJob("prune-recent", "/tmp/recent.png", "recent finished", 30, "1K", "minimal");
    const recent = getJob("prune-recent");
    recent.status = "complete";
    recent.completedAt = Date.now() - 5 * 60 * 1000; // 5 minutes ago

    pruneJobs();

    assert.equal(getJob("prune-old"), null, "old finished job should be pruned");
    assert.ok(getJob("prune-processing"), "processing job should be kept");
    assert.ok(getJob("prune-recent"), "recent finished job should be kept");
  });

  it("pruneJobs does not delete a non-processing job with null completedAt", () => {
    createJob("prune-null-completed", "/tmp/x.png", "null completedAt", 30, "1K", "minimal");
    const job = getJob("prune-null-completed");
    job.status = "failed";
    job.completedAt = null; // simulate missing completedAt

    pruneJobs();

    assert.ok(getJob("prune-null-completed"), "job with null completedAt should not be pruned");
  });
});

describe("recordActualTime", () => {
  it("updates estimate toward observed value via EMA", () => {
    // First push estimate up with a high observation to ensure there's room to decrease
    recordActualTime("1K", "minimal", 200);
    const before = estimateSeconds("1K", "minimal");
    // Now simulate a very fast generation — should pull estimate down
    recordActualTime("1K", "minimal", 1);
    const after = estimateSeconds("1K", "minimal");
    assert.ok(after < before, `estimate should decrease: ${before} → ${after}`);
  });

  it("increments sample count", () => {
    const before = getSampleCount("2K", "high");
    recordActualTime("2K", "high", 40);
    assert.equal(getSampleCount("2K", "high"), before + 1);
  });

  it("ignores unknown image_size/thinking_level gracefully", () => {
    assert.doesNotThrow(() => recordActualTime("99K", "turbo", 30));
  });
});

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

  it("treats FINISH_REASON_UNSPECIFIED as a successful finish", async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        candidates: [{ finishReason: "FINISH_REASON_UNSPECIFIED", content: { parts: [{ text: "ok" }] } }]
      })
    });
    process.env.GEMINI_API_KEY = "test-key";

    try {
      const result = await callGeminiAPI({ parts: [{ text: "test" }], modalities: ["TEXT"], thinkingLevel: "minimal", includeThoughts: false });
      assert.equal(result.type, "text");
      assert.equal(result.data, "ok");
    } finally {
      globalThis.fetch = origFetch;
      delete process.env.GEMINI_API_KEY;
    }
  });

  it("sanitizes error response — extracts message from JSON body", async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: false,
      status: 403,
      json: async () => ({ error: { message: "API key invalid" } })
    });
    process.env.GEMINI_API_KEY = "test-key";

    try {
      await assert.rejects(
        () => callGeminiAPI({ parts: [{ text: "test" }], modalities: ["TEXT"], thinkingLevel: "minimal", includeThoughts: false }),
        { message: /403.*API key invalid/ }
      );
    } finally {
      globalThis.fetch = origFetch;
      delete process.env.GEMINI_API_KEY;
    }
  });

  it("handles non-JSON error response gracefully", async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: false,
      status: 502,
      json: async () => { throw new Error("not json"); }
    });
    process.env.GEMINI_API_KEY = "test-key";

    try {
      await assert.rejects(
        () => callGeminiAPI({ parts: [{ text: "test" }], modalities: ["TEXT"], thinkingLevel: "minimal", includeThoughts: false }),
        { message: /502/ }
      );
    } finally {
      globalThis.fetch = origFetch;
      delete process.env.GEMINI_API_KEY;
    }
  });

  it("throws when fetch itself fails (network error)", async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error("ECONNREFUSED"); };
    process.env.GEMINI_API_KEY = "test-key";

    try {
      await assert.rejects(
        () => callGeminiAPI({ parts: [{ text: "test" }], modalities: ["TEXT"], thinkingLevel: "minimal", includeThoughts: false }),
        { message: /ECONNREFUSED/ }
      );
    } finally {
      globalThis.fetch = origFetch;
      delete process.env.GEMINI_API_KEY;
    }
  });

  it("sends API key in x-goog-api-key header, not as URL query param", async () => {
    const origFetch = globalThis.fetch;
    let capturedUrl;
    let capturedHeaders;
    globalThis.fetch = async (url, opts) => {
      capturedUrl = url;
      capturedHeaders = opts.headers;
      return {
        ok: true,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: "hi" }] } }]
        })
      };
    };
    process.env.GEMINI_API_KEY = "secret-api-key";

    try {
      await callGeminiAPI({ parts: [{ text: "test" }], modalities: ["TEXT"], thinkingLevel: "minimal", includeThoughts: false });
      assert.ok(!capturedUrl.includes("secret-api-key"), "API key must not appear in URL");
      assert.equal(capturedHeaders["x-goog-api-key"], "secret-api-key");
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

  it("throws a clear message when candidate finishReason is SAFETY", async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        candidates: [{
          finishReason: "SAFETY",
          safetyRatings: [
            { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", probability: "HIGH", blocked: true },
          ],
          content: { parts: [] },
        }]
      })
    });
    process.env.GEMINI_API_KEY = "test-key";

    try {
      await assert.rejects(
        () => callGeminiAPI({ parts: [{ text: "test" }], modalities: ["IMAGE"], thinkingLevel: "minimal", includeThoughts: false }),
        { message: /safety filters.*sexually explicit/i }
      );
    } finally {
      globalThis.fetch = origFetch;
      delete process.env.GEMINI_API_KEY;
    }
  });

  it("throws a clear message when candidate finishReason is RECITATION", async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        candidates: [{ finishReason: "RECITATION", content: { parts: [] } }]
      })
    });
    process.env.GEMINI_API_KEY = "test-key";

    try {
      await assert.rejects(
        () => callGeminiAPI({ parts: [{ text: "test" }], modalities: ["IMAGE"], thinkingLevel: "minimal", includeThoughts: false }),
        { message: /copyright/i }
      );
    } finally {
      globalThis.fetch = origFetch;
      delete process.env.GEMINI_API_KEY;
    }
  });

  it("throws when prompt is blocked via promptFeedback", async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        promptFeedback: { blockReason: "SAFETY" },
        candidates: []
      })
    });
    process.env.GEMINI_API_KEY = "test-key";

    try {
      await assert.rejects(
        () => callGeminiAPI({ parts: [{ text: "test" }], modalities: ["IMAGE"], thinkingLevel: "minimal", includeThoughts: false }),
        { message: /Prompt blocked/ }
      );
    } finally {
      globalThis.fetch = origFetch;
      delete process.env.GEMINI_API_KEY;
    }
  });

  it("throws when candidates empty and no promptFeedback", async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ candidates: [] })
    });
    process.env.GEMINI_API_KEY = "test-key";

    try {
      await assert.rejects(
        () => callGeminiAPI({ parts: [{ text: "test" }], modalities: ["IMAGE"], thinkingLevel: "minimal", includeThoughts: false }),
        { message: /no candidates/ }
      );
    } finally {
      globalThis.fetch = origFetch;
      delete process.env.GEMINI_API_KEY;
    }
  });

  it("throws when body has a top-level error field (200 OK)", async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ error: { message: "quota exceeded" } })
    });
    process.env.GEMINI_API_KEY = "test-key";

    try {
      await assert.rejects(
        () => callGeminiAPI({ parts: [{ text: "test" }], modalities: ["TEXT"], thinkingLevel: "minimal", includeThoughts: false }),
        { message: /quota exceeded/ }
      );
    } finally {
      globalThis.fetch = origFetch;
      delete process.env.GEMINI_API_KEY;
    }
  });

  it("handles 200 OK error with missing error.message gracefully", async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ error: { code: 429 } }) // no message field
    });
    process.env.GEMINI_API_KEY = "test-key";

    try {
      await assert.rejects(
        () => callGeminiAPI({ parts: [{ text: "test" }], modalities: ["TEXT"], thinkingLevel: "minimal", includeThoughts: false }),
        { message: /unknown error/ }
      );
    } finally {
      globalThis.fetch = origFetch;
      delete process.env.GEMINI_API_KEY;
    }
  });

  it("throws on finishReason MAX_TOKENS", async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        candidates: [{ finishReason: "MAX_TOKENS", content: { parts: [] } }]
      })
    });
    process.env.GEMINI_API_KEY = "test-key";

    try {
      await assert.rejects(
        () => callGeminiAPI({ parts: [{ text: "test" }], modalities: ["IMAGE"], thinkingLevel: "high", includeThoughts: true }),
        { message: /token limit/ }
      );
    } finally {
      globalThis.fetch = origFetch;
      delete process.env.GEMINI_API_KEY;
    }
  });

  it("throws on unexpected finishReason with the reason in the message", async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        candidates: [{ finishReason: "BLOCKLIST", content: { parts: [] } }]
      })
    });
    process.env.GEMINI_API_KEY = "test-key";

    try {
      await assert.rejects(
        () => callGeminiAPI({ parts: [{ text: "test" }], modalities: ["IMAGE"], thinkingLevel: "minimal", includeThoughts: false }),
        { message: /BLOCKLIST/ }
      );
    } finally {
      globalThis.fetch = origFetch;
      delete process.env.GEMINI_API_KEY;
    }
  });

  it("throws when IMAGE response has no inlineData part", async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        candidates: [{ finishReason: "STOP", content: { parts: [{ text: "oops" }] } }]
      })
    });
    process.env.GEMINI_API_KEY = "test-key";

    try {
      await assert.rejects(
        () => callGeminiAPI({ parts: [{ text: "test" }], modalities: ["IMAGE"], thinkingLevel: "minimal", includeThoughts: false }),
        { message: /No image data/ }
      );
    } finally {
      globalThis.fetch = origFetch;
      delete process.env.GEMINI_API_KEY;
    }
  });

  it("throws when TEXT response has no text part", async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        candidates: [{ finishReason: "STOP", content: { parts: [{ inlineData: { data: "x" } }] } }]
      })
    });
    process.env.GEMINI_API_KEY = "test-key";

    try {
      await assert.rejects(
        () => callGeminiAPI({ parts: [{ text: "test" }], modalities: ["TEXT"], thinkingLevel: "minimal", includeThoughts: false }),
        { message: /No text data/ }
      );
    } finally {
      globalThis.fetch = origFetch;
      delete process.env.GEMINI_API_KEY;
    }
  });
});

describe("activeJobCount", () => {
  it("counts only processing jobs", () => {
    const before = activeJobCount();
    createJob("active-test-1", "/tmp/a.png", "test", 30, "1K", "minimal");
    assert.equal(activeJobCount(), before + 1);
    completeJob("active-test-1");
    assert.equal(activeJobCount(), before);
  });
});

describe("job queue edge cases", () => {
  it("completeJob on unknown id is a no-op", () => {
    assert.doesNotThrow(() => completeJob("nonexistent-complete"));
    assert.equal(getJob("nonexistent-complete"), null);
  });

  it("failJob on unknown id is a no-op", () => {
    assert.doesNotThrow(() => failJob("nonexistent-fail", "some error"));
    assert.equal(getJob("nonexistent-fail"), null);
  });
});

describe("recordActualTime with valid size and unknown thinking level", () => {
  it("returns without throwing when thinking_level is not in the table", () => {
    assert.doesNotThrow(() => recordActualTime("1K", "turbo", 30));
    // estimate should be unchanged
    assert.ok(estimateSeconds("1K", "turbo") === 45); // falls back to default
  });
});

describe("isValidTemplateName", () => {
  it("accepts a normal template name", () => {
    assert.ok(isValidTemplateName("cinematic_fujifilm"));
    assert.ok(isValidTemplateName("my-template"));
    assert.ok(isValidTemplateName("template123"));
  });

  it("rejects names with forward slash", () => {
    assert.equal(isValidTemplateName("../../etc/passwd"), false);
    assert.equal(isValidTemplateName("foo/bar"), false);
  });

  it("rejects names with backslash", () => {
    assert.equal(isValidTemplateName("foo\\bar"), false);
  });

  it("rejects names with double dot", () => {
    assert.equal(isValidTemplateName("..hidden"), false);
  });

  it("rejects names with spaces or special characters", () => {
    assert.equal(isValidTemplateName("foo bar"), false);
    assert.equal(isValidTemplateName("foo.bar"), false);
    assert.equal(isValidTemplateName("foo;bar"), false);
  });

  it("rejects empty string", () => {
    assert.equal(isValidTemplateName(""), false);
  });
});

describe("assertPathAllowed", () => {
  it("allows image files with standard extensions", () => {
    assert.doesNotThrow(() => assertPathAllowed("/some/path/photo.png"));
    assert.doesNotThrow(() => assertPathAllowed("/some/path/photo.jpg"));
    assert.doesNotThrow(() => assertPathAllowed("/some/path/photo.webp"));
    assert.doesNotThrow(() => assertPathAllowed("/some/path/photo.heic"));
  });

  it("rejects non-image files", () => {
    assert.throws(() => assertPathAllowed("/etc/passwd"), /Access denied/);
    assert.throws(() => assertPathAllowed("/home/user/.ssh/id_rsa"), /Access denied/);
    assert.throws(() => assertPathAllowed("/home/user/file.txt"), /Access denied/);
  });

  it("rejects relative path traversal targeting non-image files", () => {
    assert.throws(() => assertPathAllowed("../../etc/passwd"), /Access denied/);
  });
});

describe("validateImageBuffer", () => {
  it("accepts valid PNG magic bytes", () => {
    const buf = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    assert.doesNotThrow(() => validateImageBuffer(buf, "test.png"));
  });

  it("accepts valid JPEG magic bytes", () => {
    const buf = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10]);
    assert.doesNotThrow(() => validateImageBuffer(buf, "test.jpg"));
  });

  it("accepts valid GIF magic bytes", () => {
    const buf = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
    assert.doesNotThrow(() => validateImageBuffer(buf, "test.gif"));
  });

  it("accepts valid BMP magic bytes", () => {
    const buf = Buffer.from([0x42, 0x4D, 0x00, 0x00, 0x00, 0x00]);
    assert.doesNotThrow(() => validateImageBuffer(buf, "test.bmp"));
  });

  it("accepts valid WebP magic bytes", () => {
    // RIFF....WEBP
    const buf = Buffer.alloc(12);
    buf.write("RIFF", 0); buf.writeUInt32LE(100, 4); buf.write("WEBP", 8);
    assert.doesNotThrow(() => validateImageBuffer(buf, "test.webp"));
  });

  it("accepts valid TIFF magic bytes (little-endian)", () => {
    const buf = Buffer.from([0x49, 0x49, 0x2A, 0x00, 0x08, 0x00]);
    assert.doesNotThrow(() => validateImageBuffer(buf, "test.tiff"));
  });

  it("accepts valid TIFF magic bytes (big-endian)", () => {
    const buf = Buffer.from([0x4D, 0x4D, 0x00, 0x2A, 0x00, 0x08]);
    assert.doesNotThrow(() => validateImageBuffer(buf, "test.tiff"));
  });

  it("accepts valid HEIC magic bytes (ftyp + heic brand)", () => {
    const buf = Buffer.alloc(12);
    buf.writeUInt32BE(12, 0); // box size
    buf.write("ftyp", 4);
    buf.write("heic", 8);
    assert.doesNotThrow(() => validateImageBuffer(buf, "test.heic"));
  });

  it("accepts valid AVIF magic bytes (ftyp + avif brand)", () => {
    const buf = Buffer.alloc(12);
    buf.writeUInt32BE(12, 0);
    buf.write("ftyp", 4);
    buf.write("avif", 8);
    assert.doesNotThrow(() => validateImageBuffer(buf, "test.avif"));
  });

  it("rejects ftyp with unknown brand (e.g. mp4 video)", () => {
    const buf = Buffer.alloc(12);
    buf.writeUInt32BE(12, 0);
    buf.write("ftyp", 4);
    buf.write("isom", 8); // MP4 brand — not an image
    assert.throws(() => validateImageBuffer(buf, "video.heic"), /does not contain valid image data/);
  });

  it("rejects non-image content", () => {
    const buf = Buffer.from("This is plain text content, not an image");
    assert.throws(() => validateImageBuffer(buf, "fake.png"), /does not contain valid image data/);
  });

  it("rejects buffers that are too small", () => {
    const buf = Buffer.from([0x89, 0x50]);
    assert.throws(() => validateImageBuffer(buf, "tiny.png"), /too small/);
  });
});

describe("loadImageParts success path", () => {
  const tmpFile = join(tmpdir(), "nanobanana-test.png");
  // Valid PNG header bytes
  const pngHeader = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

  it("returns inlineData with correct mimeType and base64 data", async () => {
    writeFileSync(tmpFile, pngHeader);

    const parts = await loadImageParts([tmpFile]);
    assert.equal(parts.length, 1);
    assert.equal(parts[0].inlineData.mimeType, "image/png");
    assert.equal(parts[0].inlineData.data, pngHeader.toString("base64"));

    unlinkSync(tmpFile);
  });

  it("loads multiple images concurrently", async () => {
    const tmpFile2 = join(tmpdir(), "nanobanana-test2.png");
    writeFileSync(tmpFile, pngHeader);
    writeFileSync(tmpFile2, pngHeader);

    const parts = await loadImageParts([tmpFile, tmpFile2]);
    assert.equal(parts.length, 2);

    unlinkSync(tmpFile);
    unlinkSync(tmpFile2);
  });

  it("rejects non-image file paths", async () => {
    await assert.rejects(
      () => loadImageParts(["/etc/passwd"]),
      /Access denied/
    );
  });

  it("rejects files with image extension but non-image content", async () => {
    const fakePng = join(tmpdir(), "not-really.png");
    writeFileSync(fakePng, "This is plain text pretending to be a PNG");
    try {
      await assert.rejects(
        () => loadImageParts([fakePng]),
        /does not contain valid image data/
      );
    } finally {
      unlinkSync(fakePng);
    }
  });

  it("throws when file does not exist", async () => {
    await assert.rejects(
      () => loadImageParts([join(tmpdir(), "nonexistent-image.png")]),
      /not found/
    );
  });

  it("rejects non-regular files (directories)", async () => {
    // Directories have image-like names sometimes; ensure they're rejected
    const dirPath = join(tmpdir(), "nanobanana-fake-dir.png");
    try { mkdirSync(dirPath); } catch { /* may exist */ }
    try {
      await assert.rejects(
        () => loadImageParts([dirPath]),
        /not a regular file/
      );
    } finally {
      try { require("fs").rmdirSync(dirPath); } catch { /* best effort */ }
    }
  });

  it("rejects symlink pointing to non-image file", async () => {
    const symlinkPath = join(tmpdir(), "nanobanana-symlink-test.png");
    try { unlinkSync(symlinkPath); } catch { /* may not exist */ }
    symlinkSync("/etc/hosts", symlinkPath);
    try {
      await assert.rejects(
        () => loadImageParts([symlinkPath]),
        /Access denied/
      );
    } finally {
      unlinkSync(symlinkPath);
    }
  });

  it("throws when no paths provided", async () => {
    await assert.rejects(() => loadImageParts([]), /at least one image path/);
  });

  it("throws when too many images", async () => {
    await assert.rejects(() => loadImageParts(new Array(15).fill("/tmp/x.png")), /Maximum 14/);
  });
});

describe("loadEstimates / saveEstimates", () => {
  const origOutputDir = process.env.OUTPUT_DIR;
  const testDir = join(tmpdir(), `nanobanana-estimates-test-${Date.now()}`);

  it("saveEstimates writes a readable JSON file, loadEstimates reads it back", () => {
    process.env.OUTPUT_DIR = testDir;
    mkdirSync(testDir, { recursive: true });

    // Write known values into the file directly, then load them
    const fixture = {
      table: { "1K": { minimal: 99, high: 199 }, "2K": { minimal: 88, high: 177 }, "0.5K": { minimal: 11, high: 22 }, "4K": { minimal: 55, high: 66 } },
      samples: { "1K": { minimal: 7, high: 3 } }
    };
    writeFileSync(getEstimatesFile(), JSON.stringify(fixture));

    loadEstimates();

    assert.equal(estimateSeconds("1K", "minimal"), 99);
    assert.equal(estimateSeconds("1K", "high"), 199);
    assert.equal(getSampleCount("1K", "minimal"), 7);

    // Cleanup
    unlinkSync(getEstimatesFile());
    process.env.OUTPUT_DIR = origOutputDir || "";
  });

  it("loadEstimates silently ignores a missing file", () => {
    process.env.OUTPUT_DIR = join(testDir, "nonexistent-subdir");
    assert.doesNotThrow(() => loadEstimates());
    process.env.OUTPUT_DIR = origOutputDir || "";
  });

  it("loadEstimates silently ignores corrupt JSON", () => {
    process.env.OUTPUT_DIR = testDir;
    mkdirSync(testDir, { recursive: true });
    writeFileSync(getEstimatesFile(), "{ not valid json ~~");
    assert.doesNotThrow(() => loadEstimates());
    unlinkSync(getEstimatesFile());
    process.env.OUTPUT_DIR = origOutputDir || "";
  });

  it("loadEstimates ignores table with wrong structure (missing sizes)", () => {
    process.env.OUTPUT_DIR = testDir;
    mkdirSync(testDir, { recursive: true });
    const before = estimateSeconds("1K", "minimal");
    // table missing required sizes
    writeFileSync(getEstimatesFile(), JSON.stringify({ table: { "1K": { minimal: 999 } } }));
    loadEstimates();
    // estimate should NOT change since schema is invalid (missing "0.5K", "2K", "4K")
    assert.equal(estimateSeconds("1K", "minimal"), before);
    unlinkSync(getEstimatesFile());
    process.env.OUTPUT_DIR = origOutputDir || "";
  });

  it("loadEstimates ignores samples with non-number counts", () => {
    process.env.OUTPUT_DIR = testDir;
    mkdirSync(testDir, { recursive: true });
    const countBefore = getSampleCount("1K", "minimal");
    const validTable = {
      "0.5K": { minimal: 20, high: 30 },
      "1K": { minimal: 30, high: 45 },
      "2K": { minimal: 50, high: 75 },
      "4K": { minimal: 90, high: 135 },
    };
    const badSamples = { "1K": { minimal: "lots" } };
    writeFileSync(getEstimatesFile(), JSON.stringify({ table: validTable, samples: badSamples }));
    loadEstimates();
    // table should load fine but bad samples should be rejected — count unchanged
    assert.equal(estimateSeconds("1K", "minimal"), 30);
    assert.equal(getSampleCount("1K", "minimal"), countBefore);
    unlinkSync(getEstimatesFile());
    process.env.OUTPUT_DIR = origOutputDir || "";
  });

  it("loadEstimates ignores samples that are an array", () => {
    process.env.OUTPUT_DIR = testDir;
    mkdirSync(testDir, { recursive: true });
    const countBefore = getSampleCount("1K", "minimal");
    const validTable = {
      "0.5K": { minimal: 20, high: 30 },
      "1K": { minimal: 30, high: 45 },
      "2K": { minimal: 50, high: 75 },
      "4K": { minimal: 90, high: 135 },
    };
    writeFileSync(getEstimatesFile(), JSON.stringify({ table: validTable, samples: [1, 2, 3] }));
    loadEstimates();
    assert.equal(getSampleCount("1K", "minimal"), countBefore);
    unlinkSync(getEstimatesFile());
    process.env.OUTPUT_DIR = origOutputDir || "";
  });

  it("loadEstimates ignores table with NaN values", () => {
    process.env.OUTPUT_DIR = testDir;
    mkdirSync(testDir, { recursive: true });
    const before = estimateSeconds("1K", "minimal");
    const nanTable = {
      "0.5K": { minimal: 20, high: 30 },
      "1K": { minimal: NaN, high: 45 },
      "2K": { minimal: 50, high: 75 },
      "4K": { minimal: 90, high: 135 },
    };
    writeFileSync(getEstimatesFile(), JSON.stringify({ table: nanTable }));
    loadEstimates();
    assert.equal(estimateSeconds("1K", "minimal"), before);
    unlinkSync(getEstimatesFile());
    process.env.OUTPUT_DIR = origOutputDir || "";
  });

  it("loadEstimates ignores table with Infinity values", () => {
    process.env.OUTPUT_DIR = testDir;
    mkdirSync(testDir, { recursive: true });
    const before = estimateSeconds("1K", "high");
    const infTable = {
      "0.5K": { minimal: 20, high: 30 },
      "1K": { minimal: 30, high: Infinity },
      "2K": { minimal: 50, high: 75 },
      "4K": { minimal: 90, high: 135 },
    };
    writeFileSync(getEstimatesFile(), JSON.stringify({ table: infTable }));
    loadEstimates();
    assert.equal(estimateSeconds("1K", "high"), before);
    unlinkSync(getEstimatesFile());
    process.env.OUTPUT_DIR = origOutputDir || "";
  });

  it("loadEstimates ignores table with non-number values", () => {
    process.env.OUTPUT_DIR = testDir;
    mkdirSync(testDir, { recursive: true });
    const before = estimateSeconds("2K", "minimal");
    const badTable = {
      "0.5K": { minimal: 20, high: 30 },
      "1K": { minimal: 30, high: 45 },
      "2K": { minimal: "fast", high: 75 }, // non-number
      "4K": { minimal: 90, high: 135 },
    };
    writeFileSync(getEstimatesFile(), JSON.stringify({ table: badTable }));
    loadEstimates();
    assert.equal(estimateSeconds("2K", "minimal"), before);
    unlinkSync(getEstimatesFile());
    process.env.OUTPUT_DIR = origOutputDir || "";
  });
});
