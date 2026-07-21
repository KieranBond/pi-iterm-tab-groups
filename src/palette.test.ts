import { getGroupColor, generateGroupId, isValidPaletteColor, getPalette } from "./palette";

describe("palette", () => {
  describe("getGroupColor", () => {
    it("should return deterministic colors", () => {
      const color1a = getGroupColor("group-1");
      const color1b = getGroupColor("group-1");
      expect(color1a).toBe(color1b);
    });

    it("should return valid hex colors", () => {
      const color = getGroupColor("test-group");
      expect(color).toMatch(/^[0-9A-F]{6}$/);
    });

    it("should return colors from the palette", () => {
      const color = getGroupColor("test-group");
      expect(isValidPaletteColor(color)).toBe(true);
    });

    it("should distribute across palette", () => {
      const colors = new Set<string>();
      for (let i = 0; i < 100; i++) {
        const color = getGroupColor(`group-${i}`);
        colors.add(color);
      }
      // Should see multiple different colors
      expect(colors.size).toBeGreaterThan(5);
    });

    it("should handle empty string", () => {
      const color = getGroupColor("");
      expect(color).toMatch(/^[0-9A-F]{6}$/);
    });
  });

  describe("generateGroupId", () => {
    it("should generate deterministic IDs", () => {
      const id1a = generateGroupId("Feature Work");
      const id1b = generateGroupId("Feature Work");
      expect(id1a).toBe(id1b);
    });

    it("should normalize labels", () => {
      const id1 = generateGroupId("Feature Work");
      const id2 = generateGroupId("  feature   work  ");
      expect(id1).toMatch(/^feature-work-[0-9a-f]{8}$/);
      expect(id2).toBe(id1);
    });

    it("should include hash for uniqueness", () => {
      const id = generateGroupId("Test");
      expect(id).toMatch(/^test-[0-9a-f]{8}$/);
    });

    it("should remove special characters from the slug", () => {
      const id = generateGroupId("Test@#$%Group");
      expect(id).toMatch(/^test-group-[0-9a-f]{8}$/);
    });

    it("should reject an empty label", () => {
      expect(() => generateGroupId("")).toThrow("Group label must not be empty");
    });
  });

  describe("isValidPaletteColor", () => {
    it("should accept palette colors", () => {
      const palette = getPalette();
      for (const color of palette) {
        expect(isValidPaletteColor(color)).toBe(true);
      }
    });

    it("should reject non-palette colors", () => {
      expect(isValidPaletteColor("FF0000")).toBe(false);
      expect(isValidPaletteColor("ABCDEF")).toBe(false);
      expect(isValidPaletteColor("000000")).toBe(false);
    });

    it("should reject invalid formats", () => {
      expect(isValidPaletteColor("")).toBe(false);
      expect(isValidPaletteColor("invalid")).toBe(false);
    });
  });

  describe("getPalette", () => {
    it("should return array of valid colors", () => {
      const palette = getPalette();
      expect(palette.length).toBeGreaterThan(0);
      for (const color of palette) {
        expect(color).toMatch(/^[0-9A-F]{6}$/);
      }
    });

    it("should return readonly array", () => {
      const palette = getPalette();
      // TypeScript enforces readonly, but we can verify it returns the same reference
      expect(getPalette()).toBe(palette);
    });
  });
});
