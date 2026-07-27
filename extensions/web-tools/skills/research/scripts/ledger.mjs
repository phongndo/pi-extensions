#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = 1;
const MAX_INPUT_BYTES = 1_000_000;
const MAX_FILE_BYTES = 5_000_000;
const DEFAULT_FRESHNESS_MAX_AGE_DAYS = 365;
const SESSION_PATTERN = /^research-[0-9a-f-]{36}$/;
const MODES = {
  quick: { rounds: 1, searches: 1, fetches: 3, workers: 1 },
  standard: { rounds: 3, searches: 5, fetches: 8, workers: 1 },
  deep: { rounds: 10, searches: 15, fetches: 25, workers: 1 },
  broad: { rounds: 6, searches: 16, fetches: 30, workers: 4 },
};
const SOURCE_TIERS = new Set([
  "primary",
  "official",
  "government",
  "scholarly",
  "reputable",
  "secondary",
  "community",
  "unknown",
]);
const SOURCE_SCORES = {
  primary: 4,
  official: 4,
  government: 4,
  scholarly: 4,
  reputable: 3,
  secondary: 2,
  community: 1,
  unknown: 0,
};
const TRACKING_PARAMETERS = new Set([
  "fbclid",
  "gclid",
  "dclid",
  "msclkid",
  "ref",
  "ref_src",
]);

function fail(message, code = "invalid_input") {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function rootDirectory() {
  if (process.env.PI_WEB_RESEARCH_DIR)
    return resolve(process.env.PI_WEB_RESEARCH_DIR);
  const suffix =
    typeof process.getuid === "function" ? `-${process.getuid()}` : "";
  return join(tmpdir(), `pi-web-research${suffix}`);
}

const LEDGER_FILE_SYSTEM = { chmod, mkdir, readdir, rm, stat };

export async function ensureRoot(fileSystem = LEDGER_FILE_SYSTEM) {
  const root = rootDirectory();
  await fileSystem.mkdir(root, { recursive: true, mode: 0o700 });
  await fileSystem.chmod(root, 0o700);
  return root;
}

function sessionPath(sessionId) {
  if (!SESSION_PATTERN.test(sessionId)) fail("Invalid research session ID.");
  return join(rootDirectory(), `${sessionId}.json`);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value, label, maximum = 10_000, required = true) {
  if (value == null && !required) return undefined;
  if (typeof value !== "string" || (required && !value.trim()))
    fail(`${label} must be a non-empty string.`);
  const result = value.trim();
  if (result.length > maximum) fail(`${label} exceeds ${maximum} characters.`);
  return result;
}

function boundedInteger(value, label, minimum, maximum, fallback) {
  if (value == null) return fallback;
  if (!Number.isInteger(value) || value < minimum || value > maximum)
    fail(`${label} must be an integer from ${minimum} to ${maximum}.`);
  return value;
}

function boundedNumber(value, label, minimum, maximum, fallback) {
  if (value == null) return fallback;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < minimum ||
    value > maximum
  )
    fail(`${label} must be a number from ${minimum} to ${maximum}.`);
  return value;
}

function array(value, label, maximum = 100) {
  if (value == null) return [];
  if (!Array.isArray(value)) fail(`${label} must be an array.`);
  if (value.length > maximum) fail(`${label} allows at most ${maximum} items.`);
  return value;
}

function normalizeIdentifier(value, fallback, label) {
  if (value == null) return fallback;
  const id = text(value, label, 80)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  if (!id) fail(`${label} must contain a letter or number.`);
  return id;
}

