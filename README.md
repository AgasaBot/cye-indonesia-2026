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

## Hosting & domain

- Hosted free on **GitHub Pages** from `main` (root). Live build:
  <https://agasabot.github.io/cye-indonesia-2026/>.
- Custom domain **cye-indonesia.com** (registrar: Domainesia) is pointed at
  GitHub Pages via DNS; the `CNAME` file holds the domain and GitHub issues a
  free HTTPS certificate for it.

## Registration form

- **No payment is taken on the site.** The form collects details + a business
  plan, headshot, and a pitch-video *link*, then submits. The IDR 150,000 fee is
  arranged manually afterwards (the copy says so, and the confirmation email
  repeats it).
- **Submissions** post to a Google Apps Script web app → a **Google Sheet**
  (data) + **Google Drive** folder (files). Set up via
  [`apps-script/SETUP.md`](apps-script/SETUP.md); the deployed `/exec` URL goes
  into `app.js` as `ENDPOINT`. While `ENDPOINT` is empty the form keeps a local
  copy (preview only).
- **Timeline dates** are filled in from the design (deadline 31 Aug 2026, Top 30
  early Sep, National Final 3 Oct 2026).
