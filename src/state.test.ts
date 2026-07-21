import {
  clearManualLock,
  FakeStateStore,
  loadState,
  setEnabled,
  updateLastAssignment,
  updateManualLock,
} from "./state";
import type { GroupAssignment, TabGroup } from "./types";

function assignment(groupId: string | null, source: GroupAssignment["source"] = "ticket"): GroupAssignment {
  return {
    sessionId: "session-1",
    groupId,
    source,
    reasonCode: `${source}_test`,
    confidenceBand: source === "unknown" ? "low" : "high",
    cardHash: "hash",
    updatedAt: Date.now(),
  };
}

const group: TabGroup = {
  id: "group-1",
  label: "Group 1",
  colour: "5B9BD5",
  createdAt: 1,
  updatedAt: 1,
};

describe("session state", () => {
  let store: FakeStateStore;

  beforeEach(() => { store = new FakeStateStore(); });

  it("defaults to enabled", async () => {
    await expect(loadState(store)).resolves.toEqual({ enabled: true });
  });

  it("persists a labelled manual lock and explicit ungrouping", async () => {
    let state = await updateManualLock(store, "group-1", "Group 1");
    expect(state.manualLock).toMatchObject({ groupId: "group-1", label: "Group 1" });

    state = await updateManualLock(store, null);
    expect(state.manualLock?.groupId).toBeNull();
  });

  it("clears only the manual lock", async () => {
    await updateManualLock(store, "group-1", "Group 1");
    await updateLastAssignment(store, assignment("group-1"), group);
    const state = await clearManualLock(store);
    expect(state.manualLock).toBeUndefined();
    expect(state.lastAssignment?.assignment.groupId).toBe("group-1");
  });

  it("persists the assignment and group needed to restore terminal style", async () => {
    const state = await updateLastAssignment(store, assignment("group-1"), group);
    expect(state.lastAssignment?.assignment.source).toBe("ticket");
    expect(state.lastAssignment?.group).toEqual(group);
    expect(state.lastAssignment?.appliedAt).toBeGreaterThan(0);
  });

  it("preserves state while disabling and enabling", async () => {
    await updateManualLock(store, "group-1", "Group 1");
    let state = await setEnabled(store, false);
    expect(state.enabled).toBe(false);
    expect(state.manualLock?.groupId).toBe("group-1");

    state = await setEnabled(store, true);
    expect(state.enabled).toBe(true);
  });
});
