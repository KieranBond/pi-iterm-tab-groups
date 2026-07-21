import { createHash } from "node:crypto";
import type { SemanticConfig } from "./config";
import type { IntercomExtensionBus, ExtensionStateSnapshot } from "./intercom-bus";
import { generateGroupId, getGroupColor, normalizeGroupLabel } from "./palette";
import type { ClassificationDecision, SemanticModel, SemanticSummary } from "./semantic-model";
import type { ContextCard, GroupAssignment, TabGroup } from "./types";

interface RegistryStateV1 {
  version: 1;
  groups: Record<string, TabGroup>;
  classifiedCardHashes: Record<string, string>;
  proposals: Record<string, { groupId: string; count: number }>;
  observations: Record<string, string[]>;
  callTimestamps: number[];
}

const EMPTY_STATE: RegistryStateV1 = {
  version: 1,
  groups: {},
  classifiedCardHashes: {},
  proposals: {},
  observations: {},
  callTimestamps: [],
};

export type SynopsisGenerationResult =
  | { status: "generated"; summary: SemanticSummary }
  | { status: "unchanged" }
  | { status: "deferred"; inputChanged: true; retryAfterMs: number }
  | { status: "empty"; inputChanged: true };

export class SemanticSynopsisGenerator {
  private callTimestamps: number[] = [];
  private lastCallAt = 0;
  private lastInputHash = "";
  private inFlight = false;

  constructor(
    private readonly model: SemanticModel,
    private readonly config: SemanticConfig,
    private readonly now: () => number = Date.now,
  ) {}

  async generate(userPrompts: string[], signal?: AbortSignal): Promise<SynopsisGenerationResult> {
    if (!this.config.enabled) return { status: "unchanged" };
    if (userPrompts.length === 0) return { status: "empty", inputChanged: true };
    const inputHash = createHash("sha256").update(JSON.stringify(userPrompts.slice(-3))).digest("hex");
    if (inputHash === this.lastInputHash) return { status: "unchanged" };
    const now = this.now();
    this.callTimestamps = this.callTimestamps.filter((timestamp) => now - timestamp < 60 * 60_000);
    if (this.inFlight || this.callTimestamps.length >= this.config.maxCallsPerHour || now - this.lastCallAt < this.config.cooldownMs) {
      const cooldownRemaining = Math.max(0, this.lastCallAt + this.config.cooldownMs - now);
      const budgetRemaining = this.callTimestamps.length >= this.config.maxCallsPerHour
        ? Math.max(0, this.callTimestamps[0]! + 60 * 60_000 - now)
        : 0;
      return { status: "deferred", inputChanged: true, retryAfterMs: Math.max(1_000, cooldownRemaining, budgetRemaining) };
    }

    this.lastCallAt = now;
    this.callTimestamps.push(now);
    this.inFlight = true;
    try {
      const summary = await this.model.summarize(userPrompts.slice(-3), signal);
      this.lastInputHash = inputHash;
      return { status: "generated", summary };
    } finally {
      this.inFlight = false;
    }
  }
}

export class SemanticCoordinator {
  private readonly cards = new Map<string, ContextCard>();
  private state: RegistryStateV1 = structuredClone(EMPTY_STATE);
  private stateRevision = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private abortController?: AbortController;
  private running = false;
  private dirty = false;
  private expectedCommitRevision?: number;
  private active = false;
  private unsubscribers: Array<() => void> = [];

  constructor(
    private readonly bus: IntercomExtensionBus,
    private readonly model: SemanticModel,
    private readonly config: SemanticConfig,
    private readonly onAssignment: (assignment: GroupAssignment, group?: TabGroup) => void,
    private readonly now: () => number = Date.now,
    private readonly onError?: (error: unknown) => void,
  ) {}

  start(): void {
    if (!this.config.enabled || this.active) return;
    this.active = true;
    const snapshot = this.bus.getState();
    if (snapshot) this.applyState(snapshot);
    this.unsubscribers.push(
      this.bus.subscribe((message, fromSessionId) => {
        if (message.type !== "context_card" || fromSessionId !== message.card.sessionId) return;
        this.cards.delete(message.card.sessionId);
        this.cards.set(message.card.sessionId, message.card);
        while (this.cards.size > 32) this.cards.delete(this.cards.keys().next().value!);
        this.schedule();
      }),
      this.bus.onOwnerChange(() => this.schedule()),
      this.bus.subscribeState((state) => this.applyState(state)),
    );
  }

