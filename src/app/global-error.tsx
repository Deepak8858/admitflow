"use client";

import "./fonts.css";
import "./tokens.css";

// Root failures replace the document, so keep this surface independent of app providers.
const fallbackStyles = `
  .global-error-document {
    color-scheme: light;
    background: var(--color-paper, #fafaf7);
  }
  .global-error-page {
    box-sizing: border-box;
    display: grid;
    align-items: center;
    min-height: 100vh;
    min-height: 100svh;
    margin: 0;
    padding: 32px 20px;
    background: var(--color-paper, #fafaf7);
    color: var(--color-body, #66645d);
    font-family: var(--font-body, "Inter Variable", sans-serif);
    font-size: var(--text-body, 16px);
    font-weight: var(--font-weight-body, 400);
    font-feature-settings: var(--font-features, "blwf" on, "cv03" on, "cv04" on, "cv09" on, "cv11" on);
    font-variation-settings: "wght" 400, "opsz" 18;
    line-height: var(--leading-body, 1.55);
    letter-spacing: var(--tracking-body, -.008em);
  }
  .global-error-content {
    box-sizing: border-box;
    width: 100%;
    max-width: 640px;
    margin-inline: auto;
  }
  .global-error-eyebrow {
    margin: 0 0 20px;
    color: var(--color-body, #66645d);
    font-family: var(--font-mono, "Geist Mono", monospace);
    font-size: var(--text-label, 12px);
    font-weight: 400;
    font-feature-settings: normal;
    font-variation-settings: normal;
    line-height: var(--leading-label, 1.4);
    letter-spacing: var(--tracking-label, .06em);
  }
  .global-error-title {
    margin: 0 0 20px;
    color: var(--color-ink, #2a2a27);
    font-family: var(--font-display, "Inter Variable", sans-serif);
    font-size: clamp(28px, 5vw, 36px);
    font-weight: var(--font-weight-heading, 500);
    font-variation-settings: "wght" 500, "opsz" 32;
    line-height: var(--leading-heading, 1.04);
    letter-spacing: var(--tracking-heading, -.03em);
    text-wrap: balance;
  }
  .global-error-message { margin: 0; }
  .global-error-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    margin-top: 28px;
  }
  .global-error-action {
    box-sizing: border-box;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 44px;
    padding: 12px 20px;
    border: 1px solid var(--color-rule-strong, #dfdcd3);
    border-radius: var(--radius-sm, 7px);
    background: var(--color-surface, #fff);
    color: var(--color-ink, #2a2a27);
    font: inherit;
    font-size: var(--text-nav, 14px);
    font-weight: var(--font-weight-medium, 500);
    font-feature-settings: inherit;
    font-variation-settings: "wght" 500, "opsz" 14;
    line-height: var(--leading-nav, 1.2);
    letter-spacing: var(--tracking-nav, -.003em);
    text-decoration: none;
    cursor: pointer;
  }
  .global-error-action-primary {
    border-color: var(--color-ink, #2a2a27);
    background: var(--color-ink, #2a2a27);
    color: var(--color-surface, #fff);
  }
  .global-error-action:focus-visible {
    outline: 2px solid var(--color-focus, #7466e8);
    outline-offset: 4px;
  }
`;

export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en" data-theme="light" className="global-error-document">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="robots" content="noindex, nofollow" />
        <title>This page couldn’t load | AdmitFlow</title>
        <style>{fallbackStyles}</style>
      </head>
      <body className="global-error-page">
        <main className="global-error-content" aria-labelledby="global-error-title">
          <p className="global-error-eyebrow">LET’S TRY THAT AGAIN</p>
          <h1 id="global-error-title" className="global-error-title">This page couldn’t load.</h1>
          <p className="global-error-message">Please try again. If you were saving a change, check its status before submitting it again.</p>
          <div className="global-error-actions">
            <button type="button" className="global-error-action global-error-action-primary" onClick={reset}>Try again</button>
            <a className="global-error-action" href="/">Back to home</a>
          </div>
        </main>
      </body>
    </html>
  );
}
