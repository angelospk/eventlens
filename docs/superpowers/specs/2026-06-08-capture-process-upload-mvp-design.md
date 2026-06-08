# Spec — MVP: Capture + Process + Upload

**Ημερομηνία:** 2026-06-08
**Project:** eventlens (προσωρινό όνομα)
**Sub-project:** 1ο από 5 — το θεμέλιο πάνω στο οποίο χτίζονται τα υπόλοιπα.

---

## Σκοπός

Ο φωτογράφος ανεβάζει φωτογραφίες από browser. Κάθε φωτογραφία αυτόματα παίρνει
logo (στην πιο «ήσυχη» γωνία) + ένα brand φίλτρο, συμπιέζεται σε AVIF, και ανεβαίνει
σε μόνιμη αποθήκευση **χωρίς να χάνεται ποτέ**, ακόμα και με κακό δίκτυο, refresh ή crash.

Επιτυχία = ο φωτογράφος διαλέγει N φωτό, φεύγει, και όλες καταλήγουν επεξεργασμένες
στο R2 + metadata στο D1, με ορατή κατάσταση ουράς και αυτόματα retries.

## Εκτός σκοπού (MVP)

- AI curation / scoring / captions (sub-project 3)
- Photo wall display (sub-project 4)
- Manager/admin UI, download, ρόλοι χρηστών (sub-project 5)
- Επιλέξιμα φίλτρα/presets, customizable prompts — αργότερα
- Πραγματικοί λογαριασμοί χρηστών (μένει το PocketBase ως μελλοντική επιλογή)

---

## Αρχιτεκτονική (κλειδωμένες αποφάσεις)

| Στρώμα | Επιλογή | Σημείωση |
|--------|---------|----------|
| Frontend | **SvelteKit, πλήρως static** | Hostable σε GitHub Pages ή Cloudflare Pages |
| Επεξεργασία εικόνας | **Στον browser** (canvas + WASM) | Όπως squoosh — μηδέν server load |
| Codec | **AVIF** (WASM encoder) | Ακριβής lib προς επιβεβαίωση (έρευνα) |
| Αποθήκευση εικόνων | **Cloudflare R2** (free 10GB) | Public URLs, γρήγορο serving |
| Metadata | **Cloudflare D1** (free SQLite) | Σχήμα ως migration σε κώδικα |
| Backend | **Cloudflare Worker** | passcode auth + presigned URL + meta write |
| Auth | **Κοινός passcode** | Ελέγχεται στον Worker |

Όλα σε **ένα Cloudflare account**. Δεν χρησιμοποιείται PocketBase στο MVP.

### Ροή

```
[Login passcode] → [Διάλεξε φωτό] → ουρά (IndexedDB)
        ↓ (σειριακά, μία-μία)
  quiet-corner → logo → φίλτρο → AVIF encode
        ↓
  POST /sign (passcode) → Worker → presigned R2 PUT URL
        ↓
  PUT blob στο R2
        ↓
  POST /meta (passcode) → Worker → INSERT στο D1
        ↓
  ✅ done  /  ❌ retry με exponential backoff
```

---

## Κομμάτια (κάθε ένα ανεξάρτητο & test-able)

### `quiet-corner`
- **Τι κάνει:** δέχεται `ImageBitmap`, επιστρέφει ποια από τις 4 γωνίες είναι πιο «ήσυχη».
- **Πώς:** δειγματοληψία περιοχής σε κάθε γωνία, υπολογισμός variance / edge-density,
  επιλογή της χαμηλότερης.
- **Έξοδος:** `{ corner: 'tl'|'tr'|'bl'|'br', padding }`.
- **Εξαρτήσεις:** καμία (καθαρή συνάρτηση).

### `processor`
- **Τι κάνει:** δέχεται αρχικό `Blob/File` + logo asset, εφαρμόζει φίλτρο (color grade),
  τοποθετεί logo στη γωνία που λέει το `quiet-corner`, κωδικοποιεί σε AVIF.
- **Έξοδος:** `{ avifBlob, width, height, bytes }`.
- **Εξαρτήσεις:** `quiet-corner`, WASM AVIF encoder.
- **Φίλτρο MVP:** ένα σταθερό color grade (π.χ. contrast/saturation/warmth) με brand τιμές
  σε ένα config — εύκολο να αλλάξει, configurable presets αργότερα.
- **Διατήρηση ανάλυσης:** δεν μειώνουμε διαστάσεις· μόνο AVIF συμπίεση. (Προαιρετικό μέγιστο
  edge cap προς επιβεβαίωση στην έρευνα ποιότητας.)

