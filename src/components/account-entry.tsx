"use client";

import { useActionState, useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { ArrowRight, LoaderCircle } from "lucide-react";
import { ThemeSelect } from "./appearance";
import { Illustration } from "./illustration";
import { Brand, Button, Field } from "./ui";
import type { AuthEntryAction, AuthEntryMode, AuthEntryState } from "@/lib/auth-entry";

interface AccountEntryProps {
  mode: AuthEntryMode;
  configured: boolean;
  localPreview: boolean;
  action: AuthEntryAction;
}

const initialState: AuthEntryState = {};

export function AccountEntry({ mode, configured, localPreview, action }: AccountEntryProps) {
  const signup = mode === "signup";
  const [state, formAction, pending] = useActionState(action, initialState);
  const [email, setEmail] = useState(state.email ?? "");
  const formRef = useRef<HTMLFormElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const fieldErrorId = useId();

  useEffect(() => {
    if (state.fieldError) {
      formRef.current?.querySelector<HTMLInputElement>('input[name="email"]')?.focus();
    } else if (state.error) {
      errorRef.current?.focus();
    }
  }, [state]);

  return (
    <div className="account-entry">
      <a className="skip-link" href="#account-entry-main">Skip to account access</a>
      <header className="account-entry-header">
        <Link href="/" aria-label="AdmitFlow home"><Brand /></Link>
        <div className="account-entry-header-actions">
          <Link href="/help">Help</Link>
          <ThemeSelect />
        </div>
      </header>

      <main className="account-entry-main" id="account-entry-main">
        <section className="account-entry-form-panel" aria-labelledby="account-entry-title">
          <div className="account-entry-form-inner">
            <span className="account-entry-eyebrow">{signup ? "A GOOD PLACE TO BEGIN" : "WELCOME BACK"}</span>
            <h1 id="account-entry-title">{signup ? "Start with your account." : "Welcome back."}</h1>
            <p className="account-entry-intro">
              {signup
                ? "A few thoughtful steps, and your admissions workspace is ready to take shape."
                : "Continue to the admissions workspace with your work email."}
            </p>

            {signup && (
              <ol className="account-entry-steps" aria-label="Signup steps">
                <li aria-current="step"><span className="account-entry-step-number">01</span><span>Account</span></li>
                <li><span className="account-entry-step-number">02</span><span>Institute</span></li>
                <li><span className="account-entry-step-number">03</span><span>Workspace</span></li>
              </ol>
            )}

            <div className="account-entry-card">
              <div className="account-entry-card-heading">
                <h2>{signup ? "Create your account" : "Sign in to AdmitFlow"}</h2>
                <p>{signup ? "Use the email you’d like to work with." : "Enter the email linked to your account."}</p>
              </div>

              {!configured && (
                <div className="account-entry-unavailable" role="status">
                  <strong>Hosted account access is unavailable</strong>
                  <p>Please try again later or contact your administrator.</p>
                  {localPreview && <Link href="/settings">Open local workspace settings <ArrowRight size={14} aria-hidden="true" /></Link>}
                </div>
              )}

              <form ref={formRef} action={formAction} aria-busy={pending}>
                {state.error && (
                  <div ref={errorRef} className="account-entry-error" role="alert" tabIndex={-1}>
                    {state.error}
                  </div>
                )}
                <Field
                  label="Email address"
                  name="email"
                  type="email"
                  autoComplete="email"
                  inputMode="email"
                  maxLength={254}
                  required
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  disabled={!configured || pending}
                  aria-invalid={Boolean(state.fieldError)}
                  aria-describedby={state.fieldError ? fieldErrorId : undefined}
                />
                {state.fieldError && <p id={fieldErrorId} className="account-entry-field-error" role="alert">{state.fieldError}</p>}
                <Button type="submit" variant="primary" className="account-entry-submit" disabled={!configured || pending}>
                  {pending ? <><LoaderCircle size={17} className="spin" aria-hidden="true" />Continuing…</> : <>Continue with email <ArrowRight size={17} aria-hidden="true" /></>}
                </Button>
              </form>

              <p className="account-entry-next">
                {signup
                  ? "Next, secure sign-in will guide you through any required email verification."
                  : "Secure sign-in will guide you through the next step."}
              </p>
            </div>

            <p className="account-entry-switch">
              {signup ? "Already have an account?" : "New to AdmitFlow?"}{" "}
              <Link href={signup ? "/login" : "/signup"}>{signup ? "Log in" : "Create an account"}</Link>
            </p>
          </div>
        </section>

        <aside className="account-entry-visual" aria-label="About AdmitFlow">
          <div className="account-entry-visual-inner">
            <div className="account-entry-visual-copy">
              <span>ADMITFLOW / YOUR NEXT CHAPTER</span>
              <h2>Make room for every next step.</h2>
              <p>Bring your institute, enquiries and conversations into one shared place.</p>
            </div>
            <div className="account-entry-art-frame">
              <Illustration name="next-chapter-campus" className="account-entry-art" decorative eager sizes="(max-width: 800px) 100vw, 50vw" />
            </div>
            <div className="account-entry-visual-footer"><span>Thoughtful admissions, from the first hello.</span><span aria-hidden="true">↗</span></div>
          </div>
        </aside>
      </main>
    </div>
  );
}
