"use client";

import { useId, useState } from "react";
import {
  ArrowRight,
  ArrowUpRight,
  Check,
  CheckCheck,
  ChevronRight,
  CircleCheck,
  Layers3,
  Search,
  Sparkles,
} from "lucide-react";

const steps = ["Prioritise", "Review context", "Compose", "Check status"];
const people = [
  { name: "Aanya", initials: "AS", course: "Entrance preparation", next: "Review course questions" },
  { name: "Kabir", initials: "KM", course: "Foundation programme", next: "Arrange counselling" },
  { name: "Meera", initials: "MP", course: "Weekend preparation", next: "Discuss availability" },
];

export function ProductPreview() {
  const [step, setStep] = useState(0);
  const [student, setStudent] = useState("Aanya");
  const [message, setMessage] = useState(
    "Hi Aanya, would you like to find a time to talk through your course options? Happy to answer any questions.",
  );
  const [reviewed, setReviewed] = useState(false);
  const id = useId();

  function chooseStudent(name: string) {
    setStudent(name);
    setMessage(`Hi ${name}, would you like to find a time to talk through your course options? Happy to answer any questions.`);
    setReviewed(false);
    setStep(1);
  }

  return (
    <div className="product-workbench">
      <div className="workbench-chrome">
        <span>
          <span className="workbench-logo"><Layers3 size={16} aria-hidden="true" /></span>
          Northstar Academy <ChevronRight size={13} aria-hidden="true" />
          <strong>Recovery workbench</strong>
        </span>
        <span className="badge violet">Fictional preview</span>
      </div>
      <div className="workbench-body">
        <aside className="workbench-rail">
          <span>THE NEXT STEP</span>
          {steps.map((label, index) => (
            <button
              type="button"
              key={label}
              onClick={() => setStep(index)}
              aria-pressed={step === index}
              className={step === index ? "active" : ""}
              data-public-action="preview-step"
              data-public-label={label}
            >
              <b>{String(index + 1).padStart(2, "0")}</b>
              {label}
              {step === index && <i className="active-indicator" aria-hidden="true" />}
            </button>
          ))}
          <p>Try it out.<br />Nothing here is sent.</p>
        </aside>
        <section className="workbench-canvas" aria-label="Interactive product example">
          <div className="workbench-heading">
            <div>
              <span className="public-eyebrow">{String(step + 1).padStart(2, "0")} / RECOVERY WORKFLOW</span>
              <h3>{[
                "A fresh conversation starts here.",
                "Context before contact.",
                "Make it sound like you.",
                "Accepted is not delivered.",
              ][step]}</h3>
            </div>
            <span className="workbench-tool"><Search size={16} aria-hidden="true" /></span>
          </div>
          {step === 0 && (
            <>
              <p>Choose a fictional enquiry to explore their next step.</p>
              <div className="preview-table">
                <div className="preview-table-heading">
                  <span>STUDENT</span><span>INTEREST</span><span>NEXT STEP</span>
                </div>
                {people.map((person, index) => (
                  <button
                    type="button"
                    onClick={() => chooseStudent(person.name)}
                    key={person.name}
                    data-public-action="preview-enquiry"
                  >
                    <span><i className={`preview-avatar tone-${index}`}>{person.initials}</i><strong>{person.name}</strong></span>
                    <span>{person.course}</span>
                    <span>{person.next}<ArrowUpRight size={14} aria-hidden="true" /></span>
                  </button>
                ))}
              </div>
              <div className="preview-note">
                <Sparkles size={16} aria-hidden="true" />
                Priority signals help your team decide. They don’t guarantee an admission.
              </div>
            </>
          )}
          {step === 1 && (
            <div className="preview-context">
              <div>
                <span className="preview-avatar tone-0">{student.slice(0, 1)}</span>
                <h4>{student}’s enquiry</h4>
                <p>Interested in course options and study schedules.</p>
                <dl>
                  <div><dt>Contact preference</dt><dd>Opted in · sample</dd></div>
                  <div><dt>Conversation owner</dt><dd>Human counsellor</dd></div>
                  <div><dt>Next action</dt><dd>Answer course questions</dd></div>
                </dl>
              </div>
              <blockquote>
                “I’d like to understand how the classes fit around my school schedule.”
                <cite>Fictional student message</cite>
              </blockquote>
              <button type="button" className="button primary" onClick={() => setStep(2)}>
                Draft a follow-up <ArrowRight size={15} aria-hidden="true" />
              </button>
            </div>
          )}
          {step === 2 && (
            <div className="preview-compose">
              <label htmlFor={`${id}-message`}>Sample follow-up for {student}</label>
              <textarea
                id={`${id}-message`}
                value={message}
                onChange={(event) => { setMessage(event.target.value); setReviewed(false); }}
                maxLength={500}
                rows={4}
              />
              <p>This is an editable illustration, not an approved WhatsApp template.</p>
              <label className="preview-checkbox">
                <input
                  type="checkbox"
                  checked={reviewed}
                  onChange={(event) => setReviewed(event.target.checked)}
                />
                I’ve reviewed this fictional message.
              </label>
              <button
                type="button"
                className="button primary"
                disabled={!reviewed || !message.trim()}
                onClick={() => setStep(3)}
              >
                See example statuses <ArrowRight size={15} aria-hidden="true" />
              </button>
              <small>No message will be sent.</small>
            </div>
          )}
          {step === 3 && (
            <div className="preview-statuses">
              <div><CircleCheck size={21} aria-hidden="true" /><span><strong>Queued</strong><p>The request is waiting to be processed.</p></span></div>
              <div><Check size={21} aria-hidden="true" /><span><strong>Provider accepted</strong><p>The provider accepted the request, with delivery still to confirm.</p></span></div>
              <div><CheckCheck size={21} aria-hidden="true" /><span><strong>Delivered</strong><p>Only shown when a delivery receipt confirms it.</p></span></div>
              <p className="preview-note">Illustrative states only. No live request has been made.</p>
              <button type="button" className="button secondary" onClick={() => setStep(0)}>
                Explore another enquiry <ArrowRight size={15} aria-hidden="true" />
              </button>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
