// IMPORTANT: do NOT statically import "@/lib/ai-adapter" here. It pulls
// "@/lib/prisma" at module-eval time, and this file (lib/analyzer.ts) is
// imported by client components for the type exports + pure helpers
// (DEFAULT_CRITICAL_INSTRUCTIONS, getEffectiveRules, etc.). A static import
// would cause Prisma to be bundled for the browser, throwing
// "PrismaClient is unable to run in this browser environment" at module
// evaluation. The dynamic import below loads ai-adapter only when
// analyzeProfile actually runs, which is server-side only.

/**
 * Profile Analyzer — Ported from linkedInScraper Chrome Extension
 *
 * This module evaluates a LinkedIn profile against a Job Description
 * using an 85-point scoring rubric with 7 configurable dimensions.
 *
 * Flow:
 *   1. Deterministic pre-computation (stability, location, candidate info)
 *   2. LLM evaluation via OpenAI for remaining dimensions
 *   3. Merge both into a final scored result
 */

// ─── Types ─────────────────────────────────────────────────────────

export interface ScoringRules {
  stability?: boolean;
  growth?: boolean;
  graduation?: boolean;
  companyType?: boolean;
  mba?: boolean;
  skillMatch?: boolean;
  location?: boolean;
}

export interface CustomScoringRule {
  id: string;
  name: string;
  maxPoints: number;
  criteria: string;
  enabled: boolean;
}

export interface ScoreParameter {
  key: string;              // JSON field name e.g. "promotionSameCompany"
  label: string;            // human label e.g. "Same Company"
  allowedValuesHint: string; // rendered in prompt e.g. `<15 or "">`
  maxPoints: number;        // used for totals + sheets labels
}

export interface RuleDefinition {
  key: string;              // stable slug, e.g. "growth" or the custom rule id
  label: string;
  type: "built-in" | "custom";
  description: string;      // rule scoring prompt block; empty for pre-computed rules
  scoreParameters: ScoreParameter[];
  logFormat: string;        // instruction shown inside scoringLogs for this rule
  isPreComputed?: boolean;  // true for stability/location — skipped from LLM prompt
  resumeDescription?: string; // LLM scoring instructions used when processing uploaded resumes
}

export interface PromptEnvelope {
  /** Identity line. Tokens: {role}, {today}. */
  identityTemplate: string;
  /** Default role substituted into {role} when no override is provided. */
  defaultRole: string;
  /** Header rendered before promptGuidelines (when set). */
  guidelinesSectionHeader: string;
  /** Header rendered before customPrompt (when set). */
  recruiterContextHeader: string;
  /** Header rendered before the scoring rule blocks. */
  scoringSectionHeader: string;
  /** Full JSON response schema + footer. Tokens: {scoringFields}, {scoringLogsFields}. */
  responseSchemaTemplate: string;
}

export interface AnalysisConfig {
  jobDescription: string;
  customPrompt?: string;
  scoringRules?: ScoringRules;
  customScoringRules?: CustomScoringRule[];
  aiModel?: string;
  aiProviderId?: string;
  /** User-defined AI evaluator identity. Substituted into {role} token of identityTemplate. */
  promptRole?: string;
  /** User-defined evaluation guidelines. Injected after the critical instructions block. */
  promptGuidelines?: string;
  /** Override the default CRITICAL INSTRUCTIONS behavioral rules block. */
  criticalInstructions?: string;
  /** Legacy: override individual built-in rule descriptions. Keyed by rule key. Superseded by ruleDefinitions. */
  builtInRuleDescriptions?: Record<string, string>;
  /** Full per-rule overrides: description, scoreParameters, logFormat. Keyed by rule key. */
  ruleDefinitions?: Record<string, Partial<RuleDefinition>>;
  /** Per-field overrides for identity / section headers / response schema. */
  promptEnvelope?: Partial<PromptEnvelope>;
}

export interface CandidateInfo {
  name: string;
  btech: string;
  graduation: string;
  mba: string;
  currentOrg: string;
  currentDesignation: string;
  totalExperienceYears: number;
  companiesSwitched: number;
  stabilityAvgYears: number;
  currentLocation: string;
  graduationYear: number | null;
}

export interface CareerStats {
  distinctCompanyCount: number;
  companyTenures: Record<string, number>;
  averageTenureYears: number;
  averageTenureMonths: number;
  stabilityScore: number;
  totalExperienceYears: number;
  jobSwitchCount: number;
}

export interface AnalysisResult {
  candidateInfo: CandidateInfo;
  scoring: Record<string, number | string>;
  scoringLogs: Record<string, string>;
  enabledRules?: ScoringRules;
  maxScore: number;
  totalScore: number;
  scorePercent: number;
  recommendation: string;
  customScoringRules: CustomScoringRule[];
  remarks: string;
  experienceSummary: string;
  skillBreakdown: {
    matchedSkills: string[];
    missingSkills: string[];
    matchPercent: number;
  } | null;
  strengths: string[];
  gaps: string[];
  flags: string[];
  __debug?: {
    systemPrompt: string;
    userPrompt: string;
    model: string;
    usage: any;
    preComputed: Record<string, any>;
  };
}

// ─── Constants ─────────────────────────────────────────────────────

const BTECH_KEYWORDS = [
  "b.tech", "btech", "b tech", "bachelor of technology",
  "b.e.", "b.e", "bachelor of engineering",
];

const MBA_KEYWORDS = [
  "mba", "pgdm", "master of business administration",
  "post graduate diploma in management",
];

// ─── Built-in Rule Order (controls display + prompt order) ────────

const BUILT_IN_RULE_ORDER = ["stability", "growth", "graduation", "companyType", "mba", "skillMatch", "location"] as const;

// ─── Default Rule Definitions (source of truth for all defaults) ──

