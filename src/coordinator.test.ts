import { generateContextCard } from "./context";
import { DeterministicCoordinator } from "./coordinator";
import { FakeIntercomExtensionBus } from "./intercom-bus";
import { generateGroupId } from "./palette";
import type { ExtensionMessage } from "./types";

function assignments(bus: FakeIntercomExtensionBus): Extract<ExtensionMessage, { type: "assignment" }>[] {
  return bus.publishedMessages
    .map(({ message }) => message)
    .filter((message): message is Extract<ExtensionMessage, { type: "assignment" }> => message.type === "assignment");
}

describe("deterministic coordinator", () => {
  it("routes a fleet refresh request through the owner", () => {
    const requesterBus = new FakeIntercomExtensionBus("requester", "owner");
    const requester = new DeterministicCoordinator(requesterBus, () => {}, () => {});
    requester.start();
    requester.requestFleetRefresh();
    expect(requesterBus.publishedMessages).toContainEqual({
      message: { type: "refresh_fleet" },
      options: { audience: "owner" },
    });

    const ownerBus = new FakeIntercomExtensionBus("owner", "owner");
    const refreshLocalCard = jest.fn();
    const owner = new DeterministicCoordinator(ownerBus, () => {}, refreshLocalCard);
    owner.start();
    ownerBus.simulateMessage({ type: "refresh_fleet" }, "requester");
    expect(ownerBus.publishedMessages).toContainEqual({
      message: { type: "request_cards" },
      options: { audience: "capable", ownerOnly: true },
    });
    expect(refreshLocalCard).toHaveBeenCalledTimes(1);
  });

  it("groups matching tickets and broadcasts owner-only assignments", () => {
    const bus = new FakeIntercomExtensionBus("self", "self");
    const coordinator = new DeterministicCoordinator(bus, () => {}, () => {});
    coordinator.start();

    const first = generateContextCard({ sessionId: "a", ticketIds: ["ABC-123"] });
    const second = generateContextCard({ sessionId: "b", ticketIds: ["ABC-123"] });
    bus.simulateMessage({ type: "context_card", card: first }, "a");
    bus.simulateMessage({ type: "context_card", card: second }, "b");

    const results = assignments(bus);
    expect(results.find(({ assignment }) => assignment.sessionId === "a")?.assignment.groupId).toBe(generateGroupId("ABC-123"));
    expect(results.find(({ assignment }) => assignment.sessionId === "b")?.assignment.groupId).toBe(generateGroupId("ABC-123"));
    expect(bus.publishedMessages.filter(({ message }) => message.type === "assignment").every(({ options }) => options?.ownerOnly)).toBe(true);
  });

  it("resolves parent chains regardless of card sort order", () => {
    const bus = new FakeIntercomExtensionBus("self", "self");
    const coordinator = new DeterministicCoordinator(bus, () => {}, () => {});
    coordinator.start();
    bus.simulateMessage({ type: "context_card", card: generateContextCard({ sessionId: "a", parentSessionId: "b" }) }, "a");
    bus.simulateMessage({ type: "context_card", card: generateContextCard({ sessionId: "b", parentSessionId: "z" }) }, "b");
    bus.simulateMessage({
      type: "context_card",
      card: generateContextCard({ sessionId: "z" }, { groupId: "root", label: "Root", lockedAt: 1 }),
    }, "z");

    const latestFor = (sessionId: string) => [...assignments(bus)].reverse().find(({ assignment }) => assignment.sessionId === sessionId);
    expect(latestFor("z")?.assignment.groupId).toBe("root");
    expect(latestFor("b")?.assignment.groupId).toBe("root");
    expect(latestFor("a")?.assignment.groupId).toBe("root");
  });

  it("uses a manual lock before parent and ticket signals", () => {
    const bus = new FakeIntercomExtensionBus("self", "self");
    const coordinator = new DeterministicCoordinator(bus, () => {}, () => {});
    coordinator.start();
    const card = generateContextCard(
      { sessionId: "child", parentSessionId: "parent", ticketIds: ["ABC-123"] },
      { groupId: "manual-id", label: "Manual Area", lockedAt: 1 },
    );
    bus.simulateMessage({ type: "context_card", card }, "child");

    const result = assignments(bus).find(({ assignment }) => assignment.sessionId === "child");
    expect(result?.assignment).toMatchObject({ groupId: "manual-id", source: "manual" });
    expect(result?.group?.label).toBe("Manual Area");
  });

  it("preserves a semantic sticky origin across repeated refreshes", () => {
    const bus = new FakeIntercomExtensionBus("self", "self");
    const coordinator = new DeterministicCoordinator(bus, () => {}, () => {});
    coordinator.start();
    const semantic = {
      assignment: {
        sessionId: "self",
        groupId: "semantic-group",
        source: "semantic" as const,
        reasonCode: "semantic_new",
        confidenceBand: "high" as const,
        updatedAt: 1,
      },
      group: { id: "semantic-group", label: "Semantic", colour: "5B9BD5", createdAt: 1, updatedAt: 1 },
      appliedAt: 1,
    };
    bus.simulateMessage({ type: "context_card", card: generateContextCard({ sessionId: "self" }, undefined, 0, semantic) }, "self");
    const first = assignments(bus).at(-1)!;
    expect(first.assignment.reasonCode).toBe("sticky_semantic");
    bus.simulateMessage({
      type: "context_card",
      card: generateContextCard({ sessionId: "self" }, undefined, 1, { assignment: first.assignment, group: first.group, appliedAt: 2 }),
    }, "self");
    expect(assignments(bus).at(-1)!.assignment.reasonCode).toBe("sticky_semantic");
  });

  it("ignores context cards that spoof another session ID", () => {
    const bus = new FakeIntercomExtensionBus("self", "self");
    const coordinator = new DeterministicCoordinator(bus, () => {}, () => {});
    coordinator.start();
    bus.simulateMessage({ type: "context_card", card: generateContextCard({ sessionId: "victim" }, { groupId: "forged", lockedAt: 1 }) }, "attacker");
    expect(assignments(bus)).toHaveLength(0);
  });

  it("ignores assignments forged by a non-owner peer", () => {
    const bus = new FakeIntercomExtensionBus("self", "owner");
    const received: string[] = [];
    const coordinator = new DeterministicCoordinator(bus, (assignment) => received.push(assignment.sessionId), () => {});
    coordinator.start();
    bus.simulateMessage({
      type: "assignment",
      assignment: {
        sessionId: "self",
        groupId: "forged",
        source: "manual",
        reasonCode: "forged",
        confidenceBand: "high",
        updatedAt: 1,
      },
    }, "peer");
    expect(received).toEqual([]);
  });

  it("applies assignments on non-owner sessions", () => {
    const bus = new FakeIntercomExtensionBus("self", "owner");
    const received: string[] = [];
    const coordinator = new DeterministicCoordinator(bus, (assignment) => received.push(assignment.sessionId), () => {});
    coordinator.start();
    bus.simulateMessage({
      type: "assignment",
      assignment: {
        sessionId: "self",
        groupId: null,
        source: "unknown",
        reasonCode: "no_match",
        confidenceBand: "low",
        updatedAt: 1,
      },
    }, "owner");
    expect(received).toEqual(["self"]);
  });
});
