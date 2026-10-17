import type { AnchorHTMLAttributes, MouseEvent } from "react";
import { href, navigate } from "../lib/router.ts";

type LinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & { to: string };

/** An in-app link: a plain left click navigates without a reload; modified clicks and new tabs work as usual. */
export function Link({ to, onClick, children, ...rest }: LinkProps) {
  function handle(event: MouseEvent<HTMLAnchorElement>) {
    onClick?.(event);
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (rest.target && rest.target !== "_self") return;
    event.preventDefault();
    navigate(to);
  }
  return (
    <a href={href(to)} onClick={handle} {...rest}>
      {children}
    </a>
  );
}
