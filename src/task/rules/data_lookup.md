## Data Lookup Strategy

For tasks involving prices, news, weather, facts, rates, or any structured data:

1. Think: does a free public HTTP API exist for this? Most financial/data topics have open APIs.
2. Try fetch_url() on a likely API endpoint FIRST — it returns data in <1s with no CAPTCHA or JS issues.
3. If you find useful JSON, parse it and call done() immediately.
4. If no API works, navigate to a site and read get_page_state() — it contains all visible text.

fetch_url() uses Chrome TLS fingerprint impersonation (wreq-js) to bypass Cloudflare and bot detection.
It is always faster and more reliable than browser navigation for pure data retrieval.
