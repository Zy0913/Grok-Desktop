import { describe, expect, it } from "vitest";
import {
  extractLocalServices,
  isPlausibleListenPort,
} from "../src/renderer/port-chips.js";

describe("extractLocalServices", () => {
  it("detects python http.server port from command", () => {
    const list = extractLocalServices(
      "python3 -m http.server 8765 --bind 127.0.0.1",
      "term_1",
    );
    expect(list.map((s) => s.port)).toEqual([8765]);
    expect(list[0]?.url).toBe("http://127.0.0.1:8765/");
  });

  it("does not treat 127.0.0.1 octet as a port", () => {
    const list = extractLocalServices(
      "Serving HTTP on 127.0.0.1 port 8765 (http://127.0.0.1:8765/) ...",
      "term_2",
    );
    expect(list.map((s) => s.port).sort()).toEqual([8765]);
    expect(list.some((s) => s.port === 127)).toBe(false);
  });

  it("detects vite localhost URL", () => {
    const list = extractLocalServices(
      "  ➜  Local:   http://localhost:5173/",
      "term_3",
    );
    expect(list[0]?.port).toBe(5173);
    expect(list[0]?.url).toBe("http://127.0.0.1:5173/");
  });

  it("rejects implausible listen ports", () => {
    expect(isPlausibleListenPort(127)).toBe(false);
    expect(isPlausibleListenPort(8765)).toBe(true);
    expect(isPlausibleListenPort(80)).toBe(true);
  });
});
