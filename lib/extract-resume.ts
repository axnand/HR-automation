export interface ExtractedWorkExperience {
  company: string;
  position: string;
  start: string; // "M/D/YYYY" — compatible with analyzer's parseMonthYear
  end: string | null; // null means "Present"
}

export interface ExtractedResumeInfo {
  name: string;
  linkedinUrl: string;
  currentOrg: string;
  currentDesignation: string;
  currentLocation: string;
  workExperience: ExtractedWorkExperience[];
  isLinkedInExport?: boolean;
}

const MONTHS: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6,
  jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

function parseMonth(s: string): number | null {
  return MONTHS[s.toLowerCase()] ?? null;
}

// "March 2026 - Present (2 months)" | "August 2020 - March 2022 (1 year 8 months)"
const DATE_LINE_RE =
  /^([A-Za-z]+)\s+(\d{4})\s*[-–—]\s*(Present|([A-Za-z]+)\s+(\d{4}))(?:\s*\(.+\))?\s*$/;

// "1 year" | "2 years" | "1 year 3 months" | "5 months" — LinkedIn tenure summaries
const TENURE_SUMMARY_RE = /^\d+\s+years?\s*(?:\d+\s+months?)?$|^\d+\s+months?$/i;

// Positions that must NOT count toward tenure / stability — they're not full-time employment.
// Whole-word match against the position string (case-insensitive).
const NON_FULL_TIME_POSITION_RE =
  /\b(intern|internship|trainee|apprentice|volunteer|freelance|freelancer|contractor|part[-\s]?time|summer\s+associate|intern\.)\b/i;

export function isFullTimeRole(position: string): boolean {
  if (!position) return false;
  return !NON_FULL_TIME_POSITION_RE.test(position);
}

// Lines that look like description text rather than a company name.
function looksLikeDescriptionText(s: string): boolean {
  if (!s) return false;
  if (TENURE_SUMMARY_RE.test(s)) return true;
  if (s.length > 100) return true;
  if (/^[a-z]/.test(s)) return true;
  if (/^[-•·–*]|^\d+\.\s/.test(s)) return true;
  return false;
}

function extractWorkExperience(lines: string[]): ExtractedWorkExperience[] {
  // Locate the "Experience" section
  let expStart = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].toLowerCase() === "experience") {
      expStart = i + 1;
      break;
    }
  }
  if (expStart === -1) return [];

  const entries: ExtractedWorkExperience[] = [];
  let lastKnownCompany = "";

  for (let i = expStart; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;

    // Stop at the next section (Education, Activity, etc.)
    const lower = line.toLowerCase();
    if (SECTION_HEADERS.has(lower) && lower !== "experience") break;

    const m = DATE_LINE_RE.exec(line);
    if (!m) continue;

    // Position is the closest non-empty line above; company the one above that.
    let posIdx = i - 1;
    while (posIdx >= 0 && !lines[posIdx]) posIdx--;
    if (posIdx < 0) continue;
    const position = lines[posIdx];

    let compIdx = posIdx - 1;
    while (compIdx >= 0 && !lines[compIdx]) compIdx--;
    if (compIdx < 0) continue;
    let company = lines[compIdx];

    // Skip LinkedIn tenure summary lines (e.g. "1 year", "2 years 3 months") and
    // look one line further up for the real company name.
    if (TENURE_SUMMARY_RE.test(company)) {
      let prevIdx = compIdx - 1;
      while (prevIdx >= 0 && !lines[prevIdx]) prevIdx--;
      if (
        prevIdx >= 0 &&
        !SECTION_HEADERS.has(lines[prevIdx].toLowerCase()) &&
        !DATE_LINE_RE.test(lines[prevIdx])
      ) {
        company = lines[prevIdx];
        compIdx = prevIdx;
      }
    }

    // If the candidate company still looks like description text (e.g. a bullet from the
    // previous role's description that bleeds into the next role's lookup window), fall
    // back to the last valid company we recorded — common for grouped multi-role companies.
    if (looksLikeDescriptionText(company) && lastKnownCompany) {
      company = lastKnownCompany;
    }

    // Guard against misreads (company shouldn't be a section header or another date line)
    if (SECTION_HEADERS.has(company.toLowerCase())) continue;
    if (DATE_LINE_RE.test(company)) continue;
    if (DATE_LINE_RE.test(position)) continue;

    // Skip non-full-time roles — stability/tenure should only reflect real employment.
    if (!isFullTimeRole(position)) continue;

    const startMonth = parseMonth(m[1]);
    const startYear = parseInt(m[2], 10);
    if (!startMonth || !startYear) continue;

    let end: string | null = null;
    if (m[3].toLowerCase() !== "present") {
      const endMonth = parseMonth(m[4]);
      const endYear = parseInt(m[5], 10);
      if (!endMonth || !endYear) continue;
      end = `${endMonth}/1/${endYear}`;
    }

    if (!looksLikeDescriptionText(company)) {
      lastKnownCompany = company;
    }

    entries.push({
      company,
      position,
      start: `${startMonth}/1/${startYear}`,
      end,
    });
  }

  return entries;
}

