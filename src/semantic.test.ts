import type { SemanticConfig } from "./config";
import { FakeIntercomExtensionBus } from "./intercom-bus";
import { SemanticCoordinator, SemanticSynopsisGenerator } from "./semantic";
import type { ClassificationDecision, SemanticModel } from "./semantic-model";
import { generateGroupId } from "./palette";
import type { ContextCard, GroupAssignment, TabGroup } from "./types";

const CONFIG: SemanticConfig = {
  enabled: true,
  provider: "anthropic",
  model: "claude-haiku-4-5",
  debounceMs: 60_000,
  cooldownMs: 0,
  maxCallsPerHour: 6,
};

function card(overrides: Partial<ContextCard> = {}): ContextCard {
  return {
    sessionId: "session-a",
    revision: 1,
    cardHash: "hash-a",
    ticketIds: [],
    synopsis: "Implement automatic grouping for related Pi sessions",
    domainNouns: ["tabs", "sessions"],
    updatedAt: 1,
    ...overrides,
  };
}

function modelWith(decisions: ClassificationDecision[]): SemanticModel & { classify: jest.Mock } {
  return {
    summarize: jest.fn(),
    classify: jest.fn().mockResolvedValue(decisions),
  };
}

describe("SemanticSynopsisGenerator", () => {
  it("deduplicates inputs and enforces cooldown", async () => {
    let now = 10_000;
    const model: SemanticModel = {
      summarize: jest.fn().mockResolvedValue({ synopsis: "goal", domainNouns: ["tabs"] }),
      classify: jest.fn(),
    };
    const generator = new SemanticSynopsisGenerator(model, { ...CONFIG, cooldownMs: 1000 }, () => now);
    await expect(generator.generate(["prompt"])).resolves.toEqual({
      status: "generated",
      summary: { synopsis: "goal", domainNouns: ["tabs"] },
    });
    await expect(generator.generate(["prompt"])).resolves.toEqual({ status: "unchanged" });
    await expect(generator.generate(["new prompt"])).resolves.toEqual({ status: "deferred", inputChanged: true, retryAfterMs: 1000 });
    now += 1000;
    await generator.generate(["new prompt"]);
    expect(model.summarize).toHaveBeenCalledTimes(2);
  });

  it("coalesces overlapping calls for the same changed input", async () => {
    let resolve!: (value: { synopsis: string; domainNouns: string[] }) => void;
    const model: SemanticModel = {
      summarize: jest.fn(() => new Promise((done) => { resolve = done; })),
      classify: jest.fn(),
    };
    const generator = new SemanticSynopsisGenerator(model, CONFIG);
    const first = generator.generate(["prompt"]);
    await expect(generator.generate(["prompt"])).resolves.toEqual({ status: "deferred", inputChanged: true, retryAfterMs: 1000 });
    resolve({ synopsis: "goal", domainNouns: [] });
    await first;
    expect(model.summarize).toHaveBeenCalledTimes(1);
  });
});

