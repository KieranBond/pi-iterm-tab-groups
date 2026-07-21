import { NAMESPACE, type ExtensionMessage } from "./types";

export const INTERCOM_EXTENSION_REGISTER_EVENT = "intercom:extension-register";
export const INTERCOM_EXTENSION_REGISTRY_READY_EVENT = "intercom:extension-registry-ready";

interface IntercomExtensionOwner {
  sessionId: string;
  epoch: string;
}

export interface IntercomExtensionChannel {
  readonly namespace: string;
  snapshot(): {
    connected: boolean;
    supported: boolean;
    owner?: IntercomExtensionOwner;
    state?: ExtensionStateSnapshot;
  };
  publish(payload: unknown, options?: { audience?: "owner" | "capable"; ownerOnly?: boolean }): void;
  commitState(payload: unknown, expectedRevision?: number): void;
}

export type IntercomExtensionEvent =
  | { type: "connection"; connected: boolean; supported: boolean }
  | { type: "owner"; owner?: IntercomExtensionOwner }
  | { type: "message"; fromSessionId: string; payload: unknown }
  | { type: "state"; state: ExtensionStateSnapshot }
  | { type: "state_result"; committed: boolean; revision: number; reason?: string }
  | { type: "session_joined"; session: unknown }
  | { type: "session_left"; sessionId: string }
  | { type: "presence_update"; session: unknown };

export interface ExtensionStateSnapshot {
  revision: number;
  payload: unknown;
}

export interface IntercomExtensionBus {
  start(): void;
  stop(): void;
  publish(message: ExtensionMessage, options?: { audience?: "owner" | "capable"; ownerOnly?: boolean }): void;
  subscribe(handler: (message: ExtensionMessage, fromSessionId: string) => void): () => void;
  onOwnerChange(handler: (ownerId: string | null) => void): () => void;
  subscribeState(handler: (state: ExtensionStateSnapshot) => void): () => void;
  getState(): ExtensionStateSnapshot | undefined;
  commitState(payload: unknown, expectedRevision?: number): void;
  isOwner(): boolean;
  getOwnerId(): string | null;
  isSupported(): boolean;
}

interface PiEvents {
  emit(channel: string, payload: unknown): unknown;
  on(channel: string, handler: (payload: unknown) => void): () => void;
}

export class PiIntercomExtensionBus implements IntercomExtensionBus {
  private channel?: IntercomExtensionChannel;
  private connected = false;
  private supported = false;
  private ownerId: string | null = null;
  private readonly pending: Array<{ message: ExtensionMessage; options?: { audience?: "owner" | "capable"; ownerOnly?: boolean } }> = [];
  private readonly handlers = new Set<(message: ExtensionMessage, fromSessionId: string) => void>();
  private readonly ownerHandlers = new Set<(ownerId: string | null) => void>();
  private readonly stateHandlers = new Set<(state: ExtensionStateSnapshot) => void>();
  private state?: ExtensionStateSnapshot;
  private unsubscribeReady?: () => void;
  private registrationTimer?: ReturnType<typeof setInterval>;
  private registrationAttempts = 0;
  private started = false;

