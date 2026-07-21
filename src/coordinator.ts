import type { IntercomExtensionBus } from "./intercom-bus";
import { generateGroupId, getGroupColor, normalizeGroupLabel } from "./palette";
import type { ContextCard, ExtensionMessage, GroupAssignment, TabGroup } from "./types";

export class DeterministicCoordinator {
  private readonly cards = new Map<string, ContextCard>();
  private readonly assignments = new Map<string, GroupAssignment>();
  private readonly groups = new Map<string, TabGroup>();
  private unsubscribeMessage?: () => void;
  private unsubscribeOwner?: () => void;

  constructor(
    private readonly bus: IntercomExtensionBus,
    private readonly onAssignment: (assignment: GroupAssignment, group?: TabGroup) => void,
    private readonly onRequestCard: () => void,
  ) {}

  start(): void {
    this.unsubscribeMessage = this.bus.subscribe((message, fromSessionId) => this.handle(message, fromSessionId));
    this.unsubscribeOwner = this.bus.onOwnerChange(() => {
      if (!this.bus.isOwner()) return;
      this.cards.clear();
      this.bus.publish({ type: "request_cards" }, { audience: "capable", ownerOnly: true });
      this.onRequestCard();
    });
  }

  stop(): void {
    this.unsubscribeMessage?.();
    this.unsubscribeOwner?.();
  }

  publishCard(card: ContextCard): void {
    this.bus.publish({ type: "context_card", card }, { audience: "owner" });
  }

  private handle(message: ExtensionMessage, fromSessionId: string): void {
    if (message.type === "request_cards") {
      if (fromSessionId === this.bus.getOwnerId()) this.onRequestCard();
      return;
    }
    if (message.type === "assignment") {
      if (fromSessionId !== this.bus.getOwnerId()) return;
      this.assignments.set(message.assignment.sessionId, message.assignment);
      if (message.group) this.groups.set(message.group.id, message.group);
      this.onAssignment(message.assignment, message.group);
      return;
    }
    if (!this.bus.isOwner()) return;

    this.cards.set(message.card.sessionId, message.card);
    if (message.card.sticky) {
      this.assignments.set(message.card.sessionId, message.card.sticky.assignment);
      if (message.card.sticky.group) this.groups.set(message.card.sticky.group.id, message.card.sticky.group);
    }
    this.evaluateFleet();
  }

  private evaluateFleet(): void {
    const cards = [...this.cards.values()].sort((a, b) => a.sessionId.localeCompare(b.sessionId));
    // A bounded fixed point resolves parent chains regardless of sort order.
    // Intercom caps the fleet, so O(n²) remains small and predictable.
    for (let pass = 0; pass < cards.length; pass += 1) {
      for (const card of cards) this.evaluate(card);
    }
  }

  private evaluate(card: ContextCard): void {
    const result = this.resolve(card);
    const previous = this.assignments.get(card.sessionId);
    if (
      previous
      && previous.groupId === result.assignment.groupId
      && previous.source === result.assignment.source
      && previous.cardHash === result.assignment.cardHash
    ) {
      return;
    }

    this.assignments.set(card.sessionId, result.assignment);
    if (result.group) this.groups.set(result.group.id, result.group);
    this.bus.publish(
      { type: "assignment", assignment: result.assignment, ...(result.group ? { group: result.group } : {}) },
      { audience: "capable", ownerOnly: true },
    );
  }

  private resolve(card: ContextCard): { assignment: GroupAssignment; group?: TabGroup } {
    if (card.manualLock) {
      const group = card.manualLock.groupId
        ? this.group(card.manualLock.groupId, card.manualLock.label ?? card.manualLock.groupId)
        : undefined;
      return this.result(card, card.manualLock.groupId, "manual", "manual_lock", group);
    }

    if (card.parentSessionId) {
      const parent = this.assignments.get(card.parentSessionId);
      if (parent) {
        return this.result(
          card,
          parent.groupId,
          "parent",
          "inherited_from_parent",
          parent.groupId ? this.groups.get(parent.groupId) : undefined,
        );
      }
    }

    if (card.parentRunId) {
      const label = `run ${card.parentRunId.slice(0, 12)}`;
      const groupId = generateGroupId(label);
      return this.result(card, groupId, "parent", "shared_parent_run", this.group(groupId, label));
    }

    if (card.ticketIds.length > 0) {
      const ticket = card.ticketIds[0]!;
      const groupId = generateGroupId(ticket);
      return this.result(card, groupId, "ticket", `ticket_match_${ticket}`, this.group(groupId, ticket));
    }

    if (card.sticky) {
      return this.result(
        card,
        card.sticky.assignment.groupId,
        "sticky",
        `sticky_${card.sticky.assignment.source}`,
        card.sticky.group,
      );
    }

    return this.result(card, null, "unknown", "no_match");
  }

  private result(
    card: ContextCard,
    groupId: string | null,
    source: GroupAssignment["source"],
    reasonCode: string,
    group?: TabGroup,
  ): { assignment: GroupAssignment; group?: TabGroup } {
    return {
      assignment: {
        sessionId: card.sessionId,
        groupId,
        source,
        reasonCode,
        confidenceBand: source === "unknown" ? "low" : "high",
        cardHash: card.cardHash,
        updatedAt: Date.now(),
      },
      ...(group ? { group } : {}),
    };
  }

  private group(id: string, rawLabel: string): TabGroup {
    const existing = this.groups.get(id);
    if (existing) return existing;
    const now = Date.now();
    return {
      id,
      label: normalizeGroupLabel(rawLabel) || id,
      colour: getGroupColor(id),
      createdAt: now,
      updatedAt: now,
    };
  }
}
