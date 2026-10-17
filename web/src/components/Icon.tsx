// A small inline icon set (Lucide geometry, ISC): 1em, stroke-based, decorative unless labelled.

export type IconName = "external-link" | "arrow-left" | "arrow-right" | "search" | "alert-triangle" | "inbox" | "copy" | "check" | "chevron-down" | "chevron-up" | "message-square" | "git-pull-request";

const PATHS: Record<IconName, string> = {
  "external-link": '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  "arrow-left": '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
  "arrow-right": '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  "alert-triangle": '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  inbox: '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  "chevron-down": '<path d="m6 9 6 6 6-6"/>',
  "chevron-up": '<path d="m18 15-6-6-6 6"/>',
  "message-square": '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  "git-pull-request": '<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7"/><line x1="6" x2="6" y1="9" y2="21"/>',
};

type Props = { name: IconName; size?: number; label?: string; className?: string };

/** The paths are fixed strings from this file, never user content, so rendering them as markup is safe. */
export function Icon({ name, size, label, className }: Props) {
  const a11y = label ? { role: "img" as const, "aria-label": label } : { "aria-hidden": true as const };
  return (
    <svg
      className={["icon", size ? "icon-sized" : "", className ?? ""].filter(Boolean).join(" ")}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...a11y}
    >
      {ICON_NODES[name]}
    </svg>
  );
}

// Parsed once into React nodes so no raw HTML is ever set on the document.
const ICON_NODES: Record<IconName, React.ReactNode> = Object.fromEntries(
  (Object.keys(PATHS) as IconName[]).map((name) => [name, toNodes(PATHS[name])]),
) as Record<IconName, React.ReactNode>;

function toNodes(markup: string): React.ReactNode {
  const doc = new DOMParser().parseFromString(`<svg xmlns="http://www.w3.org/2000/svg">${markup}</svg>`, "image/svg+xml");
  return Array.from(doc.documentElement.children).map((el, i) => {
    const props: Record<string, string> = {};
    for (const attr of Array.from(el.attributes)) props[attr.name] = attr.value;
    const Tag = el.tagName as keyof React.JSX.IntrinsicElements;
    return <Tag key={i} {...props} />;
  });
}
