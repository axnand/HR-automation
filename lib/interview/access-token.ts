import { randomBytes } from "crypto";

// High-entropy capability token used as the candidate interview URL segment
// (/interview/<accessToken>). 32 bytes ≈ 256 bits of entropy — unguessable,
// the same capability-URL model as a password-reset / Calendly link. base64url
// is URL-path-safe (alphabet A–Z a–z 0–9 - _, no padding). Server-only: this
// module pulls in node:crypto and must never reach a client bundle.
// See docs/interview-flow.md §9.
export function newInterviewAccessToken(): string {
  return randomBytes(32).toString("base64url");
}
