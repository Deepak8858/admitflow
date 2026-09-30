import type { Metadata } from "next";

/** Search metadata is tied to the public site, never a request Host or auth callback origin. */
export const PUBLIC_ORIGIN = "https://admitflow.incfrog.ai";
export const DEFAULT_SOCIAL_IMAGE_PATH = "/opengraph-image.png";

export type PublicPageMetadataInput = {
  title: string;
  description: string;
  pathname: string;
  indexable?: boolean;
  imagePath?: string;
};

/** Next evaluates static metadata during the build, so this must be set before next build. */
export function publicSearchIndexable(): boolean {
  return process.env.PUBLIC_SEARCH_INDEXABLE === "true";
}

export function publicUrl(pathname: string): string {
  if (
    !pathname.startsWith("/") ||
    pathname.startsWith("//") ||
    pathname.includes("?") ||
    pathname.includes("#") ||
    (pathname.length > 1 && pathname.endsWith("/"))
  ) {
    throw new Error(`Invalid public pathname: ${pathname}`);
  }
  return `${PUBLIC_ORIGIN}${pathname}`;
}

export function publicPageMetadata({
  title,
  description,
  pathname,
  indexable = true,
  imagePath = DEFAULT_SOCIAL_IMAGE_PATH,
}: PublicPageMetadataInput): Metadata {
  const canonical = publicUrl(pathname);
  const image = publicUrl(imagePath);
  const allowIndexing = indexable && publicSearchIndexable();

  return {
    title,
    description,
    alternates: { canonical },
    robots: { index: allowIndexing, follow: allowIndexing },
    openGraph: {
      type: "website",
      siteName: "AdmitFlow",
      title,
      description,
      url: canonical,
      images: [{ url: image, width: 1200, height: 630, alt: "AdmitFlow admissions workspace for coaching teams" }],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [image],
    },
  };
}
