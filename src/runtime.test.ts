import { FakeIntercomExtensionBus } from "./intercom-bus";
import { TabGroupRuntime } from "./runtime";
import { FakeStateStore } from "./state";
import type { TerminalEnvironment, TerminalOutput, TitleSetter } from "./terminal";
import type { ExtensionMessage } from "./types";

class Environment implements TerminalEnvironment {
  getEnv(key: string): string | undefined { return key === "TERM_PROGRAM" ? "iTerm.app" : undefined; }
  getMode(): string { return "tui"; }
}
class Output implements TerminalOutput { writes: string[] = []; write(value: string): void { this.writes.push(value); } }
class Titles implements TitleSetter { values: string[] = []; setTitle(value: string): void { this.values.push(value); } }

function latest<T extends ExtensionMessage["type"]>(bus: FakeIntercomExtensionBus, type: T): Extract<ExtensionMessage, { type: T }> {
  const message = [...bus.publishedMessages].reverse().find((entry) => entry.message.type === type)?.message;
  if (!message || message.type !== type) throw new Error(`Missing ${type}`);
  return message as Extract<ExtensionMessage, { type: T }>;
}

describe("tab group runtime", () => {
  it("persists a manual group and applies the owner assignment", async () => {
    const bus = new FakeIntercomExtensionBus("self", "self");
    const store = new FakeStateStore();
    const output = new Output();
    const titles = new Titles();
    const runtime = new TabGroupRuntime(
      "self",
      bus,
      store,
      async () => ({ sessionId: "self", ticketIds: [] }),
      { output, environment: new Environment(), title: titles, titleSuffix: "worker" },
    );
    await runtime.start();
    await runtime.join("Breach Catalogues");

    const card = latest(bus, "context_card");
    bus.simulateMessage(card, "self");
    const assignment = latest(bus, "assignment");
    bus.simulateMessage(assignment, "self");
    await new Promise((resolve) => setImmediate(resolve));

    expect(runtime.status()).toBe("Tab group: Breach Catalogues (manual lock)");
    expect(output.writes.at(-1)).toMatch(/^\x1b\]1337;SetColors=tab=[0-9A-F]{6}\x1b\\$/);
    expect(titles.values.at(-1)).toBe("[Breach Catalogues] worker");
    expect((await store.get())?.manualLock?.label).toBe("Breach Catalogues");
  });

  it("does not let delayed automation override a manual lock", async () => {
    const bus = new FakeIntercomExtensionBus("self", "owner");
    const store = new FakeStateStore();
    const output = new Output();
    const runtime = new TabGroupRuntime(
      "self",
      bus,
      store,
      async () => ({ sessionId: "self", ticketIds: [] }),
      { output, environment: new Environment(), title: new Titles() },
    );
    await runtime.start();
    await runtime.join("Locked Group");
    const before = output.writes.length;

    bus.simulateMessage({
      type: "assignment",
      assignment: {
        sessionId: "self",
        groupId: "other",
        source: "semantic",
        reasonCode: "late",
        confidenceBand: "high",
        cardHash: "old",
        updatedAt: 1,
      },
      group: { id: "other", label: "Other", colour: "5B9BD5", createdAt: 1, updatedAt: 1 },
    }, "owner");
    await new Promise((resolve) => setImmediate(resolve));
    expect(output.writes).toHaveLength(before);
  });

  it("clears stale semantic style and assignment when a changed prompt is deferred", async () => {
    const bus = new FakeIntercomExtensionBus("self", "self");
    const store = new FakeStateStore();
    const output = new Output();
    const titles = new Titles();
    const runtime = new TabGroupRuntime(
      "self",
      bus,
      store,
      async () => ({ sessionId: "self", ticketIds: [] }),
      { output, environment: new Environment(), title: titles, titleSuffix: "worker" },
    );
    await runtime.start();
    await runtime.setSemanticContext("Old product goal", ["old"]);
    await runtime.applyAssignment({
      sessionId: "self",
      groupId: "old",
      source: "semantic",
      reasonCode: "semantic_new",
      confidenceBand: "high",
      updatedAt: 1,
    }, { id: "old", label: "Old", colour: "5B9BD5", createdAt: 1, updatedAt: 1 });

    await runtime.invalidateSemanticContext();

    expect((await store.get())?.lastAssignment).toBeUndefined();
    expect(output.writes.at(-1)).toBe("\x1b]1337;SetColors=tab=default\x1b\\");
    expect(titles.values.at(-1)).toBe("worker");
    expect(latest(bus, "context_card").card.synopsis).toBeUndefined();
  });

  it("requests a fleet-wide refresh through intercom", async () => {
    const bus = new FakeIntercomExtensionBus("self", "owner");
    const runtime = new TabGroupRuntime(
      "self",
      bus,
      new FakeStateStore(),
      async () => ({ sessionId: "self", ticketIds: [] }),
      { output: new Output(), environment: new Environment(), title: new Titles() },
    );
    await runtime.start();
    bus.publishedMessages.length = 0;
    await runtime.refreshAll();
    expect(bus.publishedMessages).toContainEqual({
      message: { type: "refresh_fleet" },
      options: { audience: "owner" },
    });
  });

  it("resets colour when disabled and on shutdown", async () => {
    const bus = new FakeIntercomExtensionBus("self", "self");
    const output = new Output();
    const runtime = new TabGroupRuntime(
      "self",
      bus,
      new FakeStateStore(),
      async () => ({ sessionId: "self", ticketIds: [] }),
      { output, environment: new Environment(), title: new Titles() },
    );
    await runtime.start();
    await runtime.setEnabled(false);
    expect(output.writes.at(-1)).toBe("\x1b]1337;SetColors=tab=default\x1b\\");
    await runtime.shutdown();
    expect(output.writes.at(-1)).toBe("\x1b]1337;SetColors=tab=default\x1b\\");
  });
});
