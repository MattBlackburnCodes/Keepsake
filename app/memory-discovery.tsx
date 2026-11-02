"use client";

import { useState } from "react";
import type { ExportSource } from "./export-data";
import { memoriesOnThisDay } from "./memory-features";

const QUESTIONS = [
  "What did your childhood home feel like?",
  "Who made you feel understood when you were growing up?",
  "What is a family tradition you want to keep alive?",
  "What is the story behind a photograph you love?",
  "What adventure still makes you smile?",
  "What is something you learned from someone you miss?",
  "Which everyday moment would you love to relive?",
  "What are you proud of that people rarely ask about?",
];

export function StoryPrompts({ name, save }: { name: string; save: (title: string, body: string) => void }) {
  const [index, setIndex] = useState(0);
  const [answer, setAnswer] = useState("");
  const [editing, setEditing] = useState(false);
  const [saved, setSaved] = useState(false);
  return <section className="discovery-card" aria-label="Story prompts"><p className="eyebrow">Ask them this</p><h2>A question for {name}</h2><blockquote>{QUESTIONS[index]}</blockquote><p>Ask together, or write down your own memory of them.</p>
    {editing ? <form className="note-composer" onSubmit={(event) => { event.preventDefault(); if (!answer.trim()) return; save(QUESTIONS[index], answer.trim()); setAnswer(""); setEditing(false); setSaved(true); }}><label><span>Their story</span><textarea required value={answer} onChange={(event) => setAnswer(event.target.value)} /></label><div><button className="primary-btn">Save to their story</button><button type="button" className="secondary-btn" onClick={() => setEditing(false)}>Cancel</button></div></form> : <div className="discovery-actions"><button className="primary-btn" onClick={() => { setEditing(true); setSaved(false); }}>Capture the answer</button><button className="secondary-btn" onClick={() => { setIndex((index + 1) % QUESTIONS.length); setSaved(false); }}>Another question</button></div>}
    {saved && <p role="status">Added to {name}’s story.</p>}
  </section>;
}

export function OnThisDay({ source, openPerson }: { source: ExportSource; openPerson: (id: number) => void }) {
  const memories = memoriesOnThisDay(source);
  return <section className="discovery-card"><p className="eyebrow">A little time travel</p><h2>On this day</h2><p>Stories, photos, and milestones from this date in past years.</p>
    {memories.length ? <div className="anniversary-memories">{memories.map((item) => <article key={item.key}>{item.imageUrl && <img src={item.imageUrl} alt={item.title} loading="lazy" />}<small>{item.yearsAgo} {item.yearsAgo === 1 ? "year" : "years"} ago · {item.personName}</small><h3>{item.title}</h3>{item.body && <p>{item.body}</p>}<button className="text-button" onClick={() => openPerson(item.personId)}>Visit {item.personName}’s page →</button></article>)}</div> : <p className="discovery-empty">No memories from this date yet. Add dates to your photos and milestones; new stories will appear here on future anniversaries.</p>}
  </section>;
}
