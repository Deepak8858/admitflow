"use client";

import { useEffect, useRef, useState } from "react";
const illustrations = {
  "admissions-mountain-hero": { alt: "Snow-covered alpine peaks beneath an open blue sky.", width: 1920, height: 1280 },
  "opportunity-garden": { alt: "A coral conversation path winds through a garden of turquoise leaves and violet terraces toward a sunlit blue arch.", width: 1536, height: 1024 },
  "knowledge-observatory": { alt: "A colourful knowledge observatory with spiral bookshelves and a golden conversation sculpture.", width: 1024, height: 1024 },
  "next-chapter-campus": { alt: "A welcoming miniature campus of coral pavilions, yellow stairs and turquoise bridges.", width: 1536, height: 1024 },
} as const;
export function Illustration({ name, className = "", eager = false, decorative = false, sizes = "(max-width: 700px) 100vw, 50vw" }: { name: keyof typeof illustrations; className?: string; eager?: boolean; decorative?: boolean; sizes?: string }) {
  const [failed, setFailed] = useState(false);
  const imageRef = useRef<HTMLImageElement>(null);
  useEffect(() => {
    const element = imageRef.current;
    if (element?.complete && element.naturalWidth === 0) setFailed(true);
  }, []);
  const image = illustrations[name];
  return <div className={`illustration ${className}`}>
    {failed ? <div className="illustration-fallback" role={decorative ? undefined : "img"} aria-label={decorative ? undefined : image.alt}><span aria-hidden="true">↗</span></div> : <img ref={imageRef} src={`/media/${name}.webp`} srcSet={`/media/${name}-small.webp 640w, /media/${name}.webp ${image.width}w`} sizes={sizes} width={image.width} height={image.height} alt={decorative ? "" : image.alt} loading={eager ? "eager" : "lazy"} fetchPriority={eager ? "high" : "auto"} onError={() => setFailed(true)} />}
  </div>;
}
