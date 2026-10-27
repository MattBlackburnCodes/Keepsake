export type ExportPerson = {
  id: number; name: string; relationship: string; birthday: string; anniversary?: string; color: string; about?: string;
  favorites?: { id: string; label: string; value: string }[];
  milestones?: { id: string; kind: string; title: string; date: string; details?: string }[];
};
export type ExportNote = { id: string; personId: number; title: string; body: string; createdAt: string };
export type ExportMedia = { id: string; personId: number; type: "photo" | "video" | "voice" | "profile" | "cover"; name: string; caption?: string; size: number; takenAt?: string; createdAt?: string; url: string };
export type ExportSource = { people: ExportPerson[]; notes: ExportNote[]; media: ExportMedia[] };
export const EXPORT_GROUPS = [
  { id: "relationship", label: "Relationship" }, { id: "about", label: "About them" },
  { id: "birthday", label: "Birthdays" }, { id: "anniversary", label: "Anniversaries" },
  { id: "color", label: "Favorite colors" }, { id: "favorites", label: "Favorites & gift details" },
  { id: "milestones", label: "Special dates & milestones" }, { id: "notes", label: "Notes & stories" },
  { id: "photo", label: "Photos" }, { id: "video", label: "Video details" },
  { id: "voice", label: "Recording details" }, { id: "profile", label: "Profile pictures" }, { id: "cover", label: "Cover photos" },
] as const;
export type ExportGroup = typeof EXPORT_GROUPS[number]["id"];
export type ExportEntry = { key: string; group: ExportGroup; label: string; value: string; date?: string; imageUrl?: string };
export type PersonExport = { name: string; entries: ExportEntry[] };

// Build explicit allowlisted entries rather than copying profile objects into a shared export.
export function exportChoices(person: ExportPerson, source: ExportSource): ExportEntry[] {
  const entries: ExportEntry[] = [];
  for (const group of ["relationship", "about", "birthday", "anniversary", "color"] as const) {
    const value = person[group];
    if (value) entries.push({ key: `${person.id}:field:${group}`, group, label: EXPORT_GROUPS.find((entry) => entry.id === group)!.label, value });
  }
  for (const item of person.favorites ?? []) entries.push({ key: `${person.id}:favorite:${item.id}`, group: "favorites", label: item.label, value: item.value });
  for (const item of person.milestones ?? []) entries.push({ key: `${person.id}:milestone:${item.id}`, group: "milestones", label: item.title, value: item.details ?? "", date: item.date });
  for (const item of source.notes.filter((entry) => entry.personId === person.id)) entries.push({ key: `${person.id}:note:${item.id}`, group: "notes", label: item.title, value: item.body, date: item.createdAt });
  for (const item of source.media.filter((entry) => entry.personId === person.id)) {
    const image = ["photo", "profile", "cover"].includes(item.type);
    entries.push({ key: `${person.id}:media:${item.id}`, group: item.type, label: item.caption || item.name, value: `${item.name} · ${(item.size / 1024 / 1024).toFixed(2)} MB`, date: item.takenAt || item.createdAt, ...(image ? { imageUrl: safeExportImage(item.url) } : {}) });
  }
  return entries;
}

export function buildCustomExport(source: ExportSource, personIds: number[], keys: string[]): PersonExport[] {
  const selected = new Set(keys);
  return source.people.filter((person) => personIds.includes(person.id)).map((person) => ({ name: person.name, entries: exportChoices(person, source).filter((entry) => selected.has(entry.key)) }));
}
export function exportGroupLabel(group: ExportGroup) { return EXPORT_GROUPS.find((entry) => entry.id === group)!.label; }
export function safeExportImage(url: string) {
  return /^(blob:|https:\/\/|data:image\/(?:jpeg|png|webp|gif);base64,)/i.test(url) ? url : undefined;
}
function escapeHtml(value: string) { return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[character]!); }
function csvCell(value: string) {
  // Quoting alone does not prevent spreadsheet formula execution.
  const safe = /^[\s\uFEFF]*[=+@-]/.test(value) || /^[\t\r\n]/.test(value) ? `'${value}` : value;
  return `"${safe.replace(/"/g, '""')}"`;
}
export function customExportCsv(people: PersonExport[]) {
  const rows = [["Person", "Category", "Detail", "Value", "Date"]];
  for (const person of people) {
    if (!person.entries.length) rows.push([person.name, "Person", "Name", person.name, ""]);
    for (const entry of person.entries) rows.push([person.name, exportGroupLabel(entry.group), entry.label, entry.value, entry.date ?? ""]);
  }
  return "\uFEFF" + rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
}
export function customExportJson(people: PersonExport[], exportedAt = new Date().toISOString()) {
  return JSON.stringify({ format: "Keepsake custom export", version: 1, exportedAt, people: people.map((person) => ({ name: person.name, details: person.entries.map((entry) => ({ category: exportGroupLabel(entry.group), label: entry.label, value: entry.value, ...(entry.date ? { date: entry.date } : {}) })) })) }, null, 2);
}
export function customExportHtml(people: PersonExport[]) {
  const sections = people.map((person) => `<section><h2>${escapeHtml(person.name)}</h2>${person.entries.length ? person.entries.map((entry) => `<article><small>${escapeHtml(exportGroupLabel(entry.group))}</small><h3>${escapeHtml(entry.label)}</h3><p>${escapeHtml(entry.value)}</p>${entry.date ? `<p>${escapeHtml(entry.date)}</p>` : ""}${entry.imageUrl && safeExportImage(entry.imageUrl) ? `<img src="${escapeHtml(entry.imageUrl)}" alt="${escapeHtml(entry.label)}">` : ""}</article>`).join("") : "<p>Name only — no details selected.</p>"}</section>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Keepsake custom export</title><style>body{font:16px/1.55 system-ui,sans-serif;color:#25231f;max-width:760px;padding:24px;margin:auto}h1,h2{font-family:Georgia,serif}h2{border-bottom:1px solid #ddd;padding-bottom:8px}h3,p{margin:5px 0}p{white-space:pre-wrap;overflow-wrap:anywhere}small{color:#666}article{margin:20px 0;break-inside:avoid}img{display:block;max-width:100%;max-height:400px;object-fit:contain;margin-top:12px}section+section{break-before:page}.print-tools{padding:14px;border:1px solid #ddd;border-radius:10px}button{padding:12px;cursor:pointer}@page{margin:18mm}@media print{.print-tools{display:none}body{padding:0;max-width:none}}</style></head><body><div class="print-tools"><button onclick="window.print()">Print / Save PDF</button><p>Choose Save as PDF in your browser’s print options. Check the selected details before sharing.</p></div><h1>Keepsake · Selected details</h1>${sections}</body></html>`;
}
