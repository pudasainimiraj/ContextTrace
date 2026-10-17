import { useCallback, useState, type ReactNode } from "react";
import { AnnounceContext } from "../lib/announce.ts";

/** One polite live region per page. Only state changes go through it, never a count that polls. */
export function LiveRegionProvider({ children }: { children: ReactNode }) {
  const [text, setText] = useState("");
  const announce = useCallback((next: string) => {
    // Clearing first makes a repeated message audible again.
    setText("");
    window.setTimeout(() => setText(next), 50);
  }, []);
  return (
    <AnnounceContext.Provider value={announce}>
      {children}
      <div className="sr-only" role="status" aria-live="polite">
        {text}
      </div>
    </AnnounceContext.Provider>
  );
}
