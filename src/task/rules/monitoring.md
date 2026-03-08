## Monitoring / Ongoing Tasks — CRITICAL RULES

Keywords that indicate this type of task: "monitor", "keep checking", "wait for reply", "keep me updated",
"feel free to engage", "notify when", "let me know when", "keep watching", "ongoing", "until X happens",
"schedule", "every day", "check hourly", "daily at", "recurring".

These tasks NEVER call done() on their own. The user stops them with Ctrl+C.

### FIRST RUN — initial session:
1. Perform the first action (send message, check price, post content, etc.)
2. IMMEDIATELY call remember() to store key context:
   - remember("thread_url", "<exact URL of the conversation/page>")
   - remember("last_message_sent", "<text of message you sent>")
   - remember("monitoring_target", "<name of person/thing being monitored>")
3. Call status_update() to confirm what was done
4. Call schedule() with a sensible cron interval (e.g. every 5 min for messages, every hour for prices)
5. Do NOT call done() — the process stays alive, re-running at each cron interval

### SCHEDULED CHECK-IN — sub-run spawned by cron:
1. Check memory for thread_url — navigate DIRECTLY there (do NOT start from homepage)
2. Check if already logged in by reading get_page_state(). If the URL is the target page, you ARE logged in.
3. Only log in if the page is a login form. Use list_credential_profiles() to find the right profile.
4. After navigating to the thread, read get_page_state() to find the latest state
5. Compare with memory — look for NEW messages, changes, or triggers
6. If there is a new event: respond/act naturally, then update remember() with the latest state
7. If nothing new: call status_update("No change yet. Checking again later.")
8. Call done() — the cron will re-run automatically. Do NOT call schedule() again.

### Example — "send a message and monitor for reply":
FIRST RUN:
  → Send message
  → remember("thread_url", "https://www.linkedin.com/messaging/thread/...")
  → remember("last_message_sent", "Hello! 👋 How are you doing?")
  → status_update("✉️ Message sent. Monitoring for reply every 5 minutes.")
  → schedule("*/5 * * * *", "Check for reply and respond if received")
  [do NOT call done()]

SCHEDULED CHECK-IN:
  → recall("thread_url") → navigate directly to that URL
  → get_page_state() → find latest message
  → if target replied: respond, remember("last_message_sent", ...)
  → status_update("✅ Target replied: '...' — responded with '...'" OR "No new reply yet.")
  → done() [cron handles the next run]
