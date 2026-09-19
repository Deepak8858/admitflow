import type { Metadata } from "next";
import "@fontsource-variable/geist";
import "./tokens.css";
import "./globals.css";
import { AppearanceProvider } from "@/components/appearance";
import { AuthKitProvider } from "@workos-inc/authkit-nextjs/components";
import { workosConfigured } from "@/lib/config";

export const metadata: Metadata = {
  title: "AdmitFlow — Every enquiry deserves a follow-up",
  description: "An admissions recovery workspace for coaching institutes. Prioritise enquiries, follow up, book counselling and track recovered admission revenue.",
  robots: { index: false, follow: false },
};
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const content = <AppearanceProvider>{children}</AppearanceProvider>;
  const bootstrapTheme = `(function(){try{var t=localStorage.getItem('admitflow:theme');document.documentElement.dataset.theme=(t==='dark'||t==='light')?t:(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light')}catch(e){}})()`;
  return <html lang="en" suppressHydrationWarning><head><script dangerouslySetInnerHTML={{ __html: bootstrapTheme }} /></head><body>{workosConfigured() ? <AuthKitProvider>{content}</AuthKitProvider> : content}</body></html>;
}
