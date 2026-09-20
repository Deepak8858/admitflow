import { type Workspace, type Lead, type Stage, uid, DAY, HOUR, hydrateWorkspace } from "./domain";

export function createWorkspace(demo = true): Workspace {
  const now = Date.now();
  const at = (days: number, hours = 0) => new Date(now - days * DAY + hours * HOUR).toISOString();
  const workspace: Workspace = {
    id: uid(), name: demo ? "Apex Academy" : "My institute", demo, userName: demo ? "Deepak" : "Owner", email: "",
    team: demo ? ["Priya Sharma", "Arjun Mehta", "Neha Patel"] : ["Owner"],
    courses: demo ? ["NEET 2027", "JEE 2027", "NEET Dropper", "JEE Foundation"] : [],
    leads: [], messages: [], campaigns: [], jobs: [], appointments: [], revenue: [], articles: [], activities: [],
    sequence: { delays: [0, 24, 72], enabled: true },
  };
  if (!demo) return hydrateWorkspace(workspace);
  const names = ["Rahul Verma", "Ananya Singh", "Rohan Gupta", "Ishita Shah", "Aditya Kumar", "Sneha Reddy", "Aryan Patel", "Diya Sharma", "Kabir Mehta", "Meera Joshi", "Vikram Rao", "Priyanka Das", "Arnav Jain", "Saanvi Kapoor", "Dev Malhotra", "Aisha Khan", "Yash Agarwal", "Nisha Iyer", "Kunal Sethi", "Tara Menon", "Harsh Bansal", "Kavya Nair", "Rishi Desai", "Avni Pandey", "Ritvik Sinha", "Zoya Ali", "Aarav Chawla", "Tanvi Saxena", "Dhruv Mishra", "Anika Bose", "Siddharth Roy", "Pihu Goel", "Pranav Bhat", "Myra Kohli", "Reyansh Pal", "Shreya Tiwari", "Samar Gill", "Siya Anand", "Ved Khanna", "Navya Sen"];
  const stages: Stage[] = ["Qualified", "Counselling", "Contacted", "Qualified", "Negotiation", "New", "Qualified", "Contacted", "New", "Counselling", "Demo", "Contacted"];
  const source = ["Meta Ads", "Website", "Referral", "Google Ads", "Walk-in"];
  const notes = [
    "Asked about fees and the weekend classroom batch. Parent would like to visit before enrolling.",
    "Interested in the next batch. Wants a demo and a scholarship discussion with a counsellor.",
    "Compared course fees with another institute. Budget discussed; follow up about batch timings.",
    "Downloaded the course brochure. Prefers evening classes. First counselling call pending.",
  ];
  workspace.leads = names.map((name, index): Lead => ({
    id: uid(), name, phone: `+91900000${String(index + 1).padStart(4, "0")}`, email: `${name.toLowerCase().replace(" ", ".")}@example.com`,
    course: workspace.courses[index % 4], source: source[index % source.length],
    stage: index >= 30 && index < 38 ? "Admitted" : index >= 38 ? "Lost" : stages[index % stages.length],
    owner: workspace.team[index % 3], value: [65000, 72000, 48000, 36000][index % 4],
    notes: notes[index % notes.length], nextAction: ["Discuss batch timings", "Book a counselling session", "Follow up on fees", "Share the course brochure"][index % 4],
    createdAt: at(35 + index), lastContactAt: index < 14 ? at(8 + index) : at(index % 6),
    lastInboundAt: index % 5 === 4 ? null : at(index < 14 ? 8 + index : 1, index % 3),
    consent: index === 8 || index === 20 ? "unknown" : index === 9 ? "opted_out" : "opted_in",
    consentSource: "Demo enquiry form", consentAt: at(35 + index),
    isMinor: index % 3 === 0, guardianConsent: index !== 12, humanOwned: index % 4 === 0,
  }));
  const campaignId = uid();
  workspace.campaigns.push({ id: campaignId, name: "August enquiry recovery", course: "All courses", status: "completed", message: "Hi {name}, you enquired about {course} at {institute}. Would you like to book a counselling session? Reply STOP to opt out.", leadIds: workspace.leads.slice(24, 38).map(l => l.id), createdAt: at(28), delays: [0, 24, 72] });
  workspace.leads.slice(30, 38).forEach((lead, index) => {
    const recordedAt = at(24 - index * 3);
    workspace.revenue.push({ id: uid(), leadId: lead.id, amount: [48000, 36000, 65000, 72000, 48000, 36000, 65000, 72000][index], recordedAt, campaignId, reference: `DEMO-2026-${101 + index}` });
    workspace.activities.push({ id: uid(), leadId: lead.id, text: `${lead.name} enrolled in ${lead.course}`, createdAt: recordedAt, kind: "revenue" });
  });
  workspace.leads.slice(0, 20).forEach((lead, index) => {
    workspace.messages.push({ id: uid(), leadId: lead.id, body: `Hi, I was looking at your ${lead.course} course. Could you share the fees and the next batch timings?`, direction: "inbound", author: lead.name, status: "received", createdAt: lead.lastInboundAt || at(10) });
    if (index > 2) workspace.messages.push({ id: uid(), leadId: lead.id, body: `Hi ${lead.name.split(" ")[0]}, happy to help. Would you prefer a weekday or weekend counselling session?`, direction: "outbound", author: lead.owner, status: "demo", createdAt: at(index % 5, -2) });
  });
  [1, 3, 5, 10, 15].forEach((index, position) => {
    // Fixed India-local appointment times, relative to today's calendar date.
    const indiaDate = new Date(now + 5.5 * HOUR + (position > 2 ? DAY : 0)).toISOString().slice(0, 10);
    workspace.appointments.push({ id: uid(), leadId: workspace.leads[index].id, owner: workspace.leads[index].owner, startsAt: new Date(`${indiaDate}T${["10:00", "11:30", "14:00", "10:30", "15:00"][position]}:00+05:30`).toISOString(), duration: 30, kind: position === 2 ? "Demo class" : "Counselling", status: "scheduled" });
  });
  workspace.articles = [
    { id: uid(), title: "Courses & fee structure", category: "Courses", body: "DEMO institute information. NEET 2027 classroom programme: ₹65,000. JEE 2027 programme: ₹72,000. NEET Dropper programme: ₹48,000. JEE Foundation: ₹36,000. Prices are illustrative demo content; replace them with your institute's approved fees. Instalment requests go to a counsellor.", updatedAt: at(2) },
    { id: uid(), title: "Batch timings & demo classes", category: "Admissions", body: "Weekday batches run Monday–Friday, 4–7 pm IST. Weekend batches run Saturday–Sunday, 9 am–1 pm IST. Demo classes are arranged by a counsellor. Confirm availability before promising a place.", updatedAt: at(1) },
    { id: uid(), title: "Scholarships & admission process", category: "Policies", body: "Scholarship eligibility is assessed by an academic counsellor. Never promise a discount or guaranteed exam result. Ask for the preferred course, school year and a convenient counselling time. A parent or guardian should join the counselling session for a minor.", updatedAt: at(3) },
    { id: uid(), title: "Location & visiting hours", category: "FAQs", body: "This is a fictional demonstration institute. Campus visits can be requested between 10 am and 6 pm IST. A counsellor confirms the location and availability. Do not give a real address from this demo knowledge base.", updatedAt: at(4) },
  ];
  workspace.activities.unshift(
    { id: uid(), leadId: workspace.leads[1].id, text: "Ananya Singh requested a counselling session", createdAt: at(0, -0.25), kind: "appointment" },
    { id: uid(), leadId: workspace.leads[2].id, text: "Rohan Gupta asked about the next NEET batch", createdAt: at(0, -0.75), kind: "message" },
    { id: uid(), leadId: null, text: "40 sample enquiries added to your demo workspace", createdAt: at(0, -2), kind: "lead" },
  );
  workspace.tasks = workspace.leads.slice(0, 6).map((lead, index) => ({ id: uid(), leadId: lead.id, title: lead.nextAction, owner: lead.owner, dueAt: at(index < 3 ? 1 : 0, index), status: "open" }));
  return hydrateWorkspace(workspace);
}
