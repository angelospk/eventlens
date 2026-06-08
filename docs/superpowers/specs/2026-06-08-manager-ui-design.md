# Spec — Sub-project 2: Manager UI

**Ημερομηνία:** 2026-06-08
**Project:** eventlens
**Sub-project:** 2/4 — διαβάζει από τα δεδομένα που παράγει το sub-project 1.

---

## Σκοπός

Οι social media managers μπαίνουν με δικό τους passcode, διαλέγουν βραδιά (ημερομηνία),
βλέπουν grid με τις επεξεργασμένες φωτογραφίες της βραδιάς και κατεβάζουν όποια θέλουν.

Επιτυχία = manager κάνει login, επιλέγει ημερομηνία, βλέπει τις confirmed φωτό εκείνης της
μέρας, και κατεβάζει μία με το αρχικό της όνομα.

## Εκτός σκοπού (αυτό το sub-project)

- Bulk select / ZIP download (πιθανό αργότερα)
- Delete / hide / curation (πάει στο sub-project 3 με το AI)
- Ξεχωριστά thumbnails (δείχνουμε τα AVIF με lazy-loading· προστίθενται αν χρειαστεί σε κλίμακα)
- Pagination (μια μέρα φορτώνεται ολόκληρη· τα metadata είναι μικρά)

---

## Αρχιτεκτονική

Νέα route `/manager` στην **ίδια static SvelteKit app**. Νέο endpoint `GET /list` στον
υπάρχοντα Cloudflare Worker, gated με νέο secret **`MANAGER_PASSCODE`** (header
`x-manager-passcode`). Λίστα/metadata από **D1**· εικόνες από τα δημόσια **R2** URLs.

### Ροή
```
[Login manager passcode] → [Date picker, default = σήμερα (local)]
        ↓ GET /list?date=YYYY-MM-DD   (header x-manager-passcode)
   Worker: SELECT ... FROM photos WHERE event_date=? AND status='confirmed' ORDER BY created_at
        ↓
   Grid lazy-loaded εικόνων (public_url) → κλικ → download (blob, original_name)
```

---

## Κομμάτια

| File | Ρόλος | Εξαρτήσεις |
|------|-------|------------|
| `worker/src/index.ts` | + `GET /list` handler· CORS update | D1 |
| `src/lib/types.ts` | + `PhotoListItem` | — |
| `src/lib/manager-client.ts` | `fetchList(date)` + `downloadPhoto(item)` | Worker, fetch |
| `src/routes/manager/+page.svelte` | login + date picker + grid + download | manager-client |
| R2 bucket CORS | + GET/HEAD από το Pages origin (για fetch-to-download) | — |

### Worker `GET /list`
- Auth: `x-manager-passcode` === `env.MANAGER_PASSCODE` (αλλιώς 401). Σημείωση: ξεχωριστό
  από το `PASSCODE` των φωτογράφων.
- Validate `date` query param με `^\d{4}-\d{2}-\d{2}$` (αλλιώς 400).
- `SELECT id, public_url, original_name, width, height, bytes, created_at
   FROM photos WHERE event_date=? AND status='confirmed' ORDER BY created_at`.
- Επιστρέφει `{ photos: PhotoListItem[] }`.
- CORS: πρόσθεσε `GET` στα allowed methods και `x-manager-passcode` στα allowed headers
  (το υπάρχον `cors(env)` ήδη κλειδώνει στο `ALLOWED_ORIGIN`).

### `PhotoListItem` (types.ts)
```ts
export interface PhotoListItem {
  id: string;
  public_url: string;
  original_name: string;
  width: number;
  height: number;
  bytes: number;
  created_at: string;
}
```

### `manager-client.ts`
- `fetchList(deps, date): Promise<PhotoListItem[]>` — GET `/list?date=`, με header passcode·
  throw σε non-200· επιστρέφει `photos`. Injectable `fetchImpl` + `workerUrl` + `passcode`
  (όπως το `r2-client`, ώστε να ελέγχεται χωρίς δίκτυο).
- `downloadPhoto(item)` — fetch το `public_url` ως blob, `URL.createObjectURL`, anchor με
  `download = <original_name βάση>.avif`, click, revoke. (Browser-only· δεν unit-testάρεται.)

### R2 CORS
Πρόσθεσε κανόνα/μέθοδο για **GET** (και HEAD) από `https://angelospk.github.io`, ώστε το
`fetch(public_url)` για download να περνά το CORS. (Τα `<img>` δεν χρειάζονται CORS· το
`fetch`-to-blob χρειάζεται.)

---

## Error handling
- Λάθος passcode → 401 → μήνυμα «λάθος κωδικός».
- Κενή μέρα → «καμία φωτογραφία για αυτή την ημερομηνία».
- Network error στο `fetchList` → μήνυμα + κουμπί retry.
- Αποτυχία download → μήνυμα, δεν ρίχνει τη σελίδα.

---

## Testing
- `manager-client.fetchList`: test με stubbed `fetch` — σωστό URL+query, header
  `x-manager-passcode`, parse του `photos`, throw σε 401/500.
- Worker `/list`: χειροκίνητος έλεγχος (όπως `/sign` `/meta`) — 401 χωρίς/λάθος passcode,
  σωστό shape με passcode, 400 σε κακή ημερομηνία.
- `downloadPhoto`: browser-only, χειροκίνητο smoke.

---

## Deploy deltas (μετά την υλοποίηση)
- `bunx wrangler secret put MANAGER_PASSCODE`
- Update R2 CORS (πρόσθεσε GET/HEAD).
- `bunx wrangler deploy` (νέο `/list`).
- Frontend auto-deploy μέσω του υπάρχοντος GitHub Actions workflow.

---

## Σειρά υλοποίησης (υπόλοιπα sub-projects)
1. Capture+Process+Upload ✅ (deployed)
2. Manager UI ← *αυτό*
3. AI Curation (vision scoring + captions, customizable· + delete/hide)
4. Photo Wall (curated feed σε λούπα + χορηγικά)