function normalizeQuery(value) {
  return value
    .toLowerCase()
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function querySimilarity(left, right) {
  if (left === right) return 1;
  const tokens = (value) => new Set(value.match(/[\p{L}\p{N}]+/gu) ?? []);
  const a = tokens(left);
  const b = tokens(right);
  if (Math.min(a.size, b.size) < 3) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

function canonicalUrl(value) {
  let url;
  try {
    url = new URL(text(value, "url", 8_000));
  } catch {
    fail("url must be an absolute HTTP(S) URL.");
  }
  if (!["http:", "https:"].includes(url.protocol))
    fail("url must use HTTP or HTTPS.");
  if (url.username || url.password) fail("url must not contain credentials.");
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    if (
      key.toLowerCase().startsWith("utm_") ||
      TRACKING_PARAMETERS.has(key.toLowerCase())
    )
      url.searchParams.delete(key);
  }
  url.searchParams.sort();
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString();
}

function domainOf(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

function publicationDate(value, label) {
  const raw = text(value, label, 100, false);
  if (raw === undefined) return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T.*)?$/.exec(raw);
  if (!match) fail(`${label} must be an ISO 8601 date or timestamp.`);
  const [, year, month, day] = match;
  const calendarDate = new Date(
    Date.UTC(Number(year), Number(month) - 1, Number(day)),
  );
  if (
    calendarDate.getUTCFullYear() !== Number(year) ||
    calendarDate.getUTCMonth() !== Number(month) - 1 ||
    calendarDate.getUTCDate() !== Number(day)
  )
    fail(`${label} must contain a real calendar date.`);
  if (raw.length === 10) return raw;
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(
      raw,
    )
  )
    fail(`${label} must be an ISO 8601 date or timestamp.`);
  const timestamp = Date.parse(raw);
  if (!Number.isFinite(timestamp)) fail(`${label} must be a valid timestamp.`);
  return new Date(timestamp).toISOString();
}

function normalizeCriteria(raw) {
  const values = array(raw, "criteria", 30);
  if (!values.length)
    fail("criteria must contain at least one explicit answer criterion.");
  const seen = new Set();
  return values.map((entry, index) => {
    const item = typeof entry === "string" ? { text: entry } : entry;
    if (!isObject(item)) fail(`criteria[${index}] must be a string or object.`);
    const id = normalizeIdentifier(
      item.id,
      `criterion-${index + 1}`,
      `criteria[${index}].id`,
    );
    if (seen.has(id)) fail(`Duplicate criterion ID: ${id}.`);
    seen.add(id);
    const freshnessRequired =
      item.freshness_required === true || item.freshnessRequired === true;
    return {
      id,
      text: text(item.text, `criteria[${index}].text`, 1_000),
      required: item.required !== false,
      minSources: boundedInteger(
        item.min_sources ?? item.minSources,
        `criteria[${index}].min_sources`,
        1,
        5,
        1,
      ),
      freshnessRequired,
      freshnessMaxAgeDays: boundedInteger(
        item.freshness_max_age_days ?? item.freshnessMaxAgeDays,
        `criteria[${index}].freshness_max_age_days`,
        1,
        3_650,
        DEFAULT_FRESHNESS_MAX_AGE_DAYS,
      ),
    };
  });
}

function normalizeFacets(raw) {
  const seen = new Set();
  return array(raw, "facets", 30).map((entry, index) => {
    const item = typeof entry === "string" ? { text: entry } : entry;
    if (!isObject(item)) fail(`facets[${index}] must be a string or object.`);
    const id = normalizeIdentifier(
      item.id,
      `facet-${index + 1}`,
      `facets[${index}].id`,
    );
    if (seen.has(id)) fail(`Duplicate facet ID: ${id}.`);
    seen.add(id);
    return {
      id,
      text: text(item.text, `facets[${index}].text`, 1_000),
      status: "open",
    };
  });
}

function normalizeBudgets(mode, raw) {
  const defaults = MODES[mode];
  if (raw != null && !isObject(raw)) fail("budgets must be an object.");
  const value = raw ?? {};
  return {
    rounds: boundedInteger(
      value.rounds,
      "budgets.rounds",
      1,
      20,
      defaults.rounds,
    ),
    searches: boundedInteger(
      value.searches,
      "budgets.searches",
      1,
      50,
      defaults.searches,
    ),
    fetches: boundedInteger(
      value.fetches,
      "budgets.fetches",
      1,
      100,
      defaults.fetches,
    ),
    workers: boundedInteger(
      value.workers,
      "budgets.workers",
      1,
      10,
      defaults.workers,
    ),
  };
}

