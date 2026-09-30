import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowUpRight } from "lucide-react";
import { ThemeSelect } from "../appearance";
import { PublicAnalytics } from "../public-analytics";
import { MobileNavigation, type PublicNavLink } from "./mobile-navigation";

const primaryLinks: PublicNavLink[] = [
  { href: "/", label: "Why AdmitFlow" },
  { href: "/product", label: "Product" },
  { href: "/pricing", label: "Pricing" },
  { href: "/help", label: "Help" },
  { href: "/resources", label: "Resources" },
];

const companyLinks: PublicNavLink[] = [
  { href: "/about", label: "About" },
  { href: "/security", label: "Security" },
  { href: "/contact", label: "Contact" },
];

function Brand() {
  return (
    <span className="brand">
      <span className="brand-mark" aria-hidden="true">
        <svg viewBox="0 0 32 32">
          <path d="m6 24 9-17h7l-9 17H6Z" fill="currentColor" />
          <path d="m20 17 6 7h-10l4-7Z" fill="currentColor" />
        </svg>
      </span>
      <span>AdmitFlow</span>
    </span>
  );
}

function currentPath(pathname: string, href: string) {
  return pathname === href || (href === "/product" && pathname.startsWith("/product/"));
}

export function PublicLayout({
  pathname,
  children,
}: {
  pathname: string;
  children: ReactNode;
}) {
  const path = pathname === "/welcome" ? "/" : pathname;
  const page = path === "/" ? "welcome" : path.slice(1).replaceAll("/", "-");
  const navLinks = [...primaryLinks, ...companyLinks];

  return (
    <div className="marketing-site" data-public-page={page}>
      <PublicAnalytics pathname={path} />
      <a className="skip-link" href="#public-content">Skip to main content</a>
      <header className="public-nav">
        <Link href="/" aria-label="AdmitFlow home"><Brand /></Link>
        <nav className="public-desktop-nav" aria-label="Public navigation">
          {primaryLinks.map(({ href, label }) => (
            <Link key={href} href={href} aria-current={currentPath(path, href) ? "page" : undefined}>
              {label}
            </Link>
          ))}
          <Link href="/contact" aria-current={currentPath(path, "/contact") ? "page" : undefined} data-af-event="primary_cta_click" data-af-cta="contact" data-af-placement="nav">
            Contact
          </Link>
        </nav>
        <div className="public-nav-actions">
          <ThemeSelect />
          <Link href="/login" className="public-login">Log in</Link>
          <Link href="/signup" className="button primary public-header-cta" data-af-event="primary_cta_click" data-af-cta="signup" data-af-placement="nav">
            Create account <ArrowUpRight size={15} aria-hidden="true" />
          </Link>
          <MobileNavigation links={navLinks} pathname={path} />
        </div>
      </header>
      <main id="public-content">{children}</main>
      <footer className="public-footer">
        <div>
          <Link href="/" aria-label="AdmitFlow home"><Brand /></Link>
          <h2>Behind every enquiry,<br />a new possibility.</h2>
          <p>Admissions software for coaching institutes in India.</p>
        </div>
        <nav aria-label="Footer navigation">
          <span>EXPLORE</span>
          {primaryLinks.map(({ href, label }) => (
            <Link key={href} href={href}>
              {label} <ArrowUpRight size={14} aria-hidden="true" />
            </Link>
          ))}
        </nav>
        <nav aria-label="Company navigation">
          <span>ADMITFLOW</span>
          {companyLinks.map(({ href, label }) => (
            <Link key={href} href={href} {...(href === "/contact" ? { "data-af-event": "primary_cta_click", "data-af-cta": "contact", "data-af-placement": "footer" } : {})}>
              {label} <ArrowUpRight size={14} aria-hidden="true" />
            </Link>
          ))}
          <Link href="/login">Log in <ArrowUpRight size={14} aria-hidden="true" /></Link>
        </nav>
        <div className="footer-bottom">
          <span>AdmitFlow · Built for coaching teams</span>
          <span>Product examples use fictional institutes and students.</span>
        </div>
      </footer>
    </div>
  );
}
