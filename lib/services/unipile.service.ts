// Custom error classes for Unipile API responses
export class RateLimitError extends Error {
  retryAfterMs: number;
  constructor(message: string, retryAfterMs: number = 60000) {
    super(message);
    this.name = "RateLimitError";
    this.retryAfterMs = retryAfterMs;
  }
}

export class ServerError extends Error {
  statusCode: number;
  constructor(message: string, statusCode: number) {
    super(message);
    this.name = "ServerError";
    this.statusCode = statusCode;
  }
}

export class ClientError extends Error {
  statusCode: number;
  constructor(message: string, statusCode: number) {
    super(message);
    this.name = "ClientError";
    this.statusCode = statusCode;
  }
}

export class NetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NetworkError";
  }
}

/**
 * Extract LinkedIn public identifier from a URL.
 * e.g. "https://www.linkedin.com/in/johndoe?foo=bar" → "johndoe"
 */
export function extractIdentifier(url: string): string | null {
  try {
    const parsed = new URL(url);
    const match = parsed.pathname.match(/^\/in\/([^\/\?]+)/);
    if (match && match[1]) {
      return match[1].replace(/\/$/, "");
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Format a phone number for the WhatsApp provider ID format.
 * Strips the leading + if present, then appends @s.whatsapp.net.
 * e.g. "+14155550100" → "14155550100@s.whatsapp.net"
 *       "14155550100" → "14155550100@s.whatsapp.net"
 */
export function formatWhatsAppId(phone: string): string {
  const digits = phone.replace(/^\+/, "").replace(/\D/g, "");
  return `${digits}@s.whatsapp.net`;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function resolveDsnAndKey(accountDsn?: string, accountApiKey?: string) {
  const rawDsn = (accountDsn || process.env.UNIPILE_DSN)?.trim();
  const dsn = rawDsn && !rawDsn.startsWith("http") ? `https://${rawDsn}` : rawDsn;
  const apiKey = (accountApiKey || process.env.UNIPILE_API_KEY)?.trim();
  if (!dsn || !apiKey) {
    throw new Error("Unipile DSN and API key must be provided (via account or environment)");
  }
  return { dsn, apiKey };
}

function handleResponseError(status: number, text: string): never {
  if (status === 429) throw new RateLimitError("Rate limited by Unipile", 60000);
  if (status >= 500) throw new ServerError(`Unipile server error: ${status} - ${text}`, status);
  throw new ClientError(`Unipile client error: ${status} - ${text}`, status);
}

function wrapFetchError(error: any): never {
  if (
    error instanceof RateLimitError ||
    error instanceof ServerError ||
    error instanceof ClientError
  ) throw error;
  if (error.name === "AbortError" || error.name === "TimeoutError") {
    throw new NetworkError("Request to Unipile timed out");
  }
  throw new NetworkError(`Network error calling Unipile: ${error.message}`);
}

/** POST with application/json body */
async function postJson<T>(url: string, apiKey: string, body: Record<string, unknown>): Promise<T> {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "X-API-KEY": apiKey,
        "Accept": "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      handleResponseError(response.status, text);
    }

    return (await response.json()) as T;
  } catch (error: any) {
    wrapFetchError(error);
  }
}

/**
 * POST with multipart/form-data body.
 * Unipile's chat endpoints (/api/v1/chats, /api/v1/chats/{id}/messages)
 * require form-data, not JSON.
 */
async function postFormData<T>(url: string, apiKey: string, fields: Record<string, string>): Promise<T> {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    form.append(key, value);
  }

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "X-API-KEY": apiKey,
        "Accept": "application/json",
        // Do NOT set Content-Type — let the browser/runtime set it with the boundary
      },
      body: form,
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      handleResponseError(response.status, text);
    }

    return (await response.json()) as T;
  } catch (error: any) {
    wrapFetchError(error);
  }
}

// ─── Public API functions ─────────────────────────────────────────────────────

/**
 * Fetch a LinkedIn profile via the Unipile REST API.
 */
