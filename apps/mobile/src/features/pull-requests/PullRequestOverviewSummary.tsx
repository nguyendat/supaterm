import { Chip } from "../../components/ui/Chip";
import { Button } from "../../components/ui/Button";
import { AppText as Text } from "../../components/ui/AppText";
import { PullRequestSectionHeading } from "./PullRequestSectionHeading";
import type { PullRequestListEntry } from "@supaterm/contracts";
import { View } from "react-native";
import { PullRequestCardGroup, PullRequestCardRow } from "./PullRequestControls";
import { PullRequestStackCard } from "./PullRequestStackCard";
import type { PullRequestParams } from "./usePullRequestDiff";
import type { PullRequestStackState } from "./usePullRequestStack";
import { pullRequestListReviewStatus } from "./pullRequestList";

export function PullRequestOverviewSummary({
  summary,
  params,
  stack,
  loading,
  connected,
  onRetry,
}: {
  readonly summary: PullRequestListEntry;
  readonly params: PullRequestParams;
  readonly stack: PullRequestStackState;
  readonly loading: boolean;
  readonly connected: boolean;
  readonly onRetry: () => void;
}) {
  const review = pullRequestListReviewStatus(summary);
  const conflicting = summary.mergeability === "conflicting";
  const clean = summary.mergeability === "mergeable";
  return (
    <View
      className="gap-5"
      accessibilityLabel={loading ? "Loading pull request details" : "Pull request summary"}
      accessibilityState={{ busy: loading }}
    >
      <PullRequestStackCard params={params} state={stack} />
      <PullRequestCardGroup>
        <PullRequestCardRow
          compact
          title={
            summary.checksState === "passing"
              ? "Checks completed"
              : summary.checksState === "failing"
                ? "Checks failing"
                : summary.checksState === "pending"
                  ? "Checks running"
                  : "Checks"
          }
          icon={
            summary.checksState === "passing"
              ? "checkmark.circle"
              : summary.checksState === "failing"
                ? "exclamationmark.circle"
                : "clock"
          }
          tint={
            summary.checksState === "passing"
              ? "accent-adaptive-emerald-600-400"
              : summary.checksState === "failing"
                ? "accent-danger-foreground"
                : "accent-icon-muted"
          }
        >
          {loading ? <View className="h-3 w-16 rounded bg-subtle-strong" /> : null}
        </PullRequestCardRow>
        <PullRequestCardRow
          compact
          title={review?.accessibleLabel ?? "Reviews"}
          icon={review?.icon ?? "bubble.left"}
          tint={review?.tint}
        >
          {loading ? <View className="h-3 w-20 rounded bg-subtle-strong" /> : null}
        </PullRequestCardRow>
        <PullRequestCardRow
          compact
          title={
            conflicting
              ? `Conflicts with ${summary.baseBranch}`
              : clean
                ? `No conflicts with ${summary.baseBranch}`
                : "Branch"
          }
          icon={
            conflicting ? "exclamationmark.triangle" : clean ? "checkmark.circle" : "arrow.branch"
          }
          tint={
            conflicting
              ? "accent-danger-foreground"
              : clean
                ? "accent-adaptive-emerald-600-400"
                : undefined
          }
        />
        {loading ? (
          <View className="border-t border-border-subtle p-3">
            <View className="h-11 rounded-xl bg-subtle-strong" />
          </View>
        ) : null}
      </PullRequestCardGroup>
      {summary.labels.length ? (
        <View className="flex-row flex-wrap gap-2">
          {summary.labels.map((label) => (
            <Chip key={label.name} label={label.name} size="small" />
          ))}
        </View>
      ) : null}
      <View className="gap-3">
        <PullRequestSectionHeading>Description</PullRequestSectionHeading>
        {loading ? (
          <View className="gap-3 py-1">
            <View className="h-4 w-full rounded bg-subtle-strong" />
            <View className="h-4 w-full rounded bg-subtle-strong" />
            <View className="h-4 w-3/4 rounded bg-subtle-strong" />
          </View>
        ) : (
          <View className="items-start gap-3">
            <Text className="text-sm text-foreground-muted">
              {connected
                ? "Couldn't load this description. Try again."
                : "This description isn't saved on this device. Reconnect to load it."}
            </Text>
            {connected ? <Button label="Retry" onPress={onRetry} /> : null}
          </View>
        )}
      </View>
    </View>
  );
}
