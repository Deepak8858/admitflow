"use client";
import { useEffect, useId, useRef, type ButtonHTMLAttributes, type ReactNode, type InputHTMLAttributes, type SelectHTMLAttributes, type KeyboardEvent } from "react";
import { X, LoaderCircle, ArrowUpRight, Inbox, Check } from "lucide-react";
import { initials, scoreLead, type Lead } from "@/lib/domain";
import { useWorkspace, useOptionalWorkspace, paidActionBlocked } from "./provider";
import { cva } from "class-variance-authority";
import * as Tooltip from "@radix-ui/react-tooltip";
import * as Switch from "@radix-ui/react-switch";

export function Brand({ small = false }: { small?: boolean }) {
  return <span className={`brand ${small ? "small" : ""}`}><span className="brand-mark" aria-hidden="true"><svg viewBox="0 0 32 32"><path d="m6 24 9-17h7l-9 17H6Z" fill="currentColor"/><path d="m20 17 6 7h-10l4-7Z" fill="currentColor"/></svg></span>{!small && <span>AdmitFlow</span>}</span>;
}
const buttonClass = cva("button", { variants: { variant: { primary: "primary", secondary: "secondary", ghost: "ghost", danger: "danger" } }, defaultVariants: { variant: "secondary" } });
export function Button({ children, variant = "secondary", loading, action, className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "ghost" | "danger"; loading?: boolean; action?: Record<string, unknown> }) {
  const context = useOptionalWorkspace();
  const blocked = Boolean(action && context?.data && paidActionBlocked(context.data, action));
  return <button type="button" {...props} title={blocked ? context?.data?.capabilities?.message : props.title} className={`${buttonClass({ variant })} ${className}`} disabled={loading || props.disabled || blocked} aria-busy={loading || undefined}>{loading && <LoaderCircle size={16} className="spin" />}{children}</button>;
}
export function IconButton({ label, children, className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return <Tooltip.Root><Tooltip.Trigger asChild><button type="button" {...props} className={`icon-button ${className}`} aria-label={label}>{children}</button></Tooltip.Trigger><Tooltip.Portal><Tooltip.Content className="tooltip" sideOffset={6}>{label}<Tooltip.Arrow /></Tooltip.Content></Tooltip.Portal></Tooltip.Root>;
}
export function Avatar({ name, small = false, index = 0 }: { name: string; small?: boolean; index?: number }) {
  const colour = (name.charCodeAt(0) + index) % 5;
  return <span aria-hidden="true" className={`avatar avatar-${colour} ${small ? "avatar-small" : ""}`}>{initials(name)}</span>;
}
export function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: string }) { return <span className={`badge ${tone}`}>{children}</span>; }
export function Score({ lead }: { lead: Lead }) {
  const { score, reasons } = scoreLead(lead);
  return <span className={`score ${score >= 70 ? "high" : score >= 40 ? "medium" : "low"}`} title={reasons.map(r => `${r.label}: +${r.points}`).join("\n")}><span className="score-dot" />{score}<span className="sr-only"> out of 100, heuristic intent score</span></span>;
}
export function Field({ label, hint, className = "", ...props }: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string }) {
  const id = useId();
  return <label className={`field ${className}`} htmlFor={id}><span id={`${id}-label`}>{label}{props.required && <span className="required-mark" aria-hidden="true"> *</span>}</span><input {...props} id={id} aria-labelledby={`${id}-label`} aria-describedby={hint ? `${id}-hint` : undefined} />{hint && <small id={`${id}-hint`}>{hint}</small>}</label>;
}
export function SelectField({ label, children, className = "", ...props }: SelectHTMLAttributes<HTMLSelectElement> & { label: string }) {
  const id = useId();
  return <label className={`field ${className}`} htmlFor={id}><span id={`${id}-label`}>{label}</span><select {...props} id={id} aria-labelledby={`${id}-label`}>{children}</select></label>;
}
export function TextareaField({ label, ...props }: React.TextareaHTMLAttributes<HTMLTextAreaElement> & { label: string }) {
  const id = useId();
  return <label className="field" htmlFor={id}><span id={`${id}-label`}>{label}</span><textarea {...props} id={id} aria-labelledby={`${id}-label`} /></label>;
}
function containDialogFocus(event: KeyboardEvent<HTMLDialogElement>) {
  if (event.key !== "Tab") return;
  const dialog = event.currentTarget;
  const targets = [...dialog.querySelectorAll<HTMLElement>('button:enabled, a[href], input:enabled:not([type="hidden"]), select:enabled, textarea:enabled, [tabindex]:not([tabindex="-1"])')]
    .filter(element => element.getClientRects().length > 0 && element.getAttribute("aria-hidden") !== "true");
  const first = targets[0], last = targets.at(-1);
  if (!first || !last) { event.preventDefault(); dialog.focus(); return; }
  if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
}
export function Dialog({ title, children, onClose, wide, drawer }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean; drawer?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  const { notice, clearNotice } = useWorkspace();
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const dialog = ref.current;
    dialog?.showModal();
    const focusable = dialog?.querySelector<HTMLElement>("[autofocus], input, textarea, select");
    focusable?.focus();
    return () => { dialog?.close(); if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, []);
  return <dialog ref={ref} className={`dialog ${wide ? "dialog-wide" : ""} ${drawer ? "drawer" : ""}`} aria-labelledby={id} onKeyDown={containDialogFocus} onCancel={e => { e.preventDefault(); onClose(); }} onClick={e => { if (e.target === ref.current) onClose(); }}><div className="dialog-content"><header className="dialog-header"><h2 id={id}>{title}</h2><IconButton label="Close dialog" onClick={onClose}><X size={20} /></IconButton></header>{notice?.tone === "error" && <div className="inline-error dialog-error" role="alert"><p>{notice.message}</p><IconButton label="Dismiss error" onClick={clearNotice}><X size={16} /></IconButton></div>}{children}</div></dialog>;
}
export function EmptyState({ title, body, action }: { title: string; body: string; action?: ReactNode }) {
  return <div className="empty-state"><span className="empty-icon"><Inbox size={26} /></span><h3>{title}</h3><p>{body}</p>{action}</div>;
}
export function PanelHeader({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
  return <header className="panel-header"><div><h2>{title}</h2>{description && <p>{description}</p>}</div>{action}</header>;
}
export function PageHeading({ title, description, children }: { title: string; description: string; children?: ReactNode }) {
  return <header className="page-heading"><div><h1>{title}</h1><p>{description}</p></div><div className="heading-actions">{children}</div></header>;
}
export function TextLink({ children, onClick }: { children: ReactNode; onClick: () => void }) { return <button className="text-link" onClick={onClick}>{children}<ArrowUpRight size={15} /></button>; }
export function CheckLine({ children }: { children: ReactNode }) { return <span className="check-line"><Check size={14} />{children}</span>; }
export function Toggle({ label, checked, onChange, disabled }: { label: string; checked: boolean; onChange: (value: boolean) => void; disabled?: boolean }) { return <Switch.Root className="switch" aria-label={label} checked={checked} onCheckedChange={onChange} disabled={disabled}><Switch.Thumb className="switch-thumb" /></Switch.Root>; }
export function download(content: string, name: string, type = "text/csv;charset=utf-8") {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement("a"); anchor.href = url; anchor.download = name; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
