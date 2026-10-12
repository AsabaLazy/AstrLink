import { i18n } from "./i18n";
import { privacyKindLabel, sortPrivacyKinds } from "./privacy-kind";
import type { RequestRecord, RequestStatus } from "./request-record-model";
import { groupTurns } from "./request-trajectory-model";

/**
 * What the privacy policy did to one call, as the audit tab states it. Every
 * value maps to one of Core's decisions, except `off`, `inspecting`, `failed`
 * and `unknown`, which describe why there is no decision to read.
 */
export type PrivacyOutcome =
  | "off"
  | "clean"
  | "warned"
  | "redacted"
  | "blocked"
  | "unchecked"
  | "inspecting"
  | "failed"
  | "unknown";

export interface PrivacyKindCount {
  kind: string;
  label: string;
  count: number;
}

/** One call's privacy result, with what it replaced and what it put back. */
export interface PrivacyCallAudit {
  recordId: string;
  /** 1-based position across the whole conversation. */
  index: number;
  /** 1-based user turn, null when the protocol has no turns. */
  turnIndex: number | null;
  /** 1-based position within its turn. */
  turnCallIndex: number;
  startedAt: string;
  status: RequestStatus;
  outcome: PrivacyOutcome;
  /** Why a failed or unfinished check stopped, taken from Core's own summary. */
  detail: string | null;
  kinds: PrivacyKindCount[];
  /** Distinct values replaced before the request went upstream. */
  replaced: number;
  restored: number;
  restoredVisible: number;
  restoredTools: number;
  /** Parts of the answer left with replacements still in them. */
  unrestored: number;
}

export interface PrivacyAuditSummary {
  calls: PrivacyCallAudit[];
  /** The outcome the header names, at the severity of the worst call. */
  outcome: PrivacyOutcome;
  callCount: number;
  replaced: number;
  restored: number;
  restoredVisible: number;
  restoredTools: number;
  unrestored: number;
  kinds: PrivacyKindCount[];
  blockedCalls: number;
  /** Calls that reached the model without a completed inspection. */
  uncheckedCalls: number;
  /** Calls no policy applied to, so the body went upstream untouched. */
  offCalls: number;
  warnedCalls: number;
  redactedCalls: number;
}

/**
 * A call whose privacy result is worth a row of its own: it changed, stopped,
 * or could not be inspected. Calls with nothing to report are counted in the
 * header instead, so a 40-call agent loop does not bury the one that mattered.
 */
export function notableCall(audit: PrivacyCallAudit): boolean {
  return audit.outcome !== "clean" && audit.outcome !== "off";
}

export function requestPrivacyAudit(
  turns: RequestRecord[],
): PrivacyAuditSummary {
  const calls: PrivacyCallAudit[] = [];
  let index = 0;
  for (const group of groupTurns(turns)) {
    group.records.forEach((record, position) => {
      index += 1;
      calls.push(callAudit(record, index, group.turnIndex, position + 1));
    });
  }

  const kindCounts = new Map<string, number>();
  const summary: PrivacyAuditSummary = {
    calls,
    outcome: "off",
    callCount: calls.length,
    replaced: 0,
    restored: 0,
    restoredVisible: 0,
    restoredTools: 0,
    unrestored: 0,
    kinds: [],
    blockedCalls: 0,
    uncheckedCalls: 0,
    offCalls: 0,
    warnedCalls: 0,
    redactedCalls: 0,
  };
  let worst: PrivacyOutcome = "clean";
  let seen = false;
  for (const call of calls) {
    summary.replaced += call.replaced;
    summary.restored += call.restored;
    summary.restoredVisible += call.restoredVisible;
    summary.restoredTools += call.restoredTools;
    summary.unrestored += call.unrestored;
    if (call.outcome === "blocked") summary.blockedCalls += 1;
    if (call.outcome === "unchecked") summary.uncheckedCalls += 1;
    if (call.outcome === "off") summary.offCalls += 1;
    if (call.outcome === "warned") summary.warnedCalls += 1;
    if (call.outcome === "redacted") summary.redactedCalls += 1;
    for (const { kind, count } of call.kinds) {
      kindCounts.set(kind, (kindCounts.get(kind) ?? 0) + count);
    }
    if (!seen) {
      seen = true;
      worst = call.outcome;
      continue;
    }
    if (outcomeSeverity(call.outcome) > outcomeSeverity(worst)) {
      worst = call.outcome;
    }
  }
  summary.outcome = seen ? worst : "unknown";
  summary.kinds = sortPrivacyKinds([...kindCounts.keys()]).map((kind) => ({
    kind,
    label: privacyKindLabel(kind),
    count: kindCounts.get(kind) ?? 0,
  }));
  return summary;
}

