import { CONTRACT_VERSIONS } from "@mclab/contracts";

import type { ParsedHtml, RawSnapshot, RobotsAgentResult, TechnicalCheck, TechnicalFinding } from "./types";

const AGENTS = [
  { agent: "*", purpose: "general_crawl" },
  { agent: "OAI-SearchBot", purpose: "openai_search" },
  { agent: "GPTBot", purpose: "openai_training" },
] as const;

type Group = { agents: string[]; rules: Rule[] };
type Rule = { directive: "allow" | "disallow"; pattern: string };

export function buildTechnicalCheck(input: {
  productUrl: string;
  capturedAt: string;
  html: ParsedHtml;
  htmlSnapshot: RawSnapshot;
  robotsSnapshot: RawSnapshot | null;
  robotsError?: string;
}): TechnicalCheck {
  const xRobotsTag = splitDirectives(input.htmlSnapshot.headers["x-robots-tag"]);
  const pageDirectives = [...input.html.metaRobots, ...xRobotsTag];
  const noindex = pageDirectives.some((directive) => directive === "noindex" || directive === "none");
  const robotsAvailable = Boolean(
    input.robotsSnapshot && input.robotsSnapshot.status >= 200 && input.robotsSnapshot.status < 300,
  );
  const crawlerAccess: RobotsAgentResult[] = AGENTS.map(({ agent, purpose }) =>
    robotsAvailable
      ? evaluateAgent(input.robotsSnapshot!.body, new URL(input.productUrl).pathname, agent, purpose)
      : { agent, purpose, result: "unknown", matched_user_agent: null, matched_rule: null },
  );
  const findings: TechnicalFinding[] = [];

  if (noindex) {
    findings.push({
      code: "PAGE_NOINDEX",
      severity: "error",
      message: "The product page declares noindex/none in page-level robots directives.",
      evidence_paths: [
        ...input.html.metaRobots.map((directive) => `meta[robots]=${directive}`),
        ...xRobotsTag.map((directive) => `x-robots-tag=${directive}`),
      ],
    });
  }
  for (const result of crawlerAccess) {
    if (result.result === "blocked") {
      findings.push({
        code: "CRAWLER_BLOCKED",
        severity: result.agent === "OAI-SearchBot" || result.agent === "*" ? "error" : "warning",
        message: `${result.agent} is blocked from the captured product path by robots.txt.`,
        evidence_paths: result.matched_rule ? [`robots.txt:${result.matched_rule}`] : [],
      });
    }
  }
  if (!robotsAvailable) {
    findings.push({
      code: "ROBOTS_UNAVAILABLE",
      severity: "warning",
      message: input.robotsError ?? `robots.txt returned HTTP ${input.robotsSnapshot?.status ?? "unknown"}.`,
      evidence_paths: [],
    });
  }

  return {
    schema_version: CONTRACT_VERSIONS.technicalCheck,
    product_url: input.productUrl,
    captured_at: input.capturedAt,
    status: robotsAvailable ? "complete" : "partial",
    page_directives: { meta_robots: input.html.metaRobots, x_robots_tag: xRobotsTag },
    robots_url: new URL("/robots.txt", input.productUrl).toString(),
    robots_http_status: input.robotsSnapshot?.status ?? null,
    crawler_access: crawlerAccess,
    findings,
  };
}

export function evaluateAgent(
  robotsText: string,
  path: string,
  agent: RobotsAgentResult["agent"],
  purpose: RobotsAgentResult["purpose"],
): RobotsAgentResult {
  const groups = parseGroups(robotsText);
  const normalizedAgent = agent.toLowerCase();
  const matches = groups
    .flatMap((group) => group.agents.map((token) => ({ group, token })))
    .filter(({ token }) => token === "*" || normalizedAgent.startsWith(token));
  if (!matches.length) {
    return { agent, purpose, result: "allowed", matched_user_agent: null, matched_rule: null };
  }
  const bestLength = Math.max(...matches.map(({ token }) => (token === "*" ? 0 : token.length)));
  const selected = matches.filter(({ token }) => (token === "*" ? 0 : token.length) === bestLength);
  const rules = selected.flatMap(({ group }) => group.rules);
  const matchingRules = rules.filter((rule) => rule.pattern && pathMatches(path, rule.pattern));
  if (!matchingRules.length) {
    return {
      agent,
      purpose,
      result: "allowed",
      matched_user_agent: selected[0]?.token ?? null,
      matched_rule: null,
    };
  }
  matchingRules.sort((left, right) => {
    const lengthDifference = ruleSpecificity(right.pattern) - ruleSpecificity(left.pattern);
    if (lengthDifference) return lengthDifference;
    return left.directive === right.directive ? 0 : left.directive === "allow" ? -1 : 1;
  });
  const winner = matchingRules[0]!;
  return {
    agent,
    purpose,
    result: winner.directive === "allow" ? "allowed" : "blocked",
    matched_user_agent: selected[0]?.token ?? null,
    matched_rule: `${winner.directive}: ${winner.pattern}`,
  };
}

function parseGroups(text: string): Group[] {
  const groups: Group[] = [];
  let agents: string[] = [];
  let rules: Rule[] = [];
  let hasDirectives = false;
  const commit = () => {
    if (agents.length) groups.push({ agents: [...new Set(agents)], rules });
    agents = [];
    rules = [];
    hasDirectives = false;
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*/, "").trim();
    if (!line) continue;
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (field === "user-agent") {
      if (hasDirectives) commit();
      if (value) agents.push(value.toLowerCase());
    } else if ((field === "allow" || field === "disallow") && agents.length) {
      hasDirectives = true;
      if (value) rules.push({ directive: field, pattern: value });
    }
  }
  commit();
  return groups;
}

function pathMatches(path: string, pattern: string): boolean {
  const anchored = pattern.endsWith("$");
  const source = pattern.slice(0, anchored ? -1 : undefined);
  const expression = source.split("*").map(escapeRegExp).join(".*");
  return new RegExp(`^${expression}${anchored ? "$" : ""}`).test(path);
}

function ruleSpecificity(pattern: string): number {
  return pattern.replace(/[*$]/g, "").length;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function splitDirectives(value: string | undefined): string[] {
  return value
    ? value.split(",").map((directive) => directive.trim().toLowerCase()).filter(Boolean)
    : [];
}
