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
      className="btn"
      style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "4px 10px", fontSize: 11.5, flexShrink: 0 }}
    >
      {copied ? (
        <>
          <Check size={13} /> copied
        </>
      ) : (
        <>
          <Copy size={13} /> copy
        </>
      )}
    </button>
  );
}
