import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { extractTicketIds, type SessionContext } from "./context";
import { PiIntercomExtensionBus } from "./intercom-bus";
import { TabGroupRuntime } from "./runtime";
import { STATE_ENTRY_TYPE, type StateStore } from "./state";
import { RealTerminalEnvironment, RealTerminalOutput } from "./terminal";
import type { LocalSessionState } from "./types";

function isLocalState(value: unknown): value is LocalSessionState {
  return Boolean(value && typeof value === "object" && "enabled" in value && typeof (value as { enabled?: unknown }).enabled === "boolean");
}

class PiSessionStateStore implements StateStore {
  private state: LocalSessionState | null = null;

  constructor(private readonly pi: ExtensionAPI, ctx: ExtensionContext) {
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type === "custom" && entry.customType === STATE_ENTRY_TYPE && isLocalState(entry.data)) {
        this.state = structuredClone(entry.data);
      }
    }
  }

  async get(): Promise<LocalSessionState | null> {
    return this.state ? structuredClone(this.state) : null;
  }

  async set(state: LocalSessionState): Promise<void> {
    this.state = structuredClone(state);
    this.pi.appendEntry(STATE_ENTRY_TYPE, this.state);
  }
}

function directUserText(ctx: ExtensionContext): string[] {
  const result: string[] = [];
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "message" || entry.message.role !== "user") continue;
    const contents = typeof entry.message.content === "string"
      ? [{ type: "text" as const, text: entry.message.content }]
      : entry.message.content;
    for (const content of contents) {
      if (content.type === "text") result.push(content.text);
    }
  }
  return result.slice(-10).map((text) => text.slice(0, 4000));
}

async function gitValue(pi: ExtensionAPI, cwd: string, args: string[]): Promise<string | undefined> {
  try {
    const result = await pi.exec("git", ["-C", cwd, ...args], { timeout: 3000 });
    if (result.code !== 0) return undefined;
    const value = result.stdout.trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

async function buildContext(pi: ExtensionAPI, ctx: ExtensionContext): Promise<SessionContext> {
  const [root, branch, remote] = await Promise.all([
    gitValue(pi, ctx.cwd, ["rev-parse", "--show-toplevel"]),
    gitValue(pi, ctx.cwd, ["branch", "--show-current"]),
    gitValue(pi, ctx.cwd, ["remote", "get-url", "origin"]),
  ]);
  const sessionName = pi.getSessionName();
  const ticketCandidates = [sessionName ?? "", branch ?? "", ...directUserText(ctx)];
  return {
    sessionId: ctx.sessionManager.getSessionId(),
    ...(sessionName ? { sessionName } : {}),
    ...(root ? { repoBasename: path.basename(root) } : {}),
    ...(remote ? { repoRemoteUrl: remote } : {}),
    ...(branch ? { branch } : {}),
    ticketIds: extractTicketIds(ticketCandidates),
    ...(process.env.PI_SUBAGENT_ORCHESTRATOR_SESSION_ID
      ? { parentSessionId: process.env.PI_SUBAGENT_ORCHESTRATOR_SESSION_ID }
      : {}),
    ...(process.env.PI_SUBAGENT_RUN_ID ? { parentRunId: process.env.PI_SUBAGENT_RUN_ID } : {}),
  };
}

export default function tabGroupsExtension(pi: ExtensionAPI) {
  let runtime: TabGroupRuntime | undefined;

  pi.on("session_start", async (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const bus = new PiIntercomExtensionBus(pi.events, () => sessionId);
    const stateStore = new PiSessionStateStore(pi, ctx);
    runtime = new TabGroupRuntime(
      sessionId,
      bus,
      stateStore,
      () => buildContext(pi, ctx),
      {
        output: new RealTerminalOutput(),
        environment: new RealTerminalEnvironment(ctx.mode),
        title: { setTitle: (title) => ctx.ui.setTitle(title) },
        forceTmux: process.env.PI_ITERM_TAB_GROUPS_FORCE_TMUX === "1",
        titleSuffix: pi.getSessionName() ?? path.basename(ctx.cwd),
        onError: (error) => ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"),
      },
    );
    await runtime.start();
  });

  pi.on("session_shutdown", async () => {
    await runtime?.shutdown();
    runtime = undefined;
  });

  pi.on("session_info_changed", async () => {
    await runtime?.refresh();
  });

  pi.registerCommand("tab-group", {
    description: "Inspect or control the iTerm tab group",
    getArgumentCompletions: (prefix: string) => {
      const actions = ["status", "join", "auto", "leave", "refresh", "enable", "disable"];
      const items = actions.filter((action) => action.startsWith(prefix)).map((action) => ({ value: action, label: action }));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      if (!runtime) {
        ctx.ui.notify("Tab grouping is not ready", "warning");
        return;
      }
      const [action = "status", ...rest] = args.trim().split(/\s+/).filter(Boolean);
      try {
        switch (action) {
          case "status": break;
          case "join": await runtime.join(rest.join(" ")); break;
          case "auto": await runtime.auto(); break;
          case "leave": await runtime.leave(); break;
          case "refresh": await runtime.refresh(); break;
          case "enable": await runtime.setEnabled(true); break;
          case "disable": await runtime.setEnabled(false); break;
          default: throw new Error(`Unknown tab-group action: ${action}`);
        }
        ctx.ui.notify(runtime.status(), "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });
}