export const DEFAULT_RULE_DEFINITIONS: Record<string, RuleDefinition> = {
  stability: {
    key: "stability",
    label: "Stability",
    type: "built-in",
    description: "",
    isPreComputed: true,
    scoreParameters: [
      { key: "stability", label: "Stability", allowedValuesHint: "<10 or 7 or 0>", maxPoints: 10 },
    ],
    logFormat: "<1-2 sentences: list companies and approximate tenures you found, average tenure you calculated, and the score>",
    resumeDescription: `STABILITY (Max: 10) — From the raw resume text, identify all full-time roles (ignore internships, trainee, part-time, volunteer). Calculate average tenure per employer.
   - Avg tenure > 2.5 years → stability=10
   - Avg tenure 1.5–2.5 years → stability=7
   - Avg tenure < 1.5 years → stability=0`,
  },
  growth: {
    key: "growth",
    label: "Growth",
    type: "built-in",
    description: `**GROWTH (Max: 15) — MUTUALLY EXCLUSIVE**

**Scope**
* Use ONLY full-time roles
* Ignore internships, trainee, part-time

---

**Seniority (low → high)**
Executive/Associate → Senior Executive/Specialist → Lead/Team Lead → Manager/Assistant Manager → Senior Manager → Director/AVP → VP/Head → CXO/Partner

---

**Rules**
* Sort roles chronologically
* Compare each role with previous full-time role only
* Map titles to ladder; if unclear → IGNORE (no guessing)

**Growth Types**
* Internal: same company + higher level
* External: new company + higher level
* Same level → NOT growth

---

**Scoring**
* Any internal → promotionSameCompany=15, promotionWithChange=""
* Else if any external → promotionSameCompany="", promotionWithChange=10
* Else → both ""

---

**Default**
Any ambiguity → NO growth

---

**Output**
{"promotionSameCompany":<15 or "">,"promotionWithChange":<10 or "">}`,
    scoreParameters: [
      { key: "promotionSameCompany", label: "Same Company", allowedValuesHint: '<15 or "">', maxPoints: 15 },
      { key: "promotionWithChange", label: "With Change", allowedValuesHint: '<10 or "">', maxPoints: 10 },
    ],
    logFormat: "<1-2 sentence: what evidence you found (or didn't), which sub-rule triggered, why this score>",
  },
  graduation: {
    key: "graduation",
    label: "Graduation",
    type: "built-in",
    description: `GRADUATION (Max: 15) — MUTUALLY EXCLUSIVE — Evaluate ONLY the UNDERGRADUATE degree. Do NOT use the MBA/PGDM institution here — MBA is scored separately.

   YOU MUST FOLLOW THESE TWO STEPS IN ORDER:

   STEP 1 — CLASSIFY THE DEGREE TYPE:
   - "BTech/BE-equivalent" means: BTech, B.Tech, BE, B.E., BS/BSc in Computer Science or Engineering (4-year engineering/technology degrees).
   - For 5-year integrated / Dual Degree programs, classify based on the UNDERGRADUATE component of the degree:
     * If the undergrad component is BTech/BE/Engineering (e.g., B.Tech + M.Tech, B.Tech + MBA, B.E. + MS) → classify as BTech/BE-equivalent
     * If the undergrad component is non-engineering (e.g., Integrated MBA, Integrated MCA, B.Sc + M.Sc, BBA + MBA) → classify as Non-BTech
     * When the degree title does not clearly state both components, look at the FIRST degree listed — that is the undergraduate component.
   - "Non-BTech" means ALL other undergrad degrees: BCA, BBA, BCom, BA, BSc (non-CS/non-engineering), B.Sc IT, BMS, Management, Finance, Arts, Integrated MBA, Integrated MCA, etc. These are NOT equivalent to BTech/BE even if the institution is prestigious.
   - RULE: The classification follows the undergraduate component, not the postgraduate one. A B.Tech + MBA Dual Degree is BTech/BE-equivalent because the undergraduate part is B.Tech.

   STEP 2 — CLASSIFY THE INSTITUTION TIER, THEN LOOK UP SCORE:
   **STRICT TIER CLASSIFICATION RULES (DO NOT GUESS)**

   **Tier 1 (ONLY)**
   * India: IITs, NITs, IIITs, BITS Pilani, top DU colleges
   * Global: Top globally elite universities (e.g., Ivy League, Oxford, Cambridge, MIT, Stanford)

   **Tier 2 (ONLY)**
   * India: Well-known government/state universities and top private institutes (e.g., VIT, SRM, Manipal)
   * Global: Well-known, reputable universities with strong academic standing but NOT elite (e.g., top public universities, Russell Group except Oxbridge)

   **Neither**
   * ALL other institutions (including most private universities)

   **DEFAULT RULE (CRITICAL)**
   If the institution is not **clearly and confidently identifiable** as Tier 1 or Tier 2:
   → classify as **Neither**
   DO NOT infer tier from vague reputation, partial familiarity, or assumptions. When in doubt → ALWAYS "Neither".

   SCORE LOOKUP TABLE (degree type × institution tier):
   | Degree Type  | Tier 1 Institution | Tier 2 Institution | Neither |
   |-------------|-------------------|-------------------|---------|
   | BTech/BE    | gradTier1=15      | gradTier2=10      | both "" |
   | Non-BTech   | gradTier1=7       | gradTier2=5       | both "" |

   IMPORTANT: Non-BTech from Tier 2 is ALWAYS 5, never 10. Only BTech/BE from Tier 2 gets 10. If the degree is BBA, BCom, BMS, Management, Finance, Integrated MBA, Integrated MCA, or anything other than BTech/BE/BS-Engineering, the maximum possible Tier 2 score is 5. For Dual Degree programs, classify by the undergraduate component: B.Tech + M.Tech and B.Tech + MBA both follow the BTech/BE row; Integrated MBA and BBA + MBA follow the Non-BTech row.`,
    scoreParameters: [
      { key: "gradTier1", label: "Tier 1", allowedValuesHint: '<15 or 7 or "">', maxPoints: 15 },
      { key: "gradTier2", label: "Tier 2", allowedValuesHint: '<10 or 5 or "">', maxPoints: 10 },
    ],
    logFormat: "<MUST state: 1) degree name, 2) undergraduate component identified, 3) BTech/BE or Non-BTech classification, 4) institution name, 5) Tier 1/Tier 2/Neither, 6) score from lookup table. Examples: 'BBA (Non-BTech) from De La Salle University (Tier 2) → gradTier2=5', 'B.Tech + M.Tech Dual Degree (undergrad=B.Tech → BTech/BE-equivalent) from IIT Bombay (Tier 1) → gradTier1=15', 'B.Tech + MBA Dual Degree (undergrad=B.Tech → BTech/BE-equivalent) from VIT (Tier 2) → gradTier2=10'>",
  },
  companyType: {
    key: "companyType",
    label: "Company Type",
    type: "built-in",
    description: `COMPANY TYPE (Max: 15) — MUTUALLY EXCLUSIVE, based on CURRENT/most recent company
   - Product B2B Retail/CRM/SalesTech company → salesCRM=15, otherB2B=""
   - Product B2B SaaS non-CRM (cloud, infra, developer tools, data platforms, HR tech, fintech B2B, AI/ML platforms, cybersecurity, analytics) → salesCRM="", otherB2B=10
   - Service-based/IT consulting company → salesCRM="", otherB2B=7
   - Product B2C or unrelated → both ""
   Use your knowledge to classify the company. If the company name or candidate's role strongly implies a B2B SaaS product company (e.g. selling software to businesses), classify it as B2B SaaS even if you are not 100% familiar with the company. Do NOT default to 0 when there is reasonable evidence — score based on the best available classification.
   Examples for reference only: Salesforce/HubSpot/Zoho/Freshworks = B2B SalesTech/CRM, AWS/Atlassian/Datadog/Snowflake/Darktrace/FieldAssist/LeadSquared = B2B SaaS non-CRM, TCS/Infosys/Wipro/Accenture = Service-based, Swiggy/Netflix/Zomato = B2C.`,
    scoreParameters: [
      { key: "salesCRM", label: "Sales/CRM", allowedValuesHint: '<15 or "">', maxPoints: 15 },
      { key: "otherB2B", label: "Other B2B", allowedValuesHint: '<10 or 7 or "">', maxPoints: 10 },
    ],
    logFormat: "<1-2 sentence: company name, why classified as this type, which sub-rule>",
  },
  mba: {
    key: "mba",
    label: "MBA",
    type: "built-in",
    description: `MBA (Max: 15) — MUTUALLY EXCLUSIVE
   - MBA/PGDM from Tier 1 institution → mbaA=15, mbaOthers=""
   - MBA/PGDM from other institution → mbaA="", mbaOthers=10
   - No MBA/PGDM → both ""
   Use your knowledge to classify the MBA institution as Tier 1 (premier national/global business schools) or other.`,
    scoreParameters: [
      { key: "mbaA", label: "MBA Tier 1", allowedValuesHint: '<15 or "">', maxPoints: 15 },
      { key: "mbaOthers", label: "MBA Others", allowedValuesHint: '<10 or "">', maxPoints: 10 },
    ],
    logFormat: "<1-2 sentence: State the MBA/PGDM institution name and tier, OR state 'No MBA/PGDM found in the candidate profile'. NEVER output empty strings or raw score values here — always write a human-readable explanation>",
  },
  skillMatch: {
    key: "skillMatch",
    label: "Skill Match",
    type: "built-in",
    description: `SKILLSET MATCH (Max: 10) — First extract the KEY SKILLS/COMPETENCIES required by the Job Description (e.g. lead generation, CRM, B2B SaaS, ABM, sales tools, domain expertise, languages, certifications, etc.). Then check which of those JD-required skills the candidate actually possesses based on their experience, education, skills section, and certifications. Do NOT just list the candidate's own LinkedIn skills — compare candidate capabilities against what the JD asks for.
   - >70% of JD-required skills/competencies matched → 10
   - 40-70% matched → 5
   - <40% matched → 0`,
    scoreParameters: [
      { key: "skillsetMatch", label: "Skill Match", allowedValuesHint: "<0 or 5 or 10>", maxPoints: 10 },
    ],
    logFormat: "<1-2 sentence: list which JD-required skills/competencies the candidate has vs lacks, then match %>",
  },
  location: {
    key: "location",
    label: "Location",
    type: "built-in",
    description: "",
    isPreComputed: true,
    scoreParameters: [
      { key: "locationMatch", label: "Location", allowedValuesHint: "<5 or 0>", maxPoints: 5 },
    ],
    logFormat: "<1 sentence: state the candidate location you found and whether it matches the JD location>",
    resumeDescription: `LOCATION (Max: 5) — Find the candidate's city/country from the resume header or contact section. Compare it against the job's required location.
   - Candidate location matches job location (same city, metro area, or country when the role is country-wide) → locationMatch=5
   - No match or location not found → locationMatch=0`,
  },
};

