import test from "node:test";
import assert from "node:assert/strict";
import {
  PUBLIC_ANALYTICS_EVENT,
  audioPlayingEvent,
  coarseAcquisitionContext,
  primaryCTAEvent,
  publicPagePath,
  signupStartEvent,
} from "../src/lib/public-analytics";
import { publicPages } from "../src/lib/public-content";

test("public paths discard query values and reject auth or private routes", () => {
  for (const page of publicPages) {
    assert.equal(publicPagePath(`${page.pathname}?email=owner@example.com&code=private-token#details`), page.pathname);
  }
  assert.equal(publicPagePath("/?returnTo=%2Fworkspace%2Fprivate"), "/");
  for (const path of [
    "/signup", "/login", "/callback?code=private", "/auth/error", "/onboarding",
    "/overview?student=private", "/api/organizations", "//elsewhere.invalid/product",
    "https://elsewhere.invalid/product?code=private", "/product%2Fprivate",
  ]) assert.equal(publicPagePath(path), null, path);
});

test("primary CTA emits fixed fields only for a marked real signup link", () => {
  const input = {
    pathname: "/product?email=owner@example.com&state=secret",
    href: "/signup",
    event: "primary_cta_click",
    cta: "signup",
    placement: "body",
    email: "owner@example.com",
    destination: "https://example.invalid/callback?code=secret",
  };
  const detail = primaryCTAEvent(input);
  assert.deepEqual(detail, {
    version: 1,
    name: "primary_cta_click",
    page_path: "/product",
    cta_name: "signup",
    placement: "body",
  });
  assert.ok(!JSON.stringify(detail).includes("owner@example.com"));
  assert.ok(!JSON.stringify(detail).includes("secret"));
  assert.equal(PUBLIC_ANALYTICS_EVENT, "admitflow:public-analytics");
});

test("primary CTA rejects arbitrary labels, destinations, and private source paths", () => {
  const valid = { pathname: "/", href: "/signup", event: "primary_cta_click", cta: "signup", placement: "hero" };
  for (const change of [
    { href: "/signup?email=owner@example.com" },
    { href: "https://example.invalid/signup" },
    { event: "signup_complete" },
    { cta: "owner@example.com" },
    { placement: "student-123" },
    { pathname: "/onboarding" },
  ]) assert.equal(primaryCTAEvent({ ...valid, ...change }), null);
});

test("coarse attribution admits only fixed source and medium values", () => {
  assert.deepEqual(coarseAcquisitionContext("?utm_source=google&utm_medium=cpc&utm_campaign=owner%40example.com&utm_content=secret&utm_term=student"), {
    acquisition_source: "google",
    acquisition_medium: "paid_search",
  });
  assert.deepEqual(coarseAcquisitionContext("?utm_source=linkedin&utm_medium=social"), {
    acquisition_source: "linkedin",
    acquisition_medium: "social",
  });
  assert.deepEqual(coarseAcquisitionContext("?utm_source=owner%40example.com&utm_medium=email"), {});
  assert.deepEqual(coarseAcquisitionContext("?utm_source=google&utm_source=bing&utm_medium=cpc"), {});
  assert.deepEqual(coarseAcquisitionContext("?utm_source=google&utm_medium=owner%40example.com"), {
    acquisition_source: "google",
  });
  assert.deepEqual(coarseAcquisitionContext(`?utm_source=google&unused=${"x".repeat(2048)}`), {});
  assert.deepEqual(coarseAcquisitionContext("https://example.invalid/?utm_source=google"), {});
});

test("signup start means public signup CTA activation and carries only coarse acquisition context", () => {
  const detail = primaryCTAEvent({
    pathname: "/resources/how-to-evaluate-an-admissions-crm?code=private",
    search: "?utm_source=google&utm_medium=cpc&utm_campaign=owner%40example.com&returnTo=%2Fcallback%3Fcode%3Dprivate",
    href: "/signup",
    event: "primary_cta_click",
    cta: "signup",
    placement: "body",
  });
  assert.deepEqual(detail, {
    version: 1,
    name: "primary_cta_click",
    page_path: "/resources/how-to-evaluate-an-admissions-crm",
    cta_name: "signup",
    placement: "body",
    acquisition_source: "google",
    acquisition_medium: "paid_search",
  });
  assert.deepEqual(signupStartEvent(detail!), {
    version: 1,
    name: "signup_start",
    page_path: "/resources/how-to-evaluate-an-admissions-crm",
    placement: "body",
    acquisition_source: "google",
    acquisition_medium: "paid_search",
  });
  assert.ok(!JSON.stringify(signupStartEvent(detail!)).includes("owner@example.com"));
  assert.ok(!JSON.stringify(signupStartEvent(detail!)).includes("callback"));
  const contact = primaryCTAEvent({
    pathname: "/",
    href: "/contact",
    event: "primary_cta_click",
    cta: "contact",
    placement: "hero",
  });
  assert.equal(signupStartEvent(contact!), null);
  assert.equal(signupStartEvent({ ...detail!, page_path: "/callback" }), null);
  assert.equal(signupStartEvent({ ...detail!, acquisition_source: "owner@example.com" as never }), null);
});

test("contact and mail CTAs count clicks without recording the email destination or claiming acceptance", () => {
  const base = { pathname: "/contact?code=private", event: "primary_cta_click", placement: "body" };
  assert.deepEqual(primaryCTAEvent({ ...base, href: "/contact", cta: "contact" }), {
    version: 1, name: "primary_cta_click", page_path: "/contact", cta_name: "contact", placement: "body",
  });
  const mail = primaryCTAEvent({
    ...base, href: "mailto:support@admitflow.incfrog.ai", cta: "pilot_email",
  });
  assert.deepEqual(mail, {
    version: 1, name: "primary_cta_click", page_path: "/contact", cta_name: "pilot_email", placement: "body",
  });
  assert.ok(!JSON.stringify(mail).includes("support@"));
  assert.equal(primaryCTAEvent({
    ...base, href: "mailto:other@example.com?subject=private", cta: "support_email",
  }), null);
});

test("actual audio sample contract contains a fixed sample id and public path", () => {
  const input = {
    pathname: "/product?token=secret",
    slug: "session-reminder",
    src: "/media/session-reminder.mp3",
    privateMessage: "student reply",
  };
  const detail = audioPlayingEvent(input);
  assert.deepEqual(detail, {
    version: 1,
    name: "sample_audio_play",
    page_path: "/product",
    sample_id: "session-reminder",
  });
  assert.equal(audioPlayingEvent({ pathname: "/analytics", slug: "walkthrough", src: "/media/walkthrough.mp3" }), null);
  assert.equal(audioPlayingEvent({ pathname: "/", slug: "walkthrough?email=private", src: "/media/walkthrough.mp3" }), null);
  assert.equal(audioPlayingEvent({ pathname: "/", slug: "walkthrough", src: "/media/walkthrough.mp3?token=private" }), null);
});
