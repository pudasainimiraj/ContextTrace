import type { ReactNode } from "react";
import { Icon, type IconName } from "./Icon.tsx";
import { Spinner } from "./Spinner.tsx";

type Props = {
  kind: "loading" | "empty" | "error";
  title: string;
  hint?: ReactNode;
  action?: ReactNode;
  icon?: IconName;
};

/**
 * Every surface has three states: loading, empty and error. They share one geometry (a 52 px icon
 * slot, a 14 px title, a 12 px hint, an optional action) so the title does not jump between them,
 * and empty and error never look alike.
 */
export function StateBlock({ kind, title, hint, action, icon = "inbox" }: Props) {
  return (
    <div className={`state state-${kind} fade-in`} role={kind === "error" ? "alert" : undefined}>
      <div className="slot">
        {kind === "loading" && <Spinner size={32} label="Loading" />}
        {kind === "empty" && <Icon name={icon} size={48} />}
        {kind === "error" && <Icon name="alert-triangle" size={28} />}
      </div>
      <p className="title">{title}</p>
      {hint && <div className="hint">{hint}</div>}
      {action && <div className="action">{action}</div>}
    </div>
  );
}

/** Placeholder rows while a list whose shape is known loads. */
export function SkeletonRows({ rows = 3 }: { rows?: number }) {
  return (
    <div className="skeleton-rows" aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <span key={i} className="skeleton-row" />
      ))}
    </div>
  );
}
