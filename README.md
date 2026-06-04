# CYE Indonesia 2026 — Creative Young Entrepreneur Award

Landing page for the **Creative Young Entrepreneur Award — Indonesia 2026**, hosted by
JCI Nusantara on behalf of JCI Indonesia. The national winner flies to the JCI
Asia–Pacific Conference 2027 (flights + hotel covered). National Final: **3 October 2026**,
APL Tower Level 22 — Galilee Centre, Jakarta.

A single-page static site — no build step.

## Structure

| File | Purpose |
|------|---------|
| `index.html` | Page markup (nav, hero, What-is-CYE, vision, prize, benefits, eligibility, how-it-works, timeline, pathway, FAQ, 3-step registration form, footer) |
| `styles.css` | Design system (dark blue `#0a0f29` · turquoise `#72d9bf` · white `#fefefe`, Montserrat + Inter) and responsive rules |
| `app.js` | Nav scroll state, mobile menu, scroll-reveal, FAQ accordion, multi-step registration form with validation |
| `assets/` | Brand logo and event photography |

## Run locally

Open `index.html` directly, or serve the folder:

```bash
python3 -m http.server 8000   # then visit http://localhost:8000
```

## Going live — remaining hooks

- **Form submission** currently writes to `localStorage` (`app.js` → `submitToSpreadsheet`). Swap in a real Google Sheet / Airtable / webhook POST.
- **Payment** is a labeled demo panel — connect a real gateway before launch.
- **Timeline dates** marked `TBD` (application deadline, shortlist, preliminary round) await confirmation.
