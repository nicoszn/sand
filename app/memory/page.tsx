"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { BookOpen, Pin, PinOff, Search, Trash2 } from "lucide-react";
import { api, EpisodeItem, MemoryItem, MemoryResponse, timeAgo } from "@/lib/api";

export default function MemoryPage() {
  const [data, setData] = useState<MemoryResponse | null>(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = (q: string) =>
    api
      .memory(q)
      .then((result) => {
        setData(result);
        setError(null);
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load memory"));

  // Debounced search; the first run also does the initial load.
  useEffect(() => {
    const timer = setTimeout(() => load(query), 250);
    return () => clearTimeout(timer);
  }, [query]);

  const togglePin = async (memory: MemoryItem) => {
    setBusy(memory.id);
    try {
      await api.setMemoryPinned(memory.id, !memory.pinned);
      await load(query);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update");
    } finally {
      setBusy(null);
    }
  };

  const remove = async (type: "memory" | "episode", id: string, label: string) => {
    if (!confirm(`Forget ${label}? Future tasks won't see it.`)) return;
    setBusy(id);
    try {
      await api.deleteMemoryItem(type, id);
      await load(query);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete");
    } finally {
      setBusy(null);
    }
  };

  const groups = new Map<string, MemoryItem[]>();
  for (const memory of data?.memories ?? []) {
    const key = memory.topic_path ?? "uncategorised";
    groups.set(key, [...(groups.get(key) ?? []), memory]);
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Memory</h1>
          <p className="page-sub">
            What this workspace has learned. Every finished task is indexed here, and facts the agent deliberately
            saved live under topics. New tasks are given the relevant parts automatically.
          </p>
        </div>
      </div>

      {data && (
        <div className="mem-summary">
          <span>
            <strong>{data.stats.facts}</strong> facts
          </span>
          <span className="sep" />
          <span>
            <strong>{data.stats.topics}</strong> topics
          </span>
          <span className="sep" />
          <span>
            <strong>{data.stats.episodes}</strong> tasks learned from
          </span>
        </div>
      )}

      <div style={{ position: "relative", marginBottom: 22, maxWidth: 360 }}>
        <Search size={14} style={{ position: "absolute", left: 11, top: 12, color: "var(--ink-3)" }} />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search memory…"
          style={{ paddingLeft: 32 }}
        />
      </div>

      {error && <div className="notice error">{error}</div>}

      {!data && !error && <div className="card empty">Loading memory…</div>}

      {data && data.memories.length === 0 && (
        <div className="card empty">
          <span className="empty-icon">
            <BookOpen size={18} />
          </span>
          <strong>{query ? "Nothing matched" : "No saved facts yet"}</strong>
          <span>
            {query
              ? "Try a different word, or clear the search."
              : "The agent saves durable facts with its remember tool as it works."}
          </span>
        </div>
      )}

      {data && data.memories.length > 0 && (
        <div style={{ marginBottom: 8 }}>
          {[...groups.entries()].map(([topic, items]) => (
            <div key={topic} className="mem-group">
              <div className="section-label" style={{ margin: "0 0 6px 2px" }}>
                {topic}
              </div>
              <div className="card">
                {items.map((memory) => (
                  <div key={memory.id} className="mem-row">
                    <div style={{ minWidth: 0 }}>
                      <div className="mem-title">
                        {memory.pinned ? (
                          <Pin size={12} style={{ color: "var(--accent-amber)" }} />
                        ) : null}
                        {memory.title}
                      </div>
                      <div className="mem-content">{memory.content}</div>
                      <div className="mem-meta">
                        {memory.source_task_id ? (
                          <Link href={`/tasks/${memory.source_task_id}`}>from task {memory.source_task_id}</Link>
                        ) : (
                          <span>added manually</span>
                        )}
                        <span className="sep" />
                        <span>used {memory.use_count}×</span>
                        <span className="sep" />
                        <span>{timeAgo(memory.updated_at)}</span>
                      </div>
                    </div>
                    <div className="mem-actions">
                      <button
                        className="btn btn-sm"
                        disabled={busy === memory.id}
                        onClick={() => togglePin(memory)}
                        title={memory.pinned ? "Unpin" : "Pin so it outranks other facts"}
                      >
                        {memory.pinned ? <PinOff size={13} /> : <Pin size={13} />}
                        {memory.pinned ? "Unpin" : "Pin"}
                      </button>
                      <button
                        className="btn btn-sm btn-danger"
                        disabled={busy === memory.id}
                        onClick={() => remove("memory", memory.id, `"${memory.title}"`)}
                        title="Delete this fact"
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {data && data.episodes.length > 0 && (
        <>
          <div className="section-head">
            <span className="section-label">Tasks the agent can learn from</span>
            <span className="section-meta">{data.episodes.length} indexed</span>
          </div>
          <div className="card">
            {data.episodes.map((episode: EpisodeItem) => (
              <div key={episode.task_id} className="mem-row">
                <div style={{ minWidth: 0 }}>
                  <div className="mem-title">
                    <Link href={`/tasks/${episode.task_id}`}>{episode.goal}</Link>
                  </div>
                  <div className="mem-content">
                    {episode.summary.replace(/\s+/g, " ").slice(0, 220)}
                    {episode.summary.length > 220 ? "…" : ""}
                  </div>
                  <div className="mem-meta">
                    <span className="pill" data-tone={episode.outcome === "completed" ? "completed" : "failed"}>
                      <span className="pill-dot" />
                      {episode.outcome}
                    </span>
                    <span>{episode.tools || "no tools"}</span>
                    <span className="sep" />
                    <span>{episode.step_count} steps</span>
                    <span className="sep" />
                    <span>{timeAgo(episode.updated_at)}</span>
                  </div>
                </div>
                <div className="mem-actions">
                  <button
                    className="btn btn-sm btn-danger"
                    disabled={busy === episode.task_id}
                    onClick={() => remove("episode", episode.task_id, "this task from memory")}
                    title="Stop future tasks from learning from it"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </>
  );
}
