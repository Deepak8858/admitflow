import { publicPages } from "./public-content";

// Public access and search eligibility are distinct. Auth entry and metadata routes
// bypass hosted auth, but only published pages in publicPages can enter the sitemap.
const exactPublicPaths = new Set([
  ...publicPages.map((page) => page.pathname),
  "/welcome",
  "/login",
  "/signup",
  "/auth/error",
  "/robots.txt",
  "/sitemap.xml",
  "/opengraph-image.png",
]);

export function isPublicRoute(pathname: string): boolean {
  return exactPublicPaths.has(pathname);
}
