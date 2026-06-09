// ─── Channel config type definitions + runtime validators ─────────────────────
//
// These types define the JSON shape stored in Channel.config.
// Validated at the API boundary (POST/PATCH /channels) before hitting the DB.
// No external deps — plain TypeScript + manual checks so we stay dep-free.

export interface FollowupRule {
  afterDays: number;
  template: string;
  subjectTemplate?: string; // email only
}

// ─── LinkedIn ─────────────────────────────────────────────────────────────────

export type InviteType = "CONNECTION_REQUEST" | "INMAIL";

export interface LinkedInInviteRule {
  key: string;
  minScore: number;
  maxScore: number;
  inviteType: InviteType;
  noteTemplate?: string;    // CONNECTION_REQUEST note, max 300 chars
  messageTemplate?: string; // INMAIL body
  priority: number;         // higher wins when bands overlap
}

export interface LinkedInConfig {
  inviteRules: LinkedInInviteRule[];
  archiveAfterInviteDays: number; // archive if invite not accepted within N days
  followups: FollowupRule[];      // [0] = first DM after connect (or first followup for InMail)
  replyWaitDays?: number;         // after the LAST follow-up, wait N days for a reply before archiving
  // First message for candidates we are ALREADY connected to (1st-degree), who
  // never receive the connection note because no invite is sent. Delivered as a
  // DM before the followups[] sequence. If unset, the connection note's content
  // is used as the opener instead.
  connectedFirstMessage?: string;
}

// ─── Email ────────────────────────────────────────────────────────────────────

export interface EmailRule {
  key: string;
  minScore: number;
  maxScore: number;
  subjectTemplate: string;
  bodyTemplate: string;
  priority: number;
}

export interface EmailConfig {
  emailRules: EmailRule[];
  followups: FollowupRule[];
  fromName?: string;           // display name override
  replyTo?: string;
  contactRetryMinutes?: number; // how long to wait before retrying when no email found (default 60)
  contactRetryMaxDays?: number; // give up after N days of retrying (default 7)
  replyWaitDays?: number;       // after the LAST follow-up, wait N days for a reply before archiving
}

// ─── WhatsApp ─────────────────────────────────────────────────────────────────

export interface WARule {
  key: string;
  minScore: number;
  maxScore: number;
  messageTemplate: string;
  priority: number;
}

export interface QuietHours {
  startHour: number; // 0-23
  endHour: number;   // 0-23 (exclusive — messages held until this hour)
  tz: string;        // IANA timezone, e.g. "Asia/Kolkata"
}

export interface WAConfig {
  waRules: WARule[];
  followups: FollowupRule[];
  quietHours?: QuietHours;
  contactRetryMinutes?: number; // how long to wait before retrying when no phone found (default 60)
  contactRetryMaxDays?: number; // give up after N days of retrying (default 7)
  replyWaitDays?: number;       // after the LAST follow-up, wait N days for a reply before archiving
}

export type ChannelConfig = LinkedInConfig | EmailConfig | WAConfig;

// ─── Provider sub-state (stored in ChannelThread.providerState) ───────────────

export interface LinkedInProviderState {
  phase: "INVITE_PENDING" | "CONNECTED" | "INMAIL_SENT";
  inviteSentAt?: string; // ISO string
}

export interface EmailProviderState {
  phase: "SENT" | "BOUNCED";
  bounceReason?: string;
}

export interface WAProviderState {
  phase: "DELIVERED" | "READ";
  waMessageId?: string;
}

// ─── Runtime validators ───────────────────────────────────────────────────────

type ValidationResult = { ok: true } | { ok: false; error: string };

function validateFollowup(f: unknown, index: number): ValidationResult {
  if (!f || typeof f !== "object") return { ok: false, error: `followups[${index}] must be an object` };
  const fu = f as Record<string, unknown>;
  if (typeof fu.afterDays !== "number" || fu.afterDays < 1) {
    return { ok: false, error: `followups[${index}].afterDays must be a positive number` };
  }
  if (typeof fu.template !== "string" || !fu.template.trim()) {
    return { ok: false, error: `followups[${index}].template is required` };
  }
  return { ok: true };
}