export async function fetchProfile(
  unipileAccountId: string,
  identifier: string,
  accountDsn?: string,
  accountApiKey?: string,
): Promise<any> {
  const startTime = Date.now();
  const { dsn, apiKey } = resolveDsnAndKey(accountDsn, accountApiKey);
  const url = `${dsn}/api/v1/users/${encodeURIComponent(identifier)}?account_id=${encodeURIComponent(unipileAccountId)}&linkedin_sections=*`;

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { "X-API-KEY": apiKey, "Accept": "application/json" },
      signal: AbortSignal.timeout(30000),
    });

    console.log(`Unipile fetchProfile took ${Date.now() - startTime}ms`);

    if (response.status === 429) {
      const retryAfter = response.headers.get("Retry-After");
      throw new RateLimitError(`Rate limited for account ${unipileAccountId}`, retryAfter ? parseInt(retryAfter, 10) * 1000 : 60000);
    }
    if (response.status >= 500) {
      const body = await response.text().catch(() => "");
      throw new ServerError(`Unipile server error: ${response.status} - ${body}`, response.status);
    }
    if (response.status >= 400) {
      const body = await response.text().catch(() => "");
      throw new ClientError(`Unipile client error: ${response.status} - ${body}`, response.status);
    }

    return await response.json();
  } catch (error) {
    console.error(`Error during Unipile fetchProfile: ${(error as Error).message}`);
    throw error;
  }
}

/**
 * Send a LinkedIn connection invitation.
 * Endpoint: POST /api/v1/users/invite (JSON)
 */
export async function sendInvitation(params: {
  accountId: string;
  providerUserId: string;
  message?: string;
  accountDsn?: string;
  accountApiKey?: string;
}): Promise<{ invitationId: string }> {
  const { dsn, apiKey } = resolveDsnAndKey(params.accountDsn, params.accountApiKey);
  const res = await postJson<{ invitation_id?: string; id?: string }>(
    `${dsn}/api/v1/users/invite`,
    apiKey,
    {
      account_id: params.accountId,
      provider_id: params.providerUserId,
      ...(params.message ? { message: params.message } : {}),
    },
  );
  return { invitationId: res.invitation_id || res.id || "" };
}

/**
 * Send a LinkedIn InMail (direct message without connection).
 * Endpoint: POST /api/v1/chats (multipart/form-data) with linkedin[inmail]=true
 */
export async function sendInMail(params: {
  accountId: string;
  providerUserId: string;  // LinkedIn provider_id of recipient
  text: string;
  accountDsn?: string;
  accountApiKey?: string;
}): Promise<{ chatId: string; messageId: string }> {
  const { dsn, apiKey } = resolveDsnAndKey(params.accountDsn, params.accountApiKey);
  const res = await postFormData<{ chat_id?: string; id?: string; message_id?: string }>(
    `${dsn}/api/v1/chats`,
    apiKey,
    {
      account_id: params.accountId,
      attendees_ids: params.providerUserId,
      text: params.text,
      "linkedin[api]": "classic",
      "linkedin[inmail]": "true",
    },
  );
  return {
    chatId: res.chat_id || res.id || "",
    messageId: res.message_id || "",
  };
}

/**
 * Start a new chat with the first message (LinkedIn DM or WhatsApp).
 * Endpoint: POST /api/v1/chats (multipart/form-data)
 *
 * For WhatsApp, providerUserId must be formatted as "{digits}@s.whatsapp.net".
 * Use formatWhatsAppId() to convert a phone number before calling this.
 */
export async function startChat(params: {
  accountId: string;
  providerUserId: string;
  text: string;
  accountDsn?: string;
  accountApiKey?: string;
}): Promise<{ chatId: string; messageId: string }> {
  const { dsn, apiKey } = resolveDsnAndKey(params.accountDsn, params.accountApiKey);
  const res = await postFormData<{ chat_id?: string; id?: string; message_id?: string }>(
    `${dsn}/api/v1/chats`,
    apiKey,
    {
      account_id: params.accountId,
      attendees_ids: params.providerUserId,
      text: params.text,
    },
  );
  return {
    chatId: res.chat_id || res.id || "",
    messageId: res.message_id || "",
  };
}

/**
 * Send a follow-up message in an existing chat (LinkedIn DM or WhatsApp).
 * Endpoint: POST /api/v1/chats/{chatId}/messages (multipart/form-data)
 */
export async function sendChatMessage(params: {
  accountId: string;
  chatId: string;
  text: string;
  accountDsn?: string;
  accountApiKey?: string;
}): Promise<{ messageId: string }> {
  const { dsn, apiKey } = resolveDsnAndKey(params.accountDsn, params.accountApiKey);
  const res = await postFormData<{ id?: string; message_id?: string }>(
    `${dsn}/api/v1/chats/${encodeURIComponent(params.chatId)}/messages`,
    apiKey,
    {
      account_id: params.accountId,
      text: params.text,
    },
  );
  return { messageId: res.message_id || res.id || "" };
}

