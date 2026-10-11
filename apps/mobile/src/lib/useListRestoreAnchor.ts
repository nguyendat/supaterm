import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";

/**
 * Keeps one row of a LegendList in place while the rows around it change,
 * such as a section header the user just tapped. Pass
 * `maintainVisibleContentPosition` and `onItemSizeChanged` to the list, then
 * call `anchor(key)` before the change. The row stays anchored until the rows
 * around it have measured in.
 */
export function useListRestoreAnchor() {
  const anchorKeyRef = useRef<string | null>(null);
  const settleFrameRef = useRef<number | null>(null);

  const maintainVisibleContentPosition = useMemo(
    () => ({
      data: true,
      shouldRestorePosition: (item: { readonly key: string }) => item.key === anchorKeyRef.current,
    }),
    [],
  );

  const settle = useCallback(() => {
    if (anchorKeyRef.current === null) return;
    if (settleFrameRef.current !== null) cancelAnimationFrame(settleFrameRef.current);
    settleFrameRef.current = requestAnimationFrame(() => {
      settleFrameRef.current = requestAnimationFrame(() => {
        anchorKeyRef.current = null;
        settleFrameRef.current = null;
      });
    });
  }, []);
  useLayoutEffect(() => settle());
  useEffect(
    () => () => {
      if (settleFrameRef.current !== null) cancelAnimationFrame(settleFrameRef.current);
    },
    [],
  );

  const anchor = useCallback((key: string) => {
    anchorKeyRef.current = key;
  }, []);

  return { anchor, maintainVisibleContentPosition, onItemSizeChanged: settle };
}
