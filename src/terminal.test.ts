import {
  isTerminalSupported,
  isValidHexColor,
  setTabColor,
  resetTabColor,
  sanitizeTitle,
  applyGroupStyle,
  TerminalEnvironment,
  TerminalOutput,
  FakeTitleSetter,
} from "./terminal";
import { TabGroup } from "./types";

class FakeTerminalEnvironment implements TerminalEnvironment {
  constructor(
    private env: Record<string, string> = {},
    private mode = "tui"
  ) {}

  getEnv(key: string): string | undefined {
    return this.env[key];
  }

  getMode(): string {
    return this.mode;
  }
}

class FakeTerminalOutput implements TerminalOutput {
  public writes: string[] = [];

  write(data: string): void {
    this.writes.push(data);
  }

  getLastWrite(): string | undefined {
    return this.writes[this.writes.length - 1];
  }
}

describe("terminal", () => {
  describe("isTerminalSupported", () => {
    it("should support TUI mode with iTerm", () => {
      const env = new FakeTerminalEnvironment({ TERM_PROGRAM: "iTerm.app" }, "tui");
      expect(isTerminalSupported(env)).toBe(true);
    });

    it("should reject headless mode", () => {
      const env = new FakeTerminalEnvironment({ TERM_PROGRAM: "iTerm.app" }, "headless");
      expect(isTerminalSupported(env)).toBe(false);
    });

    it("should reject non-iTerm terminals", () => {
      const env = new FakeTerminalEnvironment({ TERM_PROGRAM: "Apple_Terminal" }, "tui");
      expect(isTerminalSupported(env)).toBe(false);
    });

    it("should reject tmux by default", () => {
      const env = new FakeTerminalEnvironment(
        { TERM_PROGRAM: "iTerm.app", TMUX: "/tmp/tmux-501/default,12345,0" },
        "tui"
      );
      expect(isTerminalSupported(env)).toBe(false);
    });

    it("should allow tmux when forced", () => {
      const env = new FakeTerminalEnvironment(
        { TERM_PROGRAM: "iTerm.app", TMUX: "/tmp/tmux-501/default,12345,0" },
        "tui"
      );
      expect(isTerminalSupported(env, true)).toBe(true);
    });
  });

  describe("isValidHexColor", () => {
    it("should accept valid 6-digit hex colors", () => {
      expect(isValidHexColor("FF0000")).toBe(true);
      expect(isValidHexColor("00FF00")).toBe(true);
      expect(isValidHexColor("0000FF")).toBe(true);
      expect(isValidHexColor("ABCDEF")).toBe(true);
      expect(isValidHexColor("123456")).toBe(true);
    });

    it("should reject invalid formats", () => {
      expect(isValidHexColor("ff0000")).toBe(false); // lowercase
      expect(isValidHexColor("#FF0000")).toBe(false); // with hash
      expect(isValidHexColor("FFF")).toBe(false); // too short
      expect(isValidHexColor("FF00000")).toBe(false); // too long
      expect(isValidHexColor("GGGGGG")).toBe(false); // invalid chars
      expect(isValidHexColor("")).toBe(false); // empty
    });
  });

  describe("setTabColor", () => {
    it("should write correct OSC sequence", () => {
      const env = new FakeTerminalEnvironment({ TERM_PROGRAM: "iTerm.app" }, "tui");
      const output = new FakeTerminalOutput();

      const result = setTabColor("FF0000", output, env);

      expect(result).toBe(true);
      expect(output.getLastWrite()).toBe("\x1b]1337;SetColors=tab=FF0000\x1b\\");
    });

    it("should reject invalid colors", () => {
      const env = new FakeTerminalEnvironment({ TERM_PROGRAM: "iTerm.app" }, "tui");
      const output = new FakeTerminalOutput();

      expect(() => setTabColor("invalid", output, env)).toThrow("Invalid hex color");
    });

    it("should return false for unsupported terminals", () => {
      const env = new FakeTerminalEnvironment({}, "headless");
      const output = new FakeTerminalOutput();

      const result = setTabColor("FF0000", output, env);

      expect(result).toBe(false);
      expect(output.writes.length).toBe(0);
    });
  });

  describe("resetTabColor", () => {
    it("should write correct reset sequence", () => {
      const env = new FakeTerminalEnvironment({ TERM_PROGRAM: "iTerm.app" }, "tui");
      const output = new FakeTerminalOutput();

      const result = resetTabColor(output, env);

      expect(result).toBe(true);
      expect(output.getLastWrite()).toBe("\x1b]1337;SetColors=tab=default\x1b\\");
    });

    it("should return false for unsupported terminals", () => {
      const env = new FakeTerminalEnvironment({}, "headless");
      const output = new FakeTerminalOutput();

      const result = resetTabColor(output, env);

      expect(result).toBe(false);
      expect(output.writes.length).toBe(0);
    });
  });

  describe("sanitizeTitle", () => {
    it("should strip C0 control characters", () => {
      const result = sanitizeTitle("Hello\x00\x01\x1fWorld");
      expect(result).toBe("HelloWorld");
    });

    it("should strip C1 control characters", () => {
      const result = sanitizeTitle("Hello\x7f\x80\x9fWorld");
      expect(result).toBe("HelloWorld");
    });

    it("should normalize whitespace", () => {
      const result = sanitizeTitle("  Hello   World  ");
      expect(result).toBe("Hello World");
    });

    it("should cap at max code points", () => {
      const long = "a".repeat(100);
      const result = sanitizeTitle(long, 80);
      expect(Array.from(result).length).toBe(80);
    });

    it("should handle Unicode correctly", () => {
      const emoji = "Hello 👋 World 🌍";
      const result = sanitizeTitle(emoji, 20);
      expect(result).toBe(emoji); // Should fit
      expect(Array.from(result).length).toBeLessThanOrEqual(20);
    });

    it("should handle empty strings", () => {
      expect(sanitizeTitle("")).toBe("");
    });

    it("should handle only whitespace", () => {
      expect(sanitizeTitle("   \n\t   ")).toBe("");
    });
  });

  describe("applyGroupStyle", () => {
    it("should apply group color and title", () => {
      const env = new FakeTerminalEnvironment({ TERM_PROGRAM: "iTerm.app" }, "tui");
      const output = new FakeTerminalOutput();
      const titleSetter = new FakeTitleSetter();
      const group: TabGroup = {
        id: "group-1",
        label: "Feature Work",
        colour: "FF0000",
        createdAt: 123,
        updatedAt: 123,
      };

      const result = applyGroupStyle(group, output, env, titleSetter);

      expect(result).toBe(true);
      expect(output.getLastWrite()).toBe("\x1b]1337;SetColors=tab=FF0000\x1b\\");
      expect(titleSetter.getLastTitle()).toBe("[Feature Work]");
    });

    it("should reset color and title when group is null", () => {
      const env = new FakeTerminalEnvironment({ TERM_PROGRAM: "iTerm.app" }, "tui");
      const output = new FakeTerminalOutput();
      const titleSetter = new FakeTitleSetter();

      const result = applyGroupStyle(null, output, env, titleSetter);

      expect(result).toBe(true);
      expect(output.getLastWrite()).toBe("\x1b]1337;SetColors=tab=default\x1b\\");
      expect(titleSetter.getLastTitle()).toBe("");
    });

    it("should restore the session title when group is null", () => {
      const env = new FakeTerminalEnvironment({ TERM_PROGRAM: "iTerm.app" }, "tui");
      const output = new FakeTerminalOutput();
      const titleSetter = new FakeTitleSetter();

      applyGroupStyle(null, output, env, titleSetter, false, "rbac");

      expect(titleSetter.getLastTitle()).toBe("rbac");
    });

    it("should sanitize group label", () => {
      const env = new FakeTerminalEnvironment({ TERM_PROGRAM: "iTerm.app" }, "tui");
      const output = new FakeTerminalOutput();
      const titleSetter = new FakeTitleSetter();
      const group: TabGroup = {
        id: "group-1",
        label: "Feature\x00Work\x1fWith\x7fBad\x9fChars",
        colour: "FF0000",
        createdAt: 123,
        updatedAt: 123,
      };

      applyGroupStyle(group, output, env, titleSetter);

      expect(titleSetter.getLastTitle()).toBe("[FeatureWorkWithBadChars]");
    });

    it("should work without title setter", () => {
      const env = new FakeTerminalEnvironment({ TERM_PROGRAM: "iTerm.app" }, "tui");
      const output = new FakeTerminalOutput();
      const group: TabGroup = {
        id: "group-1",
        label: "Test",
        colour: "FF0000",
        createdAt: 123,
        updatedAt: 123,
      };

      const result = applyGroupStyle(group, output, env);

      expect(result).toBe(true);
      expect(output.getLastWrite()).toBe("\x1b]1337;SetColors=tab=FF0000\x1b\\");
    });
  });
});
