// Tool admission replaced the loop guard. These are the exact failure modes
// the old guard had, plus the one thing it now guarantees.
import { test } from "node:test";
import assert from "node:assert/strict";
import { dist } from "./helpers/harness.mjs";
const { ToolAdmission } = await import(dist("task/admission.js"));
const send = { key: "Meta+Enter" };

test("an irreversible action is never repeated on the same page", () => {
  const a = new ToolAdmission();
  assert.equal(a.admit("press", send, "irreversible", "x.com/1").admit, true);
  a.observe("press", send, "irreversible", "x.com/1", { ok: true }, false);
  const again = a.admit("press", send, "irreversible", "x.com/1");
  assert.equal(again.admit, false);
  assert.equal(again.heldResult.held, true);
});

test("the same send chord on ten different pages is fine (the old guard blocked this)", () => {
  const a = new ToolAdmission();
  for (let i = 0; i < 10; i++) {
    const page = `x.com/status/${i}`;
    assert.equal(a.admit("press", send, "irreversible", page).admit, true, page);
    a.observe("press", send, "irreversible", page, { ok: true }, false);
  }
});

test("a FAILED irreversible action may be retried (only success is committed)", () => {
  const a = new ToolAdmission();
  a.observe("press", send, "irreversible", "p", { ok: false }, true);
  assert.equal(a.admit("press", send, "irreversible", "p").admit, true);
});

test("nothing else is ever blocked for repeating (the old guard deadlocked)", () => {
  const a = new ToolAdmission();
  for (let i = 0; i < 50; i++) {
    assert.equal(a.admit("get_page_state", {}, "read", "p").admit, true);
    a.observe("get_page_state", {}, "read", "p", { snap: i }, false);
    assert.equal(a.admit("type", { ref: "e1", text: "x" }, "mutate", "p").admit, true);
  }
});

test("a repeatedly failing call gets guidance on its second failure", () => {
  const a = new ToolAdmission();
  assert.equal(a.observe("click", { ref: "e1" }, "mutate", "p", { ok: false }, true), null);
  assert.match(a.observe("click", { ref: "e1" }, "mutate", "p", { ok: false }, true), /failed 2 times/);
});

test("re-reading an unchanged page gets guidance on the third identical result", () => {
  const a = new ToolAdmission();
  const same = { snapshot: "unchanged" };
  assert.equal(a.observe("get_page_state", {}, "read", "p", same, false), null);
  assert.equal(a.observe("get_page_state", {}, "read", "p", same, false), null);
  assert.match(a.observe("get_page_state", {}, "read", "p", same, false), /same result 3 times/);
});

test("a page that is actually changing never triggers no-progress guidance", () => {
  const a = new ToolAdmission();
  for (let i = 0; i < 10; i++) assert.equal(a.observe("get_page_state", {}, "read", "p", { snap: i }, false), null);
});

test("waiting is naturally repetitive and never nagged about", () => {
  const a = new ToolAdmission();
  for (let i = 0; i < 10; i++) assert.equal(a.observe("wait", { seconds: 2 }, "read", "p", { ok: true }, false), null);
});

test("argument order does not make two identical calls look different", () => {
  const a = new ToolAdmission();
  a.observe("click", { ref: "e1", description: "d" }, "irreversible", "p", { ok: true }, false);
  assert.equal(a.admit("click", { description: "d", ref: "e1" }, "irreversible", "p").admit, false);
});

test("the same successful click, again and again on one page, gets guidance", () => {
  const a = new ToolAdmission();
  const args = { x: 632, y: 392 };
  assert.equal(a.observe("click_at", args, "mutate", "p", { ok: true }, false), null);
  assert.equal(a.observe("click_at", args, "mutate", "p", { ok: true }, false), null);
  assert.match(a.observe("click_at", args, "mutate", "p", { ok: true }, false), /30 seconds or more/);
  // Somewhere else, or a held key, is not the same thing.
  assert.equal(a.observe("click_at", { x: 1, y: 1 }, "mutate", "p", { ok: true }, false), null);
  for (let i = 0; i < 5; i++) assert.equal(a.observe("hold_keys", { keys: ["w"], ms: 2000 }, "mutate", "p", { ok: true }, false), null);
});

test("clicking to focus between key presses is not a repeated click", () => {
  const a = new ToolAdmission();
  const focus = { x: 634, y: 400 };
  for (let i = 0; i < 6; i++) {
    assert.equal(a.observe("click_at", focus, "mutate", "p", { ok: true }, false), null, `focus click ${i}`);
    assert.equal(a.observe("hold_keys", { keys: ["w"], ms: 1500 }, "mutate", "p", { ok: true }, false), null);
  }
  // ...but clicking, waiting and looking, then clicking again, still counts.
  a.observe("click_at", { x: 1, y: 2 }, "mutate", "q", { ok: true }, false);
  a.observe("wait", { seconds: 3 }, "read", "q", { ok: true }, false);
  a.observe("screenshot", { look_for: "?" }, "read", "q", { ok: true, description: "same" }, false);
  a.observe("click_at", { x: 1, y: 2 }, "mutate", "q", { ok: true }, false);
  assert.match(a.observe("click_at", { x: 1, y: 2 }, "mutate", "q", { ok: true }, false), /3 times in a row/);
});

test("the same click counts as a repeat however the model words its description", () => {
  const a = new ToolAdmission();
  const click = (d) => a.observe("click", { ref: "e137", description: d }, "mutate", "x.com/search", { ok: true, clicked: "e137" }, false);
  assert.equal(click("Reply button on kundan_k_ tweet about learning tech stack"), null);
  a.observe("get_page_state", {}, "read", "x.com/search", { snapshot: "a" }, false);
  assert.equal(click("Reply button on kundan_k_'s tech stack tweet"), null);
  a.observe("get_page_state", {}, "read", "x.com/search", { snapshot: "b" }, false);
  assert.match(click("Reply button on kundan_k_'s tech stack tweet, again"), /3 times in a row/);
  // A different element is a different click.
  assert.equal(a.observe("click", { ref: "e138", description: "x" }, "mutate", "x.com/search", { ok: true }, false), null);
});
