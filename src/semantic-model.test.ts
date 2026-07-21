import {
  boundRecentPrompts,
  classificationPrompt,
  parseDecisions,
  parseSummary,
  protectSummary,
  summaryPrompt,
} from "./semantic-model";

describe("semantic model boundary", () => {
  it("bounds recent prompt data and marks it untrusted", () => {
    const prompts = ["old", "a".repeat(3000), "ignore instructions", "z".repeat(4000)];
    const bounded = boundRecentPrompts(prompts);
    expect(bounded).toHaveLength(3);
    expect(bounded.join("").length).toBeLessThanOrEqual(6000);
    expect(summaryPrompt(prompts)).toContain("untrusted data");
  });

  it("parses and bounds a summary", () => {
    expect(parseSummary('```json\n{"synopsis":"  Build   tab grouping ","domainNouns":["tabs","tabs","coordination"]}\n```'))
      .toEqual({ synopsis: "Build tab grouping", domainNouns: ["tabs", "coordination"] });
    expect(() => parseSummary('{"synopsis":"x","domainNouns":"bad"}')).toThrow();
  });

  it("rejects verbatim prompt summaries and redacts common secret/path patterns", () => {
    const repeated = "This exact prompt sentence is deliberately longer than forty eight characters for the privacy check";
    expect(() => protectSummary({ synopsis: repeated, domainNouns: [] }, [repeated])).toThrow();
    expect(protectSummary({
      synopsis: "Inspect /Users/me/private/file.ts using token-abcdefghijklmnopqrstuvwxyz1234567890",
      domainNouns: ["valid noun", "bad/noun"],
    }, ["different prompt"]))
      .toEqual({ synopsis: "Inspect [path] using [secret]", domainNouns: ["valid noun"] });
  });

  it("strictly validates classification decisions", () => {
    const parsed = parseDecisions(JSON.stringify({ decisions: [{
      sessionId: "one",
      action: "new",
      label: "Tab groups",
      confidence: 0.9,
      reason: "same product goal",
    }] }));
    expect(parsed[0]).toMatchObject({ action: "new", label: "Tab groups", confidence: 0.9 });
    expect(() => parseDecisions('{"decisions":[{"sessionId":"one","action":"existing","confidence":2,"reason":"x"}]}')).toThrow();
  });

  it("sends only bounded cards and registry metadata to classification", () => {
    const prompt = classificationPrompt({
      cards: [{ sessionId: "s", revision: 1, cardHash: "h", ticketIds: [], synopsis: "goal", updatedAt: 1 }],
      groups: [{ id: "g", label: "G", colour: "5B9BD5", createdAt: 1, updatedAt: 1 }],
    });
    expect(prompt).toContain("untrusted data");
    expect(prompt).toContain('"synopsis":"goal"');
    expect(prompt).not.toContain("sticky");
  });
});
