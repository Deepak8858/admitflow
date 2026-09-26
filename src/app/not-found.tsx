import Link from "next/link";
export default function NotFound() {
  return <main className="standalone-empty"><p className="page-eyebrow">404 · PAGE NOT FOUND</p><h1>This page isn’t here.</h1><p>The link may have changed. Head home or open your admissions workspace.</p><Link className="button primary" href="/">Back to home</Link><Link className="button secondary" href="/overview">Open workspace</Link></main>;
}
