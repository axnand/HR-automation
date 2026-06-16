// ─── Credit costs — update to match your Airscale plan ───────────────────────
export const CREDIT_COSTS = {
  work_email:     1,
  personal_email: 1,
  phone:          2,
} as const;

export type EnrichType = keyof typeof CREDIT_COSTS | "all";

export class AirscaleError extends Error {
  constructor(message: string, public statusCode?: number) {
    super(message);
    this.name = "AirscaleError";
  }
}

// ─── Internal fetch helper ────────────────────────────────────────────────────

async function post(path: string, body: Record<string, unknown>): Promise<any> {
  const apiKey = process.env.AIRSCALE_API_KEY;
  if (!apiKey) throw new AirscaleError("AIRSCALE_API_KEY is not configured");

  const res = await fetch(`https://api.airscale.io${path}`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "Accept":        "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });

  if (res.status === 402) throw new AirscaleError("Airscale credit limit reached", 402);
  if (res.status === 429) throw new AirscaleError("Airscale rate limit exceeded", 429);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new AirscaleError(`Airscale API error ${res.status}: ${text}`, res.status);
  }
  return res.json();
}

// ─── Public functions ─────────────────────────────────────────────────────────

/** Work / professional email via POST /v1/email */
export async function findWorkEmail(linkedinUrl: string): Promise<string | null> {
  const data = await post("/v1/email", { linkedin_profile_url: linkedinUrl });
  return data.email ?? null;
}

/** Personal (Gmail/Yahoo) email via POST /v1/personal-email */
export async function findPersonalEmail(linkedinUrl: string): Promise<string | null> {
  const data = await post("/v1/personal-email", { linkedin_profile_url: linkedinUrl });
  return data.email ?? null;
}

/** Mobile phone number via POST /v1/phone */
export async function findPhone(linkedinUrl: string): Promise<string | null> {
  const data = await post("/v1/phone", { linkedin_profile_url: linkedinUrl });
  // API returns either a string or an array depending on the provider
  const raw = data.phone_numbers;
  if (!raw) return null;
  return Array.isArray(raw) ? (raw[0] ?? null) : String(raw);
}

/** Remaining credit balance via POST /v1/credits */
export async function getCreditBalance(): Promise<number | null> {
  try {
    const data = await post("/v1/credits", {});
    // Response shape: { status, response: { credits: number } }
    const n = parseInt(data.response?.credits ?? data.credits, 10);
    return isNaN(n) ? null : n;
  } catch {
    return null;
  }
}
