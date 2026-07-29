# EventLens

Φωτογραφίες εκδήλωσης, από τον φακό στην οθόνη του χώρου. Ένας φωτογράφος ανεβάζει,
ένας διαχειριστής εγκρίνει, και η βραδιά παίζει σε προτζέκτορα ή στα κινητά του κόσμου.

SvelteKit static app (prerendered, GitHub Pages, installable PWA) + ένας Cloudflare
Worker με D1 + R2.

## Routes & endpoints

| URL | Ποιος | Τι κάνει |
|-----|-------|----------|
| `/` | Φωτογράφος (passcode) | Επιλογή φωτό → επεξεργασία στον browser (downscale + logo + χρωματισμός + AVIF, σε Web Worker) → upload σε R2 → confirm. Offline ουρά σε IndexedDB, χειροκίνητο retry. |
| `/manager` | Διαχειριστής (passcode) | Έγκριση / απόκρυψη / οριστική διαγραφή ανά φωτογραφία, τίτλος βραδιάς, διακόπτης αυτόματης δημοσίευσης, λήψη. |
| `/live` | Κανείς (δημόσιο) | Γκαλερί για τα κινητά των καλεσμένων· ανανεώνεται μόνη της. |
| `/wall` | Κανείς (δημόσιο) | Full-screen slideshow για προτζέκτορα + χορηγικά. |

Worker (`worker/src/index.ts`):

| Endpoint | Auth | Τι κάνει |
|---|---|---|
| `GET /auth` | φωτογράφος ή διαχειριστής | Επικύρωση passcode πριν αρχίσει η δουλειά. |
| `POST /sign` | φωτογράφος | Κρατάει pending γραμμή, γυρίζει signed PUT URL. |
| `POST /meta` | φωτογράφος | Επιβεβαίωση upload· εφαρμόζει το auto-approve της βραδιάς. |
| `GET /list` | διαχειριστής | Όλες οι φωτό μιας ημερομηνίας + οι ρυθμίσεις της. |
| `POST /moderate` | διαχειριστής | approve / hide / pending, ανά φωτό ή μαζικά. |
| `POST /delete` | διαχειριστής | Οριστική διαγραφή από R2 και D1. |
| `POST /event` | διαχειριστής | Τίτλος + διακόπτης αυτόματης δημοσίευσης. |
| `GET /wall` | δημόσιο | **Μόνο** οι εγκεκριμένες φωτό, edge-cached. |

## Κατάσταση

| # | Sub-project | Κατάσταση |
|---|-------------|-----------|
| 1 | Capture + Process + Upload | ✅ Deployed |
| 2 | Manager UI | ✅ Deployed |
| 3 | Moderation (approve / hide / delete) | ✅ Υλοποιημένο |
| 4 | Photo Wall | ✅ Deployed |
| 5 | PWA + offline | ✅ Υλοποιημένο |
| 6 | AI curation (vision scoring, captions) | ⏳ Δεν ξεκίνησε |

Specs: `docs/superpowers/specs/`.

## Πώς δουλεύει μια βραδιά

1. Ο **διαχειριστής** ανοίγει το `/manager`, βάζει τίτλο και αποφασίζει αν η δημοσίευση
   είναι **αυτόματη** ή **με έγκριση**. Το default είναι με έγκριση: τίποτα δεν γίνεται
   δημόσιο χωρίς να το δει άνθρωπος.
2. Ο **φωτογράφος** ανοίγει το `/`, βάζει το passcode μία φορά και διαλέγει φωτογραφίες.
   Κάθε μία σμικρύνεται στα 2560px, παίρνει λογότυπο και χρωματισμό, γίνεται AVIF μέσα σε
   Web Worker (δεν παγώνει η οθόνη) και ανεβαίνει. Χωρίς δίκτυο μπαίνουν στην ουρά.
3. Ο **διαχειριστής** εγκρίνει ό,τι θέλει, μαζικά ή μία-μία, και σβήνει οριστικά ό,τι δεν
   πρέπει να υπάρχει πουθενά.
4. Το **κοινό** βλέπει το `/live` στο κινητό, και ο **προτζέκτορας** το `/wall`.

Οι δύο δημόσιες σελίδες δείχνουν **μόνο** εγκεκριμένες φωτογραφίες.

### Wall και live

- Προτζέκτορας: `https://<origin>/wall`. Κουμπί πλήρους οθόνης, κρύβεται μετά από 3s.
- Η ημερομηνία είναι η σημερινή (τοπική) και **γυρίζει μόνη της** μετά τα μεσάνυχτα.
  Κλείδωμα σε συγκεκριμένη μέρα: `?date=YYYY-MM-DD`.
- Χορηγικά: `static/sponsors.json` (μήνυμα ή εικόνα, προαιρετικό `durationMs`).
  Λάθος ή άδειο αρχείο → το wall συνεχίζει μόνο με φωτό.

### PWA

Το `/` εγκαθίσταται σαν εφαρμογή (Android: "Add to Home screen", iOS: Μοιραστείτε →
Στην οθόνη Αφετηρίας, desktop: το εικονίδιο στη μπάρα διευθύνσεων). Ο service worker
κρατάει το app shell, οπότε ανοίγει και χωρίς δίκτυο.

Δύο όρια του iOS που αξίζει να ξέρεις: δεν υπάρχει Background Sync, άρα η ουρά αδειάζει
μόνο όσο η εφαρμογή είναι ανοιχτή· και το Safari καθαρίζει την IndexedDB μετά από ~7
μέρες αχρησίας, οπότε μην αφήνεις φωτογραφίες στην ουρά για την επόμενη βδομάδα.

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
Ο service worker είναι ενεργός μόνο στο production build.

## Deploy

- **Worker:** `bunx wrangler deploy`. Πριν το πρώτο deploy της moderation:
  `bunx wrangler d1 migrations apply eventlens --remote`. Secrets μέσω
  `wrangler secret put` (`PASSCODE`, `MANAGER_PASSCODE`, `R2_ACCESS_KEY_ID`,
  `R2_SECRET_ACCESS_KEY`). Λεπτομέρειες: `worker/DEPLOY.md`.
- **Frontend:** auto-deploy σε GitHub Pages με push στο `main`
  (`.github/workflows/deploy.yml`).

## Γνωστά όρια

- Το R2 σερβίρεται από το `pub-*.r2.dev` dev URL, που η Cloudflare rate-limitάρει και δεν
  προορίζεται για production. Με πολύ κόσμο στο `/live` θέλει custom domain στο bucket.
- Δεν υπάρχει rate limiting στο Worker. Το `/wall` είναι δημόσιο και edge-cached, οπότε το
  κόστος μιας πλημμύρας είναι μικρό, αλλά δεν είναι μηδέν.
