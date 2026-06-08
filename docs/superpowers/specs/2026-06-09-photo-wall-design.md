# Spec — Sub-project 4: Photo Wall

**Ημερομηνία:** 2026-06-09
**Project:** eventlens
**Sub-project:** 4/4 — δημόσια οθόνη προβολής· διαβάζει τις φωτό που παράγει το sub-project 1.

> Σημείωση σειράς: το AI curation (sub-project 3) δεν έχει υλοποιηθεί ακόμα. Το wall MVP
> παίζει **όλες** τις confirmed φωτό της ημέρας (όχι AI-curated). Το curation/approval
> προστίθεται αργότερα στο sub-project 3.

---

## Σκοπός

Μια δημόσια full-screen οθόνη (`/wall`) παίζει σε λούπα τις επεξεργασμένες φωτογραφίες της
τρέχουσας βραδιάς, παρεμβάλλοντας χορηγικά μηνύματα/προσφορές. Νέες φωτό μπαίνουν αυτόματα
(polling). Χωρίς login — προορίζεται για projector/TV που βλέπει ο κόσμος.

Επιτυχία = ανοίγεις `/wall` σε μια οθόνη, παίζει αδιάκοπα τις φωτό της ημέρας + χορηγικά,
και όταν ανέβει νέα φωτό εμφανίζεται μέσα σε ~30s χωρίς χειροκίνητη ενέργεια.

## Εκτός σκοπού (MVP)

- AI curation / scoring (sub-project 3)
- Manual queue / approval (το wall παίζει ό,τι είναι confirmed)
- Transitions/εφέ πέρα από απλό fade (Ken Burns κ.λπ. αργότερα)
- Διαχειριστικό UI για χορηγικά (ορίζονται σε `static/sponsors.json`)

---

## Αρχιτεκτονική

Νέα **public** route `/wall` στην ίδια static SvelteKit app (prerendered· χωρίς login).
Νέο **public** endpoint `GET /wall?date=YYYY-MM-DD` στον Worker (χωρίς passcode) που
επιστρέφει τις `confirmed` φωτό της ημέρας. Χορηγικά από `static/sponsors.json`. Polling
κάθε ~30s για νέες φωτό.

### Ροή
```
/wall  →  loadSponsors() (static JSON, same-origin)
       +  fetchWallPhotos(date) (public GET /wall)
       →  buildPlaylist(photos, sponsors, opts)  →  Slide[]
       →  player διατρέχει τα slides σε λούπα, auto-advance ανά duration
       →  κάθε 30s: ξανα-fetch φωτό → rebuild playlist (νέες μπαίνουν αυτόματα)
```

---

## Κομμάτια (κάθε ένα με σαφή ευθύνη)

| File | Ρόλος | Εξαρτήσεις | Test |
|------|-------|------------|------|
| `worker/src/index.ts` | + `GET /wall?date=` (public, validate date, confirmed-only) | D1 | manual |
| `src/lib/types.ts` | + `WallPhoto`, `Sponsor`, `Slide` | — | — |
| `src/lib/playlist.ts` | **pure** `buildPlaylist()` | types | **TDD** |
| `src/lib/wall-client.ts` | `fetchWallPhotos(date)` + `loadSponsors()` | Worker, fetch | fetchWallPhotos TDD |
| `src/routes/wall/+page.svelte` | full-screen player + poll | playlist, wall-client | manual |
| `static/sponsors.json` | δείγμα χορηγικών | — | — |

### Τύποι (types.ts)
```ts
export interface WallPhoto { id: string; public_url: string; created_at: string; }

export interface Sponsor {
  type: 'message' | 'image';
  text?: string;        // για type 'message'
  imageUrl?: string;    // για type 'image'
  durationMs?: number;  // default αν λείπει
}

export interface Slide {
  kind: 'photo' | 'message' | 'image';
  src?: string;         // photo/image URL
  text?: string;        // message
  durationMs: number;
  key: string;          // σταθερό key για το {#each}
}
```

### `buildPlaylist` (pure — το «μυαλό»)
```
buildPlaylist(
  photos: WallPhoto[],
  sponsors: Sponsor[],
  opts: { photoDurationMs: number; sponsorEvery: number; defaultSponsorMs: number }
): Slide[]
```
- Για κάθε φωτό → photo slide (`durationMs = opts.photoDurationMs`).
- Μετά από κάθε `sponsorEvery` φωτό → ένα sponsor slide (κυκλικά από τη λίστα sponsors),
  `durationMs = sponsor.durationMs ?? opts.defaultSponsorMs`.
- Καμία φωτό αλλά υπάρχουν sponsors → playlist = τα sponsors (μία φορά, κυκλώνει ο player).
- Καμία φωτό & κανένα sponsor → `[]` (ο player δείχνει placeholder).
- `key`: για photo = `photo:<id>`· για sponsor = `sponsor:<index>:<θέση>` (μοναδικό).

### Worker `GET /wall`
- **Public** (καμία επικύρωση passcode — οι εικόνες είναι ήδη δημόσιες).
- Validate `date` (regex + `Date.parse`, όπως στο `/list`).
- `SELECT id, public_url, created_at FROM photos
   WHERE event_date=? AND status='confirmed' ORDER BY created_at`.
- Επιστρέφει `{ photos: WallPhoto[] }`. Header `cache-control: no-store`.
- CORS: ήδη επιτρέπεται `GET` από `ALLOWED_ORIGIN`· το request δεν έχει custom headers
  (απλό CORS, χωρίς preflight).

### Player (`/wall/+page.svelte`)
- Full-screen, μαύρο φόντο· φωτό με `object-fit: contain`.
- Κρατάει `Slide[]` + δείκτη· auto-advance με `setTimeout(slide.durationMs)`· λούπα στο τέλος.
- Poll κάθε 30s: `fetchWallPhotos` → rebuild playlist· ο δείκτης clamp-άρεται στο νέο μήκος.
- Sponsor `message` → styled κείμενο· `image` → full-screen εικόνα.
- Default date = σήμερα (local· override με `?date=`).

---

## Error handling
- Καμία φωτό → λούπα μόνο χορηγικών· καμία φωτό & κανένα χορηγικό → placeholder «Σε λίγο…».
- Poll network error → κρατάει την τρέχουσα playlist, ξαναδοκιμάζει στο επόμενο interval.
- Σπασμένο image URL (`onerror`) → προσπερνά στο επόμενο slide.
- Άδειο/κακό `sponsors.json` → συνεχίζει με μόνο φωτό (sponsors = []).

---

## Testing
- `buildPlaylist` (pure): interleaving (χορηγικό ανά Ν φωτό), σωστές διάρκειες, κενές λίστες,
  μόνο-sponsors, μοναδικά keys.
- `fetchWallPhotos`: stubbed fetch — σωστό URL/query, parse `photos`, throw σε non-200.
- player + poll + `loadSponsors`: χειροκίνητο browser smoke.

---

## Deploy deltas
- `bunx wrangler deploy` (νέο public `/wall` endpoint).
- Frontend auto-deploy μέσω GitHub Actions (νέα route `/wall`, prerendered).
- Δεν χρειάζεται νέο secret (public endpoint).

---

## Σειρά υλοποίησης (sub-projects)
1. Capture+Process+Upload ✅ (deployed)
2. Manager UI ✅ (deployed)
3. AI Curation (vision scoring + captions + approval/curation) — εκκρεμεί
4. Photo Wall ← *αυτό*
