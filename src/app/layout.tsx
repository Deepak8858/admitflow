import type { Metadata } from "next";
import "./fonts.css";
import "./tokens.css";
import "./globals.css";
import { AppearanceProvider } from "@/components/appearance";

export const metadata: Metadata = {
  title: "AdmitFlow — Every enquiry deserves a follow-up",
  description: "An admissions recovery workspace for coaching institutes. Prioritise enquiries, follow up, book counselling and track recovered admission revenue.",
  robots: { index: false, follow: false },
};
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const content = <AppearanceProvider>{children}</AppearanceProvider>;
  const bootstrapTheme = `(function(){var theme='light';try{var saved=localStorage.getItem('admitflow:theme');if(saved==='dark'||saved==='light'){theme=saved}else if(saved==='system'){theme=matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'}}catch(e){}document.documentElement.dataset.theme=theme})()`;
  return <html lang="en" data-theme="light" suppressHydrationWarning><head><link rel="preload" href="/fonts/inter-variable-4.0-latin.woff2" as="font" type="font/woff2" crossOrigin="anonymous" /><link rel="preload" href="/fonts/inter-medium-4.0-latin.woff2" as="font" type="font/woff2" crossOrigin="anonymous" /><script dangerouslySetInnerHTML={{ __html: bootstrapTheme }} /></head><body>{content}</body></html>;
}
