import { useCallback, useEffect, useMemo, useState } from "react";
import {
  type OpenMhzCall,
  type OpenMhzSystem,
  type OpenMhzTalkgroup,
  fetchCallsInTimeRange,
  getInitialCalls,
  getOlderCalls,
  getSystems,
  getTalkgroups,
  mergeCallsById,
  systemDisplayName,
} from "./api/openmhz";
import { mergeUrlsToWav, type MergeProgress } from "./audio/merge";
import {
  deleteProject,
  listProjects,
  saveProject,
  type SavedProject,
} from "./storage/projectDb";

const API_STORAGE_KEY = "openmhz-composer-api-base";
const DEFAULT_API = "https://api.openmhz.com";

type QueueItem = {
  id: string;
  label: string;
  audioUrl: string;
  delayAfterMs: number;
  /** OpenMHz call start (ms since epoch); uploads omit this */
  realTimeStartMs?: number;
  /** OpenMHz `len` in seconds; used for real-time gaps */
  durationSec?: number;
};

function uid(): string {
  return crypto.randomUUID();
}

function SavedRow({
  project,
  onDelete,
}: {
  project: SavedProject;
  onDelete: () => void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const u = URL.createObjectURL(project.wavBlob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [project.id, project.wavBlob]);

  const safeName = project.name.replace(/[^\w\-]+/g, "-").replace(/^-|-$/g, "");

  return (
    <li>
      <strong>{project.name}</strong>
      <span className="mono" style={{ color: "var(--muted)" }}>
        {new Date(project.createdAt).toLocaleString()}
      </span>
      {url && <audio controls src={url} preload="none" />}
      {url && (
        <a href={url} download={`${safeName || "mix"}.wav`}>
          Download
        </a>
      )}
      <button type="button" className="danger" onClick={() => void onDelete()}>
        Delete
      </button>
    </li>
  );
}

function callLabel(
  c: OpenMhzCall,
  tg: Record<string, OpenMhzTalkgroup> | null
): string {
  const desc =
    tg && tg[String(c.talkgroupNum)]
      ? tg[String(c.talkgroupNum)].description
      : `TG ${c.talkgroupNum}`;
  const t = new Date(c.time).toLocaleString();
  return `${desc} · ${t} · ${c.len}s`;
}

export default function App() {
  const [apiBase, setApiBase] = useState(() => {
    try {
      return localStorage.getItem(API_STORAGE_KEY) || DEFAULT_API;
    } catch {
      return DEFAULT_API;
    }
  });
  const [systems, setSystems] = useState<OpenMhzSystem[]>([]);
  const [sysErr, setSysErr] = useState<string | null>(null);
  const [sysLoading, setSysLoading] = useState(false);

  const [shortName, setShortName] = useState("");
  const [talkgroups, setTalkgroups] = useState<Record<
    string,
    OpenMhzTalkgroup
  > | null>(null);
  const [tgErr, setTgErr] = useState<string | null>(null);
  const [tgLoading, setTgLoading] = useState(false);
  const [tgSearch, setTgSearch] = useState("");
  const [selectedTg, setSelectedTg] = useState<Set<number>>(new Set());

  const [calls, setCalls] = useState<OpenMhzCall[]>([]);
  const [callsErr, setCallsErr] = useState<string | null>(null);
  const [callsLoading, setCallsLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);

  const [selectedCallIds, setSelectedCallIds] = useState<Set<string>>(
    new Set()
  );
  const [anchorIdx, setAnchorIdx] = useState<number | null>(null);

  const [rangeMode, setRangeMode] = useState<"end" | "delta">("end");
  const [rangeStart, setRangeStart] = useState("");
  const [rangeEnd, setRangeEnd] = useState("");
  const [rangeDeltaSec, setRangeDeltaSec] = useState("");
  const [rangeSelectErr, setRangeSelectErr] = useState<string | null>(null);
  const [rangeSelectMsg, setRangeSelectMsg] = useState<string | null>(null);
  const [rangeLoading, setRangeLoading] = useState(false);

  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [defaultDelayMs, setDefaultDelayMs] = useState(500);

  const [mergedBlob, setMergedBlob] = useState<Blob | null>(null);
  const [mergeErr, setMergeErr] = useState<string | null>(null);
  const [realtimeErr, setRealtimeErr] = useState<string | null>(null);
  const [realtimeScale, setRealtimeScale] = useState(1);
  const [merging, setMerging] = useState(false);
  const [mergeProgress, setMergeProgress] = useState<MergeProgress | null>(null);
  const [mergedUrl, setMergedUrl] = useState<string | null>(null);

  const [saved, setSaved] = useState<SavedProject[]>([]);
  const [saveName, setSaveName] = useState("");
  const [modal, setModal] = useState<
    "system" | "transmissions" | "upload" | null
  >(null);

  useEffect(() => {
    try {
      localStorage.setItem(API_STORAGE_KEY, apiBase);
    } catch {
      /* ignore */
    }
  }, [apiBase]);

  useEffect(() => {
    let cancelled = false;
    setSysLoading(true);
    setSysErr(null);
    getSystems(apiBase.trim())
      .then((r) => {
        if (!cancelled) setSystems(r.systems || []);
      })
      .catch((e: Error) => {
        if (!cancelled) setSysErr(e.message);
      })
      .finally(() => {
        if (!cancelled) setSysLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [apiBase]);

  useEffect(() => {
    if (!shortName) {
      setTalkgroups(null);
      return;
    }
    let cancelled = false;
    setTgLoading(true);
    setTgErr(null);
    getTalkgroups(apiBase.trim(), shortName)
      .then((r) => {
        if (!cancelled) setTalkgroups(r.talkgroups || {});
      })
      .catch((e: Error) => {
        if (!cancelled) setTgErr(e.message);
      })
      .finally(() => {
        if (!cancelled) setTgLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [apiBase, shortName]);

  const tgList = useMemo(() => {
    if (!talkgroups) return [];
    return Object.values(talkgroups).sort((a, b) => a.num - b.num);
  }, [talkgroups]);

  const filteredTg = useMemo(() => {
    const q = tgSearch.trim().toLowerCase();
    if (!q) return tgList;
    return tgList.filter(
      (t) =>
        String(t.num).includes(q) ||
        t.alpha.toLowerCase().includes(q) ||
        t.description.toLowerCase().includes(q)
    );
  }, [tgList, tgSearch]);

  const loadCalls = useCallback(async () => {
    if (!shortName || selectedTg.size === 0) return;
    setCallsLoading(true);
    setCallsErr(null);
    setHasMore(true);
    setSelectedCallIds(new Set());
    setAnchorIdx(null);
    try {
      const nums = [...selectedTg].sort((a, b) => a - b);
      const res = await getInitialCalls(apiBase.trim(), shortName, nums);
      setCalls(res.calls || []);
      if (!res.calls?.length) setHasMore(false);
    } catch (e) {
      setCallsErr((e as Error).message);
      setCalls([]);
    } finally {
      setCallsLoading(false);
    }
  }, [apiBase, shortName, selectedTg]);

  const loadMore = useCallback(async () => {
    if (!shortName || selectedTg.size === 0 || calls.length === 0) return;
    setLoadingMore(true);
    setCallsErr(null);
    try {
      const times = calls.map((c) => new Date(c.time).getTime());
      const oldest = Math.min(...times);
      const nums = [...selectedTg].sort((a, b) => a - b);
      const res = await getOlderCalls(apiBase.trim(), shortName, nums, oldest);
      const existing = new Set(calls.map((c) => c._id));
      const next = (res.calls || []).filter((c) => !existing.has(c._id));
      setCalls((prev) => [...prev, ...next]);
      if (!next.length) setHasMore(false);
    } catch (e) {
      setCallsErr((e as Error).message);
    } finally {
      setLoadingMore(false);
    }
  }, [apiBase, shortName, selectedTg, calls]);

  useEffect(() => {
    return () => {
      if (mergedUrl) URL.revokeObjectURL(mergedUrl);
    };
  }, [mergedUrl]);

  const refreshSaved = useCallback(() => {
    listProjects().then(setSaved).catch(() => setSaved([]));
  }, []);

  useEffect(() => {
    refreshSaved();
  }, [refreshSaved]);

  useEffect(() => {
    if (!modal) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setModal(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [modal]);

  useEffect(() => {
    if (!modal) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [modal]);

  function toggleTg(num: number) {
    setSelectedTg((prev) => {
      const n = new Set(prev);
      if (n.has(num)) n.delete(num);
      else n.add(num);
      return n;
    });
  }

  function selectAllFiltered() {
    setSelectedTg((prev) => {
      const n = new Set(prev);
      filteredTg.forEach((t) => n.add(t.num));
      return n;
    });
  }

  function clearTg() {
    setSelectedTg(new Set());
  }

  /** Row or checkbox: normal click toggles one row; Shift+click selects the inclusive range from the last anchor to this row. */
  function handleTransmissionSelect(idx: number, ev: React.MouseEvent) {
    if (ev.shiftKey && anchorIdx !== null) {
      ev.preventDefault();
      const a = Math.min(anchorIdx, idx);
      const b = Math.max(anchorIdx, idx);
      setSelectedCallIds((prev) => {
        const next = new Set(prev);
        for (let i = a; i <= b; i++) next.add(calls[i]._id);
        return next;
      });
      setAnchorIdx(idx);
      return;
    }

    const id = calls[idx]._id;
    setSelectedCallIds((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
    setAnchorIdx(idx);
  }

  function selectAllTransmissions() {
    if (calls.length === 0) return;
    setSelectedCallIds(new Set(calls.map((c) => c._id)));
    setAnchorIdx(calls.length - 1);
  }

  function clearTransmissionSelection() {
    setSelectedCallIds(new Set());
    setAnchorIdx(null);
  }

  async function selectTransmissionsInTimeRange() {
    setRangeSelectErr(null);
    setRangeSelectMsg(null);
    if (!shortName || selectedTg.size === 0) {
      setRangeSelectErr(
        "Choose a system and at least one channel—the API filters by those talkgroups."
      );
      return;
    }
    if (!rangeStart.trim()) {
      setRangeSelectErr("Enter a start date and time.");
      return;
    }
    const startMs = new Date(rangeStart).getTime();
    if (Number.isNaN(startMs)) {
      setRangeSelectErr("Invalid start date and time.");
      return;
    }

    let endMs: number;
    if (rangeMode === "end") {
      if (!rangeEnd.trim()) {
        setRangeSelectErr("Enter an end date and time.");
        return;
      }
      endMs = new Date(rangeEnd).getTime();
      if (Number.isNaN(endMs)) {
        setRangeSelectErr("Invalid end date and time.");
        return;
      }
    } else {
      const d = parseFloat(rangeDeltaSec);
      if (Number.isNaN(d) || !Number.isFinite(d)) {
        setRangeSelectErr(
          "Enter a numeric delta in seconds (e.g. 3600 or -90)."
        );
        return;
      }
      endMs = startMs + d * 1000;
    }

    const lo = Math.min(startMs, endMs);
    const hi = Math.max(startMs, endMs);

    setRangeLoading(true);
    try {
      const fetched = await fetchCallsInTimeRange(
        apiBase.trim(),
        shortName,
        [...selectedTg],
        lo,
        hi
      );
      setCalls((prev) => mergeCallsById(prev, fetched));
      setSelectedCallIds((prev) => {
        const next = new Set(prev);
        for (const c of fetched) next.add(c._id);
        return next;
      });
      setAnchorIdx(null);
      if (fetched.length === 0) {
        setRangeSelectMsg(
          "No transmissions in that time range for the selected channels."
        );
      } else {
        setRangeSelectMsg(
          `Fetched ${fetched.length} transmission(s); they appear in the list and are selected.`
        );
      }
    } catch (e) {
      setRangeSelectErr((e as Error).message);
    } finally {
      setRangeLoading(false);
    }
  }

  function addSelectedToQueue() {
    const chosen = calls.filter((c) => selectedCallIds.has(c._id));
    chosen.sort(
      (a, b) => new Date(a.time).getTime() - new Date(b.time).getTime()
    );
    setQueue((q) => [
      ...q,
      ...chosen.map((c) => ({
        id: uid(),
        label: callLabel(c, talkgroups),
        audioUrl: c.url,
        delayAfterMs: defaultDelayMs,
        realTimeStartMs: new Date(c.time).getTime(),
        durationSec: c.len,
      })),
    ]);
    setSelectedCallIds(new Set());
    setModal(null);
  }

  function onUploadFiles(files: FileList | null) {
    if (!files?.length) return;
    const next: QueueItem[] = [];
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      if (!f.type.startsWith("audio/") && !/\.(m4a|mp3|wav|aac|ogg)$/i.test(f.name)) {
        continue;
      }
      next.push({
        id: uid(),
        label: f.name,
        audioUrl: URL.createObjectURL(f),
        delayAfterMs: defaultDelayMs,
      });
    }
    setQueue((q) => [...q, ...next]);
  }

  function moveQueue(i: number, dir: -1 | 1) {
    setQueue((q) => {
      const j = i + dir;
      if (j < 0 || j >= q.length) return q;
      const copy = [...q];
      [copy[i], copy[j]] = [copy[j], copy[i]];
      return copy;
    });
  }

  function removeQueue(i: number) {
    setQueue((q) => {
      const item = q[i];
      if (item.audioUrl.startsWith("blob:")) {
        URL.revokeObjectURL(item.audioUrl);
      }
      return q.filter((_, k) => k !== i);
    });
  }

  function setQueueDelay(i: number, ms: number) {
    setQueue((q) =>
      q.map((item, k) =>
        k === i ? { ...item, delayAfterMs: Math.max(0, ms) } : item
      )
    );
  }

  /**
   * Silence after clip i:
   * ((start of next − start of this) + duration of this clip in ms) × realtimeScale.
   * Negative results clamp to 0.
   */
  function applyRealTimeGaps() {
    setRealtimeErr(null);
    if (queue.length < 2) {
      setRealtimeErr("Add at least two clips.");
      return;
    }
    for (let i = 0; i < queue.length; i++) {
      const it = queue[i];
      if (it.realTimeStartMs == null || it.durationSec == null) {
        setRealtimeErr(
          "Real-time spacing needs OpenMHz clips with timestamps. Uploaded files cannot be aligned."
        );
        return;
      }
    }
    for (let i = 0; i < queue.length - 1; i++) {
      const a = queue[i].realTimeStartMs!;
      const b = queue[i + 1].realTimeStartMs!;
      if (b <= a) {
        setRealtimeErr(
          "Clips are not in strict chronological order by transmission time. Reorder the list so each clip starts after the previous one."
        );
        return;
      }
    }
    setQueue((items) =>
      items.map((item, i) => {
        if (i >= items.length - 1) return item;
        const t0 = item.realTimeStartMs!;
        const t1 = items[i + 1].realTimeStartMs!;
        const lenMs = item.durationSec! * 1000;
        const baseMs = t1 - t0 + lenMs;
        const gapMs = baseMs * realtimeScale;
        return { ...item, delayAfterMs: Math.max(0, Math.round(gapMs)) };
      })
    );
  }

  async function buildMerge() {
    if (queue.length === 0) return;
    setMerging(true);
    setMergeErr(null);
    setMergeProgress(null);
    if (mergedUrl) {
      URL.revokeObjectURL(mergedUrl);
      setMergedUrl(null);
    }
    setMergedBlob(null);
    try {
      const { wav } = await mergeUrlsToWav(
        queue.map((q) => ({ url: q.audioUrl })),
        queue.map((q) => q.delayAfterMs),
        setMergeProgress
      );
      setMergedBlob(wav);
      const url = URL.createObjectURL(wav);
      setMergedUrl(url);
      window.setTimeout(() => setMergeProgress(null), 400);
    } catch (e) {
      setMergeErr((e as Error).message);
      setMergeProgress(null);
    } finally {
      setMerging(false);
    }
  }

  function downloadMerged() {
    if (!mergedBlob) return;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(mergedBlob);
    a.download = `openmhz-composition-${Date.now()}.wav`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  async function persistMerged() {
    if (!mergedBlob || !saveName.trim()) return;
    const p: SavedProject = {
      id: uid(),
      name: saveName.trim(),
      createdAt: Date.now(),
      wavBlob: mergedBlob,
    };
    await saveProject(p);
    setSaveName("");
    refreshSaved();
  }

  async function removeSaved(id: string) {
    await deleteProject(id);
    refreshSaved();
  }

  return (
    <div className="app">
      <h1>OpenMHz Composer</h1>
      <p className="sub">
        Use the <strong>Sources</strong> buttons above Composition to open
        full-screen panels: API host, system, talkgroups, call list, and file
        uploads. Arrange clips with optional silence, then merge to one WAV.
        Everything runs in your browser (same backend as{" "}
        <a href="https://openmhz.com" target="_blank" rel="noreferrer">
          openmhz.com
        </a>
        ).
      </p>

      <section className="panel modal-launch">
        <h2>Sources</h2>
        <div className="modal-launch-buttons">
          <button
            type="button"
            className="primary"
            onClick={() => setModal("system")}
          >
            System &amp; channels
          </button>
          <button
            type="button"
            className="primary"
            disabled={!shortName || selectedTg.size === 0}
            title={
              !shortName || selectedTg.size === 0
                ? "Select a system and at least one channel first"
                : undefined
            }
            onClick={() => setModal("transmissions")}
          >
            Transmissions
          </button>
          <button
            type="button"
            className="primary"
            onClick={() => setModal("upload")}
          >
            Upload clips
          </button>
        </div>
        <p className="hint" style={{ marginBottom: 0 }}>
          {shortName ? (
            <>
              <strong className="mono">{shortName}</strong>
              {" · "}
              {selectedTg.size} channel(s) · {calls.length} transmission(s) in
              memory · {queue.length} in composition
            </>
          ) : (
            "Pick a system and channels, load calls, then build your composition below."
          )}
        </p>
      </section>

      {modal != null && (
        <div
          className="modal-root"
          role="dialog"
          aria-modal="true"
          aria-labelledby="fullscreen-modal-title"
          onClick={() => setModal(null)}
        >
          <div
            className="modal-frame"
            onClick={(e) => e.stopPropagation()}
          >
            <header className="modal-header">
              <h2 id="fullscreen-modal-title">
                {modal === "system"
                  ? "System & channels"
                  : modal === "transmissions"
                    ? "Transmissions"
                    : "Upload clips"}
              </h2>
              <button
                type="button"
                className="modal-close"
                onClick={() => setModal(null)}
                aria-label="Close"
              >
                ×
              </button>
            </header>
            <div className="modal-body">
              {modal === "system" && (
                <>
                  <section className="panel modal-panel">
                    <h3>API</h3>
                    <div className="row">
                      <label className="field">
                        <span className="cap">Base URL</span>
                        <input
                          type="url"
                          value={apiBase}
                          onChange={(e) => setApiBase(e.target.value)}
                          placeholder={DEFAULT_API}
                        />
                      </label>
                    </div>
                    <p className="hint">
                      Production uses{" "}
                      <code className="mono">{DEFAULT_API}</code> per{" "}
                      <span className="mono">trunk-server</span> config. If
                      requests fail, check browser extensions or network policy.
                    </p>
                  </section>

                  <section className="panel modal-panel">
                    <h3>System &amp; channels</h3>
                    {sysErr && <p className="err">{sysErr}</p>}
                    <div className="row">
                      <label className="field">
                        <span className="cap">System</span>
                        <select
                          value={shortName}
                          onChange={(e) => {
                            setShortName(e.target.value);
                            setCalls([]);
                            setSelectedCallIds(new Set());
                          }}
                          disabled={sysLoading || !systems.length}
                        >
                          <option value="">— Select —</option>
                          {systems.map((s) => (
                            <option key={s.shortName} value={s.shortName}>
                              {systemDisplayName(s)} ({s.shortName})
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="field">
                        <span className="cap">Default gap after clip (ms)</span>
                        <input
                          type="number"
                          min={0}
                          step={100}
                          value={defaultDelayMs}
                          onChange={(e) =>
                            setDefaultDelayMs(Number(e.target.value) || 0)
                          }
                        />
                      </label>
                    </div>

                    {tgErr && <p className="err">{tgErr}</p>}
                    {tgLoading && <p className="hint">Loading talkgroups…</p>}
                    {talkgroups && (
                      <>
                        <input
                          className="search-tg"
                          type="text"
                          placeholder="Filter channels (number, alpha tag, name)…"
                          value={tgSearch}
                          onChange={(e) => setTgSearch(e.target.value)}
                        />
                        <div className="row">
                          <button
                            type="button"
                            className="ghost"
                            onClick={selectAllFiltered}
                          >
                            Select all filtered
                          </button>
                          <button
                            type="button"
                            className="ghost"
                            onClick={clearTg}
                          >
                            Clear selection
                          </button>
                          <button
                            type="button"
                            className="primary"
                            onClick={() => {
                              setModal("transmissions");
                              void loadCalls();
                            }}
                            disabled={
                              !shortName || selectedTg.size === 0 || callsLoading
                            }
                          >
                            Load transmissions
                          </button>
                        </div>
                        <div className="tg-grid">
                          {filteredTg.map((t) => (
                            <label key={t.num} className="tg-item">
                              <input
                                type="checkbox"
                                checked={selectedTg.has(t.num)}
                                onChange={() => toggleTg(t.num)}
                              />
                              <span>
                                <code>{t.num}</code>{" "}
                                {t.alpha ? `· ${t.alpha} ` : ""}
                                <br />
                                <span style={{ color: "var(--muted)" }}>
                                  {t.description}
                                </span>
                              </span>
                            </label>
                          ))}
                        </div>
                      </>
                    )}
                  </section>
                </>
              )}

              {modal === "transmissions" && (
                <section className="panel modal-panel">
                  <h3 className="visually-hidden">Browse calls</h3>
                  {callsErr && <p className="err">{callsErr}</p>}
                  {callsLoading && <p className="hint">Loading…</p>}
                      <div className="range-select">
                        <h4>Select by time</h4>
                        <p className="hint" style={{ marginTop: 0 }}>
                          Fetches transmissions from the server for the selected
                          channels in the time window, merges them into the list,
                          and selects them (up to thousands of calls per request,
                          in pages of 50).
                        </p>
                        <div className="row">
                          <label className="field">
                            <span className="cap">Start</span>
                            <input
                              type="datetime-local"
                              value={rangeStart}
                              onChange={(e) => setRangeStart(e.target.value)}
                            />
                          </label>
                        </div>
                        <div className="row" style={{ alignItems: "center" }}>
                          <label
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: "0.35rem",
                              cursor: "pointer",
                              fontSize: "0.88rem",
                            }}
                          >
                            <input
                              type="radio"
                              name="rangeMode"
                              checked={rangeMode === "end"}
                              onChange={() => setRangeMode("end")}
                            />
                            End time
                          </label>
                          <label
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: "0.35rem",
                              cursor: "pointer",
                              fontSize: "0.88rem",
                            }}
                          >
                            <input
                              type="radio"
                              name="rangeMode"
                              checked={rangeMode === "delta"}
                              onChange={() => setRangeMode("delta")}
                            />
                            Delta from start (seconds)
                          </label>
                        </div>
                        {rangeMode === "end" ? (
                          <div className="row">
                            <label className="field">
                              <span className="cap">End</span>
                              <input
                                type="datetime-local"
                                value={rangeEnd}
                                onChange={(e) => setRangeEnd(e.target.value)}
                              />
                            </label>
                          </div>
                        ) : (
                          <div className="row">
                            <label className="field">
                              <span className="cap">Seconds (±)</span>
                              <input
                                type="text"
                                inputMode="decimal"
                                placeholder="e.g. 3600 or -120"
                                value={rangeDeltaSec}
                                onChange={(e) =>
                                  setRangeDeltaSec(e.target.value)
                                }
                              />
                            </label>
                            <span
                              className="hint"
                              style={{ alignSelf: "center" }}
                            >
                              End = start + delta. Negative values select
                              backward in time.
                            </span>
                          </div>
                        )}
                        <div className="row">
                          <button
                            type="button"
                            disabled={rangeLoading}
                            onClick={() => void selectTransmissionsInTimeRange()}
                          >
                            {rangeLoading
                              ? "Fetching…"
                              : "Fetch & add to selection"}
                          </button>
                        </div>
                        {rangeSelectErr && (
                          <p className="err" style={{ marginTop: "0.5rem" }}>
                            {rangeSelectErr}
                          </p>
                        )}
                        {rangeSelectMsg && !rangeSelectErr && (
                          <p className="range-select-msg">{rangeSelectMsg}</p>
                        )}
                      </div>


                  {calls.length > 0 && (
                    <>
                      <div className="row">
                        <button type="button" onClick={selectAllTransmissions}>
                          Select all (loaded)
                        </button>
                        <button
                          type="button"
                          className="ghost"
                          onClick={clearTransmissionSelection}
                          disabled={selectedCallIds.size === 0}
                        >
                          Clear selection
                        </button>
                        <button
                          type="button"
                          onClick={addSelectedToQueue}
                          disabled={selectedCallIds.size === 0}
                        >
                          Add selected to composition ({selectedCallIds.size})
                        </button>
                        <span className="hint">
                          Click a row or its checkbox to set the anchor, then
                          Shift+click another row (or checkbox)—everything between
                          is selected. Use <strong>Select by time</strong> above
                          to load matching calls from the API even if they are not
                          in the table yet. Added clips are ordered by time.
                        </span>
                      </div>

                      <div className="calls-wrap">
                        <table className="calls">
                          <thead>
                            <tr>
                              <th />
                              <th>Time</th>
                              <th>TG</th>
                              <th>Length</th>
                              <th>Listen</th>
                            </tr>
                          </thead>
                          <tbody>
                            {calls.map((c, idx) => (
                              <tr
                                key={c._id}
                                className={
                                  selectedCallIds.has(c._id)
                                    ? "selected"
                                    : undefined
                                }
                                onClick={(e) => handleTransmissionSelect(idx, e)}
                                style={{ cursor: "pointer" }}
                              >
                                <td
                                  onClick={(e) => e.stopPropagation()}
                                  style={{ cursor: "default" }}
                                >
                                  <input
                                    type="checkbox"
                                    readOnly
                                    checked={selectedCallIds.has(c._id)}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      e.preventDefault();
                                      handleTransmissionSelect(idx, e);
                                    }}
                                  />
                                </td>
                                <td className="mono">
                                  {new Date(c.time).toLocaleString()}
                                </td>
                                <td>
                                  {talkgroups?.[String(c.talkgroupNum)]
                                    ?.description || c.talkgroupNum}
                                </td>
                                <td className="mono">{c.len}s</td>
                                <td
                                  onClick={(e) => e.stopPropagation()}
                                  style={{ cursor: "default" }}
                                >
                                  <audio
                                    controls
                                    src={c.url}
                                    preload="none"
                                  />
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      <div className="row" style={{ marginTop: "0.75rem" }}>
                        <button
                          type="button"
                          onClick={() => void loadMore()}
                          disabled={loadingMore || !hasMore}
                        >
                          {loadingMore
                            ? "Loading…"
                            : hasMore
                              ? "Load older"
                              : "No more"}
                        </button>
                      </div>
                    </>
                  )}
                  {calls.length === 0 && !callsLoading && (
                    <p className="hint">
                      No transmissions in memory yet. In System &amp; channels,
                      choose talkgroups and use <strong>Load transmissions</strong>
                      , or use <strong>Fetch &amp; add to selection</strong> above
                      after setting a time range (requires selected channels).
                    </p>
                  )}
                </section>
              )}

              {modal === "upload" && (
                <section className="panel modal-panel">
                  <h3>Upload clips</h3>
                  <input
                    type="file"
                    accept="audio/*,.m4a,.mp3,.wav,.aac,.ogg"
                    multiple
                    onChange={(e) => onUploadFiles(e.target.files)}
                  />
                  <p className="hint">
                    Uploads are joined in the composition. Formats depend on
                    browser decode support.
                  </p>
                </section>
              )}
            </div>
          </div>
        </div>
      )}

      <section className="panel">
        <h2>Composition</h2>
        {queue.length === 0 ? (
          <p className="hint">Add OpenMHz calls or uploads to build a sequence.</p>
        ) : (
          <ul className="composition-list">
            {queue.map((item, i) => (
              <li key={item.id}>
                <div className="comp-label">{item.label}</div>
                <label className="field">
                  <span className="cap">Silence after (ms)</span>
                  <input
                    type="number"
                    min={0}
                    step={50}
                    value={item.delayAfterMs}
                    onChange={(e) =>
                      setQueueDelay(i, Number(e.target.value) || 0)
                    }
                  />
                </label>
                <div className="comp-actions">
                  <button type="button" onClick={() => moveQueue(i, -1)}>
                    Up
                  </button>
                  <button type="button" onClick={() => moveQueue(i, 1)}>
                    Down
                  </button>
                  <button
                    type="button"
                    className="danger"
                    onClick={() => removeQueue(i)}
                  >
                    Remove
                  </button>
                </div>
                <audio controls src={item.audioUrl} preload="none" />
              </li>
            ))}
          </ul>
        )}
        <div className="row" style={{ marginTop: "1rem", alignItems: "center" }}>
          <label className="field realtime-scale">
            <span className="cap">
              Real-time gap scale: {realtimeScale.toFixed(2)}× (0–2)
            </span>
            <input
              type="range"
              min={0}
              max={2}
              step={0.01}
              value={realtimeScale}
              onChange={(e) =>
                setRealtimeScale(Number(e.target.value))
              }
            />
          </label>
        </div>
        <div className="row" style={{ marginTop: "0.5rem" }}>
          <button
            type="button"
            onClick={applyRealTimeGaps}
            disabled={
              queue.length < 2 ||
              queue.some(
                (q) => q.realTimeStartMs == null || q.durationSec == null
              )
            }
          >
            Real-time gaps
          </button>
          <span className="hint" style={{ maxWidth: "36rem" }}>
            Uses each clip&apos;s transmission start time and length. Requires
            every row to come from OpenMHz and be in chronological order (each
            clip&apos;s time after the one above). Silence after each clip =
            ((next start − this start) + this clip&apos;s duration in ms) × scale;
            negative values become 0.
          </span>
        </div>
        {realtimeErr && <p className="err">{realtimeErr}</p>}
        <div className="row" style={{ marginTop: "0.75rem" }}>
          <button
            type="button"
            className="primary"
            onClick={() => void buildMerge()}
            disabled={queue.length === 0 || merging}
          >
            {merging ? "Merging…" : "Merge to single audio"}
          </button>
        </div>
        {merging && mergeProgress && (
          <div
            className="merge-progress"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={mergeProgress.percent}
            aria-label={mergeProgress.label}
          >
            <div
              className="merge-progress-bar"
              style={{ width: `${mergeProgress.percent}%` }}
            />
            <div className="merge-progress-meta">
              <span>{mergeProgress.label}</span>
              {mergeProgress.estimatedSecondsRemaining != null &&
                mergeProgress.percent < 100 && (
                  <span className="merge-progress-eta">
                    ~
                    {mergeProgress.estimatedSecondsRemaining < 60
                      ? `${mergeProgress.estimatedSecondsRemaining}s`
                      : `${Math.ceil(mergeProgress.estimatedSecondsRemaining / 60)} min`}{" "}
                    left
                  </span>
                )}
            </div>
          </div>
        )}
        {mergeErr && <p className="err">{mergeErr}</p>}
      </section>

      <section className="panel">
        <h2>Final mix</h2>
        {!mergedUrl && (
          <p className="hint">Merge a composition to enable playback and export.</p>
        )}
        {mergedUrl && (
          <>
            <audio controls src={mergedUrl} style={{ maxWidth: "100%" }} />
            <div className="row" style={{ marginTop: "0.75rem" }}>
              <button type="button" className="primary" onClick={downloadMerged}>
                Download WAV
              </button>
              <label className="field">
                <span className="cap">Save name</span>
                <input
                  type="text"
                  value={saveName}
                  onChange={(e) => setSaveName(e.target.value)}
                  placeholder="e.g. Evening fire dispatch"
                />
              </label>
              <button
                type="button"
                onClick={() => void persistMerged()}
                disabled={!saveName.trim()}
              >
                Save in browser
              </button>
            </div>
          </>
        )}
      </section>

      <section className="panel">
        <h2>Saved in this browser</h2>
        <button type="button" className="ghost" onClick={refreshSaved}>
          Refresh list
        </button>
        {saved.length === 0 ? (
          <p className="hint">No saved projects yet.</p>
        ) : (
          <ul className="saved-list">
            {saved.map((p) => (
              <SavedRow
                key={p.id}
                project={p}
                onDelete={() => void removeSaved(p.id)}
              />
            ))}
          </ul>
        )}
        <p className="hint">
          Saved mixes live in IndexedDB on this device only.
        </p>
      </section>
    </div>
  );
}
