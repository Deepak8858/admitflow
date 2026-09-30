/**
 * The public event contract contains fixed identifiers only. A future provider
 * adapter must opt in to this contract instead of collecting page_location,
 * referrer, query strings, form fields, or arbitrary data attributes.
 */
import { publicPageByPath } from "./public-content";

export const PUBLIC_ANALYTICS_EVENT = "admitflow:public-analytics";

const ctaNames = ["signup", "contact", "pilot_email", "support_email"] as const;
const ctaPlacements = ["nav", "hero", "body", "footer"] as const;
const ctaDestinations = {
  signup: "/signup",
  contact: "/contact",
  pilot_email: "mailto:support@admitflow.incfrog.ai",
  support_email: "mailto:support@admitflow.incfrog.ai",
} as const satisfies Record<typeof ctaNames[number], string>;
const audioSamples = [
  "walkthrough",
  "counselling-invitation",
  "session-reminder",
  "thoughtful-followup",
] as const;
const utmSources = {
  google: "google",
  bing: "bing",
  linkedin: "linkedin",
  whatsapp: "whatsapp",
  newsletter: "newsletter",
} as const;
const utmMediums = {
  organic: "organic",
  cpc: "paid_search",
  paid_search: "paid_search",
  email: "email",
  social: "social",
  referral: "referral",
} as const;

export type PublicPath = string;
export type CTAName = typeof ctaNames[number];
export type CTAPlacement = typeof ctaPlacements[number];
export type AudioSample = typeof audioSamples[number];
export type AcquisitionSource = typeof utmSources[keyof typeof utmSources];
export type AcquisitionMedium = typeof utmMediums[keyof typeof utmMediums];
export type AcquisitionContext = {
  acquisition_source?: AcquisitionSource;
  acquisition_medium?: AcquisitionMedium;
};
export type PrimaryCTADetail = {
  version: 1;
  name: "primary_cta_click";
  page_path: PublicPath;
  cta_name: CTAName;
  placement: CTAPlacement;
} & AcquisitionContext;
export type SignupStartDetail = {
  version: 1;
  name: "signup_start";
  page_path: PublicPath;
  placement: CTAPlacement;
} & AcquisitionContext;

export type PublicAnalyticsDetail =
  | PrimaryCTADetail
  | SignupStartDetail
  | { version: 1; name: "sample_audio_play"; page_path: PublicPath; sample_id: AudioSample };

function isOneOf<const T extends readonly string[]>(value: unknown, options: T): value is T[number] {
  return typeof value === "string" && options.some(option => option === value);
}

export function publicPagePath(value: unknown): PublicPath | null {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) return null;
  // Query values can contain emails, callback codes, and return paths. They are
  // never interpreted as analytics parameters or included in the event.
  const pathname = value.split(/[?#]/, 1)[0].replace(/\/$/, "") || "/";
  return publicPageByPath(pathname)?.pathname ?? null;
}

/**
 * Only exact, familiar UTM values survive. Unknown values, duplicated keys,
 * other UTM fields and every other query parameter are discarded.
 */
export function coarseAcquisitionContext(search: unknown): AcquisitionContext {
  if (typeof search !== "string" || !search.startsWith("?") || search.length > 2048) return {};
  const params = new URLSearchParams(search);
  const sources = params.getAll("utm_source");
  if (sources.length !== 1 || !Object.hasOwn(utmSources, sources[0])) return {};
  const acquisition_source = utmSources[sources[0] as keyof typeof utmSources];
  const mediums = params.getAll("utm_medium");
  if (mediums.length !== 1 || !Object.hasOwn(utmMediums, mediums[0])) return { acquisition_source };
  return {
    acquisition_source,
    acquisition_medium: utmMediums[mediums[0] as keyof typeof utmMediums],
  };
}

export function primaryCTAEvent(input: {
  pathname: unknown;
  href: unknown;
  event: unknown;
  cta: unknown;
  placement: unknown;
  search?: unknown;
}): PrimaryCTADetail | null {
  const page_path = publicPagePath(input.pathname);
  if (
    !page_path ||
    input.event !== "primary_cta_click" ||
    !isOneOf(input.cta, ctaNames) ||
    !isOneOf(input.placement, ctaPlacements) ||
    input.href !== ctaDestinations[input.cta]
  ) return null;
  return {
    version: 1,
    name: "primary_cta_click",
    page_path,
    cta_name: input.cta,
    placement: input.placement,
    ...coarseAcquisitionContext(input.search),
  };
}

/** Activation of the public signup CTA starts navigation, not registration. */
export function signupStartEvent(cta: PrimaryCTADetail): SignupStartDetail | null {
  if (
    cta.version !== 1 ||
    cta.name !== "primary_cta_click" ||
    cta.cta_name !== "signup" ||
    publicPagePath(cta.page_path) !== cta.page_path ||
    !isOneOf(cta.placement, ctaPlacements) ||
    (cta.acquisition_source !== undefined && !isOneOf(cta.acquisition_source, Object.values(utmSources))) ||
    (cta.acquisition_medium !== undefined && (
      !cta.acquisition_source || !isOneOf(cta.acquisition_medium, Object.values(utmMediums))
    ))
  ) return null;
  const { version, page_path, placement, acquisition_source, acquisition_medium } = cta;
  return {
    version,
    name: "signup_start",
    page_path,
    placement,
    ...(acquisition_source ? { acquisition_source } : {}),
    ...(acquisition_medium ? { acquisition_medium } : {}),
  };
}

export function audioPlayingEvent(input: {
  pathname: unknown;
  slug: unknown;
  src: unknown;
}): PublicAnalyticsDetail | null {
  const page_path = publicPagePath(input.pathname);
  if (!page_path || !isOneOf(input.slug, audioSamples) || input.src !== `/media/${input.slug}.mp3`) return null;
  return { version: 1, name: "sample_audio_play", page_path, sample_id: input.slug };
}
