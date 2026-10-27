import { useServiceStatus } from "../lib/service-status.ts";
import { stripView } from "../lib/vocabulary.ts";
import { Link } from "./Link.tsx";

export function StatusStrip() {
  const { label, tone } = stripView(useServiceStatus());
  return (
    <Link to="/status" className={`strip strip-${tone}`}>
      <span className={`dot${tone === "muted" ? " hollow" : ""}`} aria-hidden="true" /> {label}
    </Link>
  );
}
