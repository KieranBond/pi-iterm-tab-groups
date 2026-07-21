import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_CONFIG, loadConfig } from "./config";

describe("loadConfig", () => {
  it("defaults semantic grouping off and pins Haiku", () => {
    expect(loadConfig("/does/not/exist")).toEqual(DEFAULT_CONFIG);
    expect(DEFAULT_CONFIG.semantic).toMatchObject({
      enabled: false,
      provider: "anthropic",
      model: "claude-haiku-4-5",
      maxCallsPerHour: 6,
    });
  });

  it("merges valid semantic overrides", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "tab-groups-config-"));
    const file = path.join(dir, "config.json");
    writeFileSync(file, JSON.stringify({ semantic: { enabled: true, debounceMs: 12 } }));
    expect(loadConfig(file).semantic).toMatchObject({ enabled: true, debounceMs: 12, model: "claude-haiku-4-5" });
  });

  it("fails closed to defaults for malformed config", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "tab-groups-config-"));
    const file = path.join(dir, "config.json");
    writeFileSync(file, JSON.stringify({ semantic: { enabled: true, maxCallsPerHour: 999 } }));
    expect(loadConfig(file)).toEqual(DEFAULT_CONFIG);
  });
});
