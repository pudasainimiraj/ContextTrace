import { useState, type ReactNode } from "react";
import type { ErrorView } from "../lib/errors.ts";
import { useNow } from "../lib/polling.ts";
import type { Tone } from "../lib/vocabulary.ts";
import { Icon } from "./Icon.tsx";
import { Link } from "./Link.tsx";

/** A sentence the reader should notice: a pause, a warning, a one-time confirmation. */
export function Notice({ tone, children, role = "status" }: { tone: Tone; children: ReactNode; role?: "status" | "alert" }) {
  return (
    <p role={role} className={`notice tone-${tone} fade-in`}>
      {tone === "amber" || tone === "red" ? <Icon name="alert-triangle" /> : tone === "green" ? <Icon name="check" /> : null}
      <span>{children}</span>
    </p>
  );
}

/** An inline API error in the user's words, its next action, and the raw message behind a disclosure. */
export function ErrorNotice({ error, onRetry }: { error: ErrorView; onRetry?: () => void }) {
  // The countdown restarts with every new error.
  const now = useNow(1000);
  const [shown, setShown] = useState(error);
  const [since, setSince] = useState(now);
  if (shown !== error) {
    setShown(error);
    setSince(now);
  }
  const left = error.retryAfterSeconds ? Math.max(0, error.retryAfterSeconds - Math.floor((now - since) / 1000)) : 0;

  let action: ReactNode = null;
  switch (error.action) {
    case "list":
      action = <Link to="/">See the repositories</Link>;
      break;
    case "status":
      action = <Link to="/status">See the service status</Link>;
      break;
    case "about":
      action = <Link to="/about">What can be indexed</Link>;
      break;
    case "home":
      action = <Link to="/">Go to the home page</Link>;
      break;
    case "reload":
      action = (
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => window.location.reload()}>
          Reload
        </button>
      );
      break;
    case "retry":
      action = onRetry ? (
        <button type="button" className="btn btn-secondary btn-sm" disabled={left > 0} onClick={onRetry}>
          {left > 0 ? `Try again in ${left} s` : "Try again"}
        </button>
      ) : null;
      break;
  }
  return (
    <div className="error-notice fade-in">
      <div role="alert" className="notice tone-red">
        <Icon name="alert-triangle" />
        <span className="notice-body">
          <span>{error.copy}</span>
          {action}
        </span>
      </div>
      {error.details && (
        <details className="meta">
          <summary>Details</summary>
          <p>{error.details}</p>
        </details>
      )}
    </div>
  );
}
