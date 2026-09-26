import type { Metadata } from "next";
import Link from "next/link";
import { Brand } from "@/components/ui";

export const metadata: Metadata = { title: "Sign-in interrupted — AdmitFlow", robots: { index: false, follow: false } };

export default function AuthErrorPage() {
  return <main className="standalone-empty">
    <Link href="/" aria-label="AdmitFlow home"><Brand /></Link>
    <h1>Let’s get you signed in.</h1>
    <p>Your sign-in link may have expired or the connection was interrupted. Start again to open your institute.</p>
    <a href="/login" className="button primary">Try signing in again</a>
    <Link href="/" className="button secondary">Back to home</Link>
  </main>;
}
