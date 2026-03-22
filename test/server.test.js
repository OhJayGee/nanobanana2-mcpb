import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { slugify, detectMimeType, generateFilename, callGeminiAPI } from "../server/index.js";

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
