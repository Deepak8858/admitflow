import assert from "node:assert/strict";
import { test } from "node:test";
import { NextRequest } from "next/server";
import config from "../next.config";
import { publicPages } from "../src/lib/public-content";
import { isPublicRoute } from "../src/lib/public-routes";

test("public bypass is bounded to published pages, auth entry and exact metadata paths", () => {
  for (const page of publicPages) assert.equal(isPublicRoute(page.pathname), true, page.pathname);
  for (const pathname of ["/welcome", "/login", "/signup", "/auth/error", "/robots.txt", "/sitemap.xml", "/opengraph-image.png"]) {
    assert.equal(isPublicRoute(pathname), true, pathname);
  }
  for (const pathname of [
    "/api", "/api/workspace", "/api/leads", "/callback", "/overview", "/leads",
    "/product/private", "/products", "/resources/private", "/resources/unknown",
    "/resources/how-to-evaluate-an-admissions-crm/extra", "/contact/private",
    "/privacy", "/terms", "/missing-page", "/robots.txt/private",
  ]) {
    assert.equal(isPublicRoute(pathname), false, pathname);
  }
});

test("stale cookies do not change classification of public URLs and assets", () => {
  for (const pathname of ["/", "/about", "/contact", "/resources/measuring-admissions-recovery-pilot", "/robots.txt", "/sitemap.xml", "/opengraph-image.png"]) {
    const request = new NextRequest(`https://admitflow.incfrog.ai${pathname}`, {
      headers: { cookie: "wos-session=expired-fixture" },
    });
    assert.equal(isPublicRoute(request.nextUrl.pathname), true, pathname);
  }
});

test("welcome has one permanent framework redirect with query passthrough semantics", async () => {
  assert.ok(config.redirects);
  const redirects = await config.redirects();
  assert.deepEqual(redirects.filter((item) => item.source === "/welcome"), [
    { source: "/welcome", destination: "/", permanent: true },
  ]);
});
