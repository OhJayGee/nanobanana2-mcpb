import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { slugify, detectMimeType, generateFilename } from "../server/index.js";

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
