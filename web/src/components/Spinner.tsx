/** A ring spinner in the house sizes. A working button shows its own; in-page loading uses 32. */
export function Spinner({ size = 32, label }: { size?: 20 | 26 | 32 | 40; label?: string }) {
  const a11y = label ? { role: "status" as const, "aria-label": label } : { "aria-hidden": true as const };
  return <span className={`spinner spinner-${size}`} {...a11y} />;
}