  constructor(
    private readonly events: PiEvents,
    private readonly currentSessionId: () => string,
  ) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    this.unsubscribeReady = this.events.on(INTERCOM_EXTENSION_REGISTRY_READY_EVENT, () => {
      if (!this.channel) this.registerWithIntercom();
    });
    this.registerWithIntercom();
    if (!this.channel) {
      this.registrationTimer = setInterval(() => {
        if (this.channel || this.registrationAttempts >= 20) {
          if (this.registrationTimer) clearInterval(this.registrationTimer);
          this.registrationTimer = undefined;
          return;
        }
        this.registerWithIntercom();
      }, 250);
    }
  }

  private registerWithIntercom(): void {
    this.registrationAttempts += 1;
    this.events.emit(INTERCOM_EXTENSION_REGISTER_EVENT, {
      namespace: NAMESPACE,
      ownerEligible: true,
      onReady: (channel: IntercomExtensionChannel) => {
        this.channel = channel;
        if (this.registrationTimer) clearInterval(this.registrationTimer);
        this.registrationTimer = undefined;
        const snapshot = channel.snapshot();
        this.connected = snapshot.connected;
        this.supported = snapshot.supported;
        this.setOwner(snapshot.owner?.sessionId ?? null);
        if (snapshot.state) this.setState(snapshot.state);
        this.flush();
      },
      onEvent: (event: IntercomExtensionEvent) => this.handleEvent(event),
    });
  }

  stop(): void {
    this.unsubscribeReady?.();
    this.unsubscribeReady = undefined;
    if (this.registrationTimer) clearInterval(this.registrationTimer);
    this.registrationTimer = undefined;
    this.started = false;
    this.connected = false;
    this.ownerId = null;
    this.pending.length = 0;
  }

  publish(message: ExtensionMessage, options?: { audience?: "owner" | "capable"; ownerOnly?: boolean }): void {
    if (!this.channel || !this.connected || !this.supported) {
      this.pending.push({ message, ...(options ? { options } : {}) });
      return;
    }
    this.channel.publish(message, options);
  }

  subscribe(handler: (message: ExtensionMessage, fromSessionId: string) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  onOwnerChange(handler: (ownerId: string | null) => void): () => void {
    this.ownerHandlers.add(handler);
    return () => this.ownerHandlers.delete(handler);
  }

  subscribeState(handler: (state: ExtensionStateSnapshot) => void): () => void {
    this.stateHandlers.add(handler);
    return () => this.stateHandlers.delete(handler);
  }

  getState(): ExtensionStateSnapshot | undefined {
    return this.state;
  }

  commitState(payload: unknown, expectedRevision?: number): void {
    if (!this.channel || !this.connected || !this.supported || !this.isOwner()) return;
    this.channel.commitState(payload, expectedRevision);
  }

  isOwner(): boolean {
    return this.ownerId === this.currentSessionId();
  }

  getOwnerId(): string | null {
    return this.ownerId;
  }

  isSupported(): boolean {
    return this.supported;
  }

  private handleEvent(event: IntercomExtensionEvent): void {
    switch (event.type) {
      case "connection":
        this.connected = event.connected;
        this.supported = event.supported;
        if (event.connected && event.supported) this.flush();
        break;
      case "owner":
        this.setOwner(event.owner?.sessionId ?? null);
        break;
      case "message":
        if (isExtensionMessage(event.payload)) {
          for (const handler of this.handlers) handler(event.payload, event.fromSessionId);
        }
        break;
      case "state":
        this.setState(event.state);
        break;
    }
  }

  private setState(state: ExtensionStateSnapshot): void {
    this.state = state;
    for (const handler of this.stateHandlers) handler(state);
  }

  private setOwner(ownerId: string | null): void {
    if (ownerId === this.ownerId) return;
    this.ownerId = ownerId;
    for (const handler of this.ownerHandlers) handler(ownerId);
  }

  private flush(): void {
    if (!this.channel || !this.connected || !this.supported) return;
    for (const queued of this.pending.splice(0)) {
      this.channel.publish(queued.message, queued.options);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isExtensionMessage(value: unknown): value is ExtensionMessage {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  if (value.type === "request_cards") return true;
  if (value.type === "context_card") {
    if (!isRecord(value.card)) return false;
    return typeof value.card.sessionId === "string"
      && Number.isSafeInteger(value.card.revision)
      && typeof value.card.cardHash === "string"
      && Array.isArray(value.card.ticketIds)
      && value.card.ticketIds.every((ticket) => typeof ticket === "string")
      && (value.card.synopsis === undefined || typeof value.card.synopsis === "string")
      && (value.card.domainNouns === undefined || (Array.isArray(value.card.domainNouns)
        && value.card.domainNouns.every((noun) => typeof noun === "string")))
      && typeof value.card.updatedAt === "number";
  }
  if (value.type === "assignment") {
    if (!isRecord(value.assignment)) return false;
    const assignmentValid = typeof value.assignment.sessionId === "string"
      && (typeof value.assignment.groupId === "string" || value.assignment.groupId === null)
      && typeof value.assignment.source === "string"
      && typeof value.assignment.reasonCode === "string"
      && typeof value.assignment.confidenceBand === "string"
      && typeof value.assignment.updatedAt === "number";
    if (!assignmentValid) return false;
    if (value.group === undefined) return true;
    return isRecord(value.group)
      && typeof value.group.id === "string"
      && typeof value.group.label === "string"
      && typeof value.group.colour === "string"
      && /^[0-9A-F]{6}$/.test(value.group.colour)
      && (value.group.description === undefined || typeof value.group.description === "string")
      && (value.group.status === undefined || ["provisional", "established", "archived"].includes(String(value.group.status)))
      && typeof value.group.createdAt === "number"
      && typeof value.group.updatedAt === "number";
  }
  return false;
}

export class FakeIntercomExtensionBus implements IntercomExtensionBus {
  private handlers = new Set<(message: ExtensionMessage, fromSessionId: string) => void>();
  private ownerHandlers = new Set<(ownerId: string | null) => void>();
  private stateHandlers = new Set<(state: ExtensionStateSnapshot) => void>();
  private ownerId: string | null;
  private state?: ExtensionStateSnapshot;
  readonly publishedMessages: Array<{
    message: ExtensionMessage;
    options?: { audience?: "owner" | "capable"; ownerOnly?: boolean };
  }> = [];

  constructor(private readonly sessionId = "self", ownerId: string | null = null) {
    this.ownerId = ownerId;
  }

  start(): void {}
  stop(): void {}
  publish(message: ExtensionMessage, options?: { audience?: "owner" | "capable"; ownerOnly?: boolean }): void {
    this.publishedMessages.push({ message, ...(options ? { options } : {}) });
  }
  subscribe(handler: (message: ExtensionMessage, fromSessionId: string) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }
  onOwnerChange(handler: (ownerId: string | null) => void): () => void {
    this.ownerHandlers.add(handler);
    return () => this.ownerHandlers.delete(handler);
  }
  subscribeState(handler: (state: ExtensionStateSnapshot) => void): () => void {
    this.stateHandlers.add(handler);
    return () => this.stateHandlers.delete(handler);
  }
  getState(): ExtensionStateSnapshot | undefined { return this.state; }
  commitState(payload: unknown, expectedRevision?: number): void {
    if (!this.isOwner()) return;
    const currentRevision = this.state?.revision ?? 0;
    if (expectedRevision !== undefined && expectedRevision !== currentRevision) return;
    this.state = { revision: currentRevision + 1, payload };
    for (const handler of this.stateHandlers) handler(this.state);
  }
  isOwner(): boolean { return this.ownerId === this.sessionId; }
  getOwnerId(): string | null { return this.ownerId; }
  isSupported(): boolean { return true; }

  setOwner(ownerId: string | null): void {
    this.ownerId = ownerId;
    for (const handler of this.ownerHandlers) handler(ownerId);
  }

  simulateMessage(message: ExtensionMessage, fromSessionId: string): void {
    for (const handler of this.handlers) handler(message, fromSessionId);
  }
}
