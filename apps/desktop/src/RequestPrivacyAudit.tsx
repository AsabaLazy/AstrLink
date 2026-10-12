import { useMemo } from "react";

import { DataRow } from "@/components/DataRow";
import { HelpPopover } from "@/components/HelpPopover";
import { Metric, MetricGroup } from "@/components/Metric";
import { Panel, PanelHeader } from "@/components/Panel";
import { StatusBadge } from "@/components/StatusBadge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

import { useT } from "./i18n";
import {
  notableCall,
  privacyKindCountLabel,
  privacyOutcomeLabel,
  privacyOutcomeTone,
  requestPrivacyAudit,
  type PrivacyAuditSummary,
  type PrivacyCallAudit,
} from "./request-privacy-audit";
import type { RequestRecord } from "./request-record-model";

/**
 * What privacy protection did across one conversation. Every number comes from
 * the record itself: the decision Core recorded, what it replaced, and how
 * much of it the response path put back.
 */
export function RequestPrivacyAudit({
  turns,
  selectedRequestId,
  onOpenCall,
}: {
  turns: RequestRecord[];
  selectedRequestId: string | null;
  onOpenCall: (requestId: string) => void;
}) {
  const t = useT();
  const summary = useMemo(() => requestPrivacyAudit(turns), [turns]);
  const rows = summary.calls.filter(notableCall);
  const cleanCalls = summary.callCount - rows.length;
  return (
    <div className="space-y-3" data-testid="privacy-audit">
      <Panel>
        <PanelHeader
          actions={
            <HelpPopover label={t("privacyAudit.helpLabel")} size="wide">
              <div className="space-y-2">
                <p>{t("privacyAudit.helpReplace")}</p>
                <p>{t("privacyAudit.helpRestore")}</p>
                <p>{t("privacyAudit.helpUnrestored")}</p>
              </div>
            </HelpPopover>
          }
          size="sm"
        >
          {" "}
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h3 className="text-sm font-medium">{t("privacyAudit.title")}</h3>
            <StatusBadge tone={privacyOutcomeTone(summary.outcome)}>
              {privacyOutcomeLabel(summary.outcome)}
            </StatusBadge>
          </div>
        </PanelHeader>
        <div className="space-y-3 p-3.5">
          <Headline summary={summary} />
          <Counts summary={summary} />
          {summary.kinds.length > 0 ? (
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
              <span className="text-xs text-muted-foreground">
                {t("privacyAudit.hitKinds")}
              </span>
              {summary.kinds.map((kind) => (
                <Badge
                  className="bg-muted font-normal text-foreground"
                  data-kind={kind.kind}
                  key={kind.kind}
                  variant="secondary"
                >
                  {privacyKindCountLabel(kind)}
                </Badge>
              ))}
            </div>
          ) : null}
        </div>
      </Panel>

      {rows.length > 0 && summary.callCount > 1 ? (
        <Panel>
          <PanelHeader size="sm">
            <h3 className="text-sm font-medium">{t("privacyAudit.calls")}</h3>
          </PanelHeader>
          <ul className="divide-y">
            {rows.map((call) => (
              <li key={call.recordId}>
                <CallRow
                  audit={call}
                  onOpen={() => onOpenCall(call.recordId)}
                  selected={call.recordId === selectedRequestId}
                />
              </li>
            ))}
            {cleanCalls > 0 ? (
              <li className="px-4 py-2 text-xs text-muted-foreground">
                {t("privacyAudit.cleanCalls", { count: cleanCalls })}
              </li>
            ) : null}
          </ul>
        </Panel>
      ) : null}
    </div>
  );
}

/**
 * One sentence for the whole conversation, before any number is read. A
 * session whose calls all passed untouched is described as such; a mixed one
 * keeps the strongest outcome, because it is the one worth opening.
 */
function Headline({ summary }: { summary: PrivacyAuditSummary }) {
  const t = useT();
  const outcome =
    summary.outcome === "off" && summary.offCalls !== summary.callCount
      ? "clean"
      : summary.outcome;
  return (
    <p
      className="text-sm leading-6 text-text-secondary"
      data-testid="privacy-audit-headline"
    >
      {t(`privacyAudit.headline.${outcome}`, {
        count: summary.replaced,
      })}
    </p>
  );
}

