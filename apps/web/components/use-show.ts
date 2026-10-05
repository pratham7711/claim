"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ShowAction, ShowView } from "../lib/types";

export type ActResult = { ok: true; data?: unknown } | { ok: false; error: string };

/** Live show state over SSE, plus one POST helper for every action. */
export function useShow(showId: string, initial: ShowView) {
  const [view, setView] = useState<ShowView>(initial);
  const [offset, setOffset] = useState(() => initial.now - Date.now());
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const es = new EventSource(`/api/shows/${showId}/stream`);
    es.addEventListener("snapshot", (ev) => {
      const v = JSON.parse((ev as MessageEvent<string>).data) as ShowView;
      setView(v);
      setOffset(v.now - Date.now());
      setConnected(true);
    });
    es.onerror = () => setConnected(false);
    return () => es.close();
  }, [showId]);

  const act = useCallback(
    async (a: ShowAction): Promise<ActResult> => {
      try {
        const r = await fetch(`/api/shows/${showId}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(a) });
        return (await r.json()) as ActResult;
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : "Network error" };
      }
    },
    [showId],
  );

  return { view, act, offset, connected };
}

export interface Toast {
  id: number;
  tone: "ok" | "error" | "info";
  text: string;
}

export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const n = useRef(0);
  const push = useCallback((tone: Toast["tone"], text: string) => {
    const id = ++n.current;
    setToasts((t) => [...t.slice(-3), { id, tone, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === "error" ? 6000 : 3500);
  }, []);
  return { toasts, push };
}

/**
 * Keys that first appeared within the last `windowMs`; keys present on first render are never fresh,
 * so a page load does not replay every stamp. Key a row by id plus status to animate status changes.
 */
export function useFreshKeys(keys: string[], windowMs = 1400): Set<string> {
  const firstSeen = useRef<Map<string, number> | null>(null);
  const now = Date.now();
  if (firstSeen.current === null) firstSeen.current = new Map(keys.map((k) => [k, 0]));
  const fresh = new Set<string>();
  for (const k of keys) {
    let t = firstSeen.current.get(k);
    if (t === undefined) {
      t = now;
      firstSeen.current.set(k, t);
    }
    if (now - t < windowMs) fresh.add(k);
  }
  return fresh;
}