type AccountLike = { accountId: string; dsn: string | null; apiKey: string | null };
type SendResult = { ok: true; messageId?: string; replyToId?: string } | { ok: false; error: string };

/**
 * Send an email via Unipile's email API.
 * Endpoint: POST /api/v1/emails (multipart/form-data)
 *
 * Unipile requires form-data with bracket-notation for the `to` array:
 *   to[0][identifier] = "email@example.com"
 *   to[0][display_name] = "Name"
 *
 * For reply threading, pass replyToId = the provider_id of the email being replied to.
 */
export async function sendEmail(params: {
  account: AccountLike;
  to: string;
  toName?: string;
  subject: string;
  body: string;
  tag: string;
  replyToId?: string;  // provider_id of the parent email (for threading)
}): Promise<SendResult> {
  const { dsn, apiKey } = resolveDsnAndKey(params.account.dsn ?? undefined, params.account.apiKey ?? undefined);

  const form = new FormData();
  form.append("account_id", params.account.accountId);
  form.append("to[0][identifier]", params.to);
  form.append("to[0][display_name]", params.toName ?? params.to);
  form.append("subject", params.subject);
  form.append("body", params.body);
  if (params.replyToId) {
    form.append("reply_to", params.replyToId);
  }

  try {
    const response = await fetch(`${dsn}/api/v1/emails`, {
      method: "POST",
      headers: {
        "X-API-KEY": apiKey,
        "Accept": "application/json",
        // Do NOT set Content-Type — let runtime set it with the boundary
      },
      body: form,
      signal: AbortSignal.timeout(30000),
    });

    if (response.status === 429) {
      const retryAfter = response.headers.get("Retry-After");
      throw new RateLimitError("Email rate limited", retryAfter ? parseInt(retryAfter) * 1000 : 60000);
    }
    if (response.status >= 500) {
      const text = await response.text().catch(() => "");
      throw new ServerError(`Unipile email server error ${response.status}: ${text}`, response.status);
    }
    if (response.status >= 400) {
      const text = await response.text().catch(() => "");
      return { ok: false, error: `Email rejected (${response.status}): ${text}` };
    }

    // Response: { object: "EmailSent", tracking_id: "...", provider_id: "..." }
    const data = await response.json();
    return {
      ok: true,
      messageId: data.tracking_id ?? undefined,
      replyToId: data.provider_id ?? undefined,
    };
  } catch (err: any) {
    if (err instanceof RateLimitError || err instanceof ServerError) throw err;
    if (err.name === "AbortError" || err.name === "TimeoutError") {
      throw new NetworkError("Email request to Unipile timed out");
    }
    return { ok: false, error: err.message };
  }
}

// ─── LinkedIn invite management ───────────────────────────────────────────────

export interface SentInvitation {
  id: string;               // Unipile invitation ID — used for DELETE
  invitedUserId: string | null;    // LinkedIn provider_id
  invitedUserPublicId: string | null;
  date: string;
}

/**
 * Get remaining InMail credits for a LinkedIn account.
 * Returns null if the request fails (non-throwing).
 */
export async function getInMailBalance(params: {
  accountId: string;
  accountDsn?: string;
  accountApiKey?: string;
}): Promise<{ premium: number | null; recruiter: number | null; salesNavigator: number | null } | null> {
  try {
    const { dsn, apiKey } = resolveDsnAndKey(params.accountDsn, params.accountApiKey);
    const response = await fetch(
      `${dsn}/api/v1/linkedin/inmail_balance?account_id=${encodeURIComponent(params.accountId)}`,
      {
        headers: { "X-API-KEY": apiKey, "Accept": "application/json" },
        signal: AbortSignal.timeout(15000),
      },
    );
    if (!response.ok) return null;
    const data = await response.json();
    return {
      premium: data.premium ?? null,
      recruiter: data.recruiter ?? null,
      salesNavigator: data.sales_navigator ?? null,
    };
  } catch {
    return null;
  }
}

/**
 * List pending sent invitations for a LinkedIn account.
 * Invitations that have been accepted will no longer appear here.
 * Returns [] on error (non-throwing).
 */
