import { describe, expect, it } from "vitest";

import { i18n } from "./i18n";
import { PRIVACY_OUTCOMES, requestPrivacyAudit } from "./request-privacy-audit";
import {
  emptyTrajectoryFields,
  type RequestRecord,
  type PrivacyDecision,
} from "./request-record-model";

const base: RequestRecord = {
  id: "req_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  parent_request_id: null,
  attempt_index: 1,
  child_count: 0,
  started_at: "2026-08-16T10:00:00Z",
  completed_at: "2026-08-16T10:00:02Z",
  status: "succeeded",
  input_protocol: "openai.responses",
  requested_model: "gpt-4.1",
  streaming: true,
  route_id: "route_01",
  service_id: "service_01",
  local_access_token_id: null,
  http_status: 200,
  latency_ms: 2000,
  usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
  error: null,
  audit: {
    request_body_captured: false,
    response_content_captured: false,
    request_body_truncated: false,
    response_content_truncated: false,
    upstream_request_body_captured: false,
    upstream_response_content_captured: false,
    upstream_request_body_truncated: false,
    upstream_response_content_truncated: false,
  },
  privacy_restore: null,
  ...emptyTrajectoryFields,
};

function record(overrides: Partial<RequestRecord> = {}): RequestRecord {
  return { ...base, ...overrides };
}

function redacted(
  id: string,
  mapping: number,
  restored: number,
  fallback = 0,
): RequestRecord {
  return record({
    id,
    privacy_decision: "redact",
    privacy_restore: {
      enabled: true,
      mapping_count: mapping,
      restored_count: restored,
      visible_restored_count: restored,
      tool_argument_restored_count: 0,
      fallback_count: fallback,
      hits: [
        { kind: "email", count: 1 },
        { kind: "phone", count: 1 },
      ],
    },
  });
}

describe("request privacy audit", () => {
  it("reads the recorded decision first", () => {
    const decisions: Array<[PrivacyDecision, string]> = [
      ["none", "off"],
      ["allow", "clean"],
      ["warn", "warned"],
      ["redact", "redacted"],
      ["block", "blocked"],
      ["fail_open", "unchecked"],
    ];
    for (const [decision, outcome] of decisions) {
      const summary = requestPrivacyAudit([
        record({ privacy_decision: decision }),
      ]);
      expect(summary.outcome).toBe(outcome);
      expect(summary.calls[0].outcome).toBe(outcome);
    }
  });

  it("falls back to the record's evidence for rows without a decision", () => {
    // A blocked row carries no restore summary, only findings.
    const blocked = requestPrivacyAudit([
      record({
        status: "blocked",
        privacy_findings: [
          { kind: "common_secret", json_path: "/*/content", count: 2 },
        ],
      }),
    ]);
    expect(blocked.outcome).toBe("blocked");
    expect(blocked.calls[0].kinds).toEqual([
      {
        kind: "common_secret",
        label: i18n.t("privacy.common_secret"),
        count: 2,
      },
    ]);

    // A restore summary is written only when values were replaced.
    expect(requestPrivacyAudit([redacted("req_a", 2, 1)]).outcome).toBe(
      "redacted",
    );
    // No decision, no summary, no privacy event: nothing was recorded.
    expect(requestPrivacyAudit([record()]).outcome).toBe("unknown");
  });

  it("reads a failed inspection from Core's own summary", () => {
    const failed = requestPrivacyAudit([
      record({
        status: "failed",
        error: {
          category: "runtime",
          code: "safety_engine_unavailable",
          message: "local safety engine is unavailable",
          retryable: true,
        },
        events: [
          {
            kind: "privacy",
            started_at: base.started_at,
            ended_at: base.completed_at,
            status: "failed",
            summary: "safety_engine_unavailable · detector_timeout · batch 2/5",
            attempt_index: 1,
          },
        ],
      }),
    ]);
    expect(failed.outcome).toBe("failed");
    expect(failed.calls[0].detail).toContain("detector_timeout");
  });

  it("totals replacements, restores and unrestored parts across calls", () => {
    const summary = requestPrivacyAudit([
      redacted("req_a", 3, 3),
      record({ id: "req_b", privacy_decision: "allow" }),
      redacted("req_c", 2, 0, 1),
    ]);
    expect(summary.callCount).toBe(3);
    expect(summary.replaced).toBe(5);
    expect(summary.restored).toBe(3);
    expect(summary.unrestored).toBe(1);
    expect(summary.redactedCalls).toBe(2);
    // The worst call names the session, not the last one read.
    expect(summary.outcome).toBe("redacted");
    expect(summary.kinds).toEqual([
      { kind: "email", label: i18n.t("privacy.email"), count: 2 },
      { kind: "phone", label: i18n.t("privacy.phone"), count: 2 },
    ]);
  });

  it("lets a block outrank a redaction in the header", () => {
    const summary = requestPrivacyAudit([
      redacted("req_a", 3, 3),
      record({ id: "req_b", privacy_decision: "block", status: "blocked" }),
    ]);
    expect(summary.outcome).toBe("blocked");
    expect(summary.blockedCalls).toBe(1);
    expect(summary.redactedCalls).toBe(1);
  });

  it("keeps every outcome named in both locales", () => {
    for (const outcome of PRIVACY_OUTCOMES) {
      for (const locale of ["en", "zh-CN"] as const) {
        const options = { lng: locale };
        expect(i18n.t(`privacyAudit.outcome.${outcome}`, options)).not.toBe(
          `privacyAudit.outcome.${outcome}`,
        );
        const headline = i18n.t(`privacyAudit.headline.${outcome}`, {
          ...options,
          count: 1,
        });
        expect(headline).not.toBe(`privacyAudit.headline.${outcome}`);
        expect(headline).not.toContain("{{");
      }
    }
  });
});