const SECTION_HEADERS = new Set([
  "contact",
  "top skills",
  "skills",
  "summary",
  "experience",
  "education",
  "activity",
  "languages",
  "certifications",
  "publications",
  "projects",
  "honors-awards",
  "honors & awards",
  "volunteer experience",
  "interests",
  "recommendations",
]);

function isContactMetaLine(s: string): boolean {
  if (/\((?:email|phone|mobile|other|fax|telephone|personal)\)/i.test(s)) return true;
  if (/^[\w.+-]+@[\w.-]+\.\w{2,}$/i.test(s)) return true;
  return false;
}

function isSectionHeader(s: string): boolean {
  return SECTION_HEADERS.has(s.toLowerCase().trim());
}

const LINKEDIN_URL_PATTERN = /(?:https?:\/\/)?(?:www\.)?linkedin\.com\/in\/([\w%-]+(?:[\/\-][\w%-]+)*)/i;
const HEADLINE_PATTERN = /^(.+?)\s+@\s+(.+)$/;
const TRAILING_AT_PATTERN = /^(.+?)\s+@\s*$/;

// LinkedIn URL may wrap across lines, e.g. "www.linkedin.com/in/naman-\nsuyal-441416258"
// And sometimes includes query strings or trailing slashes
function extractLinkedInUrl(text: string): string {
  // try to match wrapped lines as well
  const match = text.match(/(?:https?:\/\/)?(?:www\.)?linkedin\.com\/in\/([\w%-]+(?:\r?\n[\w%-]+)*)/i);
  if (!match) return "";
  let handle = match[1].replace(/\s+/g, "");
  // remove any trailing slash or query params if accidentally captured
  handle = handle.split(/[?\/]/)[0];
  return `https://www.linkedin.com/in/${handle}`;
}

interface HeadlineMatch {
  nameSearchIdx: number;     // look for candidate name before this line index
  locationSearchIdx: number; // look for location after this line index
  designation: string;
  org: string;
}

// Strongest anchor in LinkedIn PDFs: "Designation @ Company" — single or two-line split.
function findHeadline(lines: string[]): HeadlineMatch | null {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || /linkedin\.com/i.test(line)) continue;

    // Single-line: "Designation @ Company"
    const m = HEADLINE_PATTERN.exec(line);
    if (m) {
      return { nameSearchIdx: i, locationSearchIdx: i, designation: m[1].trim(), org: m[2].trim() };
    }

    // Two-line split: line ends with " @" and org is on the next non-empty line
    const mt = TRAILING_AT_PATTERN.exec(line);
    if (mt) {
      let nextIdx = i + 1;
      while (nextIdx < lines.length && !lines[nextIdx]) nextIdx++;
      if (nextIdx < lines.length) {
        const nextLine = lines[nextIdx];
        if (!SECTION_HEADERS.has(nextLine.toLowerCase()) && !DATE_LINE_RE.test(nextLine)) {
          return {
            nameSearchIdx: i,
            locationSearchIdx: nextIdx,
            designation: mt[1].trim(),
            org: nextLine.trim(),
          };
        }
      }
    }
  }
  return null;
}

// Name: first qualifying non-empty line before the headline. Stops at section headers / URL lines.
function findNameBeforeHeadline(lines: string[], headlineIdx: number): string {
  for (let i = headlineIdx - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;
    if (isSectionHeader(line) || /linkedin\.com/i.test(line)) break;
    if (isContactMetaLine(line)) continue;
    return line;
  }
  return "";
}

// Location: first non-empty line after the headline (before the next section header).
function findLocationAfterHeadline(lines: string[], headlineIdx: number): string {
  for (let i = headlineIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    if (isSectionHeader(line)) return "";
    return line;
  }
  return "";
}

export function extractResumeInfo(text: string): ExtractedResumeInfo {
  const result: ExtractedResumeInfo = {
    name: "",
    linkedinUrl: "",
    currentOrg: "",
    currentDesignation: "",
    currentLocation: "",
    workExperience: [],
    isLinkedInExport: false,
  };

  if (!text) return result;

  result.linkedinUrl = extractLinkedInUrl(text);

  // Check for LinkedIn Export Markers
  const hasLinkedInMarkers = 
    /Top Skills/i.test(text) && 
    /Summary/i.test(text) && 
    /Experience/i.test(text) && 
    /Education/i.test(text);

  if (hasLinkedInMarkers || text.includes("Page 1 of") || text.includes("www.linkedin.com/in")) {
    result.isLinkedInExport = true;
  }

  const lines = text.split(/\r?\n/).map((l) => l.trim());

  const headline = findHeadline(lines);
  if (headline) {
    result.currentDesignation = headline.designation;
    result.currentOrg = headline.org;
    result.name = findNameBeforeHeadline(lines, headline.nameSearchIdx);
    result.currentLocation = findLocationAfterHeadline(lines, headline.locationSearchIdx);
  }

  result.workExperience = extractWorkExperience(lines);

  return result;
}
