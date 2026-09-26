"use client";

import Link from "next/link";

export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <main className="standalone-empty">
    <p className="page-eyebrow">LET’S TRY THAT AGAIN</p>
    <h1>This page couldn’t load.</h1>
    <p>Please try again. If you were saving a change, check its status before submitting it again.</p>
    <button className="button primary" onClick={reset}>Try again</button>
    <Link className="button secondary" href="/">Back to home</Link>
  </main>;
}
