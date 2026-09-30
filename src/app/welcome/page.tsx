import { permanentRedirect } from "next/navigation";

// The permanent redirect is configured in next.config.ts so both GET and HEAD
// preserve query parameters. This is a safeguard if that configuration changes.
export default function WelcomePage() {
  permanentRedirect("/");
}
