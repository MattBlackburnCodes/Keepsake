"use client";

import { useState } from "react";
import { openPrintPreview } from "./print-preview";
import { EXPORT_GROUPS, buildCustomExport, customExportCsv, customExportHtml, customExportJson, exportChoices, exportGroupLabel, type ExportSource } from "./export-data";

export default function CustomExport(source: ExportSource) {
  const [personIds, setPersonIds] = useState<number[]>([]);
  const [keys, setKeys] = useState<string[]>([]);
  const [format, setFormat] = useState("pdf");
  const [error, setError] = useState("");
  const people = source.people.filter((person) => personIds.includes(person.id));
  const choices = people.flatMap((person) => exportChoices(person, source).map((entry) => ({ ...entry, personName: person.name })));
  const selected = new Set(keys);
  const preview = buildCustomExport(source, personIds, keys);
  const detailCount = preview.reduce((count, person) => count + person.entries.length, 0);
  const hasImages = preview.some((person) => person.entries.some((entry) => entry.imageUrl));
  const hasMedia = preview.some((person) => person.entries.some((entry) => ["photo", "video", "voice", "profile", "cover"].includes(entry.group)));
  const selectKeys = (nextKeys: string[], checked: boolean) => {
    setKeys((current) => checked ? [...new Set([...current, ...nextKeys])] : current.filter((key) => !nextKeys.includes(key)));
    setError("");
  };
  const selectPerson = (id: number, checked: boolean) => {
    setPersonIds((current) => checked ? [...current, id] : current.filter((entry) => entry !== id));
    if (!checked) setKeys((current) => current.filter((key) => !key.startsWith(`${id}:`)));
    setError("");
  };
  const download = () => {
    if (!people.length || !detailCount) return;
    setError("");
    try {
      if (format === "pdf") {
        if (!openPrintPreview(customExportHtml(preview))) setError("The print preview could not open. Try reopening Keepsake in Safari or Chrome.");
        return;
      }
      const contents = format === "csv" ? customExportCsv(preview) : customExportJson(preview);
      const url = URL.createObjectURL(new Blob([contents], { type: format === "csv" ? "text/csv;charset=utf-8" : "application/json;charset=utf-8" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = `keepsake-selected-details-${new Date().toISOString().slice(0, 10)}.${format}`;
      document.body.appendChild(link); link.click(); link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch { setError("The export could not be opened. Please try again in your browser."); }
  };
  return <section className="custom-export" aria-labelledby="custom-export-title">
    <div className="custom-export-heading"><p className="eyebrow">Take just what you need</p><h2 id="custom-export-title">Custom export</h2><p>Create a gift guide, a reference sheet, or a collection of memories. Choose exactly what to include.</p></div>
    {!source.people.length ? <p>Add a person to Keepsake to create your first custom export.</p> : <>
      <fieldset><legend>1. Choose people</legend>
        <div className="custom-export-shortcuts"><button type="button" className="text-button" onClick={() => { setPersonIds(source.people.map((person) => person.id)); setError(""); }}>Select everyone</button><button type="button" className="text-button" onClick={() => { setPersonIds([]); setKeys([]); setError(""); }}>Clear people</button></div>
        <div className="custom-export-people">{source.people.map((person) => <label key={person.id}><input type="checkbox" checked={personIds.includes(person.id)} onChange={(event) => selectPerson(person.id, event.target.checked)} /><span>{person.name}</span></label>)}</div>
      </fieldset>
      <fieldset disabled={!people.length}><legend>2. Choose details</legend>
        <p className="custom-export-help">Names are always included. All other details start unselected. Expand a category to choose individual entries.</p>
        <div className="custom-export-shortcuts"><button type="button" className="secondary-btn" onClick={() => { setKeys(choices.filter((entry) => entry.group === "favorites").map((entry) => entry.key)); setError(""); }}>Gift guide</button><button type="button" className="text-button" onClick={() => { setKeys(choices.map((entry) => entry.key)); setError(""); }}>Select all details</button><button type="button" className="text-button" onClick={() => { setKeys([]); setError(""); }}>Clear details</button></div>
        <p className="custom-export-help">Gift guide selects favorites and gift details, including any saved clothing sizes. You can remove individual entries below.</p>
        <div className="custom-export-groups">{EXPORT_GROUPS.map((group) => {
          const entries = choices.filter((entry) => entry.group === group.id);
          const count = entries.filter((entry) => selected.has(entry.key)).length;
          return <div className="custom-export-group" key={group.id}>
            <label><input type="checkbox" disabled={!entries.length} checked={entries.length > 0 && count === entries.length} onChange={(event) => selectKeys(entries.map((entry) => entry.key), event.target.checked)} /><span>{group.label}<small>{entries.length ? `${count} of ${entries.length} selected` : "No saved details"}</small></span></label>
            {entries.length > 0 && <details><summary>Choose entries</summary><div className="custom-export-entries">{entries.map((entry) => <label key={entry.key}><input type="checkbox" checked={selected.has(entry.key)} onChange={(event) => selectKeys([entry.key], event.target.checked)} /><span>{entry.label}<small>{entry.personName} · {entry.value || entry.date}</small></span></label>)}</div></details>}
          </div>;
        })}</div>
      </fieldset>
      <section className="custom-export-preview" aria-labelledby="custom-export-preview-title"><h3 id="custom-export-preview-title">3. Preview your export</h3>
        <p aria-live="polite">{people.length} {people.length === 1 ? "person" : "people"} · {detailCount} selected {detailCount === 1 ? "detail" : "details"}</p>
        {!people.length ? <p>Select people to preview their export.</p> : preview.map((person, index) => <article key={index}><h4>{person.name}</h4>{!person.entries.length && <p>No details selected for this person.</p>}{person.entries.map((entry) => <div className="custom-export-preview-entry" key={entry.key}><small>{exportGroupLabel(entry.group)}</small><strong>{entry.label}</strong><p>{entry.value}</p>{entry.date && <small>{entry.date}</small>}{entry.imageUrl && <img src={entry.imageUrl} alt={entry.label} loading="lazy" />}</div>)}</article>)}
      </section>
      <div className="custom-export-download"><label><span>Export format</span><select value={format} onChange={(event) => { setFormat(event.target.value); setError(""); }}><option value="pdf">Print / Save PDF — a shareable reference</option><option value="csv">CSV — open in a spreadsheet</option><option value="json">JSON — selected structured data</option></select></label>
        <p className="custom-export-help">{format === "pdf" ? "The preview opens inside Keepsake. Tap Print / Save PDF there, then choose Save as PDF in the print options." : "Exports selected text and file details. This custom export is not a complete app backup."}{hasMedia && " Original video and audio files are not embedded."}{hasImages && (format === "pdf" ? " Selected images are included; wait for them to load before printing." : " Image descriptions are included; photos are available in the PDF option. Media download links are excluded.")}</p>
        <p className="custom-export-help">Review the preview before sharing. Account information and Quick Notes are excluded.</p>
        {error && <p role="alert" className="form-error">{error}</p>}
        <button type="button" className="primary-btn" disabled={!people.length || !detailCount} onClick={download}>{format === "pdf" ? "Open print / PDF preview" : `Download selected ${format.toUpperCase()}`}</button>
      </div>
    </>}
  </section>;
}
