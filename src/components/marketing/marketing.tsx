import { PublicLayout } from "./public-layout";
import { HelpPage, PricingPage, ProductPage, WelcomePage } from "./marketing-pages";

export { PublicLayout } from "./public-layout";
export { ProductPreview } from "./product-preview";

type PublicPage = "welcome" | "product" | "pricing" | "help";

const paths: Record<PublicPage, string> = {
  welcome: "/",
  product: "/product",
  pricing: "/pricing",
  help: "/help",
};

export function MarketingPage({ page }: { page: PublicPage }) {
  return (
    <PublicLayout pathname={paths[page]}>
      {page === "welcome" ? (
        <WelcomePage />
      ) : page === "product" ? (
        <ProductPage />
      ) : page === "pricing" ? (
        <PricingPage />
      ) : (
        <HelpPage />
      )}
    </PublicLayout>
  );
}
