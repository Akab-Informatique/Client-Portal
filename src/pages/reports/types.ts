/** The shapes the reports API returns (see server/routes/reports.ts). */

export type Channels = { email: string[]; sms: string[]; teams: boolean };
export type Delivered = {
  email: { to: string; ok: boolean; error?: string }[];
  sms: { to: string; ok: boolean; error?: string }[];
  teams: { ok: boolean; error?: string } | null;
};
export type Schedule = {
  id: string;
  reportId: string;
  frequency: "daily" | "weekly" | "monthly";
  time: string;
  weekday: number | null;
  dayOfMonth: number | null;
  enabled: boolean;
  channels: Channels;
  label: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastStatus: "running" | "ok" | "failed" | null;
};
export type RunRow = {
  id: string;
  reportId: string;
  scheduleId: string | null;
  trigger: "manual" | "schedule";
  status: "running" | "ok" | "failed";
  startedAt: string;
  finishedAt: string | null;
  summary: string;
  error: string | null;
  delivered: Delivered | null;
  reportName?: string;
};
export type RunFull = RunRow & { body: string; data: unknown };
export type ReportConfig = { sources?: string[]; period?: 7 | 30 | 90; aiSummary?: boolean };
export type Report = {
  id: string;
  key: string | null;
  kind: "builtin" | "custom";
  name: string;
  description: string;
  config: ReportConfig;
  schedules: Schedule[];
  lastRun: RunRow | null;
};
export type Source = { key: string; title: string };
export type ReportsResponse = { reports: Report[]; sources: Source[]; usageKey: string };
export type ScheduleRow = Schedule & { reportName: string; reportKind: "builtin" | "custom"; reportKey: string | null };

/** Lines of a text box (one per line, or separated by commas), trimmed, without empty ones. */
export const lines = (s: string) =>
  s
    .split(/[\n,;]+/)
    .map((x) => x.trim())
    .filter(Boolean);
