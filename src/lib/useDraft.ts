import { useCallback, useEffect, useRef, useState } from "react";

const PREFIX = "akab.draft.";

function read(key: string): string {
  try {
    return localStorage.getItem(PREFIX + key) ?? "";
  } catch {
    return "";
  }
}

function write(key: string, value: string) {
  try {
    if (value.trim()) localStorage.setItem(PREFIX + key, value);
    else localStorage.removeItem(PREFIX + key);
  } catch {
    /* storage blocked: the text just stays in the page */
  }
}

/**
 * A text box that saves what is typed on this computer as it goes (soft save), so a note written in a
 * window that is closed, minimized or reloaded is still there when it opens again.
 * `key` names the box (e.g. `ticket:123:note`); call `clear()` once the text is really sent.
 */
export function useDraft(key: string | null, initial = ""): [string, (v: string) => void, () => void] {
  const [value, setValue] = useState(() => (key ? read(key) : "") || initial);
  const keyRef = useRef(key);
  const latest = useRef(value);
  latest.current = value;

  // another box (another ticket, another tab of the same window): load its saved text
  useEffect(() => {
    if (keyRef.current === key) return;
    keyRef.current = key;
    setValue((key ? read(key) : "") || initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // save a moment after the last keystroke, and right away when the box goes away
  useEffect(() => {
    if (!key) return;
    const id = setTimeout(() => write(key, value), 400);
    return () => clearTimeout(id);
  }, [key, value]);
  useEffect(
    () => () => {
      if (keyRef.current) write(keyRef.current, latest.current);
    },
    [],
  );

  const clear = useCallback(() => {
    latest.current = "";
    setValue("");
    if (keyRef.current) write(keyRef.current, "");
  }, []);

  return [value, setValue, clear];
}
