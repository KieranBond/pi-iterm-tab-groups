import { generateContextCard, type SessionContext } from "./context";
import { DeterministicCoordinator } from "./coordinator";
import type { IntercomExtensionBus } from "./intercom-bus";
import { generateGroupId, normalizeGroupLabel } from "./palette";
import {
  clearManualLock,
  loadState,
  setEnabled,
  updateLastAssignment,
  updateManualLock,
  type StateStore,
} from "./state";
import { applyGroupStyle, resetTabColor, type TerminalEnvironment, type TerminalOutput, type TitleSetter } from "./terminal";
import type { GroupAssignment, LocalSessionState, TabGroup } from "./types";

export class TabGroupRuntime {
  private state: LocalSessionState = { enabled: true };
  private revision = 0;
  private coordinator: DeterministicCoordinator;
  private started = false;
  private styleApplied = false;
  private semanticContext?: { synopsis: string; domainNouns: string[] };

  constructor(
    private readonly sessionId: string,
    private readonly bus: IntercomExtensionBus,
    private readonly stateStore: StateStore,
    private readonly contextProvider: () => Promise<SessionContext>,
    private readonly terminal: {
      output: TerminalOutput;
      environment: TerminalEnvironment;
      title: TitleSetter;
      forceTmux?: boolean;
      titleSuffix?: string;
      onError?: (error: unknown) => void;
    },
  ) {
    this.coordinator = new DeterministicCoordinator(
      bus,
      (assignment, group) => {
        void this.receiveAssignment(assignment, group).catch((error) => this.terminal.onError?.(error));
      },
      () => {
        void this.refresh().catch((error) => this.terminal.onError?.(error));
      },
    );
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.bus.start();
    this.coordinator.start();
    this.state = await loadState(this.stateStore);
    // Clear a colour left by an abnormal previous exit without clobbering the
    // title when this session has never owned it.
    resetTabColor(this.terminal.output, this.terminal.environment, this.terminal.forceTmux);

    if (this.state.enabled && this.state.lastAssignment?.group) {
      this.styleApplied = applyGroupStyle(
        this.state.lastAssignment.group ?? null,
        this.terminal.output,
        this.terminal.environment,
        this.terminal.title,
        this.terminal.forceTmux,
        this.terminal.titleSuffix,
      );
    }
    await this.refresh();
  }

  async shutdown(): Promise<void> {
    this.coordinator.stop();
    this.bus.stop();
    if (this.styleApplied) {
      applyGroupStyle(null, this.terminal.output, this.terminal.environment, this.terminal.title, this.terminal.forceTmux);
    } else {
      resetTabColor(this.terminal.output, this.terminal.environment, this.terminal.forceTmux);
    }
    this.styleApplied = false;
    this.started = false;
  }

  async join(labelInput: string): Promise<void> {
    const label = normalizeGroupLabel(labelInput);
    if (!label) throw new Error("Usage: /tab-group join <group>");
    const groupId = generateGroupId(label);
    this.state = await updateManualLock(this.stateStore, groupId, label);
    await this.refresh();
  }

  async leave(): Promise<void> {
    this.state = await updateManualLock(this.stateStore, null);
    await this.refresh();
  }

  async auto(): Promise<void> {
    this.state = await clearManualLock(this.stateStore);
    await this.refresh();
  }

  async setEnabled(enabled: boolean): Promise<void> {
    this.state = await setEnabled(this.stateStore, enabled);
    if (!enabled) {
      if (this.styleApplied) {
        applyGroupStyle(null, this.terminal.output, this.terminal.environment, this.terminal.title, this.terminal.forceTmux);
      } else {
        resetTabColor(this.terminal.output, this.terminal.environment, this.terminal.forceTmux);
      }
      this.styleApplied = false;
      return;
    }
    await this.refresh();
  }

  async setSemanticContext(synopsis: string, domainNouns: string[]): Promise<void> {
    this.semanticContext = { synopsis, domainNouns };
    await this.refresh();
  }

  async invalidateSemanticContext(): Promise<void> {
    this.semanticContext = undefined;
    const assignment = this.state.lastAssignment?.assignment;
    const cameFromSemantics = assignment?.source === "semantic" || assignment?.reasonCode === "sticky_semantic";
    if (cameFromSemantics) {
      this.state = { ...this.state, lastAssignment: undefined };
      await this.stateStore.set(this.state);
      if (this.styleApplied) {
        applyGroupStyle(null, this.terminal.output, this.terminal.environment, this.terminal.title, this.terminal.forceTmux);
        this.styleApplied = false;
      }
    }
    await this.refresh();
  }

  async refreshAll(): Promise<void> {
    if (!this.started || !this.state.enabled) return;
    this.coordinator.requestFleetRefresh();
  }

  async refresh(): Promise<void> {
    if (!this.started || !this.state.enabled) return;
    const baseContext = await this.contextProvider();
    if (baseContext.sessionId !== this.sessionId) return;
    const context = { ...baseContext, ...this.semanticContext };
    const card = generateContextCard(
      context,
      this.state.manualLock,
      this.revision,
      this.state.lastAssignment,
    );
    this.revision = card.revision;
    this.coordinator.publishCard(card);
  }

  async applyAssignment(assignment: GroupAssignment, group?: TabGroup): Promise<void> {
    await this.receiveAssignment(assignment, group);
  }

  status(): string {
    if (!this.state.enabled) return "Tab grouping: disabled";
    if (this.state.manualLock) {
      return this.state.manualLock.groupId
        ? `Tab group: ${this.state.manualLock.label ?? this.state.manualLock.groupId} (manual lock)`
        : "Tab group: none (manual lock)";
    }
    const current = this.state.lastAssignment;
    if (!current || !current.assignment.groupId) return "Tab group: unassigned (automatic)";
    return `Tab group: ${current.group?.label ?? current.assignment.groupId} (${current.assignment.source})`;
  }

  private async receiveAssignment(assignment: GroupAssignment, group?: TabGroup): Promise<void> {
    if (assignment.sessionId !== this.sessionId || !this.state.enabled) return;
    // Recheck local lock when delayed owner output arrives.
    if (this.state.manualLock && assignment.source !== "manual") return;
    this.state = await updateLastAssignment(this.stateStore, assignment, group);
    if (group) {
      this.styleApplied = applyGroupStyle(
        group,
        this.terminal.output,
        this.terminal.environment,
        this.terminal.title,
        this.terminal.forceTmux,
        this.terminal.titleSuffix,
      );
    } else if (this.styleApplied) {
      applyGroupStyle(null, this.terminal.output, this.terminal.environment, this.terminal.title, this.terminal.forceTmux);
      this.styleApplied = false;
    }
  }
}
