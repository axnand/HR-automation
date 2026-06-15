import { describe, it, expect } from "vitest";
import { renderTemplate, buildVars } from "../render-template";
import type { TemplateVars } from "../render-template";

const VARS: TemplateVars = {
  name: "John Doe",
  firstName: "John",
  lastName: "Doe",
  company: "Acme Corp",
  role: "Engineer",
  score: "85%",
  reason: "",
  interviewLink: "https://example.com/interview/abc",
};

describe("renderTemplate — canonical camelCase tokens", () => {
  it("replaces {{firstName}}", () => {
    expect(renderTemplate("Hi {{firstName}}", VARS)).toBe("Hi John");
  });

  it("replaces {{lastName}}", () => {
    expect(renderTemplate("Hi {{lastName}}", VARS)).toBe("Hi Doe");
  });

  it("replaces {{name}}", () => {
    expect(renderTemplate("Hi {{name}}", VARS)).toBe("Hi John Doe");
  });

  it("replaces {{company}}", () => {
    expect(renderTemplate("At {{company}}", VARS)).toBe("At Acme Corp");
  });

  it("replaces {{role}}", () => {
    expect(renderTemplate("Role: {{role}}", VARS)).toBe("Role: Engineer");
  });

  it("replaces {{score}}", () => {
    expect(renderTemplate("Score: {{score}}", VARS)).toBe("Score: 85%");
  });

  it("replaces {{interviewLink}}", () => {
    expect(renderTemplate("Link: {{interviewLink}}", VARS)).toBe(
      "Link: https://example.com/interview/abc"
    );
  });
});

describe("renderTemplate — space/casing aliases (the reported bug)", () => {
  it("replaces {{first name}} (space, lowercase)", () => {
    expect(renderTemplate("Hi {{first name}}", VARS)).toBe("Hi John");
  });

  it("replaces {{First Name}} (title case)", () => {
    expect(renderTemplate("Hi {{First Name}}", VARS)).toBe("Hi John");
  });

  it("replaces {{FIRST NAME}} (upper case)", () => {
    expect(renderTemplate("Hi {{FIRST NAME}}", VARS)).toBe("Hi John");
  });

  it("replaces {{last name}} (space, lowercase)", () => {
    expect(renderTemplate("Hi {{last name}}", VARS)).toBe("Hi Doe");
  });

  it("replaces {{Last Name}}", () => {
    expect(renderTemplate("Hi {{Last Name}}", VARS)).toBe("Hi Doe");
  });

  it("replaces {{full name}}", () => {
    expect(renderTemplate("Hi {{full name}}", VARS)).toBe("Hi John Doe");
  });

  it("replaces {{interview link}} (space)", () => {
    expect(renderTemplate("Link: {{interview link}}", VARS)).toBe(
      "Link: https://example.com/interview/abc"
    );
  });

  it("replaces {{ firstName }} (extra whitespace padding)", () => {
    expect(renderTemplate("Hi {{ firstName }}", VARS)).toBe("Hi John");
  });

  it("replaces multiple aliased tokens in one template", () => {
    expect(
      renderTemplate("Hi {{first name}}, your score is {{score}} — {{company}}", VARS)
    ).toBe("Hi John, your score is 85% — Acme Corp");
  });
});

describe("renderTemplate — safety guard: unreplaced tokens", () => {
  it("throws when an unknown variable is present", () => {
    expect(() => renderTemplate("Hi {{unknownVar}}", VARS)).toThrow(
      /unreplaced variable/
    );
  });

  it("throws when a typo token like {{fristName}} slips through", () => {
    expect(() => renderTemplate("Hi {{fristName}}", VARS)).toThrow(
      /unreplaced variable/
    );
  });

  it("does NOT throw when all variables are resolved", () => {
    expect(() =>
      renderTemplate("Hi {{first name}}, link: {{interviewLink}}", VARS)
    ).not.toThrow();
  });
});

describe("send-invite scenario — the reported bug", () => {
  it("renders invite note with {{firstName}} from a real LinkedIn profile shape", () => {
    const profile = { first_name: "Ananya", last_name: "Sharma", headline: "Head of TA @ Swiggy" };
    const vars = buildVars(profile, {});
    const noteTemplate = "Hey {{firstName}},\nWe're hiring a Head of TA at Salescode.ai, at AVP/Director level. Would be great to connect if this sounds relevant to you.";
    const rendered = renderTemplate(noteTemplate, vars);
    expect(rendered).toBe("Hey Ananya,\nWe're hiring a Head of TA at Salescode.ai, at AVP/Director level. Would be great to connect if this sounds relevant to you.");
    expect(rendered).not.toContain("{{");
  });

  it("never sends {{firstName}} literally — always substitutes", () => {
    const profile = { first_name: "Rahul", last_name: "Mehta" };
    const vars = buildVars(profile, {});
    const result = renderTemplate("Hey {{firstName}},", vars);
    expect(result).toBe("Hey Rahul,");
    expect(result).not.toContain("{{firstName}}");
  });

  it("falls back to 'there' when profile has no name, but never sends the token", () => {
    const vars = buildVars({}, {});
    const result = renderTemplate("Hey {{firstName}},", vars);
    expect(result).toBe("Hey there,");
    expect(result).not.toContain("{{");
  });
});

describe("buildVars", () => {
  it("extracts firstName from profile.first_name", () => {
    const vars = buildVars({ first_name: "Alice", last_name: "Smith" }, {});
    expect(vars.firstName).toBe("Alice");
    expect(vars.lastName).toBe("Smith");
    expect(vars.name).toBe("Alice Smith");
  });

  it("falls back to analysis.candidateInfo.name when profile has no name", () => {
    const vars = buildVars({}, { candidateInfo: { name: "Bob Jones" } });
    expect(vars.firstName).toBe("Bob");
    expect(vars.name).toBe("Bob Jones");
  });

  it("defaults firstName to 'there' when no name data exists", () => {
    const vars = buildVars({}, {});
    expect(vars.firstName).toBe("there");
  });

  it("sets reason to empty string by default", () => {
    const vars = buildVars({}, {});
    expect(vars.reason).toBe("");
  });

  it("sets interviewLink to empty string by default", () => {
    const vars = buildVars({}, {});
    expect(vars.interviewLink).toBe("");
  });
});