// ─── Default Prompt Envelope ──────────────────────────────────────

export const DEFAULT_PROMPT_ENVELOPE: PromptEnvelope = {
  identityTemplate: "{role} Treat recent or current dates as valid, not typos. Score the candidate using ONLY the rules below. Stability, location, and candidate info are pre-computed — do NOT evaluate them.",
  defaultRole: "You are a strict ATS evaluator.",
  guidelinesSectionHeader: "ADDITIONAL EVALUATION GUIDELINES (follow these strictly in all scoring decisions):",
  recruiterContextHeader: "RECRUITER CONTEXT (for this specific job — use to guide ALL scoring decisions below):",
  scoringSectionHeader: `SCORING RULES (mutually exclusive pairs: fill ONE, leave other as ""):`,
  responseSchemaTemplate: `Respond with ONLY valid JSON (no markdown, no code fences):
{
  "scoring": {
{scoringFields}
  },
  "scoringLogs": {
{scoringLogsFields}
  },
  "skillBreakdown": {
    "matchedSkills": ["<skill/competency REQUIRED BY THE JD that candidate HAS>", ...],
    "missingSkills": ["<skill/competency REQUIRED BY THE JD that candidate LACKS>", ...],
    "matchPercent": <integer 0-100>
  },
  "remarks": "<concise overall reasoning — reference any disqualifiers found>",
  "experienceSummary": "<2-3 sentence career summary>",
  "strengths": ["<string>", ...],
  "gaps": ["<string>", ...],
  "flags": ["<ONLY genuine disqualifiers — hard JD requirements candidate clearly fails. Empty array [] if none>", ...]
}

Be strict and evidence-based. Do NOT assume missing data. Do NOT give benefit of the doubt.`,
};

// Legacy export for backward compat (used by ScoringRulesTab to populate default description)
export const DEFAULT_RULE_PROMPTS: Record<string, string> = Object.fromEntries(
  Object.entries(DEFAULT_RULE_DEFINITIONS)
    .filter(([, d]) => !d.isPreComputed)
    .map(([k, d]) => [k, d.description])
);

