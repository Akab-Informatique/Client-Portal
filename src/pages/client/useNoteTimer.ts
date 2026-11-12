import { useEffect, useRef, useState } from "react";

/**
 * The stopwatch of a delegate's ticket window: it counts while the window is open
 * (it starts when the window opens, and stops when it closes). What it counted is kept
 * on this computer, per person and ticket, so a reload or a re-opening does not lose it.
 * Nothing about it reaches the server until the delegate sends a note with the time.
 */

type Stored = { seconds: number; paused: boolean };

function readStored(key: string): Stored {
  try {
    const raw = localStorage.getItem(key);
    if (raw) {
      const v = JSON.parse(raw) as Partial<Stored>;
      const seconds = typeof v.seconds === "number" && Number.isFinite(v.seconds) && v.seconds > 0 ? Math.floor(v.seconds) : 0;
      return { seconds, paused: v.paused === true };
    }
  } catch {
    /* storage blocked or damaged: the clock starts from zero */
  }
  return { seconds: 0, paused: false };
}

function writeStored(key: string, value: Stored) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage blocked: the clock still works for this window */
  }
}

export type NoteTimer = {
  /** whole seconds counted so far */
  seconds: number;
  /** true when the user paused it (a closed window does not change this) */
  paused: boolean;
  pause: () => void;
  resume: () => void;
  /** back to zero; keeps running unless it was paused */
  restart: () => void;
};

type Run = { base: number; startedAt: number | null; paused: boolean };

export function useNoteTimer(storageKey: string): NoteTimer {
  const [run, setRun] = useState<Run>(() => {
    const saved = readStored(storageKey);
    return { base: saved.seconds, startedAt: saved.paused ? null : Date.now(), paused: saved.paused };
  });
  const [now, setNow] = useState(() => Date.now());
  const running = run.startedAt != null;

  // one tick a second while it runs
  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [running]);

  const total = run.base + (run.startedAt != null ? Math.max(0, now - run.startedAt) / 1000 : 0);
  const seconds = Math.floor(total);

  // the latest values, read by the cleanup when the window closes
  const latest = useRef({ seconds, paused: run.paused, storageKey });
  latest.current = { seconds, paused: run.paused, storageKey };

  // saved as it counts, so a reload keeps the time
  useEffect(() => {
    writeStored(storageKey, { seconds, paused: run.paused });
  }, [storageKey, seconds, run.paused]);

  // the window closed: the time counted so far stays, nothing runs in the background
  useEffect(
    () => () => {
      const { seconds: s, paused, storageKey: k } = latest.current;
      writeStored(k, { seconds: s, paused });
    },
    [],
  );

  const pause = () =>
    setRun((r) => {
      if (r.startedAt == null) return { ...r, paused: true };
      const t = Date.now();
      return { base: r.base + Math.max(0, t - r.startedAt) / 1000, startedAt: null, paused: true };
    });

  const resume = () => {
    const t = Date.now();
    setNow(t);
    setRun((r) => (r.startedAt != null ? { ...r, paused: false } : { base: r.base, startedAt: t, paused: false }));
  };

  const restart = () => {
    const t = Date.now();
    setNow(t);
    setRun((r) => ({ base: 0, startedAt: r.paused ? null : t, paused: r.paused }));
  };

  return { seconds, paused: run.paused, pause, resume, restart };
}
