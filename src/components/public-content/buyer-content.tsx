import Link from "next/link";
import type { ReactNode } from "react";
import { StructuredData, breadcrumbSchema } from "@/components/marketing/structured-data";
import "./buyer-content.css";

export type BuyerCrumb = { label: string; href?: string };

export function BuyerHeader({
  eyebrow,
  title,
  lead,
  crumbs,
  note,
  pathname,
}: {
  eyebrow: string;
  title: string;
  lead: string;
  crumbs: BuyerCrumb[];
  note?: string;
  pathname: string;
}) {
  return (
    <>
    <StructuredData data={breadcrumbSchema([
      { name: "Home", pathname: "/" },
      ...crumbs.map((crumb) => ({ name: crumb.label, pathname: crumb.href ?? pathname })),
    ])} />
    <header className="buyer-header public-container">
      <Breadcrumbs crumbs={crumbs} />
      <p className="buyer-eyebrow">{eyebrow}</p>
      <h1>{title}</h1>
      <p className="buyer-lead">{lead}</p>
      {note ? <p className="buyer-header-note">{note}</p> : null}
    </header>
    </>
  );
}

export function Breadcrumbs({ crumbs }: { crumbs: BuyerCrumb[] }) {
  return (
    <nav className="buyer-breadcrumbs" aria-label="Breadcrumb">
      <ol>
        <li><Link href="/">Home</Link></li>
        {crumbs.map((crumb) => (
          <li key={crumb.label}>
            {crumb.href ? <Link href={crumb.href}>{crumb.label}</Link> : <span aria-current="page">{crumb.label}</span>}
          </li>
        ))}
      </ol>
    </nav>
  );
}

export function BuyerSection({
  eyebrow,
  title,
  children,
  id,
}: {
  eyebrow?: string;
  title: string;
  children: ReactNode;
  id?: string;
}) {
  return (
    <section className="buyer-section public-container" id={id}>
      <div className="buyer-section-heading">
        {eyebrow ? <p className="buyer-eyebrow">{eyebrow}</p> : null}
        <h2>{title}</h2>
      </div>
      <div className="buyer-section-body">{children}</div>
    </section>
  );
}

export function BuyerCta({
  title,
  children,
  linkLabel = "Get started",
  href = "/signup",
}: {
  title: string;
  children: ReactNode;
  linkLabel?: string;
  href?: string;
}) {
  return (
    <section className="buyer-cta public-container" aria-label={title}>
      <div>
        <p className="buyer-eyebrow">NEXT STEP</p>
        <h2>{title}</h2>
        <p>{children}</p>
      </div>
      <Link className="buyer-button" href={href} data-af-event="primary_cta_click" data-af-cta={href === "/contact" ? "contact" : "signup"} data-af-placement="body">{linkLabel}<span aria-hidden="true">↗</span></Link>
    </section>
  );
}

export function BuyerCardGrid({ children }: { children: ReactNode }) {
  return <div className="buyer-card-grid">{children}</div>;
}

export function BuyerCard({ title, children, href, linkLabel }: { title: string; children: ReactNode; href?: string; linkLabel?: string }) {
  return (
    <article className="buyer-card">
      <h3>{title}</h3>
      <div>{children}</div>
      {href ? <Link className="buyer-text-link" href={href}>{linkLabel ?? "Learn more"} <span aria-hidden="true">→</span></Link> : null}
    </article>
  );
}
