import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  auditSession,
  cleanupExpired,
  createSession,
  ensureRoot,
  exportSession,
  getStatus,
  ingestRound,
  verifyEvidence,
} from "../scripts/ledger.mjs";

async function withLedger(callback) {
  const directory = await mkdtemp(join(tmpdir(), "pi-web-research-test-"));
  const previous = process.env.PI_WEB_RESEARCH_DIR;
  process.env.PI_WEB_RESEARCH_DIR = directory;
  try {
    await callback(directory);
  } finally {
    if (previous === undefined) delete process.env.PI_WEB_RESEARCH_DIR;
    else process.env.PI_WEB_RESEARCH_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
}

function daysAgo(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1_000)
    .toISOString()
    .slice(0, 10);
}

const initial = {
  question: "What is the supported answer?",
  mode: "standard",
  criteria: [{ id: "answer", text: "Establish the answer", min_sources: 1 }],
  facets: [{ id: "records", text: "Find primary records" }],
};

test("fails when private ledger directory permissions cannot be enforced", async () => {
  const failure = Object.assign(new Error("chmod denied"), { code: "EACCES" });
  await assert.rejects(
    ensureRoot({
      mkdir: async () => undefined,
      chmod: async () => {
        throw failure;
      },
    }),
    (error) => error === failure,
  );
});

test("propagates ledger directory read failures during cleanup", async () => {
  const failure = Object.assign(new Error("readdir denied"), {
    code: "EACCES",
  });
  await assert.rejects(
    cleanupExpired({
      mkdir: async () => undefined,
      chmod: async () => undefined,
      readdir: async () => {
        throw failure;
      },
    }),
    (error) => error === failure,
  );
});

test("creates a private bounded session", () =>
  withLedger(async (directory) => {
    const created = await createSession(initial);
    assert.match(created.session_id, /^research-/);
    assert.deepEqual(created.budgets, {
      rounds: 3,
      searches: 5,
      fetches: 8,
      workers: 1,
    });
    const directoryMode = (await stat(directory)).mode & 0o777;
    const fileMode = (await stat(created.path)).mode & 0o777;
    assert.equal(directoryMode, 0o700);
    assert.equal(fileMode, 0o600);
  }));

test("requires fetched evidence and verifies claims before audit readiness", () =>
  withLedger(async () => {
    const created = await createSession(initial);
    await assert.rejects(
      ingestRound(created.session_id, {
        evidence: [
          {
            claim: "A",
            url: "https://example.com/a",
            excerpt: "A",
            supports: ["answer"],
          },
        ],
      }),
      /not recorded as fetched/,
    );
    const status = await ingestRound(created.session_id, {
      queries: [
        {
          query: "exact answer primary record",
          facet: "records",
          result_count: 5,
        },
      ],
      fetches: [
        {
          url: "https://example.com/a?utm_source=test",
          title: "Primary record",
        },
      ],
      evidence: [
        {
          claim: "The answer is A.",
          url: "https://example.com/a",
          title: "Primary record",
          excerpt: "The answer is A.",
          source_tier: "primary",
          confidence: 1,
          supports: ["answer"],
          facet: "records",
        },
      ],
      resolve_facets: ["records"],
    });
    assert.equal(status.stop.recommended, true);
    assert.equal(status.progress.coverage, "1/1");
    const before = await auditSession(created.session_id);
    assert.equal(before.ready, false);
    assert.ok(
      before.issues.some((issue) => issue.code === "pending_verification"),
    );
    const after = await verifyEvidence(created.session_id, {
      evidence: [{ id: "E001", status: "verified", note: "Direct support." }],
    });
    assert.equal(after.ready, true);
    const exported = await exportSession(created.session_id);
    assert.equal(exported.evidence[0].verification_status, "verified");
    assert.equal(exported.sources[0].url, "https://example.com/a");
  }));

test("tracks duplicate queries and stops after two stagnant rounds", () =>
  withLedger(async () => {
    const created = await createSession({ ...initial, mode: "deep" });
    await ingestRound(created.session_id, {
      queries: ["node stable release official"],
    });
    const status = await ingestRound(created.session_id, {
      queries: ["official release stable node"],
    });
    assert.equal(status.progress.duplicate_query_rate, 0.5);
    assert.equal(status.progress.stagnant_rounds, 2);
    assert.equal(status.stop.recommended, true);
    assert.match(status.stop.reason, /no new evidence/);
  }));