// Shared optional reply-wait validator — same rules across all channel types.
function validateReplyWaitDays(config: Record<string, unknown>): ValidationResult {
  if (config.replyWaitDays === undefined) return { ok: true };
  if (typeof config.replyWaitDays !== "number" || config.replyWaitDays < 1) {
    return { ok: false, error: "replyWaitDays must be a positive number (days to wait for a reply after the final follow-up)" };
  }
  return { ok: true };
}

function validateScoreRange(rule: Record<string, unknown>, key: string): ValidationResult {
  if (typeof rule.minScore !== "number" || rule.minScore < 0 || rule.minScore > 100) {
    return { ok: false, error: `${key}.minScore must be 0-100` };
  }
  if (typeof rule.maxScore !== "number" || rule.maxScore < 0 || rule.maxScore > 100) {
    return { ok: false, error: `${key}.maxScore must be 0-100` };
  }
  if (rule.minScore > rule.maxScore) {
    return { ok: false, error: `${key}.minScore must be ≤ maxScore` };
  }
  return { ok: true };
}

export function validateLinkedInConfig(c: unknown): ValidationResult {
  if (!c || typeof c !== "object") return { ok: false, error: "config must be an object" };
  const config = c as Record<string, unknown>;

  if (!Array.isArray(config.inviteRules) || config.inviteRules.length === 0) {
    return { ok: false, error: "inviteRules array is required and must not be empty" };
  }
  for (let i = 0; i < config.inviteRules.length; i++) {
    const rule = config.inviteRules[i] as Record<string, unknown>;
    if (!rule.key || typeof rule.key !== "string") return { ok: false, error: `inviteRules[${i}].key required` };
    const rangeCheck = validateScoreRange(rule, `inviteRules[${i}]`);
    if (!rangeCheck.ok) return rangeCheck;
    if (rule.inviteType !== "CONNECTION_REQUEST" && rule.inviteType !== "INMAIL") {
      return { ok: false, error: `inviteRules[${i}].inviteType must be CONNECTION_REQUEST or INMAIL` };
    }
  }
  if (typeof config.archiveAfterInviteDays !== "number" || config.archiveAfterInviteDays < 1) {
    return { ok: false, error: "archiveAfterInviteDays must be a positive number" };
  }
  if (!Array.isArray(config.followups)) return { ok: false, error: "followups must be an array" };
  for (let i = 0; i < config.followups.length; i++) {
    const r = validateFollowup(config.followups[i], i);
    if (!r.ok) return r;
  }
  const replyWait = validateReplyWaitDays(config);
  if (!replyWait.ok) return replyWait;
  if (config.connectedFirstMessage !== undefined && typeof config.connectedFirstMessage !== "string") {
    return { ok: false, error: "connectedFirstMessage must be a string" };
  }
  return { ok: true };
}

export function validateEmailConfig(c: unknown): ValidationResult {
  if (!c || typeof c !== "object") return { ok: false, error: "config must be an object" };
  const config = c as Record<string, unknown>;

  if (!Array.isArray(config.emailRules) || config.emailRules.length === 0) {
    return { ok: false, error: "emailRules array is required and must not be empty" };
  }
  for (let i = 0; i < config.emailRules.length; i++) {
    const rule = config.emailRules[i] as Record<string, unknown>;
    if (!rule.key || typeof rule.key !== "string") return { ok: false, error: `emailRules[${i}].key required` };
    const rangeCheck = validateScoreRange(rule, `emailRules[${i}]`);
    if (!rangeCheck.ok) return rangeCheck;
    if (!rule.subjectTemplate || typeof rule.subjectTemplate !== "string") {
      return { ok: false, error: `emailRules[${i}].subjectTemplate required` };
    }
    if (!rule.bodyTemplate || typeof rule.bodyTemplate !== "string") {
      return { ok: false, error: `emailRules[${i}].bodyTemplate required` };
    }
  }
  if (!Array.isArray(config.followups)) return { ok: false, error: "followups must be an array" };
  for (let i = 0; i < config.followups.length; i++) {
    const r = validateFollowup(config.followups[i], i);
    if (!r.ok) return r;
  }
  if (config.contactRetryMinutes !== undefined) {
    if (typeof config.contactRetryMinutes !== "number" || config.contactRetryMinutes < 1) {
      return { ok: false, error: "contactRetryMinutes must be a positive number (e.g. 30, 60, 120)" };
    }
  }
  if (config.contactRetryMaxDays !== undefined) {
    if (typeof config.contactRetryMaxDays !== "number" || config.contactRetryMaxDays < 1) {
      return { ok: false, error: "contactRetryMaxDays must be a positive number" };
    }
  }
  const replyWait = validateReplyWaitDays(config);
  if (!replyWait.ok) return replyWait;
  return { ok: true };
}

