"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button, Icon } from "./ui";

export function StartDemo({ size = "lg" }: { size?: "md" | "lg" }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <div>
      <Button
        size={size}
        variant="brand"
        busy={busy}
        onClick={async () => {
          setBusy(true);
          setError("");
          try {
            const r = await fetch("/api/shows", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ seed: true }) });
            const j = (await r.json()) as { showId?: string };
            if (!j.showId) throw new Error("no show id");
            router.push(`/demo/${j.showId}`);
          } catch {
            setError("Could not start a show. Is the server running?");
            setBusy(false);
          }
        }}
      >
        Start a demo show <Icon.Arrow size={17} />
      </Button>
      {error ? (
        <p role="alert" className="mt-2 text-[13px] text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
