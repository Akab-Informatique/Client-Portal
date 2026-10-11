import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";

/**
 * Deep link from a notification (e.g. ?message=<id>): once `ready`, scroll to
 * the element `#<prefix><id>`, highlight it for a few seconds and drop the
 * param from the URL. Returns the id currently highlighted.
 */
export function useDeepLink(param: string, prefix: string, ready: boolean): string | null {
  const [params, setParams] = useSearchParams();
  const target = params.get(param);
  const [highlight, setHighlight] = useState<string | null>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    if (!target || !ready) return;
    // Handle this target once; removing the param re-renders without it.
    setHighlight(target);
    timers.current.push(
      setTimeout(() => {
        document.getElementById(`${prefix}${target}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
      }, 150),
      setTimeout(() => setHighlight((h) => (h === target ? null : h)), 3500),
    );
    setParams(
      (p) => {
        p.delete(param);
        return p;
      },
      { replace: true },
    );
  }, [target, ready, param, prefix, setParams]);

  // Only cancel pending timers when the page goes away
  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  return highlight;
}

/** Read and remove a one-shot query param (e.g. ?user=<id> from a notification). */
export function useOneShotParam(param: string): string | null {
  const [params, setParams] = useSearchParams();
  const [value] = useState(() => params.get(param));
  useEffect(() => {
    if (!params.get(param)) return;
    setParams(
      (p) => {
        p.delete(param);
        return p;
      },
      { replace: true },
    );
  }, [param, params, setParams]);
  return value;
}
