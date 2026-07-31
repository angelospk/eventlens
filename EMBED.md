# Βάζοντας τη γκαλερί σε μια σελίδα

Ένα iframe, μία φορά. Κάθε νέα βραδιά εμφανίζεται μόνη της σαν ακόμα μια καρτέλα μέσα στη
γκαλερί — η σελίδα που τη φιλοξενεί δεν ξαναγγίζεται.

## Στο WordPress (Elementor)

Σελίδα → Επεξεργασία με Elementor → widget **HTML** → επικόλληση:

```html
<div class="eventlens-wrap">
  <iframe
    id="eventlens-gallery"
    src="https://angelospk.github.io/eventlens/live"
    title="Φωτογραφίες φεστιβάλ"
    loading="lazy"
    scrolling="no"
    style="width:100%;height:900px;border:0;display:block"></iframe>
</div>

<script>
(function () {
  var frame = document.getElementById('eventlens-gallery');
  var galleryOrigin = new URL(frame.src).origin;

  window.addEventListener('message', function (event) {
    // Δέχεται ύψος μόνο από τη γκαλερί, και μόνο από αυτό το iframe.
    if (event.origin !== galleryOrigin) return;
    if (event.source !== frame.contentWindow) return;

    var data = event.data;
    if (!data || data.type !== 'eventlens:height') return;
    if (typeof data.height !== 'number' || !isFinite(data.height)) return;

    frame.style.height = Math.min(30000, Math.max(400, Math.ceil(data.height))) + 'px';
  });
})();
</script>
```

Το `height:900px` είναι το ύψος πριν απαντήσει η γκαλερί, και ό,τι μένει αν κάτι μπλοκάρει
τα μηνύματα. Χωρίς `transition` στο ύψος: αλλάζοντας βραδιά το iframe πρέπει να πάρει το νέο
του μέγεθος αμέσως, όχι σε μισό δευτερόλεπτο κινούμενης εικόνας.

## Απευθείας σύνδεσμος σε μια βραδιά

`.../live?date=2026-07-30` ανοίγει εκείνη τη βραδιά. Μια ρητή ημερομηνία υπερισχύει πάντα,
ακόμα κι αν δεν έχει φωτογραφίες — ένας σύνδεσμος που μοιράστηκε κάποιος δείχνει αυτό που
λέει, δεν αλλάζει βραδιά από μόνος του.

## Αν αλλάξει το domain

Η γκαλερί στέλνει το ύψος της μόνο σε συγκεκριμένες σελίδες, ονομαστικά. Η λίστα είναι το
`embedOrigins` στο [src/lib/config.ts](src/lib/config.ts) — καινούργιο domain σημαίνει μια
γραμμή εκεί και ένα deploy, αλλιώς το iframe μένει στο σταθερό του ύψος.
