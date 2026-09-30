"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { MotionConfig, motion, useReducedMotion } from "framer-motion";
import * as Tooltip from "@radix-ui/react-tooltip";
import { Monitor, Moon, Sun } from "lucide-react";

export type Theme = "system" | "light" | "dark";
export const spring = { type: "spring", stiffness: 350, damping: 28 } as const;
const AppearanceContext = createContext<{ theme: Theme; ready: boolean; setTheme: (theme: Theme) => void }>({ theme: "light", ready: false, setTheme: () => {} });

function savedTheme(value: string | null): Theme {
  return value === "dark" || value === "system" ? value : "light";
}

export function AppearanceProvider({ children }: { children: ReactNode }) {
  const [theme, updateTheme] = useState<Theme>("light");
  const [ready, setReady] = useState(false);
  useEffect(() => {
    try { updateTheme(savedTheme(localStorage.getItem("admitflow:theme"))); } catch { /* The default stays light when storage is unavailable. */ }
    setReady(true);
  }, []);
  useEffect(() => {
    if (!ready) return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => { document.documentElement.dataset.theme = theme === "system" ? media.matches ? "dark" : "light" : theme; };
    apply(); media.addEventListener("change", apply);
    const sync = (event: StorageEvent) => { if (event.key === "admitflow:theme" || event.key === null) updateTheme(savedTheme(event.newValue)); };
    window.addEventListener("storage", sync);
    return () => { media.removeEventListener("change", apply); window.removeEventListener("storage", sync); };
  }, [theme, ready]);
  function setTheme(value: Theme) { updateTheme(value); try { localStorage.setItem("admitflow:theme", value); } catch { /* The in-memory preference still works. */ } }
  return <AppearanceContext.Provider value={{ theme, ready, setTheme }}><MotionConfig reducedMotion="user" transition={spring}><Tooltip.Provider delayDuration={350}>{children}</Tooltip.Provider></MotionConfig></AppearanceContext.Provider>;
}

export function ThemeSelect() {
  const { theme, ready, setTheme } = useContext(AppearanceContext);
  const Icon = theme === "system" ? Monitor : theme === "dark" ? Moon : Sun;
  return <label className="theme-select"><Icon size={15} aria-hidden="true" /><span className="sr-only">Colour theme</span><select aria-label="Colour theme" data-appearance-ready={ready} disabled={!ready} value={theme} onChange={event => setTheme(event.target.value as Theme)}><option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option></select></label>;
}

export function Reveal({ children, className = "" }: { children: ReactNode; className?: string; delay?: number }) {
  // Marketing headings and copy must remain visible through hydration, failed
  // JavaScript, reduced motion, and visitors who never scroll to a section.
  return <div className={className}>{children}</div>;
}

export function ActiveIndicator({ id }: { id: string }) {
  const reduced = useReducedMotion();
  return <motion.i className="active-indicator" aria-hidden="true" layoutId={reduced ? undefined : id} transition={reduced ? { duration: 0 } : spring} />;
}
