import { describe, it, expect, vi, beforeEach } from "vitest";
import { CandidateStage, AccountStatus } from "@prisma/client";

// ─── Mocks ────────────────────────────────────────────────────────────────────
// We mock the Prisma client and the Unipile send functions so the test exercises
// ONLY the decision logic of sendRejectionNotifications — never a real DB or a
// real message. render-template / buildVars are left real (pure functions).

const unipile = vi.hoisted(() => ({
  sendChatMessage: vi.fn(async () => ({ messageId: "msg_1" })),
  sendEmail: vi.fn(async () => ({ ok: true as const, messageId: "email_1" })),
}));
vi.mock("@/lib/services/unipile.service", () => unipile);

const db = vi.hoisted(() => ({
  threadMessage: { count: vi.fn(), create: vi.fn() },
  task: { findUnique: vi.fn() },
  channelThread: { findMany: vi.fn() },
  account: { findUnique: vi.fn() },
}));
vi.mock("@/lib/prisma", () => ({ prisma: db }));

import { sendRejectionNotifications } from "../send-rejection";

// ─── Fixtures ───────────────────────────────────────────────────────────────

type ThreadFixture = {
  id: string;
  channelType: string;
  providerChatId: string | null;
  providerThreadId: string | null;
  accountId: string | null;
  lastInboundAt: Date | null;
  lastMessageAt: Date | null;
  channel: { id: string; config: Record<string, unknown>; dailyCap: number; sendingAccountId: string | null };
};

type AccountFixture = {
  id: string;
  accountId: string;
  dsn: string | null;
  apiKey: string | null;
  status: AccountStatus;
  deletedAt: Date | null;
};

const TASK = {
  result: JSON.stringify({ first_name: "Jane", last_name: "Doe" }),
  analysisResult: null,
  contact: { workEmail: "jane@work.com", email: null, personalEmail: null },
};

const HEALTHY_ACCOUNT: AccountFixture = {
  id: "acc1",
  accountId: "unipile_acc1",
  dsn: null,
  apiKey: null,
  status: AccountStatus.ACTIVE,
  deletedAt: null,
};

const TEMPLATE = "Hi {{firstName}}, we won't be moving forward. {{reason}}";

function linkedInThread(over: Partial<ThreadFixture> = {}): ThreadFixture {
  return {
    id: "thr_li",
    channelType: "LINKEDIN",
    providerChatId: "chat_li",
    providerThreadId: null,
    accountId: "acc1",
    lastInboundAt: null,
    lastMessageAt: new Date("2026-06-01T00:00:00Z"),
    channel: { id: "chan_li", config: { rejectionTemplate: TEMPLATE }, dailyCap: 20, sendingAccountId: "acc1" },
    ...over,
  };
}

function emailThread(over: Partial<ThreadFixture> = {}): ThreadFixture {
  return {
    id: "thr_em",
    channelType: "EMAIL",
    providerChatId: null,
    providerThreadId: "email_thread_1",
    accountId: "acc1",
    lastInboundAt: null,
    lastMessageAt: new Date("2026-06-02T00:00:00Z"),
    channel: { id: "chan_em", config: { rejectionTemplate: TEMPLATE }, dailyCap: 20, sendingAccountId: "acc1" },
    ...over,
  };
}

/** Wire up the mocks for one scenario. */
function setup(opts: {
  threads: ThreadFixture[];
  alreadyNotified?: number; // idempotency count
  sentToday?: number; // per-channel daily rejection count
  account?: AccountFixture | null;
  task?: typeof TASK | null;
}) {
  db.threadMessage.count.mockImplementation(async ({ where }: any) =>
    where?.sentAt ? (opts.sentToday ?? 0) : (opts.alreadyNotified ?? 0),
  );
  db.task.findUnique.mockResolvedValue(opts.task === undefined ? TASK : opts.task);
  db.channelThread.findMany.mockResolvedValue(opts.threads);
  db.account.findUnique.mockResolvedValue(opts.account === undefined ? HEALTHY_ACCOUNT : opts.account);
  db.threadMessage.create.mockResolvedValue({});
}

