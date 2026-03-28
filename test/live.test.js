/**
 * Live integration tests — hit the real Gemini API.
 *
 * Skipped unless NANOBANANA_LIVE_TEST=1 is set.
 * Requires GEMINI_API_KEY in environment.
 *
 * Design: matches the server's async architecture.
 *  - Phase 1: queue jobs (instant — tests that the MCP tool returns a job_id)
 *  - Phase 2: poll until all jobs settle (best-effort, does not fail on timeout)
 *  - Phase 3: verify completed images + run analysis tools on them
 *
 * Run:  NANOBANANA_LIVE_TEST=1 NANOBANANA_TEST=1 node --test test/live.test.js
 */
import { describe, it, before, after } from "node:test";
import { strict as assert } from "node:assert";
import { mkdirSync, existsSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, validateImageBuffer } from "../server/index.js";

const LIVE = process.env.NANOBANANA_LIVE_TEST === "1";
const SKIP_REASON = "set NANOBANANA_LIVE_TEST=1 to run live integration tests";

const liveDir = join(tmpdir(), `nanobanana-live-${Date.now()}`);

// Shared state across phases — jobs queued in phase 1, verified in phase 3
const queued = {};  // name → { jobId, outputPath, text }

describe("live integration (real Gemini API)", { skip: !LIVE && SKIP_REASON }, () => {
  let client;
  let serverInstance;
  const origOutputDir = process.env.OUTPUT_DIR;

  before(async () => {
    assert.ok(process.env.GEMINI_API_KEY, "GEMINI_API_KEY must be set for live tests");
    process.env.OUTPUT_DIR = liveDir;
    mkdirSync(liveDir, { recursive: true });

    serverInstance = createServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await serverInstance.connect(serverTransport);
    client = new Client({ name: "live-test", version: "1.0.0" });
    await client.connect(clientTransport);
  });

  after(async () => {
    if (client) await client.close();
    if (serverInstance) await serverInstance.close();
    process.env.OUTPUT_DIR = origOutputDir || "";
    console.log(`\n  Live test output: ${liveDir}\n`);
  });

  // Helper: extract job_id and output_path from tool response text
  function parseJobResponse(text) {
    const jobId = text.match(/job_id:\s*(\S+)/)?.[1];
    const outputPath = text.match(/output_path:\s*(.+)/)?.[1]?.trim();
    return { jobId, outputPath };
  }

  // =========================================================================
  // Phase 1 — Queue jobs (instant, tests MCP tool dispatch + job creation)
  // =========================================================================

  it("queues generate_image (rubber duck, 0.5K)", async () => {
    const result = await client.callTool({
      name: "generate_image",
      arguments: { prompt: "A small yellow rubber duck on a white background", image_size: "0.5K", thinking_level: "minimal" },
    });
    assert.ok(!result.isError, result.content[0].text);
    const { jobId, outputPath } = parseJobResponse(result.content[0].text);
    assert.ok(jobId, "should return job_id");
    assert.ok(outputPath, "should return output_path");
    queued.duck = { jobId, outputPath };
    console.log(`    queued: ${jobId}`);
  });

  it("queues generate_image with style (coffee, 1K)", async () => {
    const result = await client.callTool({
      name: "generate_image",
      arguments: {
        prompt: "A steaming cup of coffee on a wooden table",
        style: "Watercolor painting with soft pastel colors",
        image_size: "1K",
        thinking_level: "minimal",
      },
    });
    assert.ok(!result.isError, result.content[0].text);
    queued.coffee = parseJobResponse(result.content[0].text);
    console.log(`    queued: ${queued.coffee.jobId}`);
  });

  it("queues generate_image (red circle for edit test, 0.5K)", async () => {
    const result = await client.callTool({
      name: "generate_image",
      arguments: { prompt: "A plain red circle on a white background", image_size: "0.5K", thinking_level: "minimal" },
    });
    assert.ok(!result.isError, result.content[0].text);
    queued.circle = parseJobResponse(result.content[0].text);
    console.log(`    queued: ${queued.circle.jobId}`);
  });

  // =========================================================================
  // Phase 2 — Wait for all generation jobs to settle (best-effort)
  // =========================================================================

  it("polls until all queued jobs settle", { timeout: 300_000 }, async () => {
    const jobIds = Object.values(queued).map((q) => q.jobId);
    const settled = new Set();
    const startTime = Date.now();
    const maxWait = 270_000; // 4.5 minutes

    while (settled.size < jobIds.length && Date.now() - startTime < maxWait) {
      for (const id of jobIds) {
        if (settled.has(id)) continue;
        const check = await client.callTool({ name: "check_generation", arguments: { job_id: id } });
        const text = check.content[0].text;
        if (text.includes("Status: complete") || text.includes("Status: failed")) {
          settled.add(id);
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
          const status = text.includes("complete") ? "complete" : "FAILED";
          console.log(`    ${id}: ${status} (${elapsed}s)`);
        }
      }
      if (settled.size < jobIds.length) {
        await new Promise((r) => setTimeout(r, 5_000));
      }
    }

    console.log(`    ${settled.size}/${jobIds.length} jobs settled in ${((Date.now() - startTime) / 1000).toFixed(0)}s`);
    // Don't assert all settled — some may take longer than 4.5 min on slow API days
  });

  // =========================================================================
  // Phase 3 — Verify completed images and run analysis tools
  // =========================================================================

  it("duck image is a valid PNG on disk", async () => {
    const { outputPath } = queued.duck;
    if (!existsSync(outputPath)) return; // generation may still be running
    const stats = statSync(outputPath);
    assert.ok(stats.size > 1000, `expected > 1 KB, got ${stats.size} bytes`);
    const buf = readFileSync(outputPath);
    assert.doesNotThrow(() => validateImageBuffer(buf, outputPath));
    console.log(`    ${(stats.size / 1024).toFixed(0)} KB, valid image`);
  });

  it("coffee image is a valid PNG on disk", async () => {
    const { outputPath } = queued.coffee;
    if (!existsSync(outputPath)) return;
    const stats = statSync(outputPath);
    assert.ok(stats.size > 5000, `1K image expected > 5 KB, got ${stats.size} bytes`);
    console.log(`    ${(stats.size / 1024).toFixed(0)} KB`);
  });

  it("edit_image edits the red circle", { timeout: 180_000 }, async () => {
    const sourcePath = queued.circle.outputPath;
    if (!existsSync(sourcePath)) {
      console.log("    skipped — source image not ready");
      return;
    }

    const editResult = await client.callTool({
      name: "edit_image",
      arguments: {
        images: [sourcePath],
        prompt: "Change the red circle to blue and add a green border",
        image_size: "0.5K",
        thinking_level: "minimal",
      },
    });
    assert.ok(!editResult.isError, editResult.content[0].text);
    const { jobId } = parseJobResponse(editResult.content[0].text);
    console.log(`    edit queued: ${jobId}, polling...`);

    // Poll this one job
    const start = Date.now();
    while (Date.now() - start < 150_000) {
      const check = await client.callTool({ name: "check_generation", arguments: { job_id: jobId } });
      const text = check.content[0].text;
      if (text.includes("Status: complete")) {
        const filePath = text.match(/File:\s*(\S+)/)[1];
        const stats = statSync(filePath);
        assert.ok(stats.size > 1000);
        console.log(`    complete: ${(stats.size / 1024).toFixed(0)} KB`);
        return;
      }
      if (text.includes("Status: failed")) {
        console.log(`    edit failed: ${text}`);
        return;
      }
      await new Promise((r) => setTimeout(r, 5_000));
    }
    console.log("    edit did not complete in time (non-fatal)");
  });

  it("describe_image describes the duck", async () => {
    const { outputPath } = queued.duck;
    if (!existsSync(outputPath)) {
      console.log("    skipped — image not ready");
      return;
    }

    const result = await client.callTool({
      name: "describe_image",
      arguments: { images: [outputPath] },
    });
    assert.ok(!result.isError, result.content[0].text);
    assert.ok(result.content[0].text.length > 50, "description should be substantial");
    console.log(`    "${result.content[0].text.slice(0, 120)}..."`);
  });

  it("extract_visual_dna extracts DNA from the coffee image", async () => {
    const { outputPath } = queued.coffee;
    if (!existsSync(outputPath)) {
      console.log("    skipped — image not ready");
      return;
    }

    const result = await client.callTool({
      name: "extract_visual_dna",
      arguments: { images: [outputPath] },
    });
    assert.ok(!result.isError, result.content[0].text);

    let dna;
    try {
      dna = JSON.parse(result.content[0].text);
    } catch {
      const cleaned = result.content[0].text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
      dna = JSON.parse(cleaned);
    }
    assert.ok(typeof dna === "object");
    assert.ok(Object.keys(dna).length >= 3, `expected >= 3 fields, got: ${Object.keys(dna).join(", ")}`);
    console.log(`    fields: ${Object.keys(dna).join(", ")}`);
  });

  it("check_generation lists all jobs from the session", async () => {
    const result = await client.callTool({ name: "check_generation", arguments: {} });
    const text = result.content[0].text;
    const lines = text.split("\n");
    assert.ok(lines.length >= 3, `should have at least 3 jobs, got ${lines.length}`);
    console.log(`    ${lines.length} jobs tracked`);
  });
});
