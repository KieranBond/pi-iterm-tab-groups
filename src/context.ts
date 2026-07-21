import { createHash } from "node:crypto";
import type { ContextCard, ManualLock, StoredAssignment } from "./types";

export interface SessionContext {
  sessionId: string;
  sessionName?: string;
  repoBasename?: string;
  repoRemoteUrl?: string;
  branch?: string;
  ticketIds?: string[];
  parentSessionId?: string;
  parentRunId?: string;
  synopsis?: string;
  domainNouns?: string[];
}

function clean(value: string | undefined, max = 120): string | undefined {
  if (!value) return undefined;
  const result = value.replace(/[\x00-\x1f\x7f-\x9f]/g, "").replace(/\s+/g, " ").trim();
  return result ? Array.from(result).slice(0, max).join("") : undefined;
}

export function generateContextCard(
  context: SessionContext,
  manualLock?: ManualLock,
  previousRevision = 0,
  sticky?: StoredAssignment,
): ContextCard {
  const ticketIds = [...new Set(extractTicketIds(context.ticketIds ?? []))].sort();
  const repoIdentityHash = context.repoRemoteUrl
    ? hashString(normalizeGitUrl(context.repoRemoteUrl))
    : undefined;
  const sessionName = clean(context.sessionName);
  const repoBasename = clean(context.repoBasename, 80);
  const branch = clean(context.branch, 160);
  const parentSessionId = clean(context.parentSessionId, 160);
  const parentRunId = clean(context.parentRunId, 160);
  const synopsis = clean(context.synopsis, 280);
  const domainNouns = [...new Set((context.domainNouns ?? []).map((noun) => clean(noun, 40)).filter((noun): noun is string => !!noun))]
    .slice(0, 8);
  const card: ContextCard = {
    sessionId: context.sessionId,
    revision: previousRevision + 1,
    cardHash: "",
    ticketIds,
    updatedAt: Date.now(),
    ...(sessionName ? { sessionName } : {}),
    ...(repoBasename ? { repoBasename } : {}),
    ...(repoIdentityHash ? { repoIdentityHash } : {}),
    ...(branch ? { branch } : {}),
    ...(parentSessionId ? { parentSessionId } : {}),
    ...(parentRunId ? { parentRunId } : {}),
    ...(manualLock ? { manualLock } : {}),
    ...(sticky ? { sticky } : {}),
    ...(synopsis ? { synopsis } : {}),
    ...(domainNouns.length ? { domainNouns } : {}),
  };
  card.cardHash = computeCardHash(card);
  return card;
}

export function extractTicketIds(candidates: string[]): string[] {
  const found = new Set<string>();
  const commonNonTicketPrefixes = new Set(["HTTP", "HTTPS", "ISO", "RFC", "SHA", "TLS", "UTF"]);
  for (const candidate of candidates) {
    for (const match of candidate.matchAll(/\b([A-Z]{2,10})-(\d+)\b/gi)) {
      const prefix = match[1]!.toUpperCase();
      if (!commonNonTicketPrefixes.has(prefix)) found.add(`${prefix}-${match[2]}`);
    }
  }
  return [...found];
}

export function normalizeGitUrl(url: string): string {
  return url
    .trim()
    .replace(/\.git$/i, "")
    .replace(/^git@/i, "")
    .replace(/^https?:\/\/([^@]*@)?/i, "")
    .replace(":", "/")
    .replace(/\/$/, "")
    .toLowerCase();
}

export function hashString(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

function computeCardHash(card: ContextCard): string {
  return hashString(JSON.stringify({
    sessionId: card.sessionId,
    sessionName: card.sessionName,
    repoBasename: card.repoBasename,
    repoIdentityHash: card.repoIdentityHash,
    branch: card.branch,
    ticketIds: card.ticketIds,
    parentSessionId: card.parentSessionId,
    parentRunId: card.parentRunId,
    manualLock: card.manualLock,
    sticky: card.sticky,
    synopsis: card.synopsis,
    domainNouns: card.domainNouns,
  }));
}
