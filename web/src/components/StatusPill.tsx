import type { StatusView } from "../lib/vocabulary.ts";

/** The state as a pill: a dot (hollow while waiting, pulsing while working), a word and a tone. */
export function StatusPill({ view }: { view: StatusView }) {
  return (
    <span className={`pill tone-${view.tone}`}>
      <span className={`dot${view.hollow ? " hollow" : ""}${view.pulse ? " pulse" : ""}`} aria-hidden="true" /> {view.label}
    </span>
  );
}
