"use client";

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { MotionConfig, motion, useInView, useReducedMotion } from "framer-motion";
import * as Tooltip from "@radix-ui/react-tooltip";
import { Monitor, Moon, Sun } from "lucide-react";

export type Theme = "system" | "light" | "dark";
export const spring = { type: "spring", stiffness: 350, damping: 28 } as const;
const AppearanceContext = createContext<{ theme: Theme; setTheme: (theme: Theme) => void }>({ theme: "system", setTheme: () => {} });

export function AppearanceProvider({ children }: { children: ReactNode }) {
  const [theme, updateTheme] = useState<Theme>("system");
  const [ready, setReady] = useState(false);
  useEffect(() => {
    try { const stored = localStorage.getItem("admitflow:theme"); if (stored === "light" || stored === "dark") updateTheme(stored); } catch { /* Storage can be unavailable in private browsing. */ }
    setReady(true);
  }, []);
  useEffect(() => {
    if (!ready) return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => { document.documentElement.dataset.theme = theme === "system" ? media.matches ? "dark" : "light" : theme; };
    apply(); media.addEventListener("change", apply);
    const sync = (event: StorageEvent) => { if (event.key === "admitflow:theme") updateTheme(event.newValue === "light" || event.newValue === "dark" ? event.newValue : "system"); };
    window.addEventListener("storage", sync);
    return () => { media.removeEventListener("change", apply); window.removeEventListener("storage", sync); };
  }, [theme, ready]);
  function setTheme(value: Theme) { updateTheme(value); try { localStorage.setItem("admitflow:theme", value); } catch { /* The in-memory preference still works. */ } }
  return <AppearanceContext.Provider value={{ theme, setTheme }}><MotionConfig reducedMotion="user" transition={spring}><Tooltip.Provider delayDuration={350}>{children}</Tooltip.Provider></MotionConfig></AppearanceContext.Provider>;
}

export function ThemeSelect() {
  const { theme, setTheme } = useContext(AppearanceContext);
  const Icon = theme === "system" ? Monitor : theme === "dark" ? Moon : Sun;
  return <label className="theme-select"><Icon size={15} aria-hidden="true" /><span className="sr-only">Colour theme</span><select aria-label="Colour theme" value={theme} onChange={event => setTheme(event.target.value as Theme)}><option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option></select></label>;
}

export function Reveal({ children, className = "", delay = 0 }: { children: ReactNode; className?: string; delay?: number }) {
  const reduced = useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);
  const visible = useInView(ref, { once: true, amount: 0.08 });
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  // SSR and first hydration stay visible and identical; motion is progressive enhancement.
  const hidden = mounted && !reduced && !visible;
  return <motion.div ref={ref} className={className} initial={false} animate={{ opacity: hidden ? 0 : 1, y: hidden ? 12 : 0 }} transition={reduced ? { duration: 0 } : { ...spring, delay }}>{children}</motion.div>;
}

export function ActiveIndicator({ id }: { id: string }) {
  const reduced = useReducedMotion();
  return <motion.i className="active-indicator" aria-hidden="true" layoutId={reduced ? undefined : id} transition={reduced ? { duration: 0 } : spring} />;
}
