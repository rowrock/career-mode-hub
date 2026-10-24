// Career Mode Hub Cloudflare Worker.
// Keep OPENROUTER_API_KEY configured as a Cloudflare secret.
const ALLOWED_ORIGIN = "https://rowrock.github.io";
const MODEL = "qwen/qwen2.5-vl-32b-instruct:free";
const CORS = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Content-Type": "application/json; charset=utf-8"
};
function reply(data, status = 200) {
  return new Response(JSON.stringify(data), { status: status, headers: CORS });
}
function instructions(task, clubName) {
  const common = "You analyse EA SPORTS FC 27 Career Mode screenshots.\nCurrent club: " +
    (clubName || "Unknown") + ".\nReturn exactly one valid JSON object without Markdown or commentary.\n" +
    "Only report visible information. Never guess. Use null when unreadable. Preserve visible spelling.\n";
  const tasks = {
    calendar: common + [
      "Read fixtures visible in the calendar/schedule.",
      '{"events":[{"date":"YYYY-MM-DD","opponent":"Team name","competition":null,"homeAway":null,"result":null,"friendly":false,"round":null,"notes":null}]}',
      "Include only visible fixtures in screen order. Read each opponent from its own row; do not substitute a familiar team.",
      "Avoid duplicate rows across overlapping screenshots. If day/month/year cannot be established, use date null. Never use today's date to guess.",
      'homeAway must be "Home", "Away", or null. friendly is true only when clearly labelled. Use null for unreadable opponents. Return {"events":[]} if none are readable.'
    ].join("\n"),
    match: common + [
      "Read the Match Facts / match statistics screenshots.",
      '{"homeTeam":null,"awayTeam":null,"homeScore":null,"awayScore":null,"goalsFor":null,"goalsAgainst":null,"opponent":null,"homeAway":null,"competition":null,"players":[{"name":"Player name","team":null,"rating":null,"goals":0,"assists":0,"minutes":null,"yellowCards":0,"redCards":0,"saves":null,"position":null}],"scorers":[{"name":"Player name","minute":null,"ownGoal":false}]}',
      "Include only visible players and stats. Read both team names and final score carefully. goalsFor/goalsAgainst are from the current club's perspective when identifiable.",
      "Do not confuse overall rating with match rating. Do not infer scorers from the scoreline. Use null when uncertain; do not invent a match date."
    ].join("\n"),
    league: common + [
      "Read a league table or knockout bracket.",
      '{"competition":null,"stage":null,"rows":[{"position":null,"team":"Team name","played":null,"wins":null,"draws":null,"losses":null,"goalsFor":null,"goalsAgainst":null,"goalDifference":null,"points":null}],"rounds":[],"matches":[]}',
      "For a table, include readable rows in screen order. For a bracket, include visible rounds and matches. Do not invent teams or statistics."
    ].join("\n"),
    transfer: common + [
      "Read the transfer screen.",
      '{"transfers":[{"player":"Player name","fromClub":null,"toClub":null,"transferType":null,"fee":null,"date":null}]}',
      "Include visible transfers only. Do not guess fees or dates."
    ].join("\n"),
    youth: common + [
      "Read the Youth Academy screen.",
      '{"players":[{"name":"Player name","age":null,"position":null,"overall":null,"potential":null,"value":null,"wage":null,"nationality":null,"playStyles":[],"notes":null}]}',
      "Include visible players and attributes only. Do not confuse overall rating with potential."
    ].join("\n")
  };
  return tasks[task] || null;
}
function normalizeImage(item) {
  const value = typeof item === "string" ? item :
    (item && typeof item === "object" ? (item.dataUrl || item.dataURL || item.url || item.src || "") : "");
  if (/^data:image\/(png|jpeg|jpg|webp);base64,/i.test(value)) return value;
  if (/^https:\/\/\S+$/i.test(value)) return value;
  throw new Error("Could not read an uploaded image. Please select the screenshot again.");
}
function readAnswer(message) {
  const content = message && message.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) return content.map(part => typeof part === "string" ? part : (part && part.text) || "").join("\n").trim();
  return "";
}
function parseAnswer(answer) {
  let value = String(answer || "").replace(/^\uFEFF/, "").trim();
  try { return JSON.parse(value); } catch (_) {}
  const start = value.indexOf("{");
  if (start >= 0) {
    let depth = 0, quoted = false, escaped = false;
    for (let i = start; i < value.length; i++) {
      const ch = value[i];
      if (quoted) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') quoted = false;
      } else if (ch === '"') quoted = true;
      else if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          try { return JSON.parse(value.slice(start, i + 1)); } catch (_) { break; }
        }
      }
    }
  }
  throw new Error("The AI response was not valid complete JSON. Try one clear screenshot.");
}
function validateData(task, data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("The AI response was not a JSON object.");
  const keys = { calendar: "events", match: "players", league: "rows", transfer: "transfers", youth: "players" };
  if (!keys[task] || !Array.isArray(data[keys[task]])) throw new Error("The AI returned incomplete " + task + " data.");
  if (task === "calendar") {
    data.events = data.events.map(event => ({
      date: typeof event.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(event.date) ? event.date : null,
      opponent: typeof event.opponent === "string" && event.opponent.trim() ? event.opponent.trim() : null,
      competition: event.competition ?? null, homeAway: event.homeAway ?? null,
      result: event.result ?? null, friendly: event.friendly === true,
      round: event.round ?? null, notes: event.notes ?? null
    }));
  }
  return data;
}
async function analyse(apiKey, prompt, images, task) {
  const content = [{ type: "text", text: prompt }].concat(images.map(url => ({ type: "image_url", image_url: { url: url } })));
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + apiKey, "Content-Type": "application/json",
      "HTTP-Referer": ALLOWED_ORIGIN, "X-Title": "Career Mode Hub"
    },
    body: JSON.stringify({
      model: MODEL, messages: [{ role: "user", content: content }],
      response_format: { type: "json_object" },
      max_tokens: task === "calendar" ? 4500 : 6000, temperature: 0
    })
  });
  const raw = await response.text();
  let result;
  try { result = JSON.parse(raw); }
  catch (_) { throw new Error(MODEL + ": Unreadable provider response (HTTP " + response.status + ")."); }
  if (!response.ok) throw new Error(MODEL + ": " + ((result.error && result.error.message) || ("HTTP " + response.status)));
  const choice = result.choices && result.choices[0];
  const answer = readAnswer(choice && choice.message);
  if (!answer) throw new Error(MODEL + ": No text returned (finish reason: " + ((choice && choice.finish_reason) || "unknown") + ").");
  if (choice.finish_reason === "length") throw new Error(MODEL + ": Response was cut off by the output limit. Try fewer screenshots.");
  return { data: validateData(task, parseAnswer(answer)), model: result.model || MODEL };
}
export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (request.method === "GET") return reply({ ok: true, service: "Career Mode Hub AI", status: "Worker is running", model: MODEL });
    if (request.method !== "POST") return reply({ ok: false, error: "Use POST to analyse screenshots." }, 405);
    const origin = request.headers.get("Origin");
    if (origin && origin !== ALLOWED_ORIGIN) return reply({ ok: false, error: "Website origin not authorised." }, 403);
    if (!env.OPENROUTER_API_KEY) return reply({ ok: false, error: "The OPENROUTER_API_KEY secret is missing in Cloudflare." }, 500);
    let body;
    try {
      const raw = await request.text();
      if (raw.length > 18 * 1024 * 1024) return reply({ ok: false, error: "Screenshots are too large. Try fewer or smaller images." }, 413);
      body = JSON.parse(raw);
    } catch (_) { return reply({ ok: false, error: "Invalid request. Reload Career Mode Hub and try again." }, 400); }
    const task = body.task;
    if (!["match", "calendar", "league", "transfer", "youth"].includes(task)) return reply({ ok: false, error: "Unknown analysis task." }, 400);
    if (!Array.isArray(body.images) || body.images.length < 1 || body.images.length > 4) return reply({ ok: false, error: "Upload between one and four screenshots at a time." }, 400);
    let images;
    try { images = body.images.map(normalizeImage); }
    catch (error) { return reply({ ok: false, error: error.message }, 400); }
    try {
      const result = await analyse(env.OPENROUTER_API_KEY, instructions(task, body.clubName), images, task);
      return reply({ ok: true, data: result.data, model: result.model });
    } catch (error) { return reply({ ok: false, error: error.message || "AI analysis failed." }, 502); }
  }
};
