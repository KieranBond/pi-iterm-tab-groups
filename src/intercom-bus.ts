import {
  INTERCOM_EXTENSION_REGISTER_EVENT,
  type IntercomExtensionChannel,
  type IntercomExtensionEvent,
} from "pi-intercom/extension-api";
import { NAMESPACE, type ExtensionMessage } from "./types";

export interface IntercomExtensionBus {
  start(): void;
  stop(): void;
  publish(message: ExtensionMessage, options?: { audience?: "owner" | "capable"; ownerOnly?: boolean }): void;
  subscribe(handler: (message: ExtensionMessage, fromSessionId: string) => void): () => void;
  onOwnerChange(handler: (ownerId: string | null) => void): () => void;
  isOwner(): boolean;
  getOwnerId(): string | null;
  isSupported(): boolean;
}

interface PiEvents {
  emit(channel: string, payload: unknown): unknown;
}

export class PiIntercomExtensionBus implements IntercomExtensionBus {
  private channel?: IntercomExtensionChannel;
  private connected = false;
  private supported = false;
  private ownerId: string | null = null;
  private readonly pending: Array<{ message: ExtensionMessage; options?: { audience?: "owner" | "capable"; ownerOnly?: boolean } }> = [];
  private readonly handlers = new Set<(message: ExtensionMessage, fromSessionId: string) => void>();
  private readonly ownerHandlers = new Set<(ownerId: string | null) => void>();
  private started = false;

  constructor(
    private readonly events: PiEvents,
    private readonly currentSessionId: () => string,
  ) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    this.events.emit(INTERCOM_EXTENSION_REGISTER_EVENT, {
      namespace: NAMESPACE,
      ownerEligible: true,
      onReady: (channel: IntercomExtensionChannel) => {
        this.channel = channel;
        const snapshot = channel.snapshot();
        this.connected = snapshot.connected;
        this.supported = snapshot.supported;
        this.setOwner(snapshot.owner?.sessionId ?? null);
        this.flush();
      },
      onEvent: (event: IntercomExtensionEvent) => this.handleEvent(event),
    });
  }

  stop(): void {
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
    }
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
      && typeof value.group.createdAt === "number"
      && typeof value.group.updatedAt === "number";
  }
  return false;
}

export class FakeIntercomExtensionBus implements IntercomExtensionBus {
  private handlers = new Set<(message: ExtensionMessage, fromSessionId: string) => void>();
  private ownerHandlers = new Set<(ownerId: string | null) => void>();
  private ownerId: string | null;
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
