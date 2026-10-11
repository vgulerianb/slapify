// Tool contracts: the harness must know a scroll from a purchase.
import { test } from "node:test";
import assert from "node:assert/strict";
import { dist } from "./helpers/harness.mjs";
const { effectOf, stripQuoted } = await import(dist("task/contracts.js"));
const ctx = { labels: { e1: 'button "Post"', e2: 'tab "For you"', e3: 'button "Place order"', e4: 'button "37 Replies. Reply"', e5: 'button "Following"' } };

test("clicking a committing control is irreversible", () => {
  assert.equal(effectOf("click", { ref: "e1" }, ctx), "irreversible");
  assert.equal(effectOf("click", { ref: "e3" }, ctx), "irreversible");
});
test("clicking an ordinary control is only a mutation", () => {
  assert.equal(effectOf("click", { ref: "e2" }, ctx), "mutate");
  assert.equal(effectOf("click", { ref: "e5" }, ctx), "mutate");
});
test("an unknown ref falls back to the model's own description", () => {
  assert.equal(effectOf("click", { ref: "e99", description: "Click the Reply submit button" }, ctx), "irreversible");
});
test("the submit chord is irreversible, a plain Enter is not", () => {
  assert.equal(effectOf("press", { key: "Meta+Enter" }, ctx), "irreversible");
  assert.equal(effectOf("press", { key: "Control+Enter" }, ctx), "irreversible");
  assert.equal(effectOf("press", { key: "Enter" }, ctx), "mutate");
  assert.equal(effectOf("press", { key: "ArrowDown" }, ctx), "mutate");
});
test("reads, navigation and control are classified statically", () => {
  assert.equal(effectOf("get_page_state", {}, ctx), "read");
  assert.equal(effectOf("find_element", {}, ctx), "read");
  assert.equal(effectOf("get_otp", { profile_name: "admin" }, ctx), "read");
  assert.equal(effectOf("navigate", { url: "u" }, ctx), "navigate");
  assert.equal(effectOf("done", {}, ctx), "control");
});
test("an unknown custom tool is treated as a mutation, never as read-only", () => {
  assert.equal(effectOf("my_plugin_tool", {}, ctx), "mutate");
});

// Seen live after a resume: no snapshot yet, so only the model's description.
test("quoted tweet text in a description doesn't make a click irreversible", () => {
  const none = { labels: {} };
  assert.equal(effectOf("click", { ref: "e87", description: "Like button on dev's 'Reply guys, share this and post it'" }, none), "mutate");
  assert.equal(effectOf("click", { ref: "e87", description: 'Like button on "Please reply and subscribe"' }, none), "mutate");
  assert.equal(effectOf("click", { ref: "e9", description: "Reply button to send my reply" }, none), "irreversible");
  assert.equal(stripQuoted(`Like on 'Post now' and "send it"`).includes("Post"), false);
});
test("clicking a text field is never irreversible, even a reply box", () => {
  assert.equal(effectOf("click", { ref: "e188", description: "reply textbox to respond to someone" }, { labels: {} }), "mutate");
  assert.equal(effectOf("click", { ref: "e5", description: "the reply composer" }, { labels: {} }), "mutate");
});
test("a real label always wins over the description", () => {
  assert.equal(effectOf("click", { ref: "e1", description: "textbox" }, { labels: { e1: 'button "Post"' } }), "irreversible");
});

test("counter buttons open things, they don't submit them", () => {
  const ctx = { labels: { e1: 'button "0 Replies. Reply"', e2: 'button "1.2K Reposts. Repost"', e3: 'button "Reply"', e4: 'button "Post"' } };
  assert.equal(effectOf("click", { ref: "e1" }, ctx), "mutate");
  assert.equal(effectOf("click", { ref: "e2" }, ctx), "mutate");
  assert.equal(effectOf("click", { ref: "e3" }, ctx), "irreversible");
  assert.equal(effectOf("click", { ref: "e4" }, ctx), "irreversible");
});