// ─── Location Matching (Deterministic) ────────────────────────────

const LOCATION_STOP_WORDS = new Set([
  "area", "region", "metro", "greater", "district", "province", "state",
  "city", "county", "metropolitan", "remote", "hybrid", "onsite", "on-site",
  "based", "office", "hq", "headquarters",
]);

function extractLocationTokens(text: string): string[] {
  if (!text) return [];
  return text
    .toLowerCase()
    .split(/[\s,|/\-–—()]+/)
    .map((t) => t.trim().replace(/[^a-z]/g, ""))
    .filter((t) => t.length > 1 && !LOCATION_STOP_WORDS.has(t));
}

function scoreLocationMatch(candidateLocation: string, jobDescription: string): number {
  if (!candidateLocation || !jobDescription) return 0;

  const jdLocMatch = jobDescription.match(/Location\s*[:：]\s*(.+?)(?:\n|$)/i);
  const jdLocText = jdLocMatch ? jdLocMatch[1] : jobDescription;

  const candidateTokens = extractLocationTokens(candidateLocation);
  const jdTokens = extractLocationTokens(jdLocText);

  if (!candidateTokens.length || !jdTokens.length) return 0;

  for (const token of candidateTokens) {
    if (jdTokens.some((jt) => jt.includes(token) || token.includes(jt))) return 5;
  }
  return 0;
}

// ─── Career Stats Computation (Deterministic) ─────────────────────

function parseMonthYear(start: string | null, end: string | null): { months: number } {
  if (!start) return { months: 0 };
  const parseDate = (s: string) => {
    // Handle "M/D/YYYY" format from Unipile
    const parts = s.split("/");
    if (parts.length === 3) {
      return { month: parseInt(parts[0], 10), year: parseInt(parts[2], 10) };
    }
    return null;
  };

  const startDate = parseDate(start);
  if (!startDate) return { months: 0 };

  let endDate: { month: number; year: number };
  if (end) {
    const parsed = parseDate(end);
    if (parsed) {
      endDate = parsed;
    } else {
      endDate = { month: new Date().getMonth() + 1, year: new Date().getFullYear() };
    }
  } else {
    endDate = { month: new Date().getMonth() + 1, year: new Date().getFullYear() };
  }

  const months = (endDate.year - startDate.year) * 12 + (endDate.month - startDate.month);
  return { months: Math.max(months, 0) };
}

export function computeCareerStats(workExperience: any[]): CareerStats {
  if (!workExperience || workExperience.length === 0) {
    return {
      distinctCompanyCount: 0,
      companyTenures: {},
      averageTenureYears: 0,
      averageTenureMonths: 0,
      stabilityScore: 0,
      totalExperienceYears: 0,
      jobSwitchCount: 0,
    };
  }

  const companyTenureMap: Record<string, number> = {};
  let totalMonths = 0;

  for (const exp of workExperience) {
    const company = (exp.company || "Unknown").trim();
    const { months } = parseMonthYear(exp.start, exp.end);
    totalMonths += months;
    companyTenureMap[company] = (companyTenureMap[company] || 0) + months;
  }

  const companyNames = Object.keys(companyTenureMap);
  const distinctCompanyCount = companyNames.length;
  const avgTenureMonths = distinctCompanyCount > 0
    ? Math.round((totalMonths / distinctCompanyCount) * 10) / 10
    : 0;
  const avgTenureYears = Math.round((avgTenureMonths / 12) * 10) / 10;
  const totalYears = Math.round((totalMonths / 12) * 10) / 10;

  let stabilityScore = 0;
  if (avgTenureYears > 2.5) stabilityScore = 10;
  else if (avgTenureYears >= 1.5) stabilityScore = 7;
  else stabilityScore = 0;

  const companyTenures: Record<string, number> = {};
  for (const [c, m] of Object.entries(companyTenureMap)) {
    companyTenures[c] = Math.round((m / 12) * 10) / 10;
  }

  return {
    distinctCompanyCount,
    companyTenures,
    averageTenureYears: avgTenureYears,
    averageTenureMonths: avgTenureMonths,
    stabilityScore,
    totalExperienceYears: totalYears,
    jobSwitchCount: Math.max(0, distinctCompanyCount - 1),
  };
}

// ─── Candidate Info Extraction (Deterministic) ────────────────────

function extractCandidateInfo(profileData: any): CandidateInfo {
  // ── Resume / plain-text mode ──
  // When a PDF resume is uploaded, profileData is { resumeText, sourceFileName, extractedInfo?, work_experience? }.
  // Regex-extracted fields (from the LinkedIn PDF header) take precedence; anything we
  // couldn't pluck out is left blank and the AI fills it in from the raw text.
  if (profileData?.resumeText) {
    const ex = profileData.extractedInfo || {};
    const careerStats = computeCareerStats(profileData.work_experience || []);
    return {
      name: ex.name || profileData.sourceFileName?.replace(/\.pdf$/i, "") || "Unknown",
      btech: "",
      graduation: "",
      mba: "",
      currentOrg: ex.currentOrg || "",
      currentDesignation: ex.currentDesignation || "",
      totalExperienceYears: careerStats.totalExperienceYears,
      companiesSwitched: careerStats.jobSwitchCount,
      stabilityAvgYears: careerStats.averageTenureYears,
      currentLocation: ex.currentLocation || "",
      graduationYear: null,
    };
  }

  const education = profileData.education || [];
  const experience = profileData.work_experience || [];

  // Find BTech/BE entry
  let btechStr = "";
  for (const edu of education) {
    const degree = (edu.degree || "").toLowerCase();
    if (BTECH_KEYWORDS.some((k) => degree.includes(k))) {
      btechStr = [edu.school, edu.degree].filter(Boolean).join(", ");
      break;
    }
  }

  // Find MBA/PGDM entry
  let mbaStr = "";
  for (const edu of education) {
    const degree = (edu.degree || "").toLowerCase();
    if (MBA_KEYWORDS.some((k) => degree.includes(k))) {
      mbaStr = [edu.school, edu.degree].filter(Boolean).join(", ");
      break;
    }
  }

  // Current role
  const currentRole = experience[0] || {};

  // Graduation year
  let graduationYear: number | null = null;
  for (const edu of education) {
    const endDate = edu.end;
    if (endDate) {
      const yearMatches = String(endDate).match(/(\d{4})/g);
      if (yearMatches?.length) {
        const lastYear = Math.max(...yearMatches.map(Number));
        if (!graduationYear || lastYear < graduationYear) graduationYear = lastYear;
      }
    }
  }

  // Generic graduation entry (non-MBA, non-BTech)
  let gradStr = "";
  if (!btechStr) {
    for (const edu of education) {
      const degree = (edu.degree || "").toLowerCase();
      if (!MBA_KEYWORDS.some((k) => degree.includes(k))) {
        gradStr = [edu.school, edu.degree].filter(Boolean).join(", ");
        break;
      }
    }
  }

  const careerStats = computeCareerStats(experience);

  return {
    name: `${profileData.first_name || ""} ${profileData.last_name || ""}`.trim(),
    btech: btechStr,
    graduation: gradStr,
    mba: mbaStr,
    currentOrg: currentRole.company || "",
    currentDesignation: currentRole.position || "",
    totalExperienceYears: careerStats.totalExperienceYears,
    companiesSwitched: careerStats.jobSwitchCount,
    stabilityAvgYears: careerStats.averageTenureYears,
    currentLocation: profileData.location || "",
    graduationYear,
  };
}