### `upload-queue`
- **Τι κάνει:** persistent ουρά σε **IndexedDB**. Σειριακό upload μία-μία. Retry με
  exponential backoff. Επιβιώνει refresh/crash/offline.
- **Καταστάσεις item:** `pending → processing → uploading → done | error(retrying)`.
- **Idempotency:** κάθε item παίρνει UUID **πριν** το upload → καμία διπλοεγγραφή σε retry.
- **Offline:** pause σε offline, auto-resume σε `online` event.
- **Εξαρτήσεις:** `processor`, `r2-client`.

### `r2-client`
- **Τι κάνει:** `POST /sign` με passcode → παίρνει presigned URL → κάνει `PUT` το blob.
  Μετά `POST /meta` για να γραφτεί το metadata.
- **Εξαρτήσεις:** Worker endpoints.

### `worker` (Cloudflare Worker)
- **Endpoints:**
  - `POST /sign` — ελέγχει passcode, εκδίδει presigned R2 PUT URL για `events/{date}/{uuid}.avif`.
  - `POST /meta` — ελέγχει passcode, κάνει INSERT στο D1.
- **Μυστικά:** R2 credentials + passcode hash ως Worker secrets (ποτέ στον client).
- **(Αργότερα:** AI proxy endpoint για sub-project 3.)

### UI (SvelteKit)
- Οθόνη login (passcode), file picker (multi-select), λίστα ουράς με progress/κατάσταση
  ανά φωτό, ορατά error/retry states, μετρητής «X από Y ανέβηκαν».

---

## Δεδομένα

### R2
```
events/{YYYY-MM-DD}/{uuid}.avif
```
Public-readable (για wall/managers αργότερα).

### D1 σχήμα (migration σε κώδικα)
```sql
CREATE TABLE photos (
  id            TEXT PRIMARY KEY,        -- uuid (ίδιο με το R2 filename)
  r2_key        TEXT NOT NULL,
  public_url    TEXT NOT NULL,
  event_date    TEXT NOT NULL,           -- YYYY-MM-DD
  original_name TEXT,
  width         INTEGER,
  height        INTEGER,
  bytes         INTEGER,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_photos_event_date ON photos(event_date);
```

---

## Αντοχή σε σφάλματα

- **Persistent ουρά (IndexedDB)** → επιβιώνει refresh/crash. Το blob ή το πηγαίο αρχείο
  κρατιέται μέχρι να επιβεβαιωθεί το upload.
- **Σειριακό upload** → δεν πνίγει αργό δίκτυο.
- **Exponential backoff** (1s→2s→4s…, με max cap & μέγιστες προσπάθειες πριν σημανθεί «failed»
  αλλά να μένει στην ουρά για manual retry).
- **Idempotent UUID** → καμία διπλοανέβασμα.
- **Offline detection** → pause + auto-resume.
- **Atomicity:** το `/meta` γράφεται **μόνο μετά** το επιτυχές R2 PUT. Αν πέσει μεταξύ τους,
  το item μένει σε «uploaded-but-unrecorded» και ξαναγράφει meta (idempotent σε id).

---

## Testing (TDD όπου έχει νόημα)

- `quiet-corner`: synthetic εικόνες με γνωστή ήσυχη γωνία → assert σωστή επιλογή.
- `upload-queue`: fake r2-client με προσομοίωση αποτυχίας/offline → assert retry, καμία
  απώλεια, καμία διπλοεγγραφή, σωστές μεταβάσεις κατάστασης.
- `processor`: assert έγκυρο AVIF output + ότι το logo τοποθετήθηκε.
- Worker: passcode reject/accept, σωστό presigned URL shape.

---

## Ανοιχτά σημεία (χρειάζονται έρευνα του χρήστη)

1. **AVIF WASM encoder lib** — υποψήφιος `@jsquash/avif`. Πιο πρόσφατη/συντηρούμενη επιλογή;
2. **Presigned R2 URL από Worker** — τρέχον σωστό pattern (aws4fetch / S3 API του R2).
3. **Όρια D1 free tier** — επιβεβαίωση τρεχόντων ορίων.
4. **AVIF ποιότητα** — προτεινόμενο quality setting / τυχόν max-dimension για ισορροπία
   μεγέθους/ποιότητας.

(Prompt έρευνας θα δοθεί χωριστά.)

---

## Σειρά υλοποίησης (επόμενα sub-projects)

1. **Capture + Process + Upload** ← *αυτό το spec*
2. Manager/Admin UI (κατέβασμα, λίστα ανά βραδιά)
3. AI Curation (vision scoring + captions, customizable)
4. Photo Wall (curated feed σε λούπα + χορηγικά)
