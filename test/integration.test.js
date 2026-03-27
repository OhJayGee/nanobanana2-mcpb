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
  it("throws on empty array", async () => {
    await assert.rejects(() => loadImageParts([]), { message: /at least one/ });
  });

  it("throws on non-existent file", async () => {
    await assert.rejects(() => loadImageParts(["/nonexistent/fake.png"]), { message: /not found/ });
  });

  it("throws on more than 14 images", async () => {
    const paths = Array(15).fill("/fake.png");
    await assert.rejects(() => loadImageParts(paths), { message: /14/ });
  });
});
