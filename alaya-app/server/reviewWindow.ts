import {
  reviewTimezoneFromEnv,
  reviewWindowsFromEnv,
  type ReviewWindowConfig,
} from "./config/env";

export interface ReviewWindowState {
  inWindow: boolean;
  timezone: string;
  windowDate: string;
  windowLabel: string;
  currentMinutes: number;
  window?: ReviewWindowConfig;
}

interface ZonedParts {
  year: string;
  month: string;
  day: string;
  hour: number;
  minute: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timezone: string): Intl.DateTimeFormat {
  const existing = formatterCache.get(timezone);
  if (existing) return existing;
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  formatterCache.set(timezone, formatter);
  return formatter;
}

function zonedParts(date: Date, timezone: string): ZonedParts {
  const parts = formatterFor(timezone).formatToParts(date);
  const byType = new Map(parts.map((part) => [part.type, part.value]));
  return {
    year: byType.get("year") ?? "1970",
    month: byType.get("month") ?? "01",
    day: byType.get("day") ?? "01",
    hour: Number(byType.get("hour") ?? 0),
    minute: Number(byType.get("minute") ?? 0),
  };
}

export function reviewWindowState(at = new Date(), env: NodeJS.ProcessEnv = process.env): ReviewWindowState {
  const timezone = reviewTimezoneFromEnv(env);
  const parts = zonedParts(at, timezone);
  const currentMinutes = parts.hour * 60 + parts.minute;
  const window = reviewWindowsFromEnv(env).find((candidate) => (
    currentMinutes >= candidate.startMinutes && currentMinutes < candidate.endMinutes
  ));

  return {
    inWindow: Boolean(window),
    timezone,
    windowDate: `${parts.year}-${parts.month}-${parts.day}`,
    windowLabel: window?.label ?? "outside",
    currentMinutes,
    window,
  };
}

export function sameReviewWindow(openedAt: string, current: ReviewWindowState, env: NodeJS.ProcessEnv = process.env): boolean {
  const opened = reviewWindowState(new Date(openedAt), env);
  return opened.inWindow &&
    current.inWindow &&
    opened.windowDate === current.windowDate &&
    opened.windowLabel === current.windowLabel;
}

function floorToMinute(date: Date): Date {
  const floored = new Date(date);
  floored.setSeconds(0, 0);
  return floored;
}

export function nextReviewWindowStart(from = new Date(), env: NodeJS.ProcessEnv = process.env): Date {
  let cursor = new Date(floorToMinute(from).getTime() + 60_000);
  let wasInWindow = reviewWindowState(from, env).inWindow;
  const maxChecks = 8 * 24 * 60;

  for (let i = 0; i < maxChecks; i += 1) {
    const state = reviewWindowState(cursor, env);
    if (!state.inWindow) {
      wasInWindow = false;
    } else if (!wasInWindow) {
      return cursor;
    }
    cursor = new Date(cursor.getTime() + 60_000);
  }

  throw new Error("unable to find next review window start within 8 days");
}

export function nextReviewWindowStartIso(from = new Date(), env: NodeJS.ProcessEnv = process.env): string {
  return nextReviewWindowStart(from, env).toISOString();
}
