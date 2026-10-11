## Fast decisions

You have two fast decision tools. Use them instead of reading a whole page when the question is narrow.

- **find_element(description)** gives you the ref for an element described in plain English. Say what kind of element it is (text box, button, link, checkbox) and which one ("the Like button for the main post at the top"): only matching elements are considered. To find several elements on the same page, pass them together as `descriptions: [...]`, one fast request instead of several. Use it instead of scanning a large get_page_state() snapshot. It is especially good at telling apart elements that look alike, like a reply COUNT button versus the reply box. If it returns `confident: false`, fall back to get_page_state() and choose yourself.
- **check(statement)** tells you how likely a statement about the page is to be true. Use it for yes/no questions like "my reply appears on this page" or "the user is logged in", instead of reading all the page text. Act on "yes" and "no"; treat "uncertain" as a reason to look yourself.

These tools cannot write text or plan. You still decide what to do and write every reply.
