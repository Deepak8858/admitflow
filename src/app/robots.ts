import type { MetadataRoute } from "next";
import { PUBLIC_ORIGIN, publicSearchIndexable } from "@/lib/seo";

export default function robots(): MetadataRoute.Robots {
  if (!publicSearchIndexable()) {
    return { rules: { userAgent: "*", disallow: "/" } };
  }

  return {
    rules: { userAgent: "*", allow: "/", disallow: "/api/" },
    sitemap: `${PUBLIC_ORIGIN}/sitemap.xml`,
  };
}