// ─── Coerce Utility ──────────────────────────────────────────────

function coerce(v: any): number | string {
  if (v === "" || v == null) return "";
  const n = Number(v);
  return Number.isNaN(n) ? "" : n;
}

// ─── JD Pre-Parser ───────────────────────────────────────────────

function parseJobDescription(jdText: string) {
  if (!jdText) return { raw: "" };
  const parsed: any = { raw: jdText };

  const expMatch =
    jdText.match(/(\d+)\s*[-–to]+\s*(\d+)\s*(?:years?|yrs?)/i) ||
    jdText.match(/(\d+)\+?\s*(?:years?|yrs?)\s*(?:of\s+)?experience/i);
  if (expMatch) {
    parsed.experienceRange = expMatch[2]
      ? `${expMatch[1]}-${expMatch[2]} years`
      : `${expMatch[1]}+ years`;
  }

  const locMatch = jdText.match(/Location\s*[:：]\s*(.+?)(?:\n|$)/i);
  if (locMatch) parsed.location = locMatch[1].trim();

  const eduMatch = jdText.match(/Education\s*[:：]\s*(.+?)(?:\n|$)/i);
  if (eduMatch) parsed.education = eduMatch[1].trim();

  const indMatch = jdText.match(/Industry\s*(?:Type)?\s*[:：]\s*(.+?)(?:\n|$)/i);
  if (indMatch) parsed.industry = indMatch[1].trim();

  const funcMatch = jdText.match(/Functional\s*Area\s*[:：]\s*(.+?)(?:\n|$)/i);
  if (funcMatch) parsed.functionalArea = funcMatch[1].trim();

  const roleMatch = jdText.match(/(?:Role|Designation)\s*[:：]\s*(.+?)(?:\n|$)/i);
  if (roleMatch) parsed.role = roleMatch[1].trim();

  return parsed;
}

// ─── Default Critical Instructions ───────────────────────────────

export const DEFAULT_CRITICAL_INSTRUCTIONS = `CRITICAL INSTRUCTIONS:
1. Your scoring values and scoringLogs MUST be consistent. If your log says an institution is "Tier 1", the score MUST reflect Tier 1 points. If your log says "assign X marks", the score MUST be exactly X. Never contradict yourself — the numeric score must EXACTLY match what your reasoning concludes.
2. Be strict and evidence-based. Do NOT assume, infer, or give benefit of the doubt for missing data. If information is not present, treat it as absent.
3. DISQUALIFIER CHECK: Before scoring, identify any hard requirements in the JD that the candidate clearly FAILS to meet. BE PRECISE — only flag genuine failures:
   - For experience ranges (e.g. "7-15 years"): only flag if candidate is OUTSIDE the range. 8.3 years IS within 7-15, so that is NOT a disqualifier. Only flag if below minimum or above maximum.
   - For mandatory skills: only flag if the skill is explicitly "required"/"mandatory" AND completely absent from the profile.
   - Do NOT flag items that are "preferred" or "nice to have" as disqualifiers.
   List genuine disqualifiers in "flags". If there are none, return an empty array.`;

// ─── Effective Rule Builder ───────────────────────────────────────

/**
 * Returns the merged list of RuleDefinitions for a job config.
 * Built-in rules are taken in canonical order; custom rules appended.
 * Each rule carries its enabled flag resolved from scoringRules toggles.
 */
export function getEffectiveRules(opts: {
  scoringRules?: ScoringRules;
  customScoringRules?: CustomScoringRule[];
  builtInRuleDescriptions?: Record<string, string>;
  ruleDefinitions?: Record<string, Partial<RuleDefinition>>;
}): Array<RuleDefinition & { enabled: boolean }> {
  const results: Array<RuleDefinition & { enabled: boolean }> = [];

  for (const key of BUILT_IN_RULE_ORDER) {
    const base = DEFAULT_RULE_DEFINITIONS[key];
    const override = opts.ruleDefinitions?.[key] || {};
    const legacyDesc = opts.builtInRuleDescriptions?.[key];
    const enabled = (opts.scoringRules as any)?.[key] !== false;

    results.push({
      ...base,
      ...override,
      key,
      description: override.description ?? legacyDesc ?? base.description,
      scoreParameters: override.scoreParameters ?? base.scoreParameters,
      logFormat: override.logFormat ?? base.logFormat,
      enabled,
    });
  }

  for (const r of (opts.customScoringRules || [])) {
    const override = opts.ruleDefinitions?.[r.id] || {};
    results.push({
      key: r.id,
      label: override.label ?? r.name,
      type: "custom",
      description: override.description ?? r.criteria,
      isPreComputed: false,
      scoreParameters: override.scoreParameters ?? [
        {
          key: `custom_${r.id}`,
          label: override.label ?? r.name,
          allowedValuesHint: `<0 to ${r.maxPoints} integer>`,
          maxPoints: r.maxPoints,
        },
      ],
      logFormat: override.logFormat ?? `<1-2 sentence: evidence and reasoning for ${r.name} score>`,
      enabled: r.enabled,
    });
  }

  return results;
}

