import { safeExportImage, type ExportSource } from "./export-data";

// Calendar dates retain their written day; timestamps use the viewer's local day.
export function memoryDate(value?: string): Date | null {
  if (!value || value === "Today" || value === "Yesterday") return null;
  const plain = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const date = plain ? new Date(+plain[1], +plain[2] - 1, +plain[3]) : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  if (plain && (date.getFullYear() !== +plain[1] || date.getMonth() !== +plain[2] - 1 || date.getDate() !== +plain[3])) return null;
  return date;
}

export function memoriesOnThisDay(source: ExportSource, today = new Date()) {
  const entries = source.people.flatMap((person) => [
    ...source.notes.filter((note) => note.personId === person.id).map((note) => ({ key: `note:${note.id}`, date: note.createdAt, title: note.title, body: note.body, imageUrl: undefined as string | undefined })),
    ...(person.milestones ?? []).map((item) => ({ key: `milestone:${person.id}:${item.id}`, date: item.date, title: item.title, body: item.details ?? "", imageUrl: undefined as string | undefined })),
    ...source.media.filter((item) => item.personId === person.id && !["profile", "cover"].includes(item.type)).map((item) => ({ key: `media:${item.id}`, date: item.takenAt || item.createdAt, title: item.caption || item.name, body: item.type === "photo" ? "" : `${item.type === "voice" ? "Voice recording" : "Video"} saved in their memories`, imageUrl: item.type === "photo" ? safeExportImage(item.url) : undefined })),
  ].flatMap((item) => {
    const date = memoryDate(item.date);
    return date && date.getFullYear() < today.getFullYear() && date.getMonth() === today.getMonth() && date.getDate() === today.getDate() ? [{ ...item, personId: person.id, personName: person.name, yearsAgo: today.getFullYear() - date.getFullYear() }] : [];
  }));
  return entries.sort((a, b) => a.yearsAgo - b.yearsAgo || a.key.localeCompare(b.key));
}

const escape = (value: string) => value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[character]!);

export function keepsakeBookHtml(source: ExportSource, personId: number, title: string, dedication: string, includePhotos: boolean) {
  const person = source.people.find((item) => item.id === personId);
  if (!person) throw new Error("Choose a person for your book.");
  const chapters = [
    ...source.notes.filter((item) => item.personId === personId).map((item) => ({ date: item.createdAt, title: item.title, body: item.body, imageUrl: undefined as string | undefined })),
    ...(person.milestones ?? []).map((item) => ({ date: item.date, title: item.title, body: item.details ?? "", imageUrl: undefined as string | undefined })),
    ...(includePhotos ? source.media.filter((item) => item.personId === personId && item.type === "photo").map((item) => ({ date: item.takenAt || item.createdAt || "", title: item.caption || item.name, body: "", imageUrl: safeExportImage(item.url) })) : []),
  ].sort((a, b) => (memoryDate(a.date)?.getTime() ?? Infinity) - (memoryDate(b.date)?.getTime() ?? Infinity));
  const dateLabel = (value: string) => { const date = memoryDate(value); return date ? date.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" }) : value === "Today" || value === "Yesterday" ? "Date not recorded" : value; };
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title || person.name + "’s keepsake book")}</title><style>@page{margin:20mm}body{max-width:720px;margin:auto;padding:32px;color:#302a27;font:17px/1.7 Georgia,serif}h1{font-size:46px;line-height:1.2}h2{font-size:28px}p{white-space:pre-wrap;overflow-wrap:anywhere}.cover{min-height:70vh;display:flex;flex-direction:column;justify-content:center;text-align:center;break-after:page}.kicker,small{font:12px/1.5 system-ui,sans-serif;letter-spacing:1px;color:#766d65}article{margin:40px 0}article+article{border-top:1px solid #dfd6cd;padding-top:30px}h2{break-after:avoid}img{display:block;max-width:100%;max-height:650px;object-fit:contain;margin:20px auto;break-inside:avoid}.about{break-after:page}footer{text-align:center;margin-top:50px;font-size:13px}@media print{body{padding:0;max-width:none}.cover{min-height:220mm}}</style></head><body><section class="cover"><p class="kicker">KEEPSAKE · A LIFE IN MEMORIES</p><h1>${escape(title || person.name + "’s keepsake book")}</h1><p>${escape(person.name)}</p>${dedication ? `<p>${escape(dedication)}</p>` : ""}</section>${person.about ? `<section class="about"><h2>About ${escape(person.name)}</h2><p>${escape(person.about)}</p></section>` : ""}${chapters.map((item) => `<article><small>${escape(dateLabel(item.date))}</small><h2>${escape(item.title)}</h2>${item.imageUrl ? `<img src="${escape(item.imageUrl)}" alt="${escape(item.title)}">` : ""}${item.body ? `<p>${escape(item.body)}</p>` : ""}</article>`).join("")}<footer>Collected with love in Keepsake</footer></body></html>`;
}