describe("SemanticCoordinator", () => {
  it("creates, persists, publishes, and locally applies a semantic group", async () => {
    const bus = new FakeIntercomExtensionBus("owner", "owner");
    const model = modelWith([{ sessionId: "session-a", action: "new", label: "Pi tab groups", confidence: 0.92, reason: "same goal" }]);
    const applied: Array<{ assignment: GroupAssignment; group?: TabGroup }> = [];
    const coordinator = new SemanticCoordinator(bus, model, CONFIG, (assignment, group) => applied.push({ assignment, group }), () => 10_000);
    coordinator.start();
    bus.simulateMessage({ type: "context_card", card: card() }, "session-a");

    await coordinator.evaluateNow();

    const published = bus.publishedMessages.find(({ message }) => message.type === "assignment");
    expect(published?.message).toMatchObject({ type: "assignment", assignment: { source: "semantic", sessionId: "session-a" } });
    expect(published?.options).toEqual({ audience: "capable", ownerOnly: true });
    expect(applied).toHaveLength(1);
    expect(applied[0]!.group).toMatchObject({ label: "Pi tab groups", status: "provisional" });
    expect(bus.getState()).toMatchObject({ revision: 1, payload: { version: 1 } });

    await coordinator.evaluateNow();
    expect(model.classify).toHaveBeenCalledTimes(1);
    coordinator.stop();
  });

  it("does not reclassify when only sticky assignment metadata changes", async () => {
    const bus = new FakeIntercomExtensionBus("owner", "owner");
    const model = modelWith([{ sessionId: "session-a", action: "new", label: "Pi tab groups", confidence: 0.92, reason: "same goal" }]);
    const applied: Array<{ assignment: GroupAssignment; group?: TabGroup }> = [];
    const coordinator = new SemanticCoordinator(bus, model, CONFIG, (assignment, group) => applied.push({ assignment, group }));
    coordinator.start();
    bus.simulateMessage({ type: "context_card", card: card() }, "session-a");
    await coordinator.evaluateNow();
    bus.simulateMessage({
      type: "context_card",
      card: card({ cardHash: "hash-after-sticky", sticky: { assignment: applied[0]!.assignment, group: applied[0]!.group, appliedAt: 2 } }),
    }, "session-a");
    await coordinator.evaluateNow();
    expect(model.classify).toHaveBeenCalledTimes(1);
    coordinator.stop();
  });

  it("retries cards omitted from a model response", async () => {
    const bus = new FakeIntercomExtensionBus("owner", "owner");
    const model = modelWith([]);
    const coordinator = new SemanticCoordinator(bus, model, CONFIG, jest.fn());
    coordinator.start();
    bus.simulateMessage({ type: "context_card", card: card() }, "session-a");
    await coordinator.evaluateNow();
    await coordinator.evaluateNow();
    expect(model.classify).toHaveBeenCalledTimes(2);
    coordinator.stop();
  });

  it("ignores context cards that spoof another sender", async () => {
    const bus = new FakeIntercomExtensionBus("owner", "owner");
    const model = modelWith([]);
    const coordinator = new SemanticCoordinator(bus, model, CONFIG, jest.fn());
    coordinator.start();
    bus.simulateMessage({ type: "context_card", card: card({ sessionId: "victim" }) }, "attacker");
    await coordinator.evaluateNow();
    expect(model.classify).not.toHaveBeenCalled();
    coordinator.stop();
  });

  it("does not classify cards covered by stronger deterministic evidence", async () => {
    const bus = new FakeIntercomExtensionBus("owner", "owner");
    const model = modelWith([]);
    const coordinator = new SemanticCoordinator(bus, model, CONFIG, jest.fn());
    coordinator.start();
    bus.simulateMessage({ type: "context_card", card: card({ ticketIds: ["ABC-123"] }) }, "session-a");
    await coordinator.evaluateNow();
    expect(model.classify).not.toHaveBeenCalled();
    coordinator.stop();
  });

  it("discards a model result after losing ownership", async () => {
    const bus = new FakeIntercomExtensionBus("owner", "owner");
    let resolve!: (value: ClassificationDecision[]) => void;
    const model: SemanticModel = {
      summarize: jest.fn(),
      classify: jest.fn(() => new Promise((done) => { resolve = done; })),
    };
    const applied = jest.fn();
    const coordinator = new SemanticCoordinator(bus, model, CONFIG, applied);
    coordinator.start();
    bus.simulateMessage({ type: "context_card", card: card() }, "session-a");
    const evaluation = coordinator.evaluateNow();
    bus.setOwner("other");
    resolve([{ sessionId: "session-a", action: "new", label: "Wrong", confidence: 0.99, reason: "stale" }]);
    await evaluation;
    expect(applied).not.toHaveBeenCalled();
    expect(bus.publishedMessages).toHaveLength(0);
    coordinator.stop();
  });

  it("schedules a fresh pass when the fleet changes during classification", async () => {
    jest.useFakeTimers();
    const bus = new FakeIntercomExtensionBus("owner", "owner");
    let resolveFirst!: (value: ClassificationDecision[]) => void;
    const model: SemanticModel = {
      summarize: jest.fn(),
      classify: jest.fn()
        .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
        .mockResolvedValueOnce([{ sessionId: "session-a", action: "unknown", confidence: 0.2, reason: "unclear" }]),
    };
    const coordinator = new SemanticCoordinator(bus, model, { ...CONFIG, debounceMs: 10 }, jest.fn());
    coordinator.start();
    bus.simulateMessage({ type: "context_card", card: card() }, "session-a");
    const first = coordinator.evaluateNow();
    bus.simulateMessage({ type: "context_card", card: card({ cardHash: "changed", synopsis: "Changed product goal" }) }, "session-a");
    resolveFirst([{ sessionId: "session-a", action: "unknown", confidence: 0.2, reason: "stale" }]);
    await first;
    await jest.advanceTimersByTimeAsync(10);
    expect(model.classify).toHaveBeenCalledTimes(2);
    coordinator.stop();
    jest.useRealTimers();
  });

  it("enforces the hourly classifier budget", async () => {
    const bus = new FakeIntercomExtensionBus("owner", "owner");
    const model = modelWith([]);
    const coordinator = new SemanticCoordinator(bus, model, { ...CONFIG, maxCallsPerHour: 2 }, jest.fn());
    coordinator.start();
    bus.simulateMessage({ type: "context_card", card: card() }, "session-a");
    await coordinator.evaluateNow();
    await coordinator.evaluateNow();
    await coordinator.evaluateNow();
    expect(model.classify).toHaveBeenCalledTimes(2);
    coordinator.stop();
  });

  it("aborts an in-flight classification when stopped", async () => {
    const bus = new FakeIntercomExtensionBus("owner", "owner");
    let receivedSignal: AbortSignal | undefined;
    const model: SemanticModel = {
      summarize: jest.fn(),
      classify: jest.fn((_input, signal) => new Promise((_resolve, reject) => {
        receivedSignal = signal;
        signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      })),
    };
    const coordinator = new SemanticCoordinator(bus, model, CONFIG, jest.fn());
    coordinator.start();
    bus.simulateMessage({ type: "context_card", card: card() }, "session-a");
    const evaluation = coordinator.evaluateNow();
    coordinator.stop();
    await expect(evaluation).rejects.toThrow("aborted");
    expect(receivedSignal?.aborted).toBe(true);
  });

  it("requires two consecutive proposals before moving a replayed semantic sticky", async () => {
    const bus = new FakeIntercomExtensionBus("owner", "owner");
    const model = modelWith([]);
    model.classify
      .mockResolvedValueOnce([{ sessionId: "session-a", action: "new", label: "First group", confidence: 0.95, reason: "initial" }])
      .mockResolvedValueOnce([{ sessionId: "session-a", action: "new", label: "Second group", confidence: 0.95, reason: "changed" }])
      .mockResolvedValueOnce([{ sessionId: "session-a", action: "new", label: "Second group", confidence: 0.95, reason: "confirmed" }]);
    const applied: Array<{ assignment: GroupAssignment; group?: TabGroup }> = [];
    const coordinator = new SemanticCoordinator(bus, model, CONFIG, (assignment, group) => applied.push({ assignment, group }));
    coordinator.start();
    bus.simulateMessage({ type: "context_card", card: card() }, "session-a");
    await coordinator.evaluateNow();
    const stickyAssignment = { ...applied[0]!.assignment, source: "sticky" as const, reasonCode: "sticky_semantic" };
    bus.simulateMessage({
      type: "context_card",
      card: card({ cardHash: "changed", synopsis: "A different product goal", sticky: { assignment: stickyAssignment, group: applied[0]!.group, appliedAt: 2 } }),
    }, "session-a");
    await coordinator.evaluateNow();
    expect(applied).toHaveLength(1);
    await coordinator.evaluateNow();
    expect(applied).toHaveLength(2);
    expect(applied[1]!.group?.label).toBe("Second group");
    coordinator.stop();
  });

  it("rejects prototype keys and existing groups absent from the registry", async () => {
    const bus = new FakeIntercomExtensionBus("owner", "owner");
    const model = modelWith([
      { sessionId: "session-a", action: "existing", groupId: "__proto__", confidence: 0.99, reason: "bad id" },
      { sessionId: "session-a", action: "existing", groupId: "invented", confidence: 0.99, reason: "bad id" },
    ]);
    const applied = jest.fn();
    const coordinator = new SemanticCoordinator(bus, model, CONFIG, applied);
    coordinator.start();
    bus.simulateMessage({ type: "context_card", card: card() }, "session-a");
    await coordinator.evaluateNow();
    await coordinator.evaluateNow();
    expect(model.classify).toHaveBeenCalledTimes(2);
    expect(applied).not.toHaveBeenCalled();
    expect(({} as { updatedAt?: number }).updatedAt).toBeUndefined();
    coordinator.stop();
  });

  it("promotes provisional groups only after distinct sessions corroborate them", async () => {
    const bus = new FakeIntercomExtensionBus("owner", "owner");
    const groupId = generateGroupId("Pi tab groups");
    const model = modelWith([]);
    model.classify
      .mockResolvedValueOnce([{ sessionId: "session-a", action: "new", label: "Pi tab groups", confidence: 0.92, reason: "goal" }])
      .mockResolvedValueOnce([{ sessionId: "session-a", action: "existing", groupId, confidence: 0.92, reason: "goal" }])
      .mockResolvedValueOnce([{ sessionId: "session-b", action: "existing", groupId, confidence: 0.92, reason: "goal" }]);
    const coordinator = new SemanticCoordinator(bus, model, CONFIG, jest.fn());
    coordinator.start();
    bus.simulateMessage({ type: "context_card", card: card() }, "session-a");
    await coordinator.evaluateNow();
    bus.simulateMessage({ type: "context_card", card: card({ cardHash: "hash-a2", synopsis: "Improve automatic grouping" }) }, "session-a");
    await coordinator.evaluateNow();
    expect(((bus.getState()!.payload as { groups: Record<string, TabGroup> }).groups[groupId]!.status)).toBe("provisional");
    bus.simulateMessage({ type: "context_card", card: card({ sessionId: "session-b", cardHash: "hash-b" }) }, "session-b");
    await coordinator.evaluateNow();
    expect(((bus.getState()!.payload as { groups: Record<string, TabGroup> }).groups[groupId]!.status)).toBe("established");
    coordinator.stop();
  });
});
