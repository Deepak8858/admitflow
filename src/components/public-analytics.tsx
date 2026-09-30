"use client";

import { useEffect } from "react";
import {
  PUBLIC_ANALYTICS_EVENT,
  audioPlayingEvent,
  primaryCTAEvent,
  publicPagePath,
  signupStartEvent,
  type PublicAnalyticsDetail,
} from "@/lib/public-analytics";

/**
 * Mount once inside the public layout. This dispatches a local CustomEvent;
 * it does not install a provider, send a request, or persist visitor data.
 */
export function PublicAnalytics({ pathname }: { pathname: string }) {
  useEffect(() => {
    const declaredPath = publicPagePath(pathname);
    if (!declaredPath) return;

    const emit = (detail: PublicAnalyticsDetail | null) => {
      if (detail && publicPagePath(window.location.pathname) === declaredPath) {
        window.dispatchEvent(new CustomEvent<PublicAnalyticsDetail>(PUBLIC_ANALYTICS_EVENT, { detail }));
      }
    };

    const onClick = (event: MouseEvent) => {
      if (event.button !== 0 || event.defaultPrevented || !(event.target instanceof Element)) return;
      const anchor = event.target.closest<HTMLAnchorElement>("a[data-af-event]");
      if (!anchor) return;
      const detail = primaryCTAEvent({
        pathname: window.location.pathname,
        href: anchor.getAttribute("href"),
        event: anchor.dataset.afEvent,
        cta: anchor.dataset.afCta,
        placement: anchor.dataset.afPlacement,
        search: window.location.search,
      });
      emit(detail);
      if (detail) emit(signupStartEvent(detail));
    };

    // "playing" follows actual media start; "play" can fire while the
    // browser is still loading or when playback ultimately fails.
    const activeAudio = new WeakSet<HTMLAudioElement>();
    const onPlaying = (event: Event) => {
      if (!(event.target instanceof HTMLAudioElement) || activeAudio.has(event.target)) return;
      const player = event.target;
      const detail = audioPlayingEvent({
        pathname: window.location.pathname,
        slug: player.dataset.afAudio,
        src: player.getAttribute("src"),
      });
      if (detail) {
        activeAudio.add(player);
        emit(detail);
      }
    };
    const onStop = (event: Event) => {
      if (event.target instanceof HTMLAudioElement) activeAudio.delete(event.target);
    };

    document.addEventListener("click", onClick, true);
    document.addEventListener("playing", onPlaying, true);
    document.addEventListener("pause", onStop, true);
    document.addEventListener("ended", onStop, true);
    return () => {
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("playing", onPlaying, true);
      document.removeEventListener("pause", onStop, true);
      document.removeEventListener("ended", onStop, true);
    };
  }, [pathname]);

  return null;
}
