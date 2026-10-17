import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { RepositoryRecord } from "../../../shared/api.ts";
import { parseRepositoryInput } from "../../../shared/github-url.ts";
import { api, postJson } from "../lib/api.ts";
import type { ErrorView } from "../lib/errors.ts";
import { repositoryPath } from "../lib/router.ts";
import { Link } from "./Link.tsx";
import { Icon } from "./Icon.tsx";
import { ErrorNotice } from "./Notice.tsx";
import { Spinner } from "./Spinner.tsx";

const TURNSTILE_SITE_KEY = import.meta.env.VITE_TURNSTILE_SITE_KEY;
const PRECHECK_DEBOUNCE_MS = 400;

declare global {
  interface Window {
    turnstile?: {
      render(container: HTMLElement, options: { sitekey: string; callback: (token: string) => void; "expired-callback"?: () => void; "error-callback"?: () => void }): string;
      reset(widgetId?: string): void;
    };
  }
}

/** The Turnstile challenge, rendered only when a sitekey is configured; its token goes with the registration. */
function TurnstileWidget({ onToken }: { onToken: (token: string | null) => void }) {
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!TURNSTILE_SITE_KEY || !container.current) return;
    let cancelled = false;
    const render = () => {
      if (cancelled || !container.current || !window.turnstile) return;
      window.turnstile.render(container.current, {
        sitekey: TURNSTILE_SITE_KEY,
        callback: onToken,
        "expired-callback": () => onToken(null),
        "error-callback": () => onToken(null),
      });
    };
    if (window.turnstile) {
      render();
    } else {
      const script = document.createElement("script");
      script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
      script.async = true;
      script.onload = render;
      document.head.appendChild(script);
    }
    return () => {
      cancelled = true;
    };
  }, [onToken]);
  if (!TURNSTILE_SITE_KEY) return null;
  return (
    <div className="turnstile-block">
      <p className="meta">A quick check keeps bots out. Nothing about you is stored.</p>
      <div ref={container} className="turnstile" />
    </div>
  );
}

type Phase = { kind: "idle" } | { kind: "submitting" } | { kind: "error"; error: ErrorView };

type Props = {
  initial?: string;
  onRegistered: (repo: RepositoryRecord, created: boolean) => void;
};

/** Add a repository: the input previews what it parsed to, finds a repository that is already indexed before anything is spent, and maps every refusal to a next step. */
export function RegisterForm({ initial = "", onRegistered }: Props) {
  const [url, setUrl] = useState(initial);
  const [settled, setSettled] = useState(initial);
  // What the pre-check found, and for which name, so a stale answer is never shown for a new name.
  const [found, setFound] = useState<{ name: string; repo: RepositoryRecord | null }>({ name: "", repo: null });
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const onToken = useCallback((token: string | null) => setTurnstileToken(token), []);
  const inputRef = useRef<HTMLInputElement>(null);

  // A new prefill (from "Register again") replaces the input and takes the focus.
  const [prevInitial, setPrevInitial] = useState(initial);
  if (initial !== prevInitial) {
    setPrevInitial(initial);
    setUrl(initial);
    setSettled(initial);
  }
  useEffect(() => {
    if (initial) inputRef.current?.focus();
  }, [initial]);

  useEffect(() => {
    const timer = setTimeout(() => setSettled(url), PRECHECK_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [url]);

  const parsed = settled.trim() ? parseRepositoryInput(settled) : null;
  const fullName = parsed?.ok ? `${parsed.owner}/${parsed.name}` : null;

  useEffect(() => {
    if (!fullName) return;
    let active = true;
    const [owner, name] = fullName.split("/");
    void api<RepositoryRecord>(`/api/repositories/by-name/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`, "read").then((result) => {
      if (active) setFound({ name: fullName, repo: result.ok ? result.value : null });
    });
    return () => {
      active = false;
    };
  }, [fullName]);
  const existing = fullName !== null && found.name === fullName ? found.repo : null;

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPhase({ kind: "submitting" });
    const result = await api<RepositoryRecord>("/api/repositories", "register", postJson({ url, ...(turnstileToken ? { turnstileToken } : {}) }));
    // A Turnstile token is single-use: ask for a fresh one for the next submission.
    window.turnstile?.reset();
    setTurnstileToken(null);
    if (!result.ok) {
      setPhase({ kind: "error", error: result.error });
      return;
    }
    setPhase({ kind: "idle" });
    onRegistered(result.value, result.status === 201);
  }

  const indexed = existing !== null && existing.status !== "removed" && existing.status !== "inaccessible";
  const again = existing !== null && !indexed;
  const hint = !settled.trim()
    ? "A URL, owner/name, or a git remote. We index issues, pull requests and their comments; never the code."
    : parsed && !parsed.ok
      ? parsed.error
      : indexed
        ? `${existing.full_name} is already indexed.`
        : again
          ? `${existing.full_name} was indexed before. Adding it again rebuilds the index.`
          : `Looks like ${fullName}.`;
  const submitting = phase.kind === "submitting";
  const needsToken = Boolean(TURNSTILE_SITE_KEY) && !turnstileToken;

  return (
    <div className="register">
      <form onSubmit={onSubmit} className="register-form">
        <label className="sr-only" htmlFor="repo-url">
          GitHub repository URL or owner/name
        </label>
        <input
          id="repo-url"
          ref={inputRef}
          type="text"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="github.com/owner/repository"
          autoComplete="off"
          spellCheck={false}
          aria-describedby="repo-hint"
          required
        />
        {indexed ? (
          <Link to={repositoryPath(existing.full_name)} className="btn btn-secondary">
            Already indexed. Open <Icon name="arrow-right" />
          </Link>
        ) : (
          <button type="submit" className="btn btn-primary" disabled={submitting || needsToken} title={needsToken ? "Complete the bot check first" : undefined}>
            {submitting && <Spinner size={20} />}
            {submitting ? "Checking on GitHub…" : again ? "Register again" : "Add"}
          </button>
        )}
      </form>
      <p className={`meta hint${parsed && !parsed.ok ? " invalid" : ""}`} id="repo-hint">
        {hint}
      </p>
      <TurnstileWidget onToken={onToken} />
      {phase.kind === "error" && <ErrorNotice error={phase.error} onRetry={() => setPhase({ kind: "idle" })} />}
    </div>
  );
}