/** Max points for a rule = max of its score parameter maxPoints (handles mutex pairs correctly). */
function ruleMax(rule: RuleDefinition): number {
  return Math.max(0, ...rule.scoreParameters.map((p) => p.maxPoints));
}

// ─── Prompt Builders ─────────────────────────────────────────────

/**
 * Assembles the full system prompt from 4 layers:
 *   1. Identity (configurable via promptRole + identityTemplate)
 *   2. Behavioral rules (built-in + user guidelines + recruiter context)
 *   3. Scoring rules (auto-generated from enabled rule definitions)
 *   4. JSON output schema (from responseSchemaTemplate with dynamic field injection)
 */
export function buildSystemPrompt(
  scoringRules: ScoringRules,
  customScoringRules: CustomScoringRule[],
  options?: {
    customPrompt?: string;
    promptRole?: string;
    promptGuidelines?: string;
    criticalInstructions?: string;
    builtInRuleDescriptions?: Record<string, string>;
    ruleDefinitions?: Record<string, Partial<RuleDefinition>>;
    promptEnvelope?: Partial<PromptEnvelope>;
    resumeMode?: boolean;
  }
): string {
  const opts = options || {};
  const envelope: PromptEnvelope = { ...DEFAULT_PROMPT_ENVELOPE, ...opts.promptEnvelope };
  const resumeMode = opts.resumeMode ?? false;

  const allRules = getEffectiveRules({
    scoringRules,
    customScoringRules,
    builtInRuleDescriptions: opts.builtInRuleDescriptions,
    ruleDefinitions: opts.ruleDefinitions,
  });
  const enabledRules = allRules.filter((r) => r.enabled);

  // ── SECTION 1: Identity ──
  const today = new Date().toISOString().split("T")[0];
  const role = opts.promptRole?.trim() || envelope.defaultRole;
  let identity = envelope.identityTemplate
    .replace("{role}", role)
    .replace("{today}", today);

  // For resume uploads the LLM scores stability + location from raw text — remove the
  // "pre-computed, do not evaluate" line and tell it to score everything.
  if (resumeMode) {
    identity = identity.replace(
      /\s*Stability, location, and candidate info are pre-computed[^.]*\./i,
      " Score ALL rules below including Stability and Location by reading the raw resume text."
    );
  }

  // ── SECTION 2: Behavioral instructions ──
  let behavior = opts.criticalInstructions?.trim() || DEFAULT_CRITICAL_INSTRUCTIONS;

  if (opts.promptGuidelines?.trim()) {
    behavior += `\n\n${envelope.guidelinesSectionHeader}\n${opts.promptGuidelines.trim()}`;
  }
  if (opts.customPrompt?.trim()) {
    behavior += `\n\n${envelope.recruiterContextHeader}\n${opts.customPrompt.trim()}`;
  }

  // ── SECTION 3: Scoring rules ──
  // In resume mode, pre-computed rules (stability, location) are included using their
  // resumeDescription so the LLM can score them from the raw text.
  let ruleNum = 0;
  const allRulesText = enabledRules
    .filter((r) => {
      if (resumeMode && r.resumeDescription) return true; // include in resume mode
      return !r.isPreComputed && r.description.trim();
    })
    .map((r) => {
      ruleNum++;
      const desc = resumeMode && r.resumeDescription ? r.resumeDescription : r.description;
      return `${ruleNum}. ${desc}`;
    })
    .join("\n\n");

  // ── SECTION 4: JSON output schema ──
  const scoringFields = enabledRules
    .filter((r) => resumeMode ? (r.resumeDescription || !r.isPreComputed) : !r.isPreComputed)
    .flatMap((r) => r.scoreParameters.map((p) => `    "${p.key}": ${p.allowedValuesHint}`))
    .join(",\n");

  const logsFields = enabledRules
    .filter((r) => {
      if (resumeMode && r.resumeDescription) return r.logFormat.trim() !== "";
      return !r.isPreComputed && r.logFormat.trim();
    })
    .map((r) => `    "${r.key}": "${r.logFormat}"`)
    .join(",\n");

  const jsonBlock = envelope.responseSchemaTemplate
    .replace("{scoringFields}", scoringFields)
    .replace("{scoringLogsFields}", logsFields);

  return `${identity}\n\n${behavior}\n\n${envelope.scoringSectionHeader}\n\n${allRulesText}\n\n${jsonBlock}`;
}