async function readStdin() {
  let body = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    body += chunk;
    if (Buffer.byteLength(body) > MAX_INPUT_BYTES)
      fail(`Input exceeds ${MAX_INPUT_BYTES} bytes.`, "input_too_large");
  }
  if (!body.trim()) fail("A JSON object is required on standard input.");
  let value;
  try {
    value = JSON.parse(body);
  } catch (error) {
    fail(`Input is not valid JSON: ${error.message}`);
  }
  if (!isObject(value)) fail("Input must decode to a JSON object.");
  return value;
}

export async function cleanupExpired(fileSystem = LEDGER_FILE_SYSTEM) {
  const root = await ensureRoot(fileSystem);
  const retentionHours = boundedNumber(
    Number(process.env.PI_WEB_RESEARCH_RETENTION_HOURS || 24),
    "PI_WEB_RESEARCH_RETENTION_HOURS",
    1,
    720,
    24,
  );
  const cutoff = Date.now() - retentionHours * 3_600_000;
  for (const name of await fileSystem.readdir(root)) {
    if (!/^research-[0-9a-f-]{36}\.json$/.test(name)) continue;
    const path = join(root, name);
    const info = await fileSystem.stat(path);
    if (info.mtimeMs < cutoff) await fileSystem.rm(path, { force: true });
  }
}

async function atomicWrite(path, value, exclusive = false) {
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(serialized) > MAX_FILE_BYTES)
    fail("Research ledger exceeded its 5 MB safety limit.", "ledger_too_large");
  if (exclusive) {
    await writeFile(path, serialized, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await chmod(path, 0o600);
    return;
  }
  const existing = await lstat(path);
  if (existing?.isSymbolicLink())
    fail("Refusing to overwrite a symbolic-link ledger.", "unsafe_path");
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, serialized, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  await rename(temporary, path);
  await chmod(path, 0o600);
}

