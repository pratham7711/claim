"use client";

import { useEffect, useRef, useState } from "react";
import type { ListingDraft, ListingResult } from "@claim/listing";
import { SAMPLE_UTTERANCE } from "../../lib/seed";
import type { ActResult } from "../use-show";
import type { ShowAction } from "../../lib/types";
import { Button, Icon, cx, inputCls } from "../ui";

interface RecognitionResult {
  isFinal: boolean;
  0: { transcript: string };
}
interface RecognitionEvent {
  resultIndex: number;
  results: ArrayLike<RecognitionResult>;
}
interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: RecognitionEvent) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  start(): void;
  stop(): void;
}
type RecognitionCtor = new () => Recognition;

function recognitionCtor(): RecognitionCtor | undefined {
  if (typeof window === "undefined") return undefined;
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
}

interface Row {
  size: string;
  color: string;
  qty: string;
}

const FIELD_PROMPT: Record<string, string> = {
  code: "Say or type the item number viewers will use.",
  title: "Name the item.",
  price: "Add the price.",
  variants: "Add at least one size or colour with a count.",
};

export function VoiceListing({ act, onListed }: { act: (a: ShowAction) => Promise<ActResult>; onListed: (msg: string, ok: boolean) => void }) {
  const [supported, setSupported] = useState<boolean | null>(null);
  const [listening, setListening] = useState(false);
  const [finalText, setFinalText] = useState("");
  const [interim, setInterim] = useState("");
  const [typed, setTyped] = useState("");
  const [result, setResult] = useState<ListingResult | null>(null);
  const [busy, setBusy] = useState<"parse" | "list" | null>(null);
  const [code, setCode] = useState("");
  const [title, setTitle] = useState("");
  const [price, setPrice] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const rec = useRef<Recognition | null>(null);
  const heard = useRef("");

  useEffect(() => setSupported(Boolean(recognitionCtor())), []);

  const loadDraft = (r: ListingResult) => {
    setResult(r);
    setCode(r.draft.code ?? "");
    setTitle(r.draft.title ?? "");
    setPrice(r.draft.priceCents !== undefined ? (r.draft.priceCents / 100).toFixed(2) : "");
    setRows(r.draft.variants.map((v) => ({ size: v.size ?? "", color: v.color ?? "", qty: v.qty !== undefined ? String(v.qty) : "" })));
  };

  const parse = async (text: string) => {
    const t = text.trim();
    if (!t) return;
    setBusy("parse");
    const r = await act({ action: "parseListing", transcript: t });
    setBusy(null);
    if (r.ok) loadDraft(r.data as ListingResult);
    else onListed(r.error, false);
  };

  const toggleMic = () => {
    if (listening) {
      rec.current?.stop();
      return;
    }
    const Ctor = recognitionCtor();
    if (!Ctor) return;
    const r = new Ctor();
    r.lang = "en-US";
    r.continuous = true;
    r.interimResults = true;
    heard.current = "";
    setFinalText("");
    setInterim("");
    r.onresult = (e) => {
      let fin = "";
      let mid = "";
      for (let i = 0; i < e.results.length; i++) {
        const res = e.results[i]!;
        if (res.isFinal) fin += res[0].transcript;
        else mid += res[0].transcript;
      }
      heard.current = fin;
      setFinalText(fin);
      setInterim(mid);
    };
    r.onerror = (e) => {
      if (e.error !== "no-speech" && e.error !== "aborted") onListed(`Microphone: ${e.error}`, false);
    };
    r.onend = () => {
      setListening(false);
      setInterim("");
      if (heard.current.trim()) {
        setTyped(heard.current.trim());
        void parse(heard.current);
      }
    };
    rec.current = r;
    r.start();
    setListening(true);
  };

  const missing = new Set<string>();
  if (result) {
    if (!code.trim()) missing.add("code");
    if (!title.trim()) missing.add("title");
    if (!(Number(price) > 0)) missing.add("price");
    if (!rows.some((r) => (r.size.trim() || r.color.trim()) && Number(r.qty) >= 0 && r.qty !== "")) missing.add("variants");
  }

  const confirm = async () => {
    if (!result) return;
    setBusy("list");
    const edits = {
      code: code.trim(),
      title: title.trim(),
      priceCents: Math.round(Number(price) * 100),
      variants: rows
        .filter((r) => r.size.trim() || r.color.trim())
        .map((r) => ({ ...(r.size.trim() ? { size: r.size.trim() } : {}), ...(r.color.trim() ? { color: r.color.trim().toLowerCase() } : {}), qty: Math.max(0, Math.floor(Number(r.qty) || 0)) })),
    };
    const r = await act({ action: "listItem", draft: result.draft as ListingDraft, edits, transcript: result.transcript, onAir: true });
    setBusy(null);
    if (r.ok) {
      onListed(`#${edits.code} is listed and on air`, true);
      setResult(null);
      setTyped("");
      setFinalText("");
    } else onListed(r.error, false);
  };

  const live = listening ? `${finalText}${interim ? ` ${interim}` : ""}` : "";

  return (
    <div className="space-y-3 p-4">
      <div className="flex items-start gap-3">
        <button
          type="button"
          onClick={toggleMic}
          disabled={!supported}
          aria-pressed={listening}
          aria-label={listening ? "Stop listening" : "Start voice listing"}
          className={cx(
            "relative inline-flex size-12 shrink-0 items-center justify-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-40",
            listening ? "bg-live text-white" : "bg-ink text-paper hover:opacity-90",
          )}
        >
          {listening ? <span className="absolute inset-0 animate-ping rounded-full bg-live/40" /> : null}
          <Icon.Mic size={20} />
        </button>
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-semibold">{listening ? "Listening… describe the item, then tap to stop." : "Say it like you would on air"}</p>
          <p className="mt-0.5 text-[12px] text-muted">
            {supported === false ? "Voice needs Chrome's speech recognition. Type the same words below." : "“Number 9, sage linen button down, two smalls and a medium, thirty six.”"}
          </p>
        </div>
      </div>

      {listening ? (
        <p aria-live="polite" className="min-h-10 rounded-lg bg-sunken px-3 py-2 text-[14px] leading-snug">
          {finalText}
          <span className="text-muted"> {interim}</span>
          {!live ? <span className="text-muted">Waiting for speech…</span> : null}
        </p>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void parse(typed);
          }}
          className="space-y-2"
        >
          <label htmlFor="typed-transcript" className="sr-only">
            Typed transcript
          </label>
          <textarea id="typed-transcript" rows={2} value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Or type what you said on air…" className={cx(inputCls, "resize-none leading-snug")} />
          <div className="flex items-center justify-between gap-2">
            <button type="button" onClick={() => setTyped(SAMPLE_UTTERANCE)} className="text-[12px] font-semibold text-ink-2 underline decoration-line-strong underline-offset-2 hover:text-brand">
              Use a sample
            </button>
            <Button type="submit" size="sm" variant="ink" busy={busy === "parse"} disabled={!typed.trim()}>
              Draft listing
            </Button>
          </div>
        </form>
      )}

      {result ? (
        <div className="anim-drop rounded-xl border border-line-strong bg-surface-2 p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="eyebrow">Draft · {result.method === "rule" ? "rules" : "rules + model"} · confidence {result.confidence.toFixed(2)}</span>
            <button type="button" onClick={() => setResult(null)} className="text-muted hover:text-ink" aria-label="Discard draft">
              <Icon.X size={14} />
            </button>
          </div>
          <div className="grid grid-cols-[72px_1fr_88px] gap-2">
            <DraftField label="Code" missing={missing.has("code")}>
              <input value={code} onChange={(e) => setCode(e.target.value)} className={cx(inputCls, "num font-mono", missing.has("code") && "border-review")} />
            </DraftField>
            <DraftField label="Title" missing={missing.has("title")}>
              <input value={title} onChange={(e) => setTitle(e.target.value)} className={cx(inputCls, missing.has("title") && "border-review")} />
            </DraftField>
            <DraftField label="Price $" missing={missing.has("price")}>
              <input value={price} inputMode="decimal" onChange={(e) => setPrice(e.target.value)} className={cx(inputCls, "num", missing.has("price") && "border-review")} />
            </DraftField>
          </div>
          <div className="mt-2">
            <div className="mb-1 grid grid-cols-[1fr_1fr_56px_24px] gap-2 text-[11px] font-semibold text-ink-2">
              <span>Size</span>
              <span>Colour</span>
              <span>Qty</span>
              <span />
            </div>
            <ul className="space-y-1.5">
              {rows.map((r, i) => (
                <li key={i} className="grid grid-cols-[1fr_1fr_56px_24px] gap-2">
                  <input aria-label="Size" value={r.size} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, size: e.target.value } : x)))} className={inputCls} />
                  <input aria-label="Colour" value={r.color} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, color: e.target.value } : x)))} className={inputCls} />
                  <input
                    aria-label="Quantity"
                    inputMode="numeric"
                    value={r.qty}
                    onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)))}
                    className={cx(inputCls, "num", r.qty === "" && "border-review")}
                  />
                  <button type="button" aria-label="Remove variant" onClick={() => setRows(rows.filter((_, j) => j !== i))} className="text-muted hover:text-danger">
                    <Icon.X size={14} />
                  </button>
                </li>
              ))}
            </ul>
            <button type="button" onClick={() => setRows([...rows, { size: "", color: "", qty: "1" }])} className="mt-1.5 text-[12px] font-semibold text-ink-2 hover:text-brand">
              + Add variant
            </button>
          </div>

          {missing.size || result.warnings.length ? (
            <ul className="mt-2.5 space-y-1 text-[12px]" aria-live="polite">
              {[...missing].map((m) => (
                <li key={m} className="flex gap-1.5 text-review">
                  <Icon.Info size={13} className="mt-px shrink-0" /> {FIELD_PROMPT[m]}
                </li>
              ))}
              {result.warnings.map((w) => (
                <li key={w} className="flex gap-1.5 text-waitlist">
                  <Icon.Info size={13} className="mt-px shrink-0" /> {w}
                </li>
              ))}
            </ul>
          ) : null}

          <p className="mt-2.5 border-t border-line pt-2 text-[11.5px] italic text-muted">As described: “{result.transcript}”</p>
          <Button variant="brand" className="mt-2.5 w-full" busy={busy === "list"} disabled={missing.size > 0} onClick={confirm}>
            Confirm and put on air
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function DraftField({ label, missing, children }: { label: string; missing: boolean; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className={cx("mb-0.5 block text-[11px] font-semibold", missing ? "text-review" : "text-ink-2")}>
        {label}
        {missing ? " · missing" : ""}
      </span>
      {children}
    </label>
  );
}
