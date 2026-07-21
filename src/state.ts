import type { GroupAssignment, LocalSessionState, TabGroup } from "./types";

export const STATE_ENTRY_TYPE = "iterm-tab-groups:state:v1";

export interface StateStore {
  get(): Promise<LocalSessionState | null>;
  set(state: LocalSessionState): Promise<void>;
}

export class FakeStateStore implements StateStore {
  private state: LocalSessionState | null = null;

  async get(): Promise<LocalSessionState | null> {
    return this.state ? structuredClone(this.state) : null;
  }

  async set(state: LocalSessionState): Promise<void> {
    this.state = structuredClone(state);
  }
}

export async function loadState(store: StateStore): Promise<LocalSessionState> {
  return (await store.get()) ?? { enabled: true };
}

export async function saveState(store: StateStore, state: LocalSessionState): Promise<void> {
  await store.set(state);
}

export async function updateManualLock(
  store: StateStore,
  groupId: string | null,
  label?: string,
): Promise<LocalSessionState> {
  const state = await loadState(store);
  state.manualLock = { groupId, lockedAt: Date.now(), ...(label ? { label } : {}) };
  await saveState(store, state);
  return state;
}

export async function clearManualLock(store: StateStore): Promise<LocalSessionState> {
  const state = await loadState(store);
  delete state.manualLock;
  await saveState(store, state);
  return state;
}

export async function updateLastAssignment(
  store: StateStore,
  assignment: GroupAssignment,
  group?: TabGroup,
): Promise<LocalSessionState> {
  const state = await loadState(store);
  state.lastAssignment = {
    assignment,
    ...(group ? { group } : {}),
    appliedAt: Date.now(),
  };
  await saveState(store, state);
  return state;
}

export async function setEnabled(store: StateStore, enabled: boolean): Promise<LocalSessionState> {
  const state = await loadState(store);
  state.enabled = enabled;
  await saveState(store, state);
  return state;
}