function Counts({ summary }: { summary: PrivacyAuditSummary }) {
  const t = useT();
  const metrics: Array<{ label: string; value: string; hint: string }> = [];
  if (summary.replaced > 0) {
    metrics.push({
      label: t("privacyAudit.replaced"),
      value: String(summary.replaced),
      hint: t("privacyAudit.replacedHint"),
    });
  }
  if (summary.restored > 0) {
    metrics.push({
      label: t("privacyAudit.restored"),
      value: String(summary.restored),
      hint: t("privacyAudit.restoredSplit", {
        visible: summary.restoredVisible,
        tools: summary.restoredTools,
      }),
    });
  }
  if (summary.unrestored > 0) {
    metrics.push({
      label: t("privacyAudit.unrestored"),
      value: String(summary.unrestored),
      hint: t("privacyAudit.unrestoredHint"),
    });
  }
  if (summary.blockedCalls > 0) {
    metrics.push({
      label: t("privacyAudit.blockedCalls"),
      value: String(summary.blockedCalls),
      hint: t("privacyAudit.blockedHint"),
    });
  }
  if (metrics.length === 0) return null;
  // The count varies with what happened, so columns flow instead of leaving
  // the fixed four-column track's empty cells showing as a border band.
  return (
    <MetricGroup className="auto-cols-fr grid-flow-col grid-cols-none rounded-md border @min-[640px]/workspace-surface:grid-cols-none">
      {metrics.map((metric) => (
        <Metric
          key={metric.label}
          label={metric.label}
          size="sm"
          title={metric.hint}
          value={metric.value}
        />
      ))}
    </MetricGroup>
  );
}

function CallRow({
  audit,
  selected,
  onOpen,
}: {
  audit: PrivacyCallAudit;
  selected: boolean;
  onOpen: () => void;
}) {
  const t = useT();
  const label =
    audit.turnIndex === null
      ? t("privacyAudit.callLabel", { index: audit.index })
      : t("privacyAudit.callLabelInTurn", {
          turn: audit.turnIndex,
          call: audit.turnCallIndex,
        });
  const counts: string[] = [];
  if (audit.replaced > 0) {
    counts.push(t("privacyAudit.callReplaced", { count: audit.replaced }));
  }
  if (audit.restored > 0) {
    counts.push(t("privacyAudit.callRestored", { count: audit.restored }));
  }
  if (audit.unrestored > 0) {
    counts.push(t("privacyAudit.callUnrestored", { count: audit.unrestored }));
  }
  return (
    <DataRow asChild className="px-0 py-0">
      <Button
        aria-current={selected ? "true" : undefined}
        className="h-auto w-full flex-col items-start gap-1 rounded-none bg-transparent px-4 py-2.5 text-left font-normal whitespace-normal text-foreground hover:bg-muted/60 focus-visible:bg-accent focus-visible:ring-inset aria-[current=true]:bg-accent"
        data-outcome={audit.outcome}
        data-testid="privacy-audit-call"
        onClick={onOpen}
        title={t("privacyAudit.openCall")}
        type="button"
        variant="ghost"
      >
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-xs font-medium">{label}</span>
          <StatusBadge tone={privacyOutcomeTone(audit.outcome)}>
            {privacyOutcomeLabel(audit.outcome)}
          </StatusBadge>
          {counts.length > 0 ? (
            <span className="text-xs text-muted-foreground">
              {counts.join(" · ")}
            </span>
          ) : null}
        </span>
        {audit.kinds.length > 0 ? (
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {audit.kinds.map((kind) => (
              <span className="text-xs text-foreground" key={kind.kind}>
                {privacyKindCountLabel(kind)}
              </span>
            ))}
          </span>
        ) : null}
        {audit.detail ? (
          <code className="min-w-0 font-mono text-micro text-muted-foreground">
            {audit.detail}
          </code>
        ) : null}
      </Button>
    </DataRow>
  );
}