beforeEach(() => vi.clearAllMocks());

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("sendRejectionNotifications", () => {
  it("does NOT send for ARCHIVED (REJECTED only)", async () => {
    setup({ threads: [linkedInThread()] });
    await sendRejectionNotifications("task1", CandidateStage.ARCHIVED, "Position filled");
    expect(unipile.sendChatMessage).not.toHaveBeenCalled();
    expect(db.threadMessage.create).not.toHaveBeenCalled();
  });

  it("is idempotent — skips if the task already has a REJECTION message", async () => {
    setup({ threads: [linkedInThread()], alreadyNotified: 1 });
    await sendRejectionNotifications("task1", CandidateStage.REJECTED, "Not a fit");
    expect(unipile.sendChatMessage).not.toHaveBeenCalled();
    expect(db.threadMessage.create).not.toHaveBeenCalled();
  });

  it("skips channels with no rejectionTemplate configured (opt-in)", async () => {
    setup({ threads: [linkedInThread({ channel: { id: "c", config: {}, dailyCap: 20, sendingAccountId: "acc1" } })] });
    await sendRejectionNotifications("task1", CandidateStage.REJECTED, "Not a fit");
    expect(unipile.sendChatMessage).not.toHaveBeenCalled();
    expect(db.threadMessage.create).not.toHaveBeenCalled();
  });

  it("sends a LinkedIn rejection and records a REJECTION message (happy path)", async () => {
    setup({ threads: [linkedInThread()] });
    await sendRejectionNotifications("task1", CandidateStage.REJECTED, "Not a fit");

    expect(unipile.sendChatMessage).toHaveBeenCalledTimes(1);
    const arg = (unipile.sendChatMessage.mock.calls[0] as any[])[0];
    expect(arg.text).toBe("Hi Jane, we won't be moving forward. Not a fit");

    expect(db.threadMessage.create).toHaveBeenCalledTimes(1);
    const created = (db.threadMessage.create.mock.calls[0] as any[])[0].data;
    expect(created.type).toBe("REJECTION");
    expect(created.threadId).toBe("thr_li");
  });

  it("messages only ONE channel when contacted on multiple, preferring the engaged one", async () => {
    // Email thread has an inbound reply (engaged); LinkedIn does not. Engagement wins.
    setup({
      threads: [
        linkedInThread(),
        emailThread({ lastInboundAt: new Date("2026-06-05T00:00:00Z") }),
      ],
    });
    await sendRejectionNotifications("task1", CandidateStage.REJECTED, "Not a fit");

    expect(unipile.sendEmail).toHaveBeenCalledTimes(1);
    expect(unipile.sendChatMessage).not.toHaveBeenCalled();
    expect(db.threadMessage.create).toHaveBeenCalledTimes(1);
  });

  it("skips a WhatsApp thread outside the 24h window", async () => {
    setup({
      threads: [
        linkedInThread({
          id: "thr_wa",
          channelType: "WHATSAPP",
          providerChatId: "wa_chat",
          lastInboundAt: null, // never replied → outside window
          channel: { id: "chan_wa", config: { rejectionTemplate: TEMPLATE }, dailyCap: 20, sendingAccountId: "acc1" },
        }),
      ],
    });
    await sendRejectionNotifications("task1", CandidateStage.REJECTED, "Not a fit");
    expect(unipile.sendChatMessage).not.toHaveBeenCalled();
  });

  it("skips when the sending account is not ACTIVE", async () => {
    setup({ threads: [linkedInThread()], account: { ...HEALTHY_ACCOUNT, status: AccountStatus.COOLDOWN } });
    await sendRejectionNotifications("task1", CandidateStage.REJECTED, "Not a fit");
    expect(unipile.sendChatMessage).not.toHaveBeenCalled();
  });

  it("skips when the per-channel daily rejection cap is reached", async () => {
    setup({ threads: [linkedInThread()], sentToday: 20 }); // dailyCap = 20
    await sendRejectionNotifications("task1", CandidateStage.REJECTED, "Not a fit");
    expect(unipile.sendChatMessage).not.toHaveBeenCalled();
    expect(db.threadMessage.create).not.toHaveBeenCalled();
  });
});