async function lstatIfExists(path) {
  try {
    return await lstat(path);
  } catch (error) {
    // A missing session is an expected lookup result at this API boundary;
    // permission and operational filesystem failures must remain visible.
    if (isObject(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function loadSession(sessionId) {
  await ensureRoot();
  const path = sessionPath(sessionId);
  const info = await lstatIfExists(path);
  if (!info || !info.isFile() || info.isSymbolicLink())
    fail("Research session does not exist or is unsafe.", "session_not_found");
  if (info.size > MAX_FILE_BYTES)
    fail("Research ledger exceeds its safety limit.", "ledger_too_large");
  let session;
  try {
    session = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    fail(`Could not read research session: ${error.message}`, "invalid_ledger");
  }
  if (
    !isObject(session) ||
    session.version !== VERSION ||
    session.sessionId !== sessionId
  )
    fail("Research ledger is invalid.", "invalid_ledger");
  return session;
}

function clip(value, maximum) {
  if (typeof value !== "string") return value;
  return value.length <= maximum
    ? value
    : `${value.slice(0, maximum - 20)}… [clipped]`;
}

function nextId(prefix, entries) {
  const maximum = entries.reduce((current, entry) => {
    const match = new RegExp(`^${prefix}(\\d+)$`).exec(entry.id ?? "");
    return match ? Math.max(current, Number(match[1])) : current;
  }, 0);
  return `${prefix}${String(maximum + 1).padStart(3, "0")}`;
}

function criterionCoverage(session, verifiedOnly = false) {
  const now = Date.now();
  return session.criteria.map((criterion) => {
    const freshnessMaxAgeDays =
      Number.isInteger(criterion.freshnessMaxAgeDays) &&
      criterion.freshnessMaxAgeDays > 0
        ? criterion.freshnessMaxAgeDays
        : DEFAULT_FRESHNESS_MAX_AGE_DAYS;
    const supporting = session.evidence.filter(
      (card) =>
        card.supports.includes(criterion.id) &&
        card.confidence >= 0.5 &&
        card.verificationStatus !== "rejected" &&
        (!verifiedOnly || card.verificationStatus === "verified"),
    );
    const eligible = criterion.freshnessRequired
      ? supporting.filter((card) => {
          const publishedAt = Date.parse(card.publishedAt ?? "");
          const cutoff = now - freshnessMaxAgeDays * 24 * 60 * 60 * 1_000;
          return (
            Number.isFinite(publishedAt) &&
            publishedAt <= now &&
            publishedAt >= cutoff
          );
        })
      : supporting;
    const domains = [
      ...new Set(eligible.map((card) => domainOf(card.url)).filter(Boolean)),
    ];
    return {
      id: criterion.id,
      text: criterion.text,
      required: criterion.required,
      min_sources: criterion.minSources,
      evidence: eligible.length,
      independent_sources: domains.length,
      covered: domains.length >= criterion.minSources,
      freshness_required: criterion.freshnessRequired,
      freshness_max_age_days: freshnessMaxAgeDays,
    };
  });
}

export async function createSession(payload) {
  if (!isObject(payload)) fail("Initialization payload must be an object.");
  await cleanupExpired();
  const mode = payload.mode ?? "standard";
  if (!Object.hasOwn(MODES, mode))
    fail(`mode must be one of: ${Object.keys(MODES).join(", ")}.`);
  const now = new Date().toISOString();
  const sessionId = `research-${randomUUID()}`;
  const session = {
    version: VERSION,
    sessionId,
    createdAt: now,
    updatedAt: now,
    question: text(payload.question, "question", 10_000),
    mode,
    criteria: normalizeCriteria(payload.criteria),
    facets: normalizeFacets(payload.facets),
    budgets: normalizeBudgets(mode, payload.budgets),
    rounds: [],
    queries: [],
    fetches: [],
    evidence: [],
    gaps: [],
    contradictions: [],
    notes: [],
  };
  await ensureRoot();
  const path = sessionPath(sessionId);
  await atomicWrite(path, session, true);
  return {
    session_id: sessionId,
    path,
    mode,
    budgets: session.budgets,
    criteria: session.criteria.map(
      ({
        id,
        text: criterionText,
        minSources,
        freshnessRequired,
        freshnessMaxAgeDays,
      }) => ({
        id,
        text: criterionText,
        min_sources: minSources,
        freshness_required: freshnessRequired,
        freshness_max_age_days: freshnessMaxAgeDays,
      }),
    ),
  };
}

function validateFacet(session, facet, label) {
  if (facet == null) return undefined;
  const value = text(facet, label, 80);
  if (!session.facets.some((entry) => entry.id === value))
    fail(`${label} references unknown facet ${value}.`);
  return value;
}

function validateCriteria(session, values, label) {
  const ids = array(values, label, 30).map((value, index) =>
    text(value, `${label}[${index}]`, 80),
  );
  for (const id of ids)
    if (!session.criteria.some((entry) => entry.id === id))
      fail(`${label} references unknown criterion ${id}.`);
  return [...new Set(ids)];
}

function sourceTier(value) {
  const tier = value ?? "unknown";
  if (!SOURCE_TIERS.has(tier))
    fail(`source_tier must be one of: ${[...SOURCE_TIERS].join(", ")}.`);
  return tier;
}

function enforceRoundBudgets(session, queryEntries, fetchEntries) {
  if (session.rounds.length + 1 > session.budgets.rounds)
    fail(
      `Research round budget of ${session.budgets.rounds} would be exceeded.`,
      "budget_exceeded",
    );
  if (session.queries.length + queryEntries.length > session.budgets.searches)
    fail(
      `Research search budget of ${session.budgets.searches} would be exceeded.`,
      "budget_exceeded",
    );

  const fetchUrls = fetchEntries.map((entry, index) => {
    const item = typeof entry === "string" ? { url: entry } : entry;
    if (!isObject(item)) fail(`fetches[${index}] must be a string or object.`);
    return canonicalUrl(item.url);
  });
  const existingUrls = new Set(session.fetches.map((entry) => entry.url));
  const newUrls = new Set(fetchUrls.filter((url) => !existingUrls.has(url)));
  if (session.fetches.length + newUrls.size > session.budgets.fetches)
    fail(
      `Research fetch budget of ${session.budgets.fetches} would be exceeded.`,
      "budget_exceeded",
    );
  return fetchUrls;
}

export async function ingestRound(sessionId, payload) {
  if (!isObject(payload)) fail("Round payload must be an object.");
  const session = await loadSession(sessionId);
  const queryEntries = array(payload.queries, "queries", 50);
  const fetchEntries = array(payload.fetches, "fetches", 100);
  const fetchUrls = enforceRoundBudgets(session, queryEntries, fetchEntries);
  const roundNumber = session.rounds.length + 1;
  const now = new Date().toISOString();
  let duplicateQueries = 0;
  let newQueries = 0;
  let newFetches = 0;
  let newEvidence = 0;

  for (const [index, entry] of queryEntries.entries()) {
    const item = typeof entry === "string" ? { query: entry } : entry;
    if (!isObject(item)) fail(`queries[${index}] must be a string or object.`);
    const query = text(item.query, `queries[${index}].query`, 500);
    const normalized = normalizeQuery(query);
    let duplicateOf;
    let maximumSimilarity = 0;
    for (const previous of session.queries) {
      const similarity = querySimilarity(normalized, previous.normalized);
      if (similarity > maximumSimilarity) {
        maximumSimilarity = similarity;
        if (similarity >= 0.8) duplicateOf = previous.query;
      }
    }
    const duplicate = maximumSimilarity >= 0.8;
    if (duplicate) duplicateQueries++;
    else newQueries++;
    session.queries.push({
      query,
      normalized,
      facet: validateFacet(session, item.facet, `queries[${index}].facet`),
      resultCount: boundedInteger(
        item.result_count ?? item.resultCount,
        `queries[${index}].result_count`,
        0,
        100,
        0,
      ),
      duplicate,
      duplicateOf,
      similarity: Number(maximumSimilarity.toFixed(3)),
      round: roundNumber,
      at: now,
    });
  }

  for (const [index, entry] of fetchEntries.entries()) {
    const item = typeof entry === "string" ? { url: entry } : entry;
    const url = fetchUrls[index];
    const existing = session.fetches.find((previous) => previous.url === url);
    if (!existing) {
      session.fetches.push({
        url,
        title: text(item.title, `fetches[${index}].title`, 1_000, false),
        round: roundNumber,
        at: now,
      });
      newFetches++;
    } else if (!existing.title && item.title)
      existing.title = text(item.title, `fetches[${index}].title`, 1_000);
  }

  for (const [index, entry] of array(
    payload.evidence,
    "evidence",
    100,
  ).entries()) {
    if (!isObject(entry)) fail(`evidence[${index}] must be an object.`);
    const url = canonicalUrl(entry.url);
    if (!session.fetches.some((fetch) => fetch.url === url))
      fail(
        `evidence[${index}] references a URL that was not recorded as fetched.`,
      );
    const claim = text(entry.claim, `evidence[${index}].claim`, 2_000);
    const key = `${url}\n${normalizeQuery(claim)}`;
    if (session.evidence.some((card) => card.key === key)) continue;
    const tier = sourceTier(entry.source_tier ?? entry.sourceTier);
    session.evidence.push({
      id: nextId("E", session.evidence),
      key,
      claim,
      url,
      title: text(entry.title, `evidence[${index}].title`, 1_000, false),
      excerpt: text(entry.excerpt, `evidence[${index}].excerpt`, 2_000),
      sourceTier: tier,
      authorityScore: SOURCE_SCORES[tier],
      publishedAt: publicationDate(
        entry.published_at ?? entry.publishedAt,
        `evidence[${index}].published_at`,
      ),
      confidence: boundedNumber(
        entry.confidence,
        `evidence[${index}].confidence`,
        0,
        1,
        0.7,
      ),
      supports: validateCriteria(
        session,
        entry.supports,
        `evidence[${index}].supports`,
      ),
      facet: validateFacet(session, entry.facet, `evidence[${index}].facet`),
      verificationStatus: "pending",
      round: roundNumber,
      at: now,
    });
    newEvidence++;
  }

  for (const [index, entry] of array(payload.gaps, "gaps", 50).entries()) {
    const item = typeof entry === "string" ? { text: entry } : entry;
    if (!isObject(item)) fail(`gaps[${index}] must be a string or object.`);
    const gapText = text(item.text, `gaps[${index}].text`, 1_000);
    if (
      !session.gaps.some(
        (gap) =>
          gap.status === "open" &&
          normalizeQuery(gap.text) === normalizeQuery(gapText),
      )
    ) {
      session.gaps.push({
        id: nextId("G", session.gaps),
        text: gapText,
        criterion: item.criterion
          ? validateCriteria(
              session,
              [item.criterion],
              `gaps[${index}].criterion`,
            )[0]
          : undefined,
        status: "open",
        round: roundNumber,
      });
    }
  }
  for (const [index, id] of array(
    payload.resolve_gaps ?? payload.resolveGaps,
    "resolve_gaps",
    50,
  ).entries()) {
    const value = text(id, `resolve_gaps[${index}]`, 20);
    const gap = session.gaps.find((entry) => entry.id === value);
    if (!gap) fail(`Unknown gap ID: ${value}.`);
    gap.status = "resolved";
    gap.resolvedAt = now;
  }

  for (const [index, entry] of array(
    payload.contradictions,
    "contradictions",
    30,
  ).entries()) {
    if (!isObject(entry)) fail(`contradictions[${index}] must be an object.`);
    const claim = text(entry.claim, `contradictions[${index}].claim`, 1_000);
    const evidenceIds = array(
      entry.evidence_ids ?? entry.evidenceIds,
      `contradictions[${index}].evidence_ids`,
      20,
    ).map((id) => text(id, "evidence_id", 20));
    for (const id of evidenceIds)
      if (!session.evidence.some((card) => card.id === id))
        fail(`Unknown evidence ID in contradiction: ${id}.`);
    session.contradictions.push({
      id: nextId("C", session.contradictions),
      claim,
      evidenceIds,
      status: "open",
      round: roundNumber,
    });
  }
  for (const [index, entry] of array(
    payload.resolve_contradictions ?? payload.resolveContradictions,
    "resolve_contradictions",
    30,
  ).entries()) {
    if (!isObject(entry))
      fail(`resolve_contradictions[${index}] must be an object.`);
    const id = text(entry.id, `resolve_contradictions[${index}].id`, 20);
    const contradiction = session.contradictions.find((item) => item.id === id);
    if (!contradiction) fail(`Unknown contradiction ID: ${id}.`);
    contradiction.status = "resolved";
    contradiction.resolution = text(
      entry.resolution,
      `resolve_contradictions[${index}].resolution`,
      1_000,
    );
    contradiction.resolvedAt = now;
  }

  for (const [index, id] of array(
    payload.resolve_facets ?? payload.resolveFacets,
    "resolve_facets",
    30,
  ).entries()) {
    const value = text(id, `resolve_facets[${index}]`, 80);
    const facet = session.facets.find((entry) => entry.id === value);
    if (!facet) fail(`Unknown facet ID: ${value}.`);
    facet.status = "resolved";
  }
  for (const [index, note] of array(payload.notes, "notes", 30).entries())
    session.notes.push({
      text: text(note, `notes[${index}]`, 1_000),
      round: roundNumber,
      at: now,
    });

  session.rounds.push({
    round: roundNumber,
    at: now,
    queries: newQueries + duplicateQueries,
    duplicateQueries,
    newQueries,
    newFetches,
    newEvidence,
  });
  session.updatedAt = now;
  await atomicWrite(sessionPath(sessionId), session);
  return sessionStatus(session);
}

export function sessionStatus(session) {
  const coverage = criterionCoverage(session);
  const required = coverage.filter((entry) => entry.required);
  const covered = required.filter((entry) => entry.covered);
  const openGaps = session.gaps.filter((entry) => entry.status === "open");
  const openContradictions = session.contradictions.filter(
    (entry) => entry.status === "open",
  );
  const openFacets = session.facets.filter(
    (entry) => entry.status !== "resolved",
  );
  let stagnantRounds = 0;
  for (const round of [...session.rounds].reverse()) {
    if (round.newEvidence > 0) break;
    stagnantRounds++;
  }
  const duplicateQueries = session.queries.filter(
    (query) => query.duplicate,
  ).length;
  const used = {
    rounds: session.rounds.length,
    searches: session.queries.length,
    fetches: session.fetches.length,
  };
  const exhausted = Object.entries(used)
    .filter(([key, value]) => value >= session.budgets[key])
    .map(([key]) => key);
  const complete =
    required.length > 0 &&
    covered.length === required.length &&
    openGaps.length === 0 &&
    openContradictions.length === 0;
  let recommended = false;
  let reason =
    "Continue with the highest-value uncovered criterion or open gap.";
  if (complete) {
    recommended = true;
    reason =
      "All required criteria meet source coverage and no gaps or contradictions remain.";
  } else if (exhausted.length) {
    recommended = true;
    reason = `Budget exhausted: ${exhausted.join(", ")}. Report remaining uncertainty.`;
  } else if (stagnantRounds >= 2) {
    recommended = true;
    reason =
      "Two consecutive rounds produced no new evidence; reformulation has low expected value.";
  }
  return {
    session_id: session.sessionId,
    mode: session.mode,
    question: clip(session.question, 300),
    progress: {
      used,
      budgets: session.budgets,
      evidence_cards: session.evidence.length,
      coverage: `${covered.length}/${required.length}`,
      open_facets: openFacets.map((entry) => entry.id),
      open_gaps: openGaps.map((entry) => ({
        id: entry.id,
        text: clip(entry.text, 200),
      })),
      open_contradictions: openContradictions.map((entry) => ({
        id: entry.id,
        claim: clip(entry.claim, 200),
      })),
      stagnant_rounds: stagnantRounds,
      duplicate_query_rate: session.queries.length
        ? Number((duplicateQueries / session.queries.length).toFixed(3))
        : 0,
    },
    criteria: coverage,
    stop: { recommended, reason },
    ledger_path: sessionPath(session.sessionId),
  };
}

export async function getStatus(sessionId) {
  return sessionStatus(await loadSession(sessionId));
}

export async function verifyEvidence(sessionId, payload) {
  if (!isObject(payload)) fail("Verification payload must be an object.");
  const session = await loadSession(sessionId);
  const now = new Date().toISOString();
  for (const [index, entry] of array(
    payload.evidence,
    "evidence",
    100,
  ).entries()) {
    if (!isObject(entry)) fail(`evidence[${index}] must be an object.`);
    const id = text(entry.id, `evidence[${index}].id`, 20);
    const card = session.evidence.find((item) => item.id === id);
    if (!card) fail(`Unknown evidence ID: ${id}.`);
    const status = entry.status;
    if (status !== "verified" && status !== "rejected")
      fail(`evidence[${index}].status must be verified or rejected.`);
    card.verificationStatus = status;
    card.verificationNote = text(
      entry.note,
      `evidence[${index}].note`,
      1_000,
      false,
    );
    card.verifiedAt = now;
  }
  session.updatedAt = now;
  await atomicWrite(sessionPath(sessionId), session);
  return auditSession(sessionId);
}

export async function auditSession(sessionId) {
  const session = await loadSession(sessionId);
  const status = sessionStatus(session);
  const verifiedCoverage = criterionCoverage(session, true);
  const issues = [];
  for (const criterion of verifiedCoverage) {
    if (criterion.required && !criterion.covered)
      issues.push({
        severity: "error",
        code: "criterion_uncovered",
        criterion: criterion.id,
        message: `Needs ${criterion.min_sources} independent qualifying source(s); has ${criterion.independent_sources}.`,
      });
  }
  for (const gap of status.progress.open_gaps)
    issues.push({ severity: "error", code: "open_gap", ...gap });
  for (const contradiction of status.progress.open_contradictions)
    issues.push({
      severity: "error",
      code: "open_contradiction",
      ...contradiction,
    });
  for (const card of session.evidence) {
    if (!card.title)
      issues.push({
        severity: "warning",
        code: "missing_title",
        evidence_id: card.id,
      });
    if (card.sourceTier === "unknown" || card.sourceTier === "community")
      issues.push({
        severity: "warning",
        code: "weak_source",
        evidence_id: card.id,
        source_tier: card.sourceTier,
      });
    if (!card.excerpt)
      issues.push({
        severity: "error",
        code: "missing_excerpt",
        evidence_id: card.id,
      });
    if (card.verificationStatus === "pending")
      issues.push({
        severity: "error",
        code: "pending_verification",
        evidence_id: card.id,
      });
  }
  const blocking = issues.filter((issue) => issue.severity === "error");
  return {
    session_id: sessionId,
    ready: blocking.length === 0,
    issues,
    verified_criteria: verifiedCoverage,
    semantic_verification: session.evidence
      .filter((card) => card.verificationStatus === "pending")
      .slice(0, 50)
      .map((card) => ({
        evidence_id: card.id,
        claim: clip(card.claim, 300),
        excerpt: clip(card.excerpt, 400),
        url: card.url,
        instruction:
          "Confirm this fetched excerpt directly supports the exact claim; then mark verified or rejected.",
      })),
    stop: status.stop,
  };
}

export async function exportSession(sessionId) {
  const session = await loadSession(sessionId);
  const audit = await auditSession(sessionId);
  return {
    session_id: sessionId,
    question: session.question,
    mode: session.mode,
    criteria: criterionCoverage(session),
    evidence: session.evidence.slice(0, 100).map((card) => ({
      id: card.id,
      claim: card.claim,
      url: card.url,
      title: card.title,
      excerpt: clip(card.excerpt, 600),
      source_tier: card.sourceTier,
      authority_score: card.authorityScore,
      published_at: card.publishedAt,
      confidence: card.confidence,
      supports: card.supports,
      verification_status: card.verificationStatus,
      verification_note: card.verificationNote,
    })),
    contradictions: session.contradictions,
    unresolved_gaps: session.gaps.filter((gap) => gap.status === "open"),
    sources: [
      ...new Map(
        session.evidence.map((card) => [
          card.url,
          { url: card.url, title: card.title, source_tier: card.sourceTier },
        ]),
      ).values(),
    ],
    audit: { ready: audit.ready, issues: audit.issues, stop: audit.stop },
    trajectory: {
      rounds: session.rounds,
      queries: session.queries.map(({ query, facet, duplicate, round }) => ({
        query,
        facet,
        duplicate,
        round,
      })),
      fetch_count: session.fetches.length,
    },
    ledger_path: sessionPath(sessionId),
  };
}

async function main() {
  const [command, sessionId] = process.argv.slice(2);
  if (command === "init") return createSession(await readStdin());
  if (command === "ingest") {
    if (!sessionId) fail("Usage: ledger.mjs ingest <session-id>");
    return ingestRound(sessionId, await readStdin());
  }
  if (command === "status") {
    if (!sessionId) fail("Usage: ledger.mjs status <session-id>");
    return getStatus(sessionId);
  }
  if (command === "audit") {
    if (!sessionId) fail("Usage: ledger.mjs audit <session-id>");
    return auditSession(sessionId);
  }
  if (command === "verify") {
    if (!sessionId) fail("Usage: ledger.mjs verify <session-id>");
    return verifyEvidence(sessionId, await readStdin());
  }
  if (command === "export") {
    if (!sessionId) fail("Usage: ledger.mjs export <session-id>");
    return exportSession(sessionId);
  }
  fail(
    "Usage: ledger.mjs <init|ingest|status|audit|verify|export> [session-id]",
  );
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main()
    .then((result) =>
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`),
    )
    .catch((error) => {
      process.stderr.write(
        `${JSON.stringify({ error: { code: error.code ?? "ledger_error", message: error.message } })}\n`,
      );
      process.exitCode = 1;
    });
}