test("rejects rounds, queries, and fetches beyond configured budgets", () =>
  withLedger(async () => {
    const created = await createSession({
      ...initial,
      budgets: { rounds: 2, searches: 1, fetches: 1 },
    });
    const isBudgetError = (error) => error?.code === "budget_exceeded";

    await assert.rejects(
      ingestRound(created.session_id, { queries: ["first", "second"] }),
      isBudgetError,
    );
    await assert.rejects(
      ingestRound(created.session_id, {
        fetches: ["https://one.example/a", "https://two.example/b"],
      }),
      isBudgetError,
    );
    let status = await getStatus(created.session_id);
    assert.deepEqual(status.progress.used, {
      rounds: 0,
      searches: 0,
      fetches: 0,
    });

    await ingestRound(created.session_id, {
      queries: ["bounded query"],
      fetches: ["https://one.example/a"],
    });
    await ingestRound(created.session_id, {});
    await assert.rejects(ingestRound(created.session_id, {}), isBudgetError);
    status = await getStatus(created.session_id);
    assert.deepEqual(status.progress.used, {
      rounds: 2,
      searches: 1,
      fetches: 1,
    });
  }));

test("enforces independent-domain and freshness criteria", () =>
  withLedger(async () => {
    const created = await createSession({
      question: "What is current?",
      mode: "standard",
      criteria: [
        {
          id: "current",
          text: "Current status",
          min_sources: 2,
          freshness_required: true,
        },
      ],
      facets: [],
    });
    await ingestRound(created.session_id, {
      fetches: ["https://one.example/report", "https://two.example/report"],
      evidence: [
        {
          claim: "Current status is active.",
          url: "https://one.example/report",
          excerpt: "Status: active",
          source_tier: "official",
          published_at: daysAgo(10),
          supports: ["current"],
        },
        {
          claim: "Current status remains active.",
          url: "https://two.example/report",
          excerpt: "It remains active",
          source_tier: "reputable",
          supports: ["current"],
        },
      ],
    });
    let status = await getStatus(created.session_id);
    assert.equal(status.criteria[0].covered, false);
    await ingestRound(created.session_id, {
      fetches: ["https://three.example/report"],
      evidence: [
        {
          claim: "Current status is active as of February.",
          url: "https://three.example/report",
          excerpt: "Active in February",
          source_tier: "government",
          published_at: daysAgo(5),
          supports: ["current"],
        },
      ],
    });
    status = await getStatus(created.session_id);
    assert.equal(status.criteria[0].covered, true);
    assert.equal(status.criteria[0].independent_sources, 2);
  }));

test("rejects malformed dates and excludes stale evidence from freshness coverage", () =>
  withLedger(async () => {
    const created = await createSession({
      question: "What changed recently?",
      mode: "standard",
      criteria: [
        {
          id: "recent",
          text: "Establish a recent change",
          freshness_required: true,
          freshness_max_age_days: 30,
        },
      ],
      facets: [],
    });

    await assert.rejects(
      ingestRound(created.session_id, {
        fetches: ["https://invalid.example/report"],
        evidence: [
          {
            claim: "Invalid date claim",
            url: "https://invalid.example/report",
            excerpt: "Claim",
            published_at: "unknown",
            supports: ["recent"],
          },
        ],
      }),
      (error) => error?.code === "invalid_input",
    );

    await ingestRound(created.session_id, {
      fetches: ["https://stale.example/report"],
      evidence: [
        {
          claim: "Stale claim",
          url: "https://stale.example/report",
          excerpt: "Old claim",
          published_at: daysAgo(40),
          supports: ["recent"],
        },
      ],
    });
    let audit = await verifyEvidence(created.session_id, {
      evidence: [{ id: "E001", status: "verified", note: "Verified old." }],
    });
    assert.equal(audit.ready, false);

    await ingestRound(created.session_id, {
      fetches: ["https://recent.example/report"],
      evidence: [
        {
          claim: "Recent claim",
          url: "https://recent.example/report",
          excerpt: "Recent claim",
          published_at: daysAgo(5),
          supports: ["recent"],
        },
      ],
    });
    audit = await verifyEvidence(created.session_id, {
      evidence: [{ id: "E002", status: "verified", note: "Verified recent." }],
    });
    assert.equal(audit.ready, true);
  }));

test("rejecting evidence removes it from verified coverage", () =>
  withLedger(async () => {
    const created = await createSession(initial);
    await ingestRound(created.session_id, {
      fetches: ["https://example.org/source"],
      evidence: [
        {
          claim: "Unsupported candidate",
          url: "https://example.org/source",
          excerpt: "Related but not exact",
          source_tier: "primary",
          supports: ["answer"],
        },
      ],
    });
    const audit = await verifyEvidence(created.session_id, {
      evidence: [
        { id: "E001", status: "rejected", note: "Does not entail claim." },
      ],
    });
    assert.equal(audit.ready, false);
    assert.ok(
      audit.issues.some((issue) => issue.code === "criterion_uncovered"),
    );
  }));