export function validateWAConfig(c: unknown): ValidationResult {
  if (!c || typeof c !== "object") return { ok: false, error: "config must be an object" };
  const config = c as Record<string, unknown>;

  if (!Array.isArray(config.waRules) || config.waRules.length === 0) {
    return { ok: false, error: "waRules array is required and must not be empty" };
  }
  for (let i = 0; i < config.waRules.length; i++) {
    const rule = config.waRules[i] as Record<string, unknown>;
    if (!rule.key || typeof rule.key !== "string") return { ok: false, error: `waRules[${i}].key required` };
    const rangeCheck = validateScoreRange(rule, `waRules[${i}]`);
    if (!rangeCheck.ok) return rangeCheck;
    if (!rule.messageTemplate || typeof rule.messageTemplate !== "string") {
      return { ok: false, error: `waRules[${i}].messageTemplate required` };
    }
  }
  if (!Array.isArray(config.followups)) return { ok: false, error: "followups must be an array" };
  for (let i = 0; i < config.followups.length; i++) {
    const r = validateFollowup(config.followups[i], i);
    if (!r.ok) return r;
  }
  if (config.contactRetryMinutes !== undefined) {
    if (typeof config.contactRetryMinutes !== "number" || config.contactRetryMinutes < 1) {
      return { ok: false, error: "contactRetryMinutes must be a positive number (e.g. 30, 60, 120)" };
    }
  }
  if (config.contactRetryMaxDays !== undefined) {
    if (typeof config.contactRetryMaxDays !== "number" || config.contactRetryMaxDays < 1) {
      return { ok: false, error: "contactRetryMaxDays must be a positive number" };
    }
  }
  if (config.quietHours !== undefined) {
    const qh = config.quietHours as Record<string, unknown>;
    if (typeof qh.startHour !== "number" || qh.startHour < 0 || qh.startHour > 23) {
      return { ok: false, error: "quietHours.startHour must be 0-23" };
    }
    if (typeof qh.endHour !== "number" || qh.endHour < 0 || qh.endHour > 23) {
      return { ok: false, error: "quietHours.endHour must be 0-23" };
    }
    if (typeof qh.tz !== "string" || !qh.tz) {
      return { ok: false, error: "quietHours.tz is required" };
    }
  }
  const replyWait = validateReplyWaitDays(config);
  if (!replyWait.ok) return replyWait;
  return { ok: true };
}

// ─── Rule matching ────────────────────────────────────────────────────────────
//
// Returns the highest-priority rule where score falls in [minScore, maxScore].

export function matchRule<T extends { minScore: number; maxScore: number; priority: number; key: string }>(
  score: number,
  rules: T[],
): T | null {
  const candidates = rules.filter(r => score >= r.minScore && score <= r.maxScore);
  if (candidates.length === 0) return null;
  return candidates.sort((a, b) => b.priority - a.priority)[0];
}

// ─── Quiet-hours check ────────────────────────────────────────────────────────
//
// Returns a Date for when the quiet period ends, or null if we're not in quiet hours.

export function quietHoursEnd(quietHours: QuietHours): Date | null {
  try {
    const now = new Date();
    const tzOptions: Intl.DateTimeFormatOptions = { timeZone: quietHours.tz, hour: "numeric", hour12: false };
    const localHour = parseInt(new Intl.DateTimeFormat("en-US", tzOptions).format(now), 10);

    const { startHour, endHour } = quietHours;
    // Two cases: wrap-midnight (e.g. 21–8) or same-day (unlikely but supported)
    const inQuiet =
      startHour > endHour
        ? localHour >= startHour || localHour < endHour
        : localHour >= startHour && localHour < endHour;

    if (!inQuiet) return null;

    // Compute the DateTime when quiet period ends (endHour in the configured tz)
    const tomorrow = new Date(now);
    if (localHour >= startHour && startHour > endHour) {
      tomorrow.setDate(tomorrow.getDate() + 1);
    }
    tomorrow.setHours(endHour, 0, 0, 0);
    return tomorrow;
  } catch {
    return null; // invalid tz — fail open (send anyway)
  }
}
