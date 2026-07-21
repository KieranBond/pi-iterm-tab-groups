import type { IntercomExtensionChannel, IntercomExtensionEvent } from "pi-intercom/extension-api";
import { INTERCOM_EXTENSION_REGISTER_EVENT } from "pi-intercom/extension-api";
import { PiIntercomExtensionBus } from "./intercom-bus";

class Events {
  channel?: string;
  registration?: {
    onReady(channel: IntercomExtensionChannel): void;
    onEvent(event: IntercomExtensionEvent): void;
  };
  emit(channel: string, payload: unknown): void {
    this.channel = channel;
    this.registration = payload as typeof this.registration;
  }
}

describe("Pi intercom adapter", () => {
  it("registers the namespace, queues until connected, and tracks ownership", () => {
    const events = new Events();
    const published: unknown[] = [];
    const channel: IntercomExtensionChannel = {
      namespace: "iterm-tab-groups/v1",
      snapshot: () => ({ connected: false, supported: false }),
      publish: (payload) => published.push(payload),
      commitState: () => {},
      listSessions: async () => [],
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
      listSessions: async () => [],
    });
    events.registration!.onEvent({
      type: "message",
      fromSessionId: "peer",
      payload: { type: "request_cards" },
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
    expect(received).toEqual(["request_cards"]);
  });
});
