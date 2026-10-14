/** The seed backlog of changes for the demo. Pairs marked "overlap" share a scope on purpose. */
import type { AgentKind } from "./types";

export interface SeedChange {
  title: string;
  body: string;
  scope: string[];
  accept: string;
  kind: AgentKind | "any";
  priority?: number;
}

export const SEED_CHANGES: SeedChange[] = [
  { title: "Add an FAQ section", body: "Create sections/faq.html with five short questions and answers about Loom Conf (dates, tickets, remote attendance, agents as attendees, recordings). Register it in site.json sections and nav.", scope: ["sections/faq.html", "site.json"], accept: "A FAQ section renders with five Q&As and appears in the nav.", kind: "llm", priority: 5 },
  { title: "Add a speakers section", body: "Create sections/speakers.html with six fictional speakers (name, role, talk title). Register it in site.json sections and nav.", scope: ["sections/speakers.html", "site.json"], accept: "Six speakers listed, section in nav.", kind: "llm", priority: 5 },
  { title: "Add a venue section", body: "Create sections/venue.html describing a fictional venue in Lisbon with address, how to get there and accessibility notes. Register it in site.json.", scope: ["sections/venue.html", "site.json"], accept: "Venue section renders and is in nav.", kind: "llm", priority: 4 },
  { title: "Add a tickets section with three tiers", body: "Create sections/tickets.html with three ticket tiers (Agent, Builder, Team) as a simple table. Register it in site.json.", scope: ["sections/tickets.html", "site.json"], accept: "Three tiers shown in a table.", kind: "llm", priority: 4 },
  { title: "Add a code of conduct section", body: "Create sections/conduct.html with a short, friendly code of conduct that explicitly covers both people and agents. Register it in site.json.", scope: ["sections/conduct.html", "site.json"], accept: "Code of conduct present and in nav.", kind: "llm", priority: 3 },
  { title: "Add a call for proposals section", body: "Create sections/cfp.html inviting talk proposals, with three suggested topics and a deadline. Register it in site.json.", scope: ["sections/cfp.html", "site.json"], accept: "CFP section present.", kind: "llm", priority: 3 },
  { title: "Add a newsletter signup", body: "Create sections/newsletter.html with a small email form (no backend; action='#'). Register it in site.json.", scope: ["sections/newsletter.html", "site.json"], accept: "Form with one email field and a button.", kind: "llm", priority: 2 },
  { title: "Lead the hero with the date and city", body: "Rewrite sections/hero.html so the first line is the date (22–23 October 2026) and the city (Lisbon). Keep the call to action.", scope: ["sections/hero.html"], accept: "Hero shows date and city first.", kind: "llm", priority: 6 },
  { title: "Add a one-line audience promise to the hero", body: "Add a sentence to sections/hero.html below the headline that says who the conference is for. Keep everything else.", scope: ["sections/hero.html"], accept: "Hero has an audience sentence.", kind: "llm", priority: 6 },
  { title: "Add a dark colour scheme", body: "In styles/base.css add a prefers-color-scheme: dark block that swaps paper, ink, muted and line colours to a dark palette with good contrast.", scope: ["styles/base.css"], accept: "Dark media query present.", kind: "llm", priority: 4 },
  { title: "Make tables readable on phones", body: "In styles/base.css add a max-width: 640px media query that shrinks table padding and font size and lets tables scroll horizontally.", scope: ["styles/base.css"], accept: "Mobile table rules present.", kind: "llm", priority: 4 },
  { title: "Fill in the day one schedule", body: "Replace the TBA rows in sections/schedule.html with six realistic sessions for day one (22 October) with fictional speakers.", scope: ["sections/schedule.html"], accept: "No TBA left; six sessions.", kind: "llm", priority: 5 },
  { title: "Add a day two schedule", body: "Add a second table to sections/schedule.html for day two (23 October) with five sessions.", scope: ["sections/schedule.html"], accept: "Two tables, two days.", kind: "llm", priority: 5 },
  { title: "Add social links to the footer", body: "In index.html, add three social links (Mastodon, Bluesky, GitHub) inside the footer.", scope: ["index.html"], accept: "Footer has three links.", kind: "llm", priority: 3 },
  { title: "Add Open Graph meta tags", body: "In index.html add og:title, og:description and og:type meta tags in the head.", scope: ["index.html"], accept: "Three og: tags present.", kind: "llm", priority: 3 },
  { title: "Translate the about section into Spanish", body: "In sections/about.html keep the English paragraphs and add Spanish translations as additional paragraphs with lang='es'.", scope: ["sections/about.html"], accept: "Spanish paragraphs present with lang attribute.", kind: "llm", priority: 2 },
  { title: "Add a workshops section", body: "Create sections/workshops.html with three half-day workshops. Register it in site.json.", scope: ["sections/workshops.html", "site.json"], accept: "Three workshops listed.", kind: "llm", priority: 2 },
  { title: "Add a travel and hotels section", body: "Create sections/travel.html with airport, train and three hotel suggestions. Register it in site.json.", scope: ["sections/travel.html", "site.json"], accept: "Travel section present.", kind: "llm", priority: 2 },
  { title: "Add an agents-welcome policy section", body: "Create sections/agents.html explaining how AI agents can attend, present and contribute, in three short paragraphs. Register it in site.json.", scope: ["sections/agents.html", "site.json"], accept: "Agents policy present.", kind: "llm", priority: 3 },
  { title: "Sharpen the tagline", body: "In site.json change the tagline to something punchier, under ten words, about agents building together.", scope: ["site.json"], accept: "Tagline changed, under ten words.", kind: "llm", priority: 1 },
  { title: "Add a press kit section", body: "Create sections/press.html with a one-paragraph boilerplate and a list of three downloadable assets (links to #). Register it in site.json.", scope: ["sections/press.html", "site.json"], accept: "Press section present.", kind: "llm", priority: 1 },
  { title: "Add an accessibility skip link", body: "In index.html add a 'Skip to content' link as the first element in body pointing at #sections, and in styles/base.css add rules that hide it until focused.", scope: ["index.html", "styles/base.css"], accept: "Skip link exists and is visually hidden until focus.", kind: "llm", priority: 2 },
];

/** Synthetic sponsor changes: all touch the same file, so the weave's JSON union merge does the work. */
export function sponsorChange(i: number, seed: string): SeedChange {
  const tiers = ["community", "silver", "gold"];
  const tier = tiers[i % 3];
  return {
    title: `Add sponsor ${seed}-${i}`,
    body: `Append {"name":"${seed.toUpperCase()}-${i}","tier":"${tier}"} to the sponsors array in sponsors.json.`,
    scope: ["sponsors.json"],
    accept: "sponsors.json contains the new entry.",
    kind: "synthetic",
    priority: 0,
  };
}
