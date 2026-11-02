"use client";

import { useState } from "react";
import type { ExportSource } from "./export-data";
import { keepsakeBookHtml } from "./memory-features";
import { openPrintPreview } from "./print-preview";

export default function KeepsakeBook({ source }: { source: ExportSource }) {
  const [personId, setPersonId] = useState("");
  const [title, setTitle] = useState("");
  const [dedication, setDedication] = useState("");
  const [photos, setPhotos] = useState(true);
  const [error, setError] = useState("");
  const person = source.people.find((item) => item.id === Number(personId));
  const stories = source.notes.filter((item) => item.personId === person?.id).length;
  const milestones = person?.milestones?.length ?? 0;
  const photoCount = photos ? source.media.filter((item) => item.personId === person?.id && item.type === "photo").length : 0;
  const create = () => {
    if (!person) return;
    setError("");
    try { if (!openPrintPreview(keepsakeBookHtml(source, person.id, title.trim(), dedication.trim(), photos))) setError("The book preview could not open. Try opening Keepsake in Safari or Chrome."); }
    catch { setError("Your book could not be created. Please try again."); }
  };
  return <section className="discovery-card" aria-labelledby="keepsake-book-title"><p className="eyebrow">Something to hold onto</p><h2 id="keepsake-book-title">Create a keepsake book</h2><p>Collect one person’s stories, milestones, and photos in a chronological book with a cover and dedication.</p>
    {!source.people.length ? <p>Add a person and some memories to start your first book.</p> : <div className="note-composer"><label><span>Whose story?</span><select value={personId} onChange={(event) => { setPersonId(event.target.value); setError(""); }}><option value="">Choose a person</option>{source.people.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label><span>Book title</span><input value={title} onChange={(event) => setTitle(event.target.value)} placeholder={person ? `${person.name}’s keepsake book` : "A life in memories"} maxLength={180} /></label><label><span>Dedication (optional)</span><textarea value={dedication} onChange={(event) => setDedication(event.target.value)} placeholder="For the moments that made us." maxLength={2000} /></label><label className="book-photo-choice"><input type="checkbox" checked={photos} onChange={(event) => setPhotos(event.target.checked)} /><span>Include photos</span></label>{person && <p aria-live="polite">{stories} stories · {milestones} milestones · {photoCount} photos</p>}<p>Review the full book before sharing. Includes all stories and milestones for this person, plus their biography and optional photos. Video and audio files are excluded. In the preview, choose Print / Save PDF to save or print your book.</p>{error && <p className="form-error" role="alert">{error}</p>}<button className="primary-btn" disabled={!person || !(stories + milestones + photoCount || person.about)} onClick={create}>Preview keepsake book</button></div>}
  </section>;
}