  stop(): void {
    this.active = false;
    this.abortController?.abort();
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  async evaluateNow(): Promise<void> {
    if (!this.config.enabled || !this.active || !this.bus.isOwner() || this.running) return;
    const now = this.now();
    this.state.callTimestamps = this.state.callTimestamps.filter((timestamp) => now - timestamp < 60 * 60_000);
    if (this.state.callTimestamps.length >= this.config.maxCallsPerHour) return;
    const lastCallAt = this.state.callTimestamps.at(-1) ?? 0;
    if (now - lastCallAt < this.config.cooldownMs) return;

    const cards = [...this.cards.values()].filter((card) => this.shouldClassify(card));
    if (!cards.length) return;
    const ownerId = this.bus.getOwnerId();
    const revision = this.stateRevision;
    const fleetHash = hashFleet(cards);
    this.running = true;
    this.state.callTimestamps.push(now);
    this.abortController = new AbortController();
    try {
      const groups = Object.values(this.state.groups).filter((group) => group.status !== "archived");
      const decisions = await this.model.classify({ cards, groups }, this.abortController.signal);
      if (!this.bus.isOwner() || this.bus.getOwnerId() !== ownerId || this.stateRevision !== revision) return;
      const currentCards = cards.filter((card) => this.cards.get(card.sessionId)?.cardHash === card.cardHash);
      if (hashFleet(currentCards) !== fleetHash) return;

      const cardsById = new Map(currentCards.map((card) => [card.sessionId, card]));
      const terminalSessionIds = new Set<string>();
      for (const decision of decisions) {
        const card = cardsById.get(decision.sessionId);
        if (!card || card.manualLock || card.parentSessionId || card.parentRunId || card.ticketIds.length) continue;
        if (this.applyDecision(card, decision, now) === "terminal") terminalSessionIds.add(card.sessionId);
      }
      for (const card of currentCards) {
        if (terminalSessionIds.has(card.sessionId)) {
          this.state.classifiedCardHashes[card.sessionId] = semanticCardHash(card);
        } else {
          this.dirty = true;
        }
      }
      this.compactState();
      this.expectedCommitRevision = revision + 1;
      this.bus.commitState(this.state, revision);
    } finally {
      this.abortController = undefined;
      this.running = false;
      if (this.dirty) {
        this.dirty = false;
        this.schedule();
      }
    }
  }

  private shouldClassify(card: ContextCard): boolean {
    if (!card.synopsis || card.manualLock || card.parentSessionId || card.parentRunId || card.ticketIds.length) return false;
    return this.state.classifiedCardHashes[card.sessionId] !== semanticCardHash(card);
  }

  private applyDecision(card: ContextCard, decision: ClassificationDecision, now: number): "terminal" | "retry" {
    if (decision.confidence < 0.75 || decision.action === "unknown") return "terminal";
    let group: TabGroup | undefined;
    if (decision.action === "existing" && decision.groupId) {
      group = Object.prototype.hasOwnProperty.call(this.state.groups, decision.groupId)
        ? this.state.groups[decision.groupId]
        : undefined;
    } else if (decision.action === "new" && decision.confidence >= 0.8 && decision.label) {
      const label = normalizeGroupLabel(decision.label);
      if (!label) return "retry";
      const id = generateGroupId(label);
      group = this.state.groups[id] ?? {
        id,
        label,
        colour: getGroupColor(id),
        description: decision.description,
        status: "provisional",
        createdAt: now,
        updatedAt: now,
      };
      this.state.groups[id] = group;
    }
    if (!group) return "retry";

    const semanticSticky = card.sticky?.assignment.source === "semantic"
      || card.sticky?.assignment.reasonCode === "sticky_semantic";
    const currentGroupId = semanticSticky ? card.sticky?.assignment.groupId ?? null : null;
    if (currentGroupId && currentGroupId !== group.id) {
      const previous = this.state.proposals[card.sessionId];
      const proposal = previous?.groupId === group.id
        ? { groupId: group.id, count: previous.count + 1 }
        : { groupId: group.id, count: 1 };
      this.state.proposals[card.sessionId] = proposal;
      if (proposal.count < 2) return "retry";
    }
    delete this.state.proposals[card.sessionId];

    const observations = this.state.observations[group.id] ?? [];
    if (!observations.includes(card.sessionId)) observations.push(card.sessionId);
    this.state.observations[group.id] = observations.slice(-8);
    if (group.status === "provisional" && observations.length >= 2) group.status = "established";
    group.updatedAt = now;

    const assignment: GroupAssignment = {
      sessionId: card.sessionId,
      groupId: group.id,
      source: "semantic",
      reasonCode: `semantic_${decision.action}`,
      confidenceBand: decision.confidence >= 0.9 ? "high" : "medium",
      cardHash: card.cardHash,
      updatedAt: now,
    };
    this.bus.publish({ type: "assignment", assignment, group }, { audience: "capable", ownerOnly: true });
    this.onAssignment(assignment, group);
    return "terminal";
  }

  private schedule(): void {
    if (!this.active || !this.bus.isOwner()) return;
    if (this.running) {
      this.dirty = true;
      return;
    }
    if (this.timer) return;
    const now = this.now();
    const lastCallAt = this.state.callTimestamps.at(-1) ?? 0;
    const delay = Math.max(this.config.debounceMs, lastCallAt + this.config.cooldownMs - now, 0);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.evaluateNow().catch((error) => this.onError?.(error));
    }, delay);
  }

  private applyState(snapshot: ExtensionStateSnapshot): void {
    const parsed = parseRegistryState(snapshot.payload);
    if (!parsed) return;
    this.state = parsed;
    this.stateRevision = snapshot.revision;
    if (snapshot.revision === this.expectedCommitRevision) {
      this.expectedCommitRevision = undefined;
    } else if (this.running) {
      this.dirty = true;
    }
  }

  private compactState(): void {
    this.state.callTimestamps = this.state.callTimestamps.slice(-this.config.maxCallsPerHour);
    for (const collection of [this.state.classifiedCardHashes, this.state.proposals]) {
      for (const key of Object.keys(collection).slice(0, Math.max(0, Object.keys(collection).length - 128))) delete collection[key];
    }
    const referencedGroups = new Set(
      [...this.cards.values()].map((card) => card.sticky?.assignment.groupId).filter((id): id is string => !!id),
    );
    const evictableGroups = Object.values(this.state.groups)
      .filter((group) => !referencedGroups.has(group.id))
      .sort((left, right) => left.updatedAt - right.updatedAt);
    while (Object.keys(this.state.groups).length > 128 && evictableGroups.length) {
      const group = evictableGroups.shift()!;
      delete this.state.groups[group.id];
      delete this.state.observations[group.id];
    }
  }
}