export function buildUserPrompt(profileData: any, jobDescription: string, candidateInfo: CandidateInfo): string {
  // Date footer is appended at the very end of the user prompt so it sits outside the cacheable
  // prefix (system + JD + candidate data). Keeping the date out of the system prompt is what lets
  // OpenAI's prompt cache stay valid for the whole batch — see lib/analyzer.ts identityTemplate.
  const dateFooter = `\n---\nToday's date is ${new Date().toISOString().split("T")[0]}.\n`;

  // ── Resume / plain-text mode ──
  // profileData comes from an uploaded PDF: { resumeText, sourceFileName }
  if (profileData?.resumeText) {
    let prompt = `## Job Description\n${jobDescription}\n\n`;
    prompt += `## Candidate Resume\n`;
    prompt += `**File:** ${profileData.sourceFileName || "Unknown"}\n\n`;
    prompt += `### Raw Resume Text\n`;
    prompt += `${profileData.resumeText}\n\n`;
    prompt += `---\n`;
    prompt += `NOTE: This candidate was sourced from an uploaded resume/LinkedIn PDF export, not a live LinkedIn scrape.\n`;
    prompt += `Extract all relevant information (name, company, role, experience, education, skills) DIRECTLY from the raw text above.\n`;
    prompt += `Score ALL rules (including Stability and Location) by reading the raw resume text directly.\n`;
    return prompt + dateFooter;
  }

  const jd = parseJobDescription(jobDescription);

  let prompt = `## Job Description\n`;
  const meta: string[] = [];
  if (jd.role) meta.push(`**Role:** ${jd.role}`);
  if (jd.experienceRange) meta.push(`**Required Experience:** ${jd.experienceRange}`);
  if (jd.location) meta.push(`**Location:** ${jd.location}`);
  if (jd.education) meta.push(`**Education:** ${jd.education}`);
  if (jd.industry) meta.push(`**Industry:** ${jd.industry}`);
  if (jd.functionalArea) meta.push(`**Functional Area:** ${jd.functionalArea}`);

  if (meta.length) {
    prompt += `### Key Requirements (extracted)\n${meta.join("\n")}\n\n`;
    prompt += `### Full JD Text\n${jobDescription}\n\n`;
  } else {
    prompt += `${jobDescription}\n\n`;
  }

  prompt += `## Candidate Profile\n\n`;
  prompt += `**Name:** ${profileData.first_name || ""} ${profileData.last_name || ""}\n`;
  prompt += `**Headline:** ${profileData.headline || "N/A"}\n`;
  prompt += `**Location:** ${profileData.location || "N/A"}\n`;

  const careerStats = computeCareerStats(profileData.work_experience || []);
  prompt += `**Total Experience:** ${careerStats.totalExperienceYears} years | **Companies:** ${careerStats.distinctCompanyCount}\n\n`;

  // About / Summary
  if (profileData.summary) {
    prompt += `### About\n${profileData.summary}\n\n`;
  }

  // Experience (grouped by company to make promotions obvious)
  prompt += `### Experience\n`;
  const experience = profileData.work_experience || [];
  if (experience.length) {
    // Group consecutive roles at the same company
    const groups: { company: string; roles: any[] }[] = [];
    let current: { company: string; roles: any[] } | null = null;
    for (const exp of experience) {
      const company = (exp.company || "Unknown").trim();
      if (current && current.company === company) {
        current.roles.push(exp);
      } else {
        current = { company, roles: [exp] };
        groups.push(current);
      }
    }

    let idx = 1;
    for (const g of groups) {
      if (g.roles.length > 1) {
        prompt += `**${g.company}** (${g.roles.length} roles — check for internal promotion):\n`;
        for (const exp of g.roles) {
          const duration = exp.start
            ? `${exp.start} – ${exp.end || "Present"}`
            : "N/A";
          prompt += `  ${idx}. ${exp.position || "Unknown"} (${duration})\n`;
          if (exp.description) prompt += `     ${exp.description.substring(0, 200)}\n`;
          idx++;
        }
      } else {
        const exp = g.roles[0];
        const duration = exp.start
          ? `${exp.start} – ${exp.end || "Present"}`
          : "N/A";
        prompt += `${idx}. **${exp.position || "Unknown"}** at **${g.company}** (${duration})\n`;
        if (exp.description) prompt += `   ${exp.description.substring(0, 200)}\n`;
        idx++;
      }
    }
    prompt += "\n";
  } else {
    prompt += "Not available — check raw data below.\n\n";
  }

  // Education
  prompt += `### Education\n`;
  const education = profileData.education || [];
  if (education.length) {
    education.forEach((edu: any, i: number) => {
      prompt += `${i + 1}. **${edu.school || "Unknown"}**\n`;
      prompt += `   Degree: ${edu.degree || "N/A"}\n`;
      if (edu.field) prompt += `   Field: ${edu.field}\n`;
      if (edu.start || edu.end) prompt += `   Years: ${edu.start || "?"} – ${edu.end || "Present"}\n`;
      prompt += "\n";
    });
  } else {
    prompt += "Not available — check raw data below.\n\n";
  }

  // Pre-extracted education info
  if (candidateInfo) {
    const eduNotes: string[] = [];
    if (candidateInfo.btech) eduNotes.push(`BTech/BE: ${candidateInfo.btech}`);
    if (candidateInfo.graduation) eduNotes.push(`Graduation: ${candidateInfo.graduation}`);
    if (candidateInfo.mba) eduNotes.push(`MBA: ${candidateInfo.mba}`);
    if (candidateInfo.graduationYear) eduNotes.push(`Graduation Year: ${candidateInfo.graduationYear}`);
    if (eduNotes.length) {
      prompt += `### Pre-extracted Education Details\n${eduNotes.join("\n")}\n\n`;
    }
  }

  // Skills
  prompt += `### Skills\n`;
  const skills = profileData.skills || [];
  if (skills.length) {
    const skillNames = skills.map((s: any) => (typeof s === "string" ? s : s.name)).filter(Boolean);
    prompt += skillNames.join(", ") + "\n\n";
  } else {
    prompt += "Not available — check raw data below.\n\n";
  }

  // Certifications (compact — useful for qualitative)
  const certifications = profileData.certifications || [];
  if (certifications.length) {
    const certNames = certifications
      .map((c: any) => (typeof c === "string" ? c : `${c.name}${c.organization ? ` (${c.organization})` : ""}`))
      .filter(Boolean);
    prompt += `### Certifications\n${certNames.join(", ")}\n\n`;
  }

  return prompt + dateFooter;
}

// ─── Main Analysis Function ──────────────────────────────────────

