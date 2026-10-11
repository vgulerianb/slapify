// Telegram: every message the README promises has to actually go out. The
// completion message used to sit after done() had already been handled, so
// it never fired.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runScripted, call } from "./helpers/harness.mjs";

const telegram = { bot_token: "test-token", allowed_chat_id: 42 };

/** Stand in for api.telegram.org and collect what was sent. */
async function withFakeTelegram(fn) {
  const sent = [];
  const realFetch = globalThis.fetch;
  const json = (body, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (!u.startsWith("https://api.telegram.org/")) return realFetch(url, init);
    if (u.includes("/getUpdates")) {
      await new Promise((r) => setTimeout(r, 25));
      return json({ ok: true, result: [] });
    }
    const body = JSON.parse(init.body);
    // Like Telegram: Markdown with an unpaired _ or * is rejected outright.
    const odd = (ch) => (body.text.split(ch).length - 1) % 2 === 1;
    if (body.parse_mode === "Markdown" && (odd("_") || odd("*"))) {
      return json({ ok: false, description: "Bad Request: can't parse entities" }, 400);
    }
    sent.push(body);
    return json({ ok: true });
  };
  try {
    await fn();
  } finally {
    globalThis.fetch = realFetch;
  }
  return sent;
}

test("start, status, question and completion messages all reach Telegram", async () => {
  const sent = await withFakeTelegram(() =>
    runScripted(
      [
        call(["status_update", { message: "halfway there" }]),
        call(["ask_user", { question: "Which plan?" }]),
        call(["done", { summary: "Picked the yearly plan." }]),
      ],
      { config: { telegram }, onHumanInput: async () => "yearly" }
    )
  );
  const texts = sent.map((m) => m.text);
  assert.ok(sent.every((m) => m.chat_id === 42));
  assert.ok(texts.some((t) => /Slapify Task Started/.test(t)), texts.join(" | "));
  assert.ok(texts.some((t) => /Status update.*\n.*halfway there/.test(t)), texts.join(" | "));
  assert.ok(texts.some((t) => /Agent asks.*\n.*Which plan\?/.test(t)), texts.join(" | "));
  assert.ok(texts.some((t) => /Task Completed[\s\S]*Picked the yearly plan\./.test(t)), texts.join(" | "));
});

test("a run that ends without finishing sends a failure message", async () => {
  const sent = await withFakeTelegram(() =>
    runScripted([call(["remember", { key: "k", value: "v" }])], { config: { telegram }, maxIterations: 1 })
  );
  assert.ok(sent.some((m) => /Task Failed[\s\S]*maximum iteration limit/.test(m.text)), sent.map((m) => m.text).join(" | "));
});

test("a summary Telegram can't parse as Markdown is sent as plain text, not dropped", async () => {
  const sent = await withFakeTelegram(() =>
    runScripted([call(["done", { summary: "Renamed the file to report_final.csv" }])], { config: { telegram } })
  );
  const completed = sent.find((m) => /Task Completed/.test(m.text));
  assert.ok(completed, sent.map((m) => m.text).join(" | "));
  assert.match(completed.text, /report_final\.csv/);
  assert.equal(completed.parse_mode, undefined);
});
