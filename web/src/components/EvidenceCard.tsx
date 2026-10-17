import { useState } from "react";
import type { EvidenceCard as Card } from "../../../shared/api.ts";
import { longDate } from "../lib/time.ts";
import { matchStrength } from "../lib/vocabulary.ts";
import { Icon } from "./Icon.tsx";

export function EvidenceCardView({ card }: { card: Card }) {
  const kind = card.type === "issue" ? "Issue" : "Pull request";
  const strength = matchStrength(card);
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(card.source_url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      window.prompt("Copy the link", card.source_url);
    }
  }

  return (
    <li className="card fade-in">
      <div className="card-head">
        <span className="card-kind">
          <Icon name={card.type === "issue" ? "message-square" : "git-pull-request"} /> {kind} #{card.number}
        </span>
        <span className={`badge tone-${strength.tone}`} title={`${card.match} match, score ${card.score.toFixed(2)}`}>
          {strength.label}
        </span>
      </div>
      <a className="card-title clamp-2" href={card.source_url} target="_blank" rel="noreferrer" title={card.title}>
        {card.title}
      </a>
      <p className="meta">
        {card.locator}
        {card.author ? ` · ${card.author}` : ""} · {longDate(card.created_at)}
      </p>
      <p className="excerpt">{card.excerpt}</p>
      <p className="card-actions">
        <a className="btn btn-ghost btn-sm" href={card.source_url} target="_blank" rel="noreferrer">
          Open on GitHub <Icon name="external-link" />
        </a>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => void copy()}>
          <Icon name={copied ? "check" : "copy"} /> {copied ? "Copied" : "Copy link"}
        </button>
      </p>
    </li>
  );
}
