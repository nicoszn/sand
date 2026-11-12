"use client";

import { useState } from "react";
import { Copy, Check } from "lucide-react";

export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard can be unavailable (permissions, insecure context) - fail quietly */
    }
  };

  return (
    <button
      onClick={copy}
      className="btn btn-sm btn-quiet"
      style={{ color: copied ? "var(--accent-green)" : undefined }}
      aria-label="Copy result"
    >
      {copied ? <Check size={13} /> : <Copy size={13} />}
      {copied ? "Copied" : "Copy"}
    </button>
  );
}
