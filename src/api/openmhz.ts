/** Matches trunk-server public API (see trunk-server/backend/index.js). */

export type OpenMhzSystem = {
  shortName: string;
  label?: string;
  name?: string;
  [key: string]: unknown;
};

export type OpenMhzTalkgroup = {
  _id: string;
  num: number;
  alpha: string;
  description: string;
};

export type OpenMhzCall = {
  _id: string;
  talkgroupNum: number;
  url: string;
  time: string;
  len: number;
  srcList?: { src: string; pos: number }[];
  freq?: number;
  star?: number;
};

export type CallsResponse = {
  calls: OpenMhzCall[];
  direction: string;
};

export type SystemsResponse = {
  success: boolean;
  systems: OpenMhzSystem[];
};

export type TalkgroupsResponse = {
  talkgroups: Record<string, OpenMhzTalkgroup>;
};

function joinUrl(base: string, path: string): string {
  const b = base.replace(/\/$/, "");
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${b}${p}`;
}

export async function fetchJson<T>(baseUrl: string, path: string): Promise<T> {
  const url = joinUrl(baseUrl, path);
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${res.status} ${res.statusText} — ${url}${text ? `\n${text.slice(0, 200)}` : ""}`);
  }
  return res.json() as Promise<T>;
}

export function getSystems(baseUrl: string) {
  return fetchJson<SystemsResponse>(baseUrl, "/systems");
}

export function getTalkgroups(baseUrl: string, shortName: string) {
  return fetchJson<TalkgroupsResponse>(baseUrl, `/${encodeURIComponent(shortName)}/talkgroups`);
}

export function getInitialCalls(
  baseUrl: string,
  shortName: string,
  talkgroupNums: number[]
): Promise<CallsResponse> {
  const code = talkgroupNums.join(",");
  const q = new URLSearchParams({
    "filter-type": "talkgroup",
    "filter-code": code,
  });
  return fetchJson<CallsResponse>(
    baseUrl,
    `/${encodeURIComponent(shortName)}/calls?${q.toString()}`
  );
}

export function getOlderCalls(
  baseUrl: string,
  shortName: string,
  talkgroupNums: number[],
  timeMs: number
): Promise<CallsResponse> {
  const code = talkgroupNums.join(",");
  const q = new URLSearchParams({
    "filter-type": "talkgroup",
    "filter-code": code,
    time: String(timeMs),
  });
  return fetchJson<CallsResponse>(
    baseUrl,
    `/${encodeURIComponent(shortName)}/calls/older?${q.toString()}`
  );
}

/** Matches trunk-server `defaultNumResults` in controllers/calls.js */
export const CALLS_PAGE_SIZE = 50;

/**
 * Paginates `GET /:shortName/calls/newer` (time strictly greater than cursor)
 * until the inclusive window [loMs, hiMs] is covered. Talkgroup filter matches
 * the main site.
 */
export async function fetchCallsInTimeRange(
  baseUrl: string,
  shortName: string,
  talkgroupNums: number[],
  loMs: number,
  hiMs: number,
  options?: { maxPages?: number }
): Promise<OpenMhzCall[]> {
  const maxPages = options?.maxPages ?? 200;
  const code = [...talkgroupNums].sort((a, b) => a - b).join(",");
  const qBase = new URLSearchParams({
    "filter-type": "talkgroup",
    "filter-code": code,
  });

  const merged: OpenMhzCall[] = [];
  const seen = new Set<string>();
  let cursor = loMs - 1;

  for (let page = 0; page < maxPages; page++) {
    const q = new URLSearchParams(qBase);
    q.set("time", String(cursor));
    const res = await fetchJson<CallsResponse>(
      baseUrl,
      `/${encodeURIComponent(shortName)}/calls/newer?${q.toString()}`
    );
    const batch = res.calls ?? [];
    if (batch.length === 0) break;

    const firstT = new Date(batch[0].time).getTime();
    if (firstT > hiMs) break;

    const lastT = new Date(batch[batch.length - 1].time).getTime();

    for (const c of batch) {
      const t = new Date(c.time).getTime();
      if (t >= loMs && t <= hiMs && !seen.has(c._id)) {
        seen.add(c._id);
        merged.push(c);
      }
    }

    if (lastT >= hiMs) break;
    if (batch.length < CALLS_PAGE_SIZE) break;

    cursor = lastT;
  }

  return merged.sort(
    (a, b) => new Date(a.time).getTime() - new Date(b.time).getTime()
  );
}

export function mergeCallsById(
  existing: OpenMhzCall[],
  incoming: OpenMhzCall[]
): OpenMhzCall[] {
  const m = new Map<string, OpenMhzCall>();
  for (const c of existing) m.set(c._id, c);
  for (const c of incoming) m.set(c._id, c);
  return [...m.values()].sort(
    (a, b) => new Date(b.time).getTime() - new Date(a.time).getTime()
  );
}

export function systemDisplayName(s: OpenMhzSystem): string {
  const label = typeof s.label === "string" ? s.label : "";
  const name = typeof s.name === "string" ? s.name : "";
  return label || name || s.shortName;
}
