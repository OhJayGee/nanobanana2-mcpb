import { describe, it, before, after } from "node:test";
import { strict as assert } from "node:assert";
import { mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../server/index.js";

// Valid PNG header for test images
const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D]);

const testDir = join(tmpdir(), `nanobanana-e2e-${Date.now()}`);

describe("MCP server e2e", () => {
  let client;
  let serverInstance;
  const origKey = process.env.GEMINI_API_KEY;
  const origOutputDir = process.env.OUTPUT_DIR;
  const origFetch = globalThis.fetch;

  before(async () => {
    process.env.OUTPUT_DIR = testDir;
    process.env.GEMINI_API_KEY = "test-e2e-key";
    mkdirSync(testDir, { recursive: true });

    serverInstance = createServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await serverInstance.connect(serverTransport);
    client = new Client({ name: "test-client", version: "1.0.0" });
    await client.connect(clientTransport);
  });

  after(async () => {
    await client.close();
    await serverInstance.close();
    globalThis.fetch = origFetch;
    process.env.GEMINI_API_KEY = origKey || "";
    process.env.OUTPUT_DIR = origOutputDir || "";
    try { rmSync(testDir, { recursive: true }); } catch { /* best effort */ }
  });

  // -------------------------------------------------------------------------
  // Tool listing
  // -------------------------------------------------------------------------

  it("registers all 7 tools", async () => {
    const result = await client.listTools();
    const names = result.tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      "check_generation",
      "describe_image",
      "edit_image",
      "extract_visual_dna",
      "generate_image",
      "get_template",
      "list_templates",
    ]);
  });

  // -------------------------------------------------------------------------
  // list_templates
  // -------------------------------------------------------------------------

  it("list_templates returns available templates", async () => {
    const result = await client.callTool({ name: "list_templates", arguments: {} });
    const text = result.content[0].text;
    assert.ok(text.includes("cinematic_fujifilm"), "should list cinematic_fujifilm");
    assert.ok(text.includes("noir_dramatic"), "should list noir_dramatic");
  });

  // -------------------------------------------------------------------------
  // get_template
  // -------------------------------------------------------------------------

  it("get_template returns valid JSON for known template", async () => {
    const result = await client.callTool({ name: "get_template", arguments: { name: "cinematic_fujifilm" } });
    const parsed = JSON.parse(result.content[0].text);
    assert.ok(parsed.style, "template should have a style field");
  });

  it("get_template rejects invalid template name", async () => {
    const result = await client.callTool({ name: "get_template", arguments: { name: "../../etc/passwd" } });
    assert.ok(result.isError);
    assert.ok(result.content[0].text.includes("Invalid template name"));
  });

  it("get_template returns error for nonexistent template", async () => {
    const result = await client.callTool({ name: "get_template", arguments: { name: "nonexistent" } });
    assert.ok(result.isError);
    assert.ok(result.content[0].text.includes("not found"));
  });

  // -------------------------------------------------------------------------
  // check_generation (no jobs)
  // -------------------------------------------------------------------------

  it("check_generation with unknown job_id returns error", async () => {
    const result = await client.callTool({ name: "check_generation", arguments: { job_id: "nonexistent" } });
    assert.ok(result.isError);
    assert.ok(result.content[0].text.includes("No job found"));
  });

  // -------------------------------------------------------------------------
  // generate_image (full flow)
  // -------------------------------------------------------------------------

  it("generate_image queues a job and check_generation tracks it to completion", async () => {
    const fakeImageData = Buffer.from(PNG_HEADER);
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        candidates: [{
          finishReason: "STOP",
          content: { parts: [{ inlineData: { mimeType: "image/png", data: fakeImageData.toString("base64") } }] },
        }],
      }),
    });

    // Queue generation
    const result = await client.callTool({
      name: "generate_image",
      arguments: { prompt: "e2e test image", image_size: "0.5K", thinking_level: "minimal" },
    });
    const text = result.content[0].text;
    assert.ok(text.includes("job_id:"), "should return job_id");
    assert.ok(text.includes("output_path:"), "should return output_path");

    const jobId = text.match(/job_id:\s*(\S+)/)[1];

    // Wait for background task to complete
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Poll check_generation
    const check = await client.callTool({ name: "check_generation", arguments: { job_id: jobId } });
    const checkText = check.content[0].text;
    assert.ok(checkText.includes("Status: complete"), `expected complete, got: ${checkText}`);
    assert.ok(checkText.includes("KB)"), "should show file size");
  });

  it("generate_image returns error when GEMINI_API_KEY is missing", async () => {
    const savedKey = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    globalThis.fetch = origFetch;

    try {
      // The tool handler catches API key error in the fire-and-forget, not upfront.
      // Actually, callGeminiAPI is called in fire-and-forget, so the tool returns successfully
      // with a job_id, and the job fails later.
      const result = await client.callTool({
        name: "generate_image",
        arguments: { prompt: "should fail", image_size: "0.5K", thinking_level: "minimal" },
      });
      const jobId = result.content[0].text.match(/job_id:\s*(\S+)/)[1];
      await new Promise((resolve) => setTimeout(resolve, 200));
      const check = await client.callTool({ name: "check_generation", arguments: { job_id: jobId } });
      assert.ok(check.content[0].text.includes("GEMINI_API_KEY"), "should mention missing key");
    } finally {
      process.env.GEMINI_API_KEY = savedKey;
    }
  });

  it("generate_image passes abort signal to fetch", async () => {
    // Verify the fire-and-forget path includes an AbortSignal
    let capturedSignal = null;
    globalThis.fetch = async (url, opts) => {
      capturedSignal = opts.signal;
      return {
        ok: true,
        json: async () => ({
          candidates: [{ finishReason: "STOP", content: { parts: [{ inlineData: { mimeType: "image/png", data: PNG_HEADER.toString("base64") } }] } }],
        }),
      };
    };

    const result = await client.callTool({
      name: "generate_image",
      arguments: { prompt: "signal test", image_size: "0.5K", thinking_level: "minimal" },
    });
    assert.ok(result.content[0].text.includes("job_id:"));
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.ok(capturedSignal instanceof AbortSignal, "fetch should receive an AbortSignal");
    assert.ok(!capturedSignal.aborted, "signal should not be aborted for a fast response");
  });

  it("generate_image validates visual_dna size limits", async () => {
    const result = await client.callTool({
      name: "generate_image",
      arguments: {
        prompt: "test",
        visual_dna: { key: "x".repeat(501) },
      },
    });
    assert.ok(result.isError);
    assert.ok(result.content[0].text.includes("value too long"));
  });

  it("generate_image rejects visual_dna with too many keys", async () => {
    const tooManyKeys = {};
    for (let i = 0; i < 21; i++) tooManyKeys[`k${i}`] = "v";
    const result = await client.callTool({
      name: "generate_image",
      arguments: { prompt: "test", visual_dna: tooManyKeys },
    });
    assert.ok(result.isError);
    assert.ok(result.content[0].text.includes("too many keys"));
  });

  // -------------------------------------------------------------------------
  // edit_image
  // -------------------------------------------------------------------------

  it("edit_image queues a job with valid image input", async () => {
    const imgPath = join(testDir, "edit-input.png");
    writeFileSync(imgPath, PNG_HEADER);

    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        candidates: [{
          finishReason: "STOP",
          content: { parts: [{ inlineData: { mimeType: "image/png", data: PNG_HEADER.toString("base64") } }] },
        }],
      }),
    });

    const result = await client.callTool({
      name: "edit_image",
      arguments: { images: [imgPath], prompt: "make it blue", image_size: "0.5K", thinking_level: "minimal" },
    });
    const text = result.content[0].text;
    assert.ok(text.includes("job_id:"), "should return job_id");
    assert.ok(text.includes("make it blue"), "should echo instruction");
  });

  it("edit_image rejects non-image file path", async () => {
    const result = await client.callTool({
      name: "edit_image",
      arguments: { images: ["/etc/passwd"], prompt: "test", image_size: "0.5K", thinking_level: "minimal" },
    });
    assert.ok(result.isError);
    assert.ok(result.content[0].text.includes("Access denied"));
  });

  it("edit_image rejects file with image extension but non-image content", async () => {
    const fakePath = join(testDir, "fake-image.png");
    writeFileSync(fakePath, "not an image at all");

    const result = await client.callTool({
      name: "edit_image",
      arguments: { images: [fakePath], prompt: "test", image_size: "0.5K", thinking_level: "minimal" },
    });
    assert.ok(result.isError);
    assert.ok(result.content[0].text.includes("does not contain valid image data"));
  });

  // -------------------------------------------------------------------------
  // Metadata stripping
  // -------------------------------------------------------------------------

  it("edit_image strips EXIF metadata from JPEG before sending to API", async () => {
    // Build a JPEG with EXIF containing fake GPS data
    const soi = Buffer.from([0xFF, 0xD8]);
    const exifPayload = Buffer.from("Exif\x00\x00GPS:SECRET-LOCATION");
    const app1 = Buffer.alloc(2 + 2 + exifPayload.length);
    app1[0] = 0xFF; app1[1] = 0xE1;
    app1.writeUInt16BE(exifPayload.length + 2, 2);
    exifPayload.copy(app1, 4);
    const sos = Buffer.from([0xFF, 0xDA, 0x00, 0x02]);
    const data = Buffer.from([0xFF, 0xD9]);
    const jpegWithExif = Buffer.concat([soi, app1, sos, data]);

    const jpegPath = join(testDir, "exif-test.jpg");
    writeFileSync(jpegPath, jpegWithExif);

    let capturedBody;
    globalThis.fetch = async (url, opts) => {
      capturedBody = JSON.parse(opts.body);
      return {
        ok: true,
        json: async () => ({
          candidates: [{ finishReason: "STOP", content: { parts: [{ inlineData: { mimeType: "image/jpeg", data: soi.toString("base64") } }] } }],
        }),
      };
    };

    await client.callTool({
      name: "edit_image",
      arguments: { images: [jpegPath], prompt: "test edit", image_size: "0.5K", thinking_level: "minimal" },
    });

    // Wait for the throttled API call to execute
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Decode the base64 that was sent to the API and verify EXIF is gone
    const sentParts = capturedBody.contents[0].parts;
    const imagePart = sentParts.find((p) => p.inlineData);
    const sentBytes = Buffer.from(imagePart.inlineData.data, "base64");
    assert.ok(!sentBytes.includes("SECRET-LOCATION"), "EXIF GPS data should be stripped before sending to API");
    assert.ok(sentBytes[0] === 0xFF && sentBytes[1] === 0xD8, "should still be valid JPEG");
  });

  // -------------------------------------------------------------------------
  // extract_visual_dna
  // -------------------------------------------------------------------------

  it("extract_visual_dna returns structured text from API", async () => {
    const imgPath = join(testDir, "dna-input.png");
    writeFileSync(imgPath, PNG_HEADER);

    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        candidates: [{
          finishReason: "STOP",
          content: { parts: [{ text: '{"style":"cinematic","lighting":"golden hour"}' }] },
        }],
      }),
    });

    const result = await client.callTool({
      name: "extract_visual_dna",
      arguments: { images: [imgPath] },
    });
    assert.ok(!result.isError);
    const parsed = JSON.parse(result.content[0].text);
    assert.equal(parsed.style, "cinematic");
  });

  // -------------------------------------------------------------------------
  // describe_image
  // -------------------------------------------------------------------------

  it("describe_image returns description text from API", async () => {
    const imgPath = join(testDir, "describe-input.png");
    writeFileSync(imgPath, PNG_HEADER);

    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        candidates: [{
          finishReason: "STOP",
          content: { parts: [{ text: "A beautiful sunset over the ocean" }] },
        }],
      }),
    });

    const result = await client.callTool({
      name: "describe_image",
      arguments: { images: [imgPath] },
    });
    assert.ok(!result.isError);
    assert.ok(result.content[0].text.includes("sunset"));
  });

  // -------------------------------------------------------------------------
  // check_generation (list all)
  // -------------------------------------------------------------------------

  it("check_generation without job_id lists all recent jobs", async () => {
    const result = await client.callTool({ name: "check_generation", arguments: {} });
    // There should be jobs from earlier tests
    const text = result.content[0].text;
    assert.ok(text.length > 0, "should return some job info");
  });

  // -------------------------------------------------------------------------
  // Gemini API error handling in tool context
  // -------------------------------------------------------------------------

  it("generate_image records API failure on the job", async () => {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        candidates: [{
          finishReason: "SAFETY",
          safetyRatings: [{ category: "HARM_CATEGORY_VIOLENCE", probability: "HIGH", blocked: true }],
          content: { parts: [] },
        }],
      }),
    });

    const result = await client.callTool({
      name: "generate_image",
      arguments: { prompt: "blocked content", image_size: "0.5K", thinking_level: "minimal" },
    });
    const jobId = result.content[0].text.match(/job_id:\s*(\S+)/)[1];
    await new Promise((resolve) => setTimeout(resolve, 200));

    const check = await client.callTool({ name: "check_generation", arguments: { job_id: jobId } });
    assert.ok(check.content[0].text.includes("failed"), "job should be failed");
    assert.ok(check.content[0].text.includes("safety"), "should mention safety");
  });
});
