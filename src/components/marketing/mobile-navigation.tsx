"use client";

import Link from "next/link";
import { useRef, type KeyboardEvent } from "react";
import { ArrowUpRight, Menu, X } from "lucide-react";

export type PublicNavLink = { href: string; label: string };

export function MobileNavigation({
  links,
  pathname,
}: {
  links: PublicNavLink[];
  pathname: string;
}) {
  const details = useRef<HTMLDetailsElement>(null);
  const summary = useRef<HTMLElement>(null);

  function close() {
    if (details.current) details.current.open = false;
  }

  function onKeyDown(event: KeyboardEvent<HTMLDetailsElement>) {
    if (event.key === "Escape" && details.current?.open) {
      event.preventDefault();
      close();
      summary.current?.focus();
    }
  }

  return (
    <details className="public-mobile-nav" ref={details} onKeyDown={onKeyDown}>
      <summary className="public-menu-toggle" ref={summary} aria-label="Navigation menu">
        <Menu className="menu-open-icon" size={19} aria-hidden="true" />
        <X className="menu-close-icon" size={19} aria-hidden="true" />
      </summary>
      <nav aria-label="Mobile public navigation">
        {links.map(({ href, label }) => (
          <Link
            key={href}
            href={href}
            aria-current={
              pathname === href || (href === "/product" && pathname.startsWith("/product/"))
                ? "page"
                : undefined
            }
            onClick={close}
            {...(href === "/contact" ? { "data-af-event": "primary_cta_click", "data-af-cta": "contact", "data-af-placement": "nav" } : {})}
          >
            {label}
          </Link>
        ))}
        <div className="public-mobile-actions">
          <Link href="/login" onClick={close}>Log in</Link>
          <Link href="/signup" className="button primary" onClick={close} data-af-event="primary_cta_click" data-af-cta="signup" data-af-placement="nav">
            Create account <ArrowUpRight size={15} aria-hidden="true" />
          </Link>
        </div>
      </nav>
    </details>
  );
}