export async function listSentInvitations(params: {
  accountId: string;
  limit?: number;
  accountDsn?: string;
  accountApiKey?: string;
}): Promise<SentInvitation[]> {
  try {
    const { dsn, apiKey } = resolveDsnAndKey(params.accountDsn, params.accountApiKey);
    const url = `${dsn}/api/v1/users/invite/sent?account_id=${encodeURIComponent(params.accountId)}&limit=${params.limit ?? 100}`;
    const response = await fetch(url, {
      headers: { "X-API-KEY": apiKey, "Accept": "application/json" },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) return [];
    const data = await response.json();
    const items: any[] = data.items ?? data ?? [];
    return items.map(item => ({
      id: item.id,
      invitedUserId: item.invited_user_id ?? null,
      invitedUserPublicId: item.invited_user_public_id ?? null,
      date: item.date ?? "",
    }));
  } catch {
    return [];
  }
}

/**
 * Cancel a pending sent invitation.
 * Returns true on success, false on error (non-throwing).
 */
export async function cancelInvitation(params: {
  invitationId: string;
  accountId: string;
  accountDsn?: string;
  accountApiKey?: string;
}): Promise<boolean> {
  try {
    const { dsn, apiKey } = resolveDsnAndKey(params.accountDsn, params.accountApiKey);
    const response = await fetch(
      `${dsn}/api/v1/users/invite/sent/${encodeURIComponent(params.invitationId)}?account_id=${encodeURIComponent(params.accountId)}`,
      {
        method: "DELETE",
        headers: { "X-API-KEY": apiKey, "Accept": "application/json" },
        signal: AbortSignal.timeout(15000),
      },
    );
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Send a WhatsApp message via Unipile.
 * For new chats, phone should be an E.164 number (e.g. "+14155550100" or "14155550100").
 * It is automatically formatted to the required "{digits}@s.whatsapp.net" format.
 */
export async function sendWhatsApp(params: {
  account: AccountLike;
  message: string;
  phone: string;         // E.164 phone number (with or without leading +)
  chatId?: string;       // existing WA chat_id for follow-ups
  tag: string;
}): Promise<SendResult & { chatId?: string }> {
  const providerUserId = formatWhatsAppId(params.phone);

  try {
    if (params.chatId) {
      const { messageId } = await sendChatMessage({
        accountId: params.account.accountId,
        chatId: params.chatId,
        text: params.message,
        accountDsn: params.account.dsn ?? undefined,
        accountApiKey: params.account.apiKey ?? undefined,
      });
      return { ok: true, messageId, chatId: params.chatId };
    } else {
      const { chatId, messageId } = await startChat({
        accountId: params.account.accountId,
        providerUserId,
        text: params.message,
        accountDsn: params.account.dsn ?? undefined,
        accountApiKey: params.account.apiKey ?? undefined,
      });
      return { ok: true, messageId, chatId };
    }
  } catch (err: any) {
    if (err instanceof RateLimitError || err instanceof ServerError) throw err;
    return { ok: false, error: err.message };
  }
}

/**
 * Fetch recent messages in a chat. Used to poll for inbound replies.
 * Returns messages newest-first. `limit` defaults to 10.
 */
export async function listChatMessages(params: {
  chatId: string;
  accountId: string;
  limit?: number;
  accountDsn?: string;
  accountApiKey?: string;
}): Promise<Array<{ id: string; fromMe: boolean; text: string; date: string }>> {
  try {
    const { dsn, apiKey } = resolveDsnAndKey(params.accountDsn, params.accountApiKey);
    const limit = params.limit ?? 10;
    const url = `${dsn}/api/v1/chats/${encodeURIComponent(params.chatId)}/messages?account_id=${encodeURIComponent(params.accountId)}&limit=${limit}`;
    const res = await fetch(url, {
      headers: { "X-API-KEY": apiKey, "Accept": "application/json" },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return [];
    const data = await res.json();
    const items: any[] = data?.items ?? data?.messages ?? (Array.isArray(data) ? data : []);
    return items.map(m => ({
      id: m.id ?? "",
      fromMe: m.from_me === true || m.is_from_me === true,
      text: m.text ?? m.body ?? "",
      date: m.date ?? m.created_at ?? "",
    }));
  } catch {
    return [];
  }
}
