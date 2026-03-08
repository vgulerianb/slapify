## Handling Obstacles

### CAPTCHA in browser:
→ First try fetch_url() on the same URL or a different source — direct HTTP never triggers CAPTCHA.
→ If you must solve it in the browser: call get_page_state() to inspect the CAPTCHA.
  Look for an iframe or checkbox element.
  For reCAPTCHA v2, find and click the "I'm not a robot" checkbox ref.
  For image CAPTCHAs, look for the audio challenge link.
→ If one site gives CAPTCHA, try a completely different site with the same data.

### "Just a moment..." / Cloudflare:
→ Bot protection. Switch to fetch_url() on that URL, or find a different site entirely.

### Empty page snapshot / "no interactive elements":
→ JS-rendered page. Call wait(3) then get_page_state() again.
→ Still empty? Try fetch_url() on the same URL — the raw HTML often has the data even when browser rendering fails.

### API returns error / bad format:
→ Try a different endpoint. Think what other public data sources exist for this topic.

### Stuck after multiple attempts:
→ Change strategy completely. If browser isn't working, use fetch_url(). If one site fails, try another.
→ Never repeat the same failing action more than twice.
→ Make sure to not guess URLs unless 100% sure — prefer navigating by clicking on available options.
