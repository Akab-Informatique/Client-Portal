import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigationType } from "react-router-dom";
import { AkabLoader } from "@/components/AkabLoader";
import { useLocale } from "@/hooks/use-locale";

const MIN_VISIBLE_MS = 420;
const MAX_VISIBLE_MS = 1400;

/**
 * Brief animated AKAB loader when navigating between portal pages.
 * Shows on pathname changes (not search/hash-only) so section switches feel branded.
 */
export function RouteLoadingOverlay() {
  const location = useLocation();
  const navType = useNavigationType();
  const { t } = useLocale();
  const [visible, setVisible] = useState(false);
  const pathRef = useRef(location.pathname);
  const shownAtRef = useRef(0);
  const hideTimerRef = useRef<number | null>(null);
  const maxTimerRef = useRef<number | null>(null);
  const firstPaintRef = useRef(true);

  useEffect(() => {
    // Skip the very first mount — boot loader already covers cold start
    if (firstPaintRef.current) {
      firstPaintRef.current = false;
      pathRef.current = location.pathname;
      return;
    }

    if (location.pathname === pathRef.current) return;
    pathRef.current = location.pathname;

    // POP (browser back/forward) still gets a short brand flash
    void navType;

    if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current);
    if (maxTimerRef.current) window.clearTimeout(maxTimerRef.current);

    shownAtRef.current = Date.now();
    setVisible(true);

    // Hide after min time — content is already rendering underneath
    hideTimerRef.current = window.setTimeout(() => {
      setVisible(false);
    }, MIN_VISIBLE_MS);

    // Safety: never leave the overlay stuck
    maxTimerRef.current = window.setTimeout(() => {
      setVisible(false);
    }, MAX_VISIBLE_MS);

    return () => {
      if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current);
      if (maxTimerRef.current) window.clearTimeout(maxTimerRef.current);
    };
  }, [location.pathname, navType]);

  if (!visible) return null;

  return (
    <AkabLoader
      overlay
      size="lg"
      label={t("app.loading")}
    />
  );
}
