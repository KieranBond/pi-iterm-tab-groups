export const NAMESPACE = "iterm-tab-groups/v1";

export type GroupSource = "manual" | "parent" | "ticket" | "sticky" | "semantic" | "unknown";
export type ConfidenceBand = "high" | "medium" | "low";

export interface ManualLock {
  groupId: string | null;
  label?: string;
  lockedAt: number;
}

export interface TabGroup {
  id: string;
  label: string;
  colour: string;
  description?: string;
  status?: "provisional" | "established" | "archived";
  createdAt: number;
  updatedAt: number;
}

export interface GroupAssignment {
  sessionId: string;
  groupId: string | null;
  source: GroupSource;
  reasonCode: string;
  confidenceBand: ConfidenceBand;
  cardHash?: string;
  updatedAt: number;
}

export interface StoredAssignment {
  assignment: GroupAssignment;
  group?: TabGroup;
  appliedAt: number;
}

/** Bounded metadata only. It never contains prompts, files, or tool output. */
export interface ContextCard {
  sessionId: string;
  sessionName?: string;
  revision: number;
  cardHash: string;
  repoBasename?: string;
  repoIdentityHash?: string;
  branch?: string;
  ticketIds: string[];
  parentSessionId?: string;
  parentRunId?: string;
  manualLock?: ManualLock;
  sticky?: StoredAssignment;
  synopsis?: string;
  domainNouns?: string[];
  updatedAt: number;
}

export interface LocalSessionState {
  manualLock?: ManualLock;
  lastAssignment?: StoredAssignment;
  enabled: boolean;
}

export type ExtensionMessage =
  | { type: "context_card"; card: ContextCard }
  | { type: "assignment"; assignment: GroupAssignment; group?: TabGroup }
  | { type: "request_cards" };
