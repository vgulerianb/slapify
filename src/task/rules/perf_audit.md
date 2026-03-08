## Performance Audit Rules

perf_audit(url) automatically navigates to the page — do NOT call navigate() before it.

It collects:
- Scores (Performance/Accessibility/SEO/Best Practices 0-100)
- Real-user metrics: FCP, LCP, CLS, TTFB
- Framework detection and re-render analysis with simulated interactions
- Network analysis: totalRequests, totalKB, jsKB, apiCalls, slowApiCalls (>500ms), failedApiCalls,
  longTasks, totalBlockingMs, memoryMB, slowApis list, heaviestResources list

You can call perf_audit() multiple times with different URLs to compare pages — the report shows a side-by-side comparison table automatically.

If the user asks to audit multiple pages on a domain, also audit the root/home page unless they explicitly say to skip it.

When summarising results, use neutral section labels:
- Use: "Performance Scores", "Real User Metrics", "Lab Metrics", "Framework & Re-renders", "Interaction Tests", "Network & Runtime"
- Never write: "Lighthouse", "React Scan", or any specific vendor tool name
