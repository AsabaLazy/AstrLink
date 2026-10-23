import { describe, expect, it } from "vitest";

import {
  ACTIVE_GRACE_MS,
  activitySnapshot,
  appendActivitySample,
  conversationActivity,
  splitActiveSessions,
} from "./request-activity-model";
import type { RequestSession } from "./request-record-model";

const NOW = Date.parse("2026-10-23T01:00:00Z");
const at = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

function session(overrides: Partial<RequestSession> = {}): RequestSession {
  return {
    id: "session_a",
    title: "fix the login redirect",
    started_at: at(-600_000),
    last_started_at: at(-30_000),
    completed_at: at(-20_000),
    duration_ms: 10_000,
    active_request_starts: [],
    turn_count: 1,
    call_count: 3,
    status: "succeeded",
    requested_model: "claude-opus-5-5",
    input_protocol: "anthropic.messages",
    service_id: "service_01",
    local_access_token_id: null,
    ...overrides,
  };
}

const running = (overrides: Partial<RequestSession> = {}) =>
  session({
    status: "pending",
    completed_at: null,
    active_request_starts: [at(-12_000)],
    ...overrides,
  });

describe("conversationActivity", () => {
  it("dates a running conversation from its oldest running call", () => {
    expect(
      conversationActivity(
        running({ active_request_starts: [at(-12_000), at(-3_000)] }),
        NOW,
      ),
    ).toEqual({ state: "calling", since: NOW - 12_000, calls: 2 });
  });

  it("falls back to the latest start for a pending conversation without starts", () => {
    expect(
      conversationActivity(running({ active_request_starts: [] }), NOW),
    ).toEqual({ state: "calling", since: NOW - 30_000, calls: 1 });
  });

  it("keeps a conversation between calls until the grace runs out", () => {
    expect(conversationActivity(session(), NOW)).toEqual({
      state: "idle",
      since: NOW - 20_000,
    });
    const ended = session({ completed_at: at(-ACTIVE_GRACE_MS) });
    expect(conversationActivity(ended, NOW)).toBeNull();
    expect(conversationActivity(ended, NOW - 1)).not.toBeNull();
  });

  it("leaves out model discovery and conversations without an end", () => {
    expect(
      conversationActivity(running({ input_protocol: "openai.models" }), NOW),
    ).toBeNull();
    expect(
      conversationActivity(session({ completed_at: null }), NOW),
    ).toBeNull();
  });
});

describe("activitySnapshot", () => {
  it("counts conversations, running calls, the oldest call and recent failures", () => {
    const sessions = [
      running({ id: "a", active_request_starts: [at(-40_000), at(-5_000)] }),
      running({ id: "b", active_request_starts: [at(-8_000)] }),
      session({ id: "c" }),
      session({ id: "d", completed_at: at(-90_000) }),
      session({ id: "e", status: "failed", completed_at: at(-120_000) }),
      session({ id: "f", status: "failed", completed_at: at(-301_000) }),
      session({
        id: "g",
        status: "failed",
        input_protocol: "google.models",
        completed_at: at(-1_000),
      }),
    ];
    expect(activitySnapshot(sessions, NOW)).toEqual({
      conversations: 3,
      calls: 3,
      oldestCallStart: NOW - 40_000,
      failures: 1,
    });
  });

  it("reports no oldest call while nothing runs", () => {
    expect(activitySnapshot([session()], NOW)).toEqual({
      conversations: 1,
      calls: 0,
      oldestCallStart: null,
      failures: 0,
    });
  });
});

describe("appendActivitySample", () => {
  it("keeps the window plus the sample holding its left edge", () => {
    const samples = [
      { at: NOW - 400_000, value: 1 },
      { at: NOW - 350_000, value: 2 },
      { at: NOW - 200_000, value: 3 },
    ];
    expect(appendActivitySample(samples, { at: NOW, value: 4 })).toEqual([
      { at: NOW - 350_000, value: 2 },
      { at: NOW - 200_000, value: 3 },
      { at: NOW, value: 4 },
    ]);
  });

  it("drops samples a clock set back left in the future", () => {
    expect(
      appendActivitySample([{ at: NOW + 5_000, value: 9 }], {
        at: NOW,
        value: 1,
      }),
    ).toEqual([{ at: NOW, value: 1 }]);
  });
});

describe("splitActiveSessions", () => {
  it("leads with conversations in progress, newest conversation first", () => {
    const older = running({ id: "older", started_at: at(-900_000) });
    const newer = session({ id: "newer", started_at: at(-60_000) });
    const settled = session({ id: "settled", completed_at: at(-120_000) });
    const { active, rest } = splitActiveSessions([older, settled, newer], NOW);
    expect(active.map((item) => item.id)).toEqual(["newer", "older"]);
    expect(rest.map((item) => item.id)).toEqual(["settled"]);
  });
});
