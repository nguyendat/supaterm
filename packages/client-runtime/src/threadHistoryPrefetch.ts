export const THREAD_HISTORY_PREFETCH_VIEWPORTS = 2;

export interface ThreadHistoryControls {
  readonly historyCursor: string | null;
  readonly hasMoreHistory: boolean;
  readonly loading: boolean;
  readonly error: string | null;
  readonly onLoadEarlier: (throughEntryId?: string) => void;
}

export function createThreadHistoryPrefetcher() {
  let lastRequest: { threadKey: string; cursor: string } | undefined;

  return (
    threadKey: string,
    history: ThreadHistoryControls | undefined,
    viewport: { scroll: number; scrollLength: number } | undefined,
  ) => {
    if (lastRequest?.threadKey !== threadKey) lastRequest = undefined;
    if (!history || history.error !== null) {
      lastRequest = undefined;
      return;
    }
    if (
      !history.hasMoreHistory ||
      history.loading ||
      history.historyCursor === null ||
      !viewport ||
      viewport.scrollLength <= 0 ||
      viewport.scroll > viewport.scrollLength * THREAD_HISTORY_PREFETCH_VIEWPORTS ||
      (lastRequest?.threadKey === threadKey && lastRequest.cursor === history.historyCursor)
    ) {
      return;
    }

    lastRequest = { threadKey, cursor: history.historyCursor };
    history.onLoadEarlier();
  };
}