export async function analyzeProfile(
  profileData: any,
  config: AnalysisConfig
): Promise<AnalysisResult> {
  if (!config.jobDescription) throw new Error("No job description provided for analysis.");

  const rules: ScoringRules = config.scoringRules || {};
  const customRules: CustomScoringRule[] = config.customScoringRules || [];

  // ── Pass 1: Deterministic pre-extraction ──
  const isResumeMode = !!profileData?.resumeText;
  const candidateInfo = extractCandidateInfo(profileData);
  const careerStats = computeCareerStats(profileData.work_experience || []);

  // Pre-compute stability + location as a fallback (authoritative for LinkedIn scrapes).
  // For resume uploads these serve as fallback only — the LLM scores them from raw text.
  const stabilityPreComputed =
    (rules.stability !== false && careerStats) ? careerStats.stabilityScore : "";
  const locationPreComputed =
    rules.location !== false
      ? scoreLocationMatch(profileData.location || "", config.jobDescription)
      : "";

  // Pre-computed logs (used for non-resume mode; resume mode uses LLM logs)
  const preComputedLogs: Record<string, string> = {};
  if (!isResumeMode) {
    if (rules.stability !== false && careerStats) {
      const avg = careerStats.averageTenureYears;
      preComputedLogs.stability =
        avg > 2.5
          ? `Avg tenure ${avg} yrs (>2.5) across ${careerStats.distinctCompanyCount} companies → 10/10`
          : avg >= 1.5
            ? `Avg tenure ${avg} yrs (1.5–2.5) across ${careerStats.distinctCompanyCount} companies → 7/10`
            : `Avg tenure ${avg} yrs (<1.5) across ${careerStats.distinctCompanyCount} companies → 0/10`;
    }
    if (rules.location !== false) {
      preComputedLogs.location =
        locationPreComputed === 5
          ? `Candidate location "${profileData.location}" matches JD location → 5/5`
          : `Candidate location "${profileData.location || "unknown"}" does not match JD location → 0/5`;
    }
  }

  console.log("[Analyzer] Pre-computed:", {
    stabilityPreComputed, locationPreComputed, isResumeMode, candidateInfo: candidateInfo.name,
  });

  // ── Pass 2: LLM evaluation ──
  const userPrompt = buildUserPrompt(profileData, config.jobDescription, candidateInfo);
  const model = config.aiModel;
  if (!model) throw new Error("No AI model configured. Please select a provider and model before running analysis.");

  // Build system prompt — resume mode includes stability + location rules for LLM scoring
  const systemPrompt = buildSystemPrompt(rules, customRules, {
    customPrompt: config.customPrompt,
    promptRole: config.promptRole,
    promptGuidelines: config.promptGuidelines,
    criticalInstructions: config.criticalInstructions,
    builtInRuleDescriptions: config.builtInRuleDescriptions,
    ruleDefinitions: config.ruleDefinitions,
    promptEnvelope: config.promptEnvelope,
    resumeMode: isResumeMode,
  });
  console.log(`[Analyzer] System prompt built (${systemPrompt.length} chars), role=${config.promptRole ? 'custom' : 'default'}, guidelines=${config.promptGuidelines ? 'custom' : 'default'}`);

  console.log(`[Analyzer] Calling AI (${model}), prompt: ${userPrompt.length} chars`);

  // Dynamic import keeps ai-adapter (and the Prisma client it uses to read
  // AiProvider rows) out of the module-eval chain that client components
  // hit when they import types/helpers from this file.
  const { chatCompletion } = await import("@/lib/ai-adapter");
  const aiResult = await chatCompletion(
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    model,
    { temperature: 0.1, max_tokens: 2000, response_format: { type: "json_object" } },
    config.aiProviderId
  );

  const content = aiResult.content;
  const resultUsage = aiResult.usage;
  const cacheHitPct = resultUsage.prompt_tokens
    ? Math.round((resultUsage.cached_tokens / resultUsage.prompt_tokens) * 100)
    : 0;
  console.log(
    `[Analyzer] AI response (${aiResult.provider}). ` +
      `prompt: ${resultUsage.prompt_tokens} (cached: ${resultUsage.cached_tokens}, ` +
      `hit: ${cacheHitPct}%${resultUsage.cache_write_tokens ? `, written: ${resultUsage.cache_write_tokens}` : ""}), ` +
      `completion: ${resultUsage.completion_tokens}, total: ${resultUsage.total_tokens}`
  );

  let llmResult: any;
  try {
    const cleaned = content.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?\s*```$/i, "").trim();
    llmResult = JSON.parse(cleaned);
  } catch {
    console.error("[Analyzer] Failed to parse AI response:", content);
    throw new Error("AI returned invalid JSON. Please retry.");
  }

  // ── Pass 3: Merge deterministic + LLM ──
  const llmScoring = llmResult.scoring || {};

  const effectiveRules = getEffectiveRules({
    scoringRules: rules,
    customScoringRules: customRules,
    builtInRuleDescriptions: config.builtInRuleDescriptions,
    ruleDefinitions: config.ruleDefinitions,
  });
  const enabledEffectiveRules = effectiveRules.filter((r) => r.enabled);

  const scoring: Record<string, number | string> = {};

  // Stability and location: for resume uploads the LLM scores these from raw text;
  // for LinkedIn scrapes we use the deterministic pre-computed values.
  if (isResumeMode) {
    const s = coerce(llmScoring.stability);
    scoring.stability = typeof s === "number" ? Math.min(s, 10) : stabilityPreComputed;
    const l = coerce(llmScoring.locationMatch);
    scoring.locationMatch = typeof l === "number" ? Math.min(l, 5) : locationPreComputed;
  } else {
    scoring.stability = stabilityPreComputed;
    scoring.locationMatch = locationPreComputed;
  }

  for (const rule of enabledEffectiveRules) {
    if (rule.isPreComputed) continue;
    for (const param of rule.scoreParameters) {
      const raw = coerce(llmScoring[param.key]);
      const maxP = param.maxPoints;
      scoring[param.key] = typeof raw === "number" ? Math.min(raw, maxP) : raw;
    }
  }

  // Compute total
  const totalScore = Object.values(scoring).reduce<number>(
    (sum, v) => sum + (typeof v === "number" ? v : 0),
    0
  );

  const maxScore = enabledEffectiveRules.reduce((sum, r) => sum + ruleMax(r), 0);
  const enabledCustomRules = enabledEffectiveRules
    .filter((r) => r.type === "custom")
    .map((r) => customRules.find((c) => c.id === r.key)!)
    .filter(Boolean);

  const scorePercent =
    maxScore > 0 ? Math.round((totalScore / maxScore) * 1000) / 10 : 0;
  const recommendation =
    scorePercent >= 70
      ? "Strong Fit"
      : scorePercent >= 40
        ? "Moderate Fit"
        : "Not a Fit";

  // Merge scoring logs
  const llmLogs = llmResult.scoringLogs || {};
  const scoringLogs = { ...preComputedLogs, ...llmLogs };

  const merged: AnalysisResult = {
    candidateInfo,
    scoring,
    scoringLogs,
    enabledRules: rules,
    maxScore,
    totalScore,
    scorePercent,
    recommendation,
    customScoringRules: enabledCustomRules,
    remarks: llmResult.remarks || "",
    experienceSummary: llmResult.experienceSummary || "",
    skillBreakdown: llmResult.skillBreakdown || null,
    strengths: llmResult.strengths || [],
    gaps: llmResult.gaps || [],
    flags: llmResult.flags || [],
    __debug: {
      systemPrompt,
      userPrompt,
      model,
      usage: resultUsage,
      preComputed: { stability: stabilityPreComputed, location: locationPreComputed },
    },
  };

  console.log(
    `[Analyzer] Score: ${totalScore}/${maxScore} (${scorePercent}%) → ${recommendation}`
  );

  return merged;
}
