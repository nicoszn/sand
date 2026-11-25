"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { BookOpen, EyeOff, History, Layers, Pin, PinOff, RotateCcw, Search, Trash2 } from "lucide-react";
import {
  api,
  CommunityItem,
  EpisodeItem,
  MemoryHistoryEntry,
  MemoryItem,
  MemoryResponse,
  timeAgo,
} from "@/lib/api";
import { MarkdownText } from "@/components/MarkdownText";

const STATUS_LABEL: Record<string, string> = {
  active: "believed",
  superseded: "superseded",
  retracted: "retracted",
  archived: "archived",
};

export default function MemoryPage() {
  const [data, setData] = useState<MemoryResponse | null>(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [historyOf, setHistoryOf] = useState<string | null>(null);
  const [chain, setChain] = useState<MemoryHistoryEntry[]>([]);
  const [showShelf, setShowShelf] = useState(false);

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

  const retract = async (memory: MemoryItem) => {
    if (!confirm(`Stop using "${memory.title}"? The belief is retracted, and its history is kept.`)) return;
    setBusy(memory.id);
    try {
      await api.retractMemory(memory.id);
      await load(query);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to retract");
    } finally {
      setBusy(null);
    }
  };

  const purge = async (memory: MemoryItem) => {
    if (!confirm(`Permanently delete "${memory.title}" and its revision history? This cannot be undone.`)) return;
    setBusy(memory.id);
    try {
      await api.purgeMemory(memory.id);
      await load(query);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete");
    } finally {
      setBusy(null);
    }
  };

  const restore = async (memory: MemoryItem) => {
    setBusy(memory.id);
    try {
      await api.restoreMemory(memory.id);
      await load(query);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to restore");
    } finally {
      setBusy(null);
    }
  };

  const removeEpisode = async (episode: EpisodeItem) => {
    if (
      !confirm(
        "Forget this task? Facts only this task supports are retracted; facts other tasks also assert keep their validity."
      )
    )
      return;
    setBusy(episode.task_id);
    try {
      await api.deleteEpisode(episode.task_id);
      await load(query);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete");
    } finally {
      setBusy(null);
    }
  };

  const openHistory = async (id: string) => {
    if (historyOf === id) {
      setHistoryOf(null);
      setChain([]);
      return;
    }
    setBusy(id);
    try {
      const result = await api.memoryHistory(id);
      setChain(result.chain);
      setHistoryOf(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load history");
    } finally {
      setBusy(null);
    }
  };

  const groups = new Map<string, MemoryItem[]>();
  const communityLabels = new Map<string, CommunityItem>((data?.communities ?? []).map((c) => [c.id, c]));
  for (const memory of data?.memories ?? []) {
    const key = memory.community_id ? communityLabels.get(memory.community_id)?.label ?? "theme" : memory.topic_path ?? "uncategorised";
    groups.set(key, [...(groups.get(key) ?? []), memory]);
  }

  return (
    <>
      <div className="page-head">
        <div>
          <span className="page-kicker">Knowledge</span>
          <h1 className="page-title">Memory</h1>
          <p className="page-sub">
            One typed, bi-temporal graph of everything this workspace knows: tasks, steps, tool calls, facts and the
            themes they form. New tasks get the relevant parts automatically.
          </p>
        </div>
      </div>

      {data && (
        <div className="mem-stats">
          <div className="mem-stat" data-tone="accent">
            <span className="mem-stat-label">Believed facts</span>
            <span className="mem-stat-value">{data.stats.facts}</span>
            <span className="mem-stat-note">active validity windows</span>
          </div>
          <div className="mem-stat" data-tone="plum">
            <span className="mem-stat-label">Themes</span>
            <span className="mem-stat-value">{data.stats.communities.total}</span>
            <span className="mem-stat-note">detected communities</span>
          </div>
          <div className="mem-stat">
            <span className="mem-stat-label">Graph edges</span>
            <span className="mem-stat-value">{data.stats.graph.edges}</span>
            <span className="mem-stat-note">typed, weighted links</span>
          </div>
          <div className="mem-stat">
            <span className="mem-stat-label">Learned from</span>
            <span className="mem-stat-value">{data.stats.episodes}</span>
            <span className="mem-stat-note">indexed tasks</span>
          </div>
          <div className="mem-stat" data-tone="muted">
            <span className="mem-stat-label">Retired beliefs</span>
            <span className="mem-stat-value">
              {data.stats.archived + data.stats.superseded + data.stats.retracted}
            </span>
            <span className="mem-stat-note">audit trail kept</span>
          </div>
        </div>
      )}

      {data && (
        <p className="mem-policy">
          Retrieval runs in tiers: pinned facts always, then earlier tasks (BM25), then facts fused from BM25,{" "}
          {data.stats.embeddings.ready ? `${data.stats.embeddings.model}` : "no embeddings"} and a bounded personalised
          PageRank walk over the graph, then the coarse theme summaries above them. Contradicted facts are never
          overwritten &mdash; their validity window closes and the earlier belief stays queryable. Retention is scored
          from ACT-R activation (d={data.stats.model.decay}), graph centrality (weight {data.stats.model.wCentrality}) and
          utility,{" "}
          {data.stats.model.source === "fitted"
            ? `fitted over ${data.stats.model.samples} facts this workspace has used (AUC ${data.stats.model.auc}).`
            : `on the priors until more facts are used (${data.stats.model.samples} so far).`}{" "}
          Over budget, the weakest facts are demoted to the archive tier rather than deleted; {data.stats.usedChars.toLocaleString()}{" "}
          of {data.stats.budgetChars.toLocaleString()} characters in use. Pinned facts are never demoted.
        </p>
      )}

      {data && data.themes.length > 0 && (
        <div className="mem-group">
          <div className="section-label" style={{ margin: "0 0 6px 2px" }}>
            Themes (archive tier)
          </div>
          <div className="theme-grid">
            {data.themes.map((theme) => (
              <div key={theme.id} className="theme-card">
                <div className="theme-title">
                  <Layers size={12} />
                  {theme.label}
                </div>
                <div className="theme-summary">{theme.summary}</div>
                <div className="theme-foot">
                  <span>
                    {theme.member_count} fact{theme.member_count === 1 ? "" : "s"}
                  </span>
                  <span className="meter" title={`cohesion ${theme.cohesion.toFixed(2)}`}>
                    <span
                      className="meter-fill"
                      style={{ width: `${Math.round(Math.min(1, Math.max(0, theme.cohesion)) * 100)}%` }}
                    />
                  </span>
                  <span>{theme.cohesion.toFixed(2)}</span>
                </div>
              </div>
            ))}
          </div>
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
          {[...groups.entries()].map(([group, items]) => (
            <div key={group} className="mem-group">
              <div className="section-label" style={{ margin: "0 0 6px 2px" }}>
                {group}
              </div>
              <div className="card">
                {items.map((memory) => (
                  <div key={memory.id}>
                    <div className="mem-row">
                      <div style={{ minWidth: 0 }}>
                        <div className="mem-title">
                          {memory.pinned ? <Pin size={12} style={{ color: "var(--accent-amber)" }} /> : null}
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
                          {memory.degree > 0 && (
                            <>
                              <span className="sep" />
                              <span>
                                linked to {memory.degree} {memory.degree === 1 ? "fact" : "facts"}
                              </span>
                            </>
                          )}
                          <span className="sep" />
                          <span>
                            {memory.status === "active" ? "believed" : STATUS_LABEL[memory.status]} since{" "}
                            {new Date(memory.valid_from * 1000).toLocaleDateString()}
                          </span>
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
                          className="btn btn-sm"
                          disabled={busy === memory.id}
                          onClick={() => openHistory(memory.id)}
                          title="Revision history and superseded versions"
                        >
                          <History size={13} />
                          {memory.history > 1 ? memory.history : ""}
                        </button>
                        <button
                          className="btn btn-sm"
                          disabled={busy === memory.id}
                          onClick={() => retract(memory)}
                          title="Stop believing this fact, keeping its audit trail"
                        >
                          <EyeOff size={13} />
                        </button>
                        <button
                          className="btn btn-sm btn-danger"
                          disabled={busy === memory.id}
                          onClick={() => purge(memory)}
                          title="Permanently delete this fact and its history"
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </div>

                    {historyOf === memory.id && (
                      <div style={{ padding: "4px 0 14px 12px" }}>
                        <div className="section-label" style={{ margin: "0 0 6px" }}>
                          Belief history
                        </div>
                        {chain.map((entry) => (
                          <div key={entry.memory.id} className="mem-meta" style={{ display: "block", marginBottom: 8 }}>
                            <strong>{entry.memory.title}</strong>{" "}
                            <span className="pill" data-tone={entry.memory.status === "active" ? "completed" : "failed"}>
                              <span className="pill-dot" />
                              {STATUS_LABEL[entry.memory.status]}
                            </span>{" "}
                            <span>
                              {new Date(entry.memory.valid_from * 1000).toLocaleString()} →{" "}
                              {entry.memory.valid_to
                                ? new Date(entry.memory.valid_to * 1000).toLocaleString()
                                : "open"}
                            </span>
                            <div className="mem-content" style={{ marginTop: 2 }}>
                              {entry.memory.content}
                            </div>
                            {entry.revisions.length > 1 && (
                              <div style={{ marginTop: 2 }}>
                                {entry.revisions.map((revision) => (
                                  <div key={revision.id}>
                                    {new Date(revision.recorded_at * 1000).toLocaleString()} · {revision.change}
                                    {revision.note ? ` — ${revision.note}` : ""}
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
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
                  <div className="mem-content md-clamp">
                    <MarkdownText text={episode.summary} />
                  </div>
                  <div className="mem-meta">
                    <span className="pill" data-tone={episode.outcome === "completed" ? "completed" : "failed"}>
                      <span className="pill-dot" />
                      {episode.outcome}
                    </span>
                    <span>{episode.tools || "no tools"}</span>
                    <span className="sep" />
                    <span>
                      {episode.step_count} {episode.step_count === 1 ? "step" : "steps"}
                    </span>
                    <span className="sep" />
                    <span>{timeAgo(episode.updated_at)}</span>
                  </div>
                </div>
                <div className="mem-actions">
                  <button
                    className="btn btn-sm btn-danger"
                    disabled={busy === episode.task_id}
                    onClick={() => removeEpisode(episode)}
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

      {data && data.inactive.length > 0 && (
        <>
          <div className="section-head">
            <button className="btn btn-sm" onClick={() => setShowShelf((value) => !value)}>
              {showShelf ? "Hide" : "Show"} retired beliefs ({data.inactive.length})
            </button>
            <span className="section-meta">superseded, retracted and archived</span>
          </div>
          {showShelf && (
            <div className="card">
              {data.inactive.map((memory) => (
                <div key={memory.id} className="mem-row">
                  <div style={{ minWidth: 0 }}>
                    <div className="mem-title">
                      {memory.title}
                      <span className="pill" data-tone="failed">
                        <span className="pill-dot" />
                        {STATUS_LABEL[memory.status]}
                      </span>
                    </div>
                    <div className="mem-content md-clamp">{memory.content}</div>
                    <div className="mem-meta">
                      <span>
                        {new Date(memory.valid_from * 1000).toLocaleDateString()} →{" "}
                        {memory.valid_to ? new Date(memory.valid_to * 1000).toLocaleDateString() : "open"}
                      </span>
                      <span className="sep" />
                      <span>{memory.history} revisions</span>
                    </div>
                  </div>
                  <div className="mem-actions">
                    <button
                      className="btn btn-sm"
                      disabled={busy === memory.id}
                      onClick={() => openHistory(memory.id)}
                      title="Revision history"
                    >
                      <History size={13} />
                    </button>
                    {memory.status === "retracted" && (
                      <button
                        className="btn btn-sm"
                        disabled={busy === memory.id}
                        onClick={() => restore(memory)}
                        title="Believe this fact again"
                      >
                        <RotateCcw size={13} />
                      </button>
                    )}
                    <button
                      className="btn btn-sm btn-danger"
                      disabled={busy === memory.id}
                      onClick={() => purge(memory)}
                      title="Permanently delete"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </>
  );
}
