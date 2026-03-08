## Batching Tool Calls — Reduce Round Trips

You can return **multiple tool calls in a single response** when they don't depend on each other's output.
This is faster — all calls in one response execute in parallel before the next LLM turn.

### Good batching examples:
- After a snapshot you already have refs → batch: type(emailRef, ...) + type(passwordRef, ...) + click(submitRef)
- Memory + notification → batch: remember(key, val) + status_update(msg)
- Click then wait → batch: click(ref) + wait(2)  (wait does not need click result)
- Multiple remembers → batch: remember(k1, v1) + remember(k2, v2) + remember(k3, v3)

### Do NOT batch when the second call needs the first call's output:
- navigate + click → you need get_page_state() in between to learn the ref
- get_page_state + click → click ref comes FROM get_page_state result