/**
 * Orders outcomes by how much the operator has to look at: a blocked call
 * first, then a call that went out uninspected, then one that was redacted.
 */
export function outcomeSeverity(outcome: PrivacyOutcome): number {
  switch (outcome) {
    case "blocked":
      return 9;
    case "unchecked":
      return 8;
    case "failed":
      return 7;
    case "redacted":
      return 6;
    case "warned":
      return 5;
    case "inspecting":
      return 4;
    case "unknown":
      return 3;
    case "clean":
      return 2;
    case "off":
      return 1;
  }
}

function callAudit(
  record: RequestRecord,
  index: number,
  turnIndex: number | null,
  turnCallIndex: number,
): PrivacyCallAudit {
  const restore = record.privacy_restore;
  const outcome = callOutcome(record);
  return {
    recordId: record.id,
    index,
    turnIndex,
    turnCallIndex,
    startedAt: record.started_at,
    status: record.status,
    outcome,
    detail: callDetail(record, outcome),
    kinds: callKinds(record),
    replaced: restore?.mapping_count ?? 0,
    restored: restore?.restored_count ?? 0,
    restoredVisible: restore?.visible_restored_count ?? 0,
    restoredTools: restore?.tool_argument_restored_count ?? 0,
    unrestored: restore?.fallback_count ?? 0,
  };
}

/**
 * Reads the recorded decision, and falls back to the record's own evidence for
 * rows written before decisions existed. A restore summary is recorded only
 * when values were replaced, and a blocked record has no summary at all.
 */
export function callOutcome(record: RequestRecord): PrivacyOutcome {
  switch (record.privacy_decision) {
    case "none":
      return "off";
    case "allow":
      return "clean";
    case "warn":
      return "warned";
    case "redact":
      return "redacted";
    case "block":
      return "blocked";
    case "fail_open":
      return "unchecked";
  }
  if (record.status === "blocked") return "blocked";
  if (record.status === "pending") return "inspecting";
  if (record.privacy_restore) return "redacted";
  const summary = privacyEventSummary(record);
  if (summary === null) return "unknown";
  const action = summary.split(" · ")[0];
  if (action === "allow") return "clean";
  if (action === "warn") return "warned";
  if (action === "block") return "blocked";
  if (action === "redact") return "redacted";
  return "failed";
}

/** What the policy found, by kind. Findings stand in for a blocked call. */
function callKinds(record: RequestRecord): PrivacyKindCount[] {
  const counts = new Map<string, number>();
  for (const hit of record.privacy_restore?.hits ?? []) {
    counts.set(hit.kind, (counts.get(hit.kind) ?? 0) + hit.count);
  }
  if (counts.size === 0) {
    for (const finding of record.privacy_findings ?? []) {
      counts.set(finding.kind, (counts.get(finding.kind) ?? 0) + finding.count);
    }
  }
  return sortPrivacyKinds([...counts.keys()]).map((kind) => ({
    kind,
    label: privacyKindLabel(kind),
    count: counts.get(kind) ?? 0,
  }));
}

/**
 * Core's own words for a stop that is not a decision, so the tab can name what
 * happened without inventing a reason. A decision is left to the badge.
 */
function callDetail(
  record: RequestRecord,
  outcome: PrivacyOutcome,
): string | null {
  if (
    outcome !== "failed" &&
    outcome !== "unchecked" &&
    outcome !== "inspecting"
  ) {
    return null;
  }
  const summary = privacyEventSummary(record);
  if (summary === null) {
    return outcome === "inspecting" ? null : (record.error?.code ?? null);
  }
  return summary;
}

function privacyEventSummary(record: RequestRecord): string | null {
  const event = [...record.events]
    .reverse()
    .find((item) => item.kind === "privacy");
  return event?.summary ?? null;
}

export function privacyOutcomeLabel(outcome: PrivacyOutcome): string {
  return i18n.t(`privacyAudit.outcome.${outcome}`);
}

export function privacyOutcomeTone(
  outcome: PrivacyOutcome,
): "blocked" | "negative" | "neutral" | "pending" {
  switch (outcome) {
    case "blocked":
      return "blocked";
    case "failed":
    case "unchecked":
      return "negative";
    case "redacted":
    case "warned":
    case "inspecting":
      return "pending";
    default:
      return "neutral";
  }
}

export function privacyKindCountLabel({
  label,
  count,
}: PrivacyKindCount): string {
  return i18n.t("privacyAudit.kindCount", { kind: label, count });
}

/** Every outcome the tab can name, so a missing label fails a test, not a render. */
export const PRIVACY_OUTCOMES: readonly PrivacyOutcome[] = [
  "off",
  "clean",
  "warned",
  "redacted",
  "blocked",
  "unchecked",
  "inspecting",
  "failed",
  "unknown",
];
