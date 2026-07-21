import {
  INTERCOM_EXTENSION_REGISTER_EVENT,
  PiIntercomExtensionBus,
  type IntercomExtensionChannel,
  type IntercomExtensionEvent,
} from "./intercom-bus";

class Events {
  channel?: string;
  private readonly handlers = new Map<string, Set<(payload: unknown) => void>>();
  registration?: {
    onReady(channel: IntercomExtensionChannel): void;
    onEvent(event: IntercomExtensionEvent): void;
  };
  emit(channel: string, payload: unknown): void {
    this.channel = channel;
    for (const handler of this.handlers.get(channel) ?? []) handler(payload);
    if (channel === INTERCOM_EXTENSION_REGISTER_EVENT) this.registration = payload as typeof this.registration;
  }
  on(channel: string, handler: (payload: unknown) => void): () => void {
    const handlers = this.handlers.get(channel) ?? new Set<(payload: unknown) => void>();
    handlers.add(handler);
    this.handlers.set(channel, handlers);
    return () => handlers.delete(handler);
  }
}

describe("Pi intercom adapter", () => {
  it("re-registers when pi-intercom announces readiness after load-order loss", () => {
    const events = new Events();
    const bus = new PiIntercomExtensionBus(events, () => "self");
    bus.start();
    events.registration = undefined;
    events.emit("intercom:extension-registry-ready", { version: 1 });
    expect(events.registration).toBeDefined();
    bus.stop();
  });

  it("retries a registration that was emitted before pi-intercom listened", () => {
    jest.useFakeTimers();
    const events = new Events();
    const bus = new PiIntercomExtensionBus(events, () => "self");
    bus.start();
    const first = events.registration;
    jest.advanceTimersByTime(250);
    expect(events.registration).toBeDefined();
    expect(events.registration).not.toBe(first);
    bus.stop();
    jest.useRealTimers();
  });

  it("registers the namespace, queues until connected, and tracks ownership", () => {
    const events = new Events();
    const published: unknown[] = [];
    const channel: IntercomExtensionChannel = {
      namespace: "iterm-tab-groups/v1",
      snapshot: () => ({ connected: false, supported: false }),
      publish: (payload) => published.push(payload),
      commitState: () => {},
    };
    const bus = new PiIntercomExtensionBus(events, () => "self");
    bus.start();
    expect(events.channel).toBe(INTERCOM_EXTENSION_REGISTER_EVENT);

    events.registration!.onReady(channel);
    bus.publish({ type: "request_cards" });
    expect(published).toEqual([]);

    events.registration!.onEvent({ type: "connection", connected: true, supported: true });
    expect(published).toEqual([{ type: "request_cards" }]);

    events.registration!.onEvent({ type: "owner", owner: { sessionId: "self", epoch: "one" } });
    expect(bus.isOwner()).toBe(true);
  });

  it("exposes broker state and only commits while owner", () => {
    const events = new Events();
    const commits: unknown[] = [];
    const bus = new PiIntercomExtensionBus(events, () => "self");
    const states: number[] = [];
    bus.subscribeState((state) => states.push(state.revision));
    bus.start();
    events.registration!.onReady({
      namespace: "iterm-tab-groups/v1",
      snapshot: () => ({ connected: true, supported: true, owner: { sessionId: "self", epoch: "one" }, state: { revision: 2, payload: { ok: true } } }),
      publish: () => {},
      commitState: (payload, revision) => commits.push({ payload, revision }),
    });
    expect(bus.getState()).toEqual({ revision: 2, payload: { ok: true } });
    expect(states).toEqual([2]);
    bus.commitState({ next: true }, 2);
    expect(commits).toEqual([{ payload: { next: true }, revision: 2 }]);
    events.registration!.onEvent({ type: "owner", owner: { sessionId: "peer", epoch: "two" } });
    bus.commitState({ ignored: true }, 2);
    expect(commits).toHaveLength(1);
  });

  it("delivers only valid tab-group payloads", () => {
    const events = new Events();
    const bus = new PiIntercomExtensionBus(events, () => "self");
    const received: string[] = [];
    bus.subscribe((message) => received.push(message.type));
    bus.start();
    events.registration!.onReady({
      namespace: "iterm-tab-groups/v1",
      snapshot: () => ({ connected: true, supported: true }),
      publish: () => {},
      commitState: () => {},
    });
    events.registration!.onEvent({
      type: "message",
      fromSessionId: "peer",
      payload: { type: "request_cards" },
    });
    events.registration!.onEvent({
      type: "message",
      fromSessionId: "peer",
      payload: { type: "refresh_fleet" },
    });
    events.registration!.onEvent({
      type: "message",
      fromSessionId: "peer",
      payload: { type: "not-ours" },
    });
    events.registration!.onEvent({
      type: "message",
      fromSessionId: "peer",
      payload: {
        type: "assignment",
        assignment: {
          sessionId: "self",
          groupId: "bad",
          source: "manual",
          reasonCode: "bad",
          confidenceBand: "high",
          updatedAt: 1,
        },
        group: { id: "bad", label: "Bad", colour: "not-hex", createdAt: 1, updatedAt: 1 },
      },
    });
    expect(received).toEqual(["request_cards", "refresh_fleet"]);
  });
});
