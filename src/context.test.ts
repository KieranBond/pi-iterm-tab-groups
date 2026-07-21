import { generateContextCard, extractTicketIds, normalizeGitUrl, hashString } from "./context";

describe("context", () => {
  describe("extractTicketIds", () => {
    it("should extract valid ticket IDs", () => {
      const result = extractTicketIds(["JIRA-123", "PROJ-456", "invalid", "ABC-1"]);
      expect(result).toEqual(["JIRA-123", "PROJ-456", "ABC-1"]);
    });

    it("should normalize lowercase ticket IDs and reject invalid formats", () => {
      const result = extractTicketIds(["jira-123", "JIRA", "123", "JIRA-", "-123"]);
      expect(result).toEqual(["JIRA-123"]);
    });

    it("should ignore common standard and encoding tokens", () => {
      expect(extractTicketIds(["UTF-8 SHA-256 RFC-822 ISO-8601 TLS-13"])).toEqual([]);
    });

    it("should handle empty input", () => {
      expect(extractTicketIds([])).toEqual([]);
    });
  });

  describe("normalizeGitUrl", () => {
    it("should normalize HTTPS URLs", () => {
      expect(normalizeGitUrl("https://github.com/user/repo.git")).toBe("github.com/user/repo");
      expect(normalizeGitUrl("https://user:pass@github.com/user/repo")).toBe("github.com/user/repo");
    });

    it("should normalize SSH URLs", () => {
      expect(normalizeGitUrl("git@github.com:user/repo.git")).toBe("github.com/user/repo");
    });

    it("should remove trailing slashes", () => {
      expect(normalizeGitUrl("https://github.com/user/repo/")).toBe("github.com/user/repo");
    });

    it("should be case-insensitive", () => {
      expect(normalizeGitUrl("HTTPS://GitHub.com/User/Repo")).toBe("github.com/user/repo");
    });
  });

  describe("hashString", () => {
    it("should produce consistent 16-character hex hashes", () => {
      const hash1 = hashString("test");
      const hash2 = hashString("test");
      expect(hash1).toBe(hash2);
      expect(hash1).toMatch(/^[0-9a-f]{16}$/);
    });

    it("should produce different hashes for different inputs", () => {
      const hash1 = hashString("test1");
      const hash2 = hashString("test2");
      expect(hash1).not.toBe(hash2);
    });
  });

  describe("generateContextCard", () => {
    it("should generate a card with all fields", () => {
      const card = generateContextCard({
        sessionId: "sess-123",
        sessionName: "Feature work",
        repoBasename: "my-repo",
        repoRemoteUrl: "https://github.com/user/repo.git",
        branch: "feature/new",
        ticketIds: ["JIRA-123"],
        parentSessionId: "parent-456",
        parentRunId: "run-789",
      });

      expect(card.sessionId).toBe("sess-123");
      expect(card.sessionName).toBe("Feature work");
      expect(card.repoBasename).toBe("my-repo");
      expect(card.repoIdentityHash).toBeDefined();
      expect(card.branch).toBe("feature/new");
      expect(card.ticketIds).toEqual(["JIRA-123"]);
      expect(card.parentSessionId).toBe("parent-456");
      expect(card.parentRunId).toBe("run-789");
      expect(card.revision).toBe(1);
      expect(card.cardHash).toMatch(/^[0-9a-f]{16}$/);
      expect(card.updatedAt).toBeGreaterThan(0);
    });

    it("should sort ticket IDs", () => {
      const card = generateContextCard({
        sessionId: "sess-1",
        ticketIds: ["ZZZ-999", "AAA-111", "MMM-555"],
      });

      expect(card.ticketIds).toEqual(["AAA-111", "MMM-555", "ZZZ-999"]);
    });

    it("should increment revision", () => {
      const card1 = generateContextCard({ sessionId: "sess-1" }, undefined, 0);
      expect(card1.revision).toBe(1);

      const card2 = generateContextCard({ sessionId: "sess-1" }, undefined, 5);
      expect(card2.revision).toBe(6);
    });

    it("should include manual lock", () => {
      const lock = { groupId: "group-1", lockedAt: 123456 };
      const card = generateContextCard({ sessionId: "sess-1" }, lock);

      expect(card.manualLock).toEqual(lock);
    });

    it("should produce same cardHash for same content", () => {
      const card1 = generateContextCard({
        sessionId: "sess-1",
        ticketIds: ["JIRA-123"],
      });

      // Different updatedAt should not affect cardHash
      const card2 = generateContextCard({
        sessionId: "sess-1",
        ticketIds: ["JIRA-123"],
      });

      expect(card1.cardHash).toBe(card2.cardHash);
    });

    it("should produce different cardHash for different content", () => {
      const card1 = generateContextCard({
        sessionId: "sess-1",
        ticketIds: ["JIRA-123"],
      });

      const card2 = generateContextCard({
        sessionId: "sess-1",
        ticketIds: ["JIRA-456"],
      });

      expect(card1.cardHash).not.toBe(card2.cardHash);
    });
  });
});
