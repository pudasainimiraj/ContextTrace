import { useServiceStatusPoll } from "../lib/service-status.ts";
import { stripView } from "../lib/vocabulary.ts";
import { Link } from "./Link.tsx";

export function StatusStrip() {
  const { data, error } = useServiceStatusPoll();
  const { label, tone } = stripView(data, error !== null);
  return (
    <Link to="/status" className={`strip strip-${tone}`}>
      <span className={`dot${tone === "muted" ? " hollow" : ""}`} aria-hidden="true" /> {label}
    </Link>
  );
}
