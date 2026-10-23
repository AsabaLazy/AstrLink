import { useEffect } from "react";

import { HelpPopover } from "@/components/HelpPopover";
import { LiveTrendChart } from "@/components/LiveTrendChart";
import { Metric, MetricGroup } from "@/components/Metric";
import { Panel } from "@/components/Panel";
import { ValueTransition } from "@/components/ValueTransition";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { listLiveRequestSessions } from "./bridge";
import { currentLocale, useT } from "./i18n";
import { useLiveClock } from "./live-clock";
import {
  ACTIVITY_SAMPLE_GAP_MS,
  ACTIVITY_WINDOW_MS,
  activitySnapshot,
  appendActivitySample,
  sameActivitySnapshot,
  type ActivitySample,
  type ActivitySnapshot,
} from "./request-activity-model";
import { formatDuration } from "./request-live-model";
import { useWorkspaceSnapshot } from "./workspace-snapshots";

const POLL_INTERVAL_MS = 1000;

interface LiveActivity {
  snapshot: ActivitySnapshot | null;
  samples: readonly ActivitySample[];
  /** When the newest snapshot was read. */
  at: number;
}

/**
 * Polls the newest conversations once a second and keeps five minutes of
 * samples. They live in the workspace snapshot, so leaving the page and coming
 * back keeps the chart; the time in between stays empty.
 */
function useLiveActivity(coreSessionKey: string | null, isReady: boolean) {
  const [live, setLive] = useWorkspaceSnapshot<LiveActivity>(
    `request-activity:${coreSessionKey}`,
    () => ({ snapshot: null, samples: [], at: Date.now() }),
  );
  useEffect(() => {
    if (!isReady) return;
    let cancelled = false;
    let inFlight = false;
    const poll = async () => {
      if (inFlight || document.visibilityState === "hidden") return;
      inFlight = true;
      try {
        const page = await listLiveRequestSessions();
        if (cancelled) return;
        const at = Date.now();
        const next = activitySnapshot(page.items, at);
        setLive((current) => ({
          snapshot: sameActivitySnapshot(current.snapshot, next)
            ? current.snapshot
            : next,
          samples: appendActivitySample(current.samples, {
            at,
            value: next.conversations,
          }),
          at,
        }));
      } catch {
        // The list below reports sync trouble; the chart shows the gap.
      } finally {
        inFlight = false;
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [isReady, setLive]);
  return live;
}

/** How long the oldest running call has run; its own clock ticks the label. */
function LongestCall({ since }: { since: number | null }) {
  const nowMs = useLiveClock(since !== null);
  return (
    <>{since === null ? "—" : formatDuration(Math.max(0, nowMs - since))}</>
  );
}

function Unit({ children }: { children: string }) {
  return (
    <span className="ml-1 text-xs font-normal tracking-normal text-muted-foreground">
      {children}
    </span>
  );
}

/**
 * The live band above the request list: how many conversations are going on
 * right now, how many calls they run, the longest one, recent failures, and
 * how the count moved over the last five minutes. It covers every model call,
 * whatever the list below is filtered to.
 */
export function RequestActivityBoard({
  coreSessionKey,
  isReady,
  onShowFailures,
}: {
  coreSessionKey: string | null;
  isReady: boolean;
  onShowFailures: () => void;
}) {
  const t = useT();
  const live = useLiveActivity(coreSessionKey, isReady);
  const snapshot = isReady ? live.snapshot : null;
  const conversations = snapshot?.conversations ?? null;
  const failures = snapshot?.failures ?? 0;
  const peak = Math.max(0, ...live.samples.map((sample) => sample.value));
  const timeFormat = new Intl.DateTimeFormat(currentLocale(), {
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    hour12: false,
  });

  return (
    <Panel
      aria-label={t("records.activityTitle")}
      className="grid shrink-0 grid-cols-[minmax(0,auto)_minmax(10rem,1fr)]"
      data-testid="request-activity"
      role="region"
    >
      <MetricGroup className="grid-cols-[repeat(2,minmax(6.5rem,auto))] border-r @min-[640px]/workspace-surface:grid-cols-[repeat(4,minmax(6.5rem,auto))]">
        <Metric
          label={
            <span className="inline-flex items-center gap-0.5">
              {t("records.activityInProgress")}
              {/* The help button is taller than the label line; keep the row even. */}
              <span className="-my-1 inline-flex">
                <HelpPopover label={t("records.activityInProgressHelp")}>
                  {t("records.activityInProgressHint")}
                </HelpPopover>
              </span>
            </span>
          }
          size="sm"
          value={
            <span data-testid="activity-conversations">
              <ValueTransition valueKey={String(conversations)}>
                {conversations ?? "—"}
              </ValueTransition>
              {conversations === null ? null : (
                <Unit>
                  {t("records.activityConversations", {
                    count: conversations,
                  })}
                </Unit>
              )}
            </span>
          }
        />
        <Metric
          label={t("records.activityCalls")}
          size="sm"
          value={
            <ValueTransition
              data-testid="activity-calls"
              valueKey={String(snapshot?.calls)}
            >
              {snapshot?.calls ?? "—"}
            </ValueTransition>
          }
        />
        <Metric
          className="@max-[639px]/workspace-surface:hidden"
          label={t("records.activityLongest")}
          size="sm"
          value={
            <span data-testid="activity-longest">
              <LongestCall since={snapshot?.oldestCallStart ?? null} />
            </span>
          }
        />
        <Metric
          className="@max-[639px]/workspace-surface:hidden"
          label={t("records.activityFailures")}
          size="sm"
          value={
            failures > 0 ? (
              <Button
                aria-label={t("records.activityShowFailures", {
                  count: failures,
                })}
                className="h-auto rounded-sm p-0 text-lg leading-6 font-semibold text-destructive"
                data-testid="activity-failures"
                onClick={onShowFailures}
                type="button"
                variant="link"
              >
                {failures}
              </Button>
            ) : (
              <span data-testid="activity-failures">{snapshot ? 0 : "—"}</span>
            )
          }
        />
      </MetricGroup>
      <LiveTrendChart
        aside={t("records.activityWindow")}
        className={cn("px-3 pt-2.5 pb-1.5", !isReady && "opacity-60")}
        formatReadout={(point) =>
          t("records.activityReadout", {
            count: point.value,
            time: timeFormat.format(point.at),
          })
        }
        gapMs={ACTIVITY_SAMPLE_GAP_MS}
        label={t("records.activityChart", {
          current: conversations ?? 0,
          peak,
        })}
        nowMs={live.at}
        points={live.samples}
        title={t("records.activityChartTitle")}
        windowMs={ACTIVITY_WINDOW_MS}
      />
    </Panel>
  );
}