function parseRegistryState(payload: unknown): RegistryStateV1 | undefined {
  if (!isRecord(payload) || payload.version !== 1) return undefined;
  if (!isRecord(payload.groups) || !isRecord(payload.classifiedCardHashes)
    || !isRecord(payload.proposals) || !isRecord(payload.observations)
    || !Array.isArray(payload.callTimestamps)) return undefined;
  if (Object.keys(payload.groups).length > 128
    || Object.keys(payload.classifiedCardHashes).length > 128
    || Object.keys(payload.proposals).length > 128
    || Object.keys(payload.observations).length > 128
    || payload.callTimestamps.length > 60) return undefined;

  const groups: Record<string, TabGroup> = Object.create(null) as Record<string, TabGroup>;
  for (const [id, raw] of Object.entries(payload.groups)) {
    if (!isRecord(raw) || id !== raw.id || typeof raw.label !== "string" || typeof raw.colour !== "string"
      || !/^[0-9A-F]{6}$/.test(raw.colour) || typeof raw.createdAt !== "number" || typeof raw.updatedAt !== "number"
      || (raw.description !== undefined && typeof raw.description !== "string")
      || (raw.status !== undefined && !["provisional", "established", "archived"].includes(String(raw.status)))) return undefined;
    groups[id] = raw as unknown as TabGroup;
  }

  const classifiedCardHashes: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [sessionId, hash] of Object.entries(payload.classifiedCardHashes)) {
    if (typeof hash !== "string") return undefined;
    classifiedCardHashes[sessionId] = hash;
  }
  const proposals: RegistryStateV1["proposals"] = Object.create(null) as RegistryStateV1["proposals"];
  for (const [sessionId, raw] of Object.entries(payload.proposals)) {
    if (!isRecord(raw) || typeof raw.groupId !== "string" || !Number.isSafeInteger(raw.count) || Number(raw.count) < 1) return undefined;
    proposals[sessionId] = { groupId: raw.groupId, count: Number(raw.count) };
  }
  const observations: Record<string, string[]> = Object.create(null) as Record<string, string[]>;
  for (const [groupId, raw] of Object.entries(payload.observations)) {
    if (!Array.isArray(raw) || raw.length > 8 || !raw.every((entry) => typeof entry === "string")) return undefined;
    observations[groupId] = [...raw];
  }
  if (!payload.callTimestamps.every((timestamp) => typeof timestamp === "number" && Number.isFinite(timestamp))) return undefined;
  return {
    version: 1,
    groups,
    classifiedCardHashes,
    proposals,
    observations,
    callTimestamps: [...payload.callTimestamps],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function semanticCardHash(card: ContextCard): string {
  return createHash("sha256")
    .update(JSON.stringify({
      sessionId: card.sessionId,
      synopsis: card.synopsis,
      domainNouns: card.domainNouns,
      repoBasename: card.repoBasename,
      repoIdentityHash: card.repoIdentityHash,
      branch: card.branch,
    }))
    .digest("hex");
}

function hashFleet(cards: ContextCard[]): string {
  return createHash("sha256")
    .update(cards.map((card) => `${card.sessionId}:${card.cardHash}`).sort().join("|"))
    .digest("hex");
}
