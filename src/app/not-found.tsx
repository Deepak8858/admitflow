import Link from "next/link";
export default function NotFound() {
  return <main className="standalone-empty"><h1>This page isn’t here.</h1><p>Return to your admissions workspace to find your next action.</p><Link className="button primary" href="/">Go to overview</Link></main>;
}
