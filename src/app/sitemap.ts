import type { MetadataRoute } from "next";
import { publicPages } from "@/lib/public-content";
import { publicSearchIndexable, publicUrl } from "@/lib/seo";

export default function sitemap(): MetadataRoute.Sitemap {
  if (!publicSearchIndexable()) return [];
  return publicPages
    .filter((page) => page.indexable && page.sitemap)
    .map((page) => ({ url: publicUrl(page.pathname) }));
}
