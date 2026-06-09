# EventLens

Φωτογραφίες εκδήλωσης, από τον φακό στην οθόνη του χώρου. Ένας φωτογράφος ανεβάζει,
ένας διαχειριστής ελέγχει, και μια δημόσια οθόνη (projector/TV) παίζει σε λούπα τις
φωτογραφίες της βραδιάς μαζί με χορηγικά μηνύματα.

SvelteKit static app (prerendered, GitHub Pages) + ένας Cloudflare Worker με D1 + R2.

## Routes & endpoints

| URL | Ποιος | Τι κάνει |
|-----|-------|----------|
| `/` | Φωτογράφος (passcode) | Επιλογή φωτό → επεξεργασία στον browser (AVIF + logo + χρωματισμός) → upload σε R2 → confirm. Offline ουρά σε IndexedDB. |
| `/manager` | Διαχειριστής (passcode) | Περιήγηση confirmed φωτό ανά ημερομηνία, κατέβασμα. |
| `/wall` | Κανείς (δημόσιο) | Full-screen slideshow της ημέρας + χορηγικά· νέες φωτό μπαίνουν αυτόματα. |

Worker (`worker/src/index.ts`): `POST /sign`, `POST /meta` (φωτογράφος), `GET /list`
(διαχειριστής), `GET /wall` (δημόσιο).

## Κατάσταση

| # | Sub-project | Κατάσταση |
|---|-------------|-----------|
| 1 | Capture + Process + Upload | ✅ Deployed |
| 2 | Manager UI | ✅ Deployed |
| 3 | AI Curation — vision scoring, captions, approval/curation, delete/hide | ⏳ Εκκρεμεί |
| 4 | Photo Wall | ✅ Deployed |

Specs: `docs/superpowers/specs/`.

## User flow (end-to-end)

1. **Φωτογράφος** ανοίγει το `/`, βάζει το passcode, διαλέγει φωτογραφίες. Κάθε μία
   επεξεργάζεται τοπικά (AVIF + λογότυπο + χρωματισμός) και ανεβαίνει στο R2· αν κοπεί
   το δίκτυο, η ουρά κρατάει τα αρχεία και ξαναπροσπαθεί.
2. Μόλις ολοκληρωθεί ένα upload, η φωτό γίνεται **`confirmed`** στη βάση (D1).
3. **Διαχειριστής** στο `/manager` βλέπει τις confirmed φωτό της ημέρας και μπορεί να
   κατεβάσει όποια θέλει.
4. **Κοινό** — η οθόνη του χώρου δείχνει το `/wall` (χωρίς login). Παίζει σε λούπα όλες
   τις confirmed φωτό της ημέρας, παρεμβάλλοντας χορηγικά slides από
   `static/sponsors.json`. Κάθε ~30s κάνει polling: νέα φωτό εμφανίζεται μέσα σε μισό
   λεπτό, χωρίς καμία χειροκίνητη ενέργεια.

> Σημείωση: μέχρι να υλοποιηθεί το AI curation (sub-project 3), το wall παίζει **όλες**
> τις confirmed φωτό — δεν υπάρχει ακόμα έγκριση/φιλτράρισμα ανά φωτογραφία.

### Wall — γρήγορη χρήση

- Άνοιξε `https://<origin>/wall` σε projector/TV (default ημερομηνία = σήμερα, τοπική).
- Override με query param: `/wall?date=YYYY-MM-DD`.
- Χορηγικά: επεξεργάσου το `static/sponsors.json` (μήνυμα ή εικόνα, προαιρετικό
  `durationMs`). Λάθος/άδειο αρχείο → το wall συνεχίζει μόνο με φωτό.

## Τι μένει

- **Sub-project 3 — AI Curation:** vision scoring + captions, approval/curation ροή, και
  delete/hide ανά φωτογραφία. Όταν μπει, το wall θα παίζει AI-curated φωτό αντί για όλες
  τις confirmed.
- **Λειτουργικά:** GitHub Actions τρέχουν σε deprecated Node 20 (checkout/upload/deploy-pages)
  — bump πριν τις 16/6/2026.

## Ανάπτυξη

```sh
bun install
bun run dev          # frontend (Vite) στο :5173
bunx wrangler dev    # worker τοπικά στο :8787
bun test             # unit tests (bun:test)
bun run check        # svelte-check
bun run build        # static build → build/
```

Ο frontend διαβάζει το Worker URL από το `VITE_WORKER_URL` (fallback `http://localhost:8787`).

## Deploy

- **Worker:** `bunx wrangler deploy` (config στο `wrangler.toml`· secrets μέσω
  `wrangler secret put`). Setup λεπτομέρειες: `worker/DEPLOY.md`.
- **Frontend:** auto-deploy σε GitHub Pages με push στο `main` (`.github/workflows/deploy.yml`).
