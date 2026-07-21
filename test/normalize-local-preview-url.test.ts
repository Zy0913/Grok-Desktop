import { describe, expect, it } from "vitest";
import { normalizeLocalPreviewUrl } from "../src/renderer/port-chips.js";

describe("normalizeLocalPreviewUrl", () => {
  it("accepts localhost / 127.0.0.1 with port", () => {
    expect(normalizeLocalPreviewUrl("http://127.0.0.1:8765/")).toBe(
      "http://127.0.0.1:8765/",
    );
    expect(normalizeLocalPreviewUrl("localhost:5173")).toBe(
      "http://127.0.0.1:5173/",
    );
  });

  it("rejects non-local hosts", () => {
    expect(normalizeLocalPreviewUrl("https://example.com")).toBeNull();
    expect(normalizeLocalPreviewUrl("http://192.168.1.1:80")).toBeNull();
  });
});
