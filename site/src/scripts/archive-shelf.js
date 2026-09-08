/* ===========================================================================
   Archive shelf — renderer.  Exposes one global:
     window.awtArchiveShelf(options) -> { render, setView, filter, replace }

   VENDORED, AND CHANGED SINCE. This came in as a standalone component whose
   own INTEGRATION.md is not part of this repo, so do not re-copy that version
   over this file without re-applying the change below. What the shelf is for
   and how /saved/ drives it: docs/ARCHITECTURE.md, "The saved list is cut in
   two". Its own "things not to change" rules still hold — no z-index or
   opacity inside a spine, clip-path rather than overflow on the rack.

   Changed here:
   - Break captions stack onto two lines when one line will not fit, and only
     then (fitCaptions). A caption is absolutely positioned, so it reserves no
     width and gets only whatever its own group occupies — one book is ~27px
     against a ~53px caption, so one-book groups printed over each other. The
     year hangs into space that was already empty, so the shelf gains no height,
     and books in a stacked group are capped at --hf .97 so a full-height volume
     cannot reach the hanging year. Opening a book buys its row a cover's width,
     which is why that caption goes back to one line.
   - No closing date, on a cover or in the list. A deadline that has already
     gone is the one fact about an archived workshop nobody can act on, and on
     a cover it cost two of about six lines — which is what forced the location
     line into a flex squeeze that sliced its letters through the middle. The
     location line moved below the rule into that room; passedOn/passedDay and
     the list's date column went with the date.

   Two contract points the handoff brief got wrong, both of which cost a while:
   - It does NOT filter by status. The page passes exactly the list it wants
     shelved (isArchived, in archive-split.js).
   - onUnstar fires AFTER the volume has been dropped from this component's own
     data and repainted, so the handler only has to persist the change — never
     call replace() from it.

   And one that bites from the CSS side: --awt-cover-w and --awt-open-pad are
   read back below with parseFloat, so they must stay plain lengths. An
   unregistered custom property computes to a token stream, so a calc() there
   parses as NaN, falls through the `|| 0`, and collapses every cover to zero
   width — books overlap and a hovered row stops opening.
   =========================================================================== */

/* ======================================================== 3. RENDERER  */
(function(){
  'use strict';

  var esc = function(s){
    return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){
      return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
    });
  };

  /* FNV-1a — stable per slug, so a book keeps its thickness and shade forever */
  function hash(s){
    var h = 2166136261, i;
    for (i = 0; i < s.length; i++){ h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }

  /* A fraction of --awt-spine-max rather than a pixel width, so the shelf can
     be thinned down for a phone from CSS alone. */
  function spineWidth(slug){ return (63 + (hash(slug) % 38)) / 100; }    /* .63–1.00 */
  function spineSat(slug){   return 15 + (hash(slug + 's') % 18); }      /* 15–32%  */
  function spineHeight(slug){ return (90 + (hash(slug + 'h') % 11)) / 100; } /* .90–1.00 of the row pitch */
  function isCloth(slug){    return (hash(slug + 'c') % 5) === 0; }      /* ~1 in 5 */

  /* A workshop's label on the spine: shortest useful handle it has. */
  function shortName(w){
    return w.acronym || w.short_name || w.name || w.slug;
  }

  /* Group into conference-years, newest first, then conference A→Z. */
  function group(list){
    var by = new Map();
    list.forEach(function(w){
      var k = w.conference + '-' + w.year;
      if (!by.has(k)) by.set(k, { conf: w.conference, year: Number(w.year), items: [] });
      by.get(k).items.push(w);
    });
    var out = Array.from(by.values());
    out.sort(function(a, b){
      return (b.year - a.year) || String(a.conf).localeCompare(String(b.conf));
    });
    out.forEach(function(g){
      g.items.sort(function(a, b){
        return String(shortName(a)).localeCompare(String(shortName(b)), undefined,
          { numeric: true, sensitivity: 'base' });
      });
    });
    return out;
  }

  /* everything the filter box should match on */
  function findKey(w, cf, topicLabel){
    return [shortName(w), w.name, cf.name, w.year, w.location_label, w.track_label]
      .concat((w.topics || []).map(topicLabel))
      .filter(Boolean).join(' ').toLowerCase();
  }

  function bookHTML(w, cf, base, topicLabel){
    var slug  = String(w.slug);
    var name  = w.name || slug;
    var label = shortName(w);
    var href  = base + '/workshop/' + encodeURIComponent(slug) + '/';
    var where = [cf.name + ' ' + w.year, w.location_label || '', w.track_label || '']
                  .filter(Boolean).join(' · ');
    return '<li class="awt-item awt-book" data-slug="' + esc(slug) + '"' +
      ' data-find="' + esc(findKey(w, cf, topicLabel)) + '"' +
      (isCloth(slug) ? ' data-cloth' : '') +
      ' style="--conf:' + esc(cf.color) + ';--wf:' + spineWidth(slug) +
        ';--hf:' + spineHeight(slug) + ';--sat:' + spineSat(slug) + '">' +
      '<div class="awt-book__body">' +
        '<button class="awt-face awt-face--spine" type="button"' +
           ' aria-label="' + esc(name + ' — ' + where) + '">' +
          '<span class="awt-spine__band awt-spine__band--head"></span>' +
          '<span class="awt-spine__title"><span>' + esc(label) + '</span></span>' +
          '<span class="awt-spine__band awt-spine__band--tail"></span>' +
          (w.proceedings_url ? '<span class="awt-spine__gilt"></span>' : '') +
        '</button>' +
        '<div class="awt-face awt-face--cover" aria-hidden="true">' +
          /* No deadline anywhere on a shelved volume. A closing date that has
             already passed is the one fact about an archived workshop nobody
             can act on, and it cost two of the cover's lines to say. What is
             left — which workshop, where, which track — moves below the rule
             into the room the date was using. */
          '<p class="awt-cover__conf">' + esc(cf.name) + ' ' + esc(w.year) + '</p>' +
          '<p class="awt-cover__title">' + esc(name) + '</p>' +
          '<hr class="awt-cover__rule">' +
          '<p class="awt-cover__where">' +
            esc([label, w.track_label, w.location_label].filter(Boolean).join(' · ')) +
          '</p>' +
          '<div class="awt-cover__acts">' +
            '<a class="awt-cover__open" href="' + esc(href) + '">Open</a>' +
            '<button class="awt-cover__unstar" type="button" data-unstar="' + esc(slug) + '"' +
              ' title="Remove from saved" aria-label="Remove ' + esc(name) + ' from saved">★</button>' +
          '</div>' +
        '</div>' +
      '</div></li>';
  }

  /* Name and year as separate spans so fitCaptions() can put them on two lines
     when one will not fit. No whitespace text node between them — the inline gap
     is a margin on the name, dropped when stacked, because whitespace under
     white-space:nowrap can open a stray line box between two block spans. */
  function breakHTML(g, cf){
    return '<li class="awt-item awt-brk" aria-hidden="true" style="--conf:' + esc(cf.color) + '">' +
      '<span class="awt-brk__label">' +
        '<span class="awt-brk__conf">' + esc(cf.name) + '</span>' +
        '<span class="awt-brk__year">' + esc(g.year) + '</span>' +
      '</span></li>';
  }

  function listHTML(groups, confMap, base, topicLabel){
    var rows = [];
    groups.forEach(function(g){
      var cf = confMap[g.conf] || { name: g.conf, color: '#888' };
      g.items.forEach(function(w){
        var href = base + '/workshop/' + encodeURIComponent(w.slug) + '/';
        rows.push('<li data-slug="' + esc(w.slug) + '" style="--conf:' + esc(cf.color) + '"' +
          ' data-find="' + esc(findKey(w, cf, topicLabel)) + '">' +
          '<span class="awt-list__conf">' + esc(cf.name) + ' ' + esc(w.year) + '</span>' +
          '<a class="awt-list__name" href="' + esc(href) + '"><b>' + esc(shortName(w)) + '</b> — ' +
            esc(w.name) + '</a>' +
          '<button class="awt-list__unstar" type="button" data-unstar="' + esc(w.slug) + '"' +
            ' aria-label="Remove ' + esc(w.name) + ' from saved">★</button></li>');
      });
    });
    return '<ul class="awt-list">' + rows.join('') + '</ul>';
  }

  window.awtArchiveShelf = function(opt){
    var mount   = opt.mount;
    var base    = (opt.base || '').replace(/\/+$/, '');
    var confMap = opt.conf || {};
    var topicLabel = opt.topicLabel || function(t){ return t; };
    var onUnstar   = opt.onUnstar || function(){};
    var countEl = opt.countEl || null;
    var view    = 'shelf';
    var data    = (opt.workshops || []).slice();

    function paint(){
      var groups = group(data);

      if (countEl){
        countEl.textContent = data.length
          ? data.length + (data.length === 1 ? ' volume' : ' volumes')
          : '';
      }
      if (!data.length){
        mount.innerHTML = '<div class="awt-shelf"><p class="awt-shelf__none">' +
          'Nothing shelved yet. When a saved workshop\u2019s deadline passes it moves ' +
          'down here, so the list above only shows what you can still submit to.' +
          '</p></div>';
        return;
      }

      if (view === 'list'){
        if (ro){ ro.disconnect(); ro = null; }
        geom = [];
        mount.innerHTML = listHTML(groups, confMap, base, topicLabel);
        applyFilter();
        return;
      }


      var items = [];
      groups.forEach(function(g){
        var cf = confMap[g.conf] || { name: g.conf, color: '#888' };
        items.push(breakHTML(g, cf));
        g.items.forEach(function(w){ items.push(bookHTML(w, cf, base, topicLabel)); });
      });
      mount.innerHTML = '<div class="awt-shelf"><ul class="awt-shelf__rack">' +
        items.join('') + '</ul></div>';
      watch();
      applyFilter();
    }

    /* remove from saved */
    mount.addEventListener('click', function(e){
      var btn = e.target.closest('[data-unstar]');
      if (!btn) return;
      e.preventDefault();
      var slug = btn.getAttribute('data-unstar');
      data = data.filter(function(w){ return w.slug !== slug; });
      onUnstar(slug);
      paint();
    });

    /* ---- who steps aside ------------------------------------------------
       The rack is one wrapping flex row, so a CSS `~` selector would push
       every later row along too. Books share a row when they share an
       offsetTop, which is cheap to read and needs no relayout. */
    function clearPush(){
      var n = mount.querySelectorAll('.awt-item.is-pushed,.awt-item.is-pulled'), i;
      for (i = 0; i < n.length; i++) n[i].classList.remove('is-pushed', 'is-pulled');
    }
    function push(book){
      clearPush();
      if (!book) return;
      var rack = book.parentNode;
      /* A flat cover sits in the book's own slot, nudged right by the pad, so
         the row has to give up the extra width plus the pad twice over. That
         leaves the same amount of air on both sides of the cover. */
      var cs = getComputedStyle(rack);
      var coverW = parseFloat(cs.getPropertyValue('--awt-cover-w')) || 0;
      var pad    = parseFloat(cs.getPropertyValue('--awt-open-pad')) || 0;
      /* The extra width a flat cover needs, split between the two sides. --awt-l
         (set in measure()) is how far this volume has to sit left of its own
         slot to stay clear of the right-hand panel; the rest goes to the right.
         Any split gives the cover the same gap on both sides, so the only thing
         it changes is which neighbours move. */
      /* Round once, then derive the other share by subtraction, so the two
         always sum to the same whole number. Rounding them independently left
         the cover with up to 2px more air on one side than the other. */
      var total = Math.round(Math.max(0, coverW - book.offsetWidth + pad * 2));
      var pull  = Math.max(0, Math.min(total, Math.round(
                    parseFloat(book.style.getPropertyValue('--awt-l')) || 0)));
      rack.style.setProperty('--awt-pull', pull + 'px');
      rack.style.setProperty('--awt-push', (total - pull) + 'px');

      /* Both sides can move at once now, each by its own share. Sides with
         nothing to give up are left alone so they don't animate to zero. */
      var row = book.offsetTop, sib;
      if (total - pull > 0.5){
        sib = book.nextElementSibling;
        while (sib){
          if (sib.offsetTop === row) sib.classList.add('is-pushed');
          sib = sib.nextElementSibling;
        }
      }
      if (pull > 0.5){
        sib = book.previousElementSibling;
        while (sib){
          if (sib.offsetTop === row) sib.classList.add('is-pulled');
          sib = sib.previousElementSibling;
        }
      }
      /* The row has just given up a cover's width, so a caption that was too
         tight for one line may not be any more. */
      fitCaptions();
    }
    function close(){
      var open = mount.querySelector('.awt-book.is-open');
      if (open) open.classList.remove('is-open');
      clearPush();
      fitCaptions(); /* the room that opening the volume bought is going away */
    }
    function overCover(book, x, y){
      var c = book && book.querySelector('.awt-face--cover');
      if (!c) return false;
      var r = c.getBoundingClientRect();
      return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    }
    function openBook(book){
      if (!book || book.classList.contains('is-open') || !openable(book)) return;
      close();
      book.classList.add('is-open');
      push(book);
    }

    /* ---- where each book sits when nothing is open ----------------------
       A finger gets implicit pointer capture, so every pointermove is
       retargeted to whatever the finger first touched and elementFromPoint
       would only ever hand back the open cover. Cache the untransformed
       layout instead, measured while the shelf is at rest, and hit-test the
       finger against a book's original slot. */
    var geom = [], geomPad = 0, geomCoverW = 0;
    function measure(){
      var rack = mount.querySelector('.awt-shelf__rack');
      var shelf = mount.querySelector('.awt-shelf');
      geom = [];
      if (!rack || !shelf) return;
      /* offsetLeft/offsetTop ignore transforms, so this reads the same whether
         or not a row happens to be mid-slide. */
      /* Measured off the RACK, not the shelf: the volumes and the plank both
         live inside it, so its content box is what they must stay within. */
      var pcs = getComputedStyle(rack);
      var edgeL = rack.offsetLeft + (parseFloat(pcs.paddingLeft) || 0);
      var edgeR = rack.offsetLeft + rack.clientWidth -
                  (parseFloat(pcs.paddingRight) || 0);
      var rcs = getComputedStyle(rack);
      var coverW = parseFloat(rcs.getPropertyValue('--awt-cover-w')) || 0;
      var pad = parseFloat(rcs.getPropertyValue('--awt-open-pad')) || 0;
      geomPad = pad; geomCoverW = coverW;
      var kids = rack.children, i, el, l, r;
      var books = [];
      for (i = 0; i < kids.length; i++)
        if (kids[i].classList.contains('awt-book')) books.push(kids[i]);

      for (i = 0; i < books.length; i++){
        el = books[i];
        l = el.offsetLeft; r = l + el.offsetWidth;
        var top = el.offsetTop;
        var total = Math.max(0, coverW - el.offsetWidth + pad * 2);

        /* --awt-l is how far left of its own slot this volume's cover sits.
           The rest of the width it needs comes off the other side, so --awt-l
           is a dial between "shove the volumes after it rightward" (0) and
           "pull the volumes before it leftward" (total).

           Set it straight from the position along the shelf. At the left end
           it is 0 and everything moves right; at the right end it is the whole
           amount and everything moves left; at the MIDDLE it is exactly half,
           so the row parts evenly around the cover. Nothing is reserved and no
           fixed number of volumes is kept in view — how many you can see ahead
           simply falls out of how wide the shelf is, which is more on a big
           display and fewer on a small one.

           A constant slope also means the per-volume lurch is total divided by
           the number of volumes on the shelf: gentler the more there are.

           The two clamps are only there for a shelf too narrow to hold a
           cover, and keep it inside the side panels. */
        var span = edgeR - edgeL - el.offsetWidth;
        var frac = span > 1 ? Math.max(0, Math.min(1, (l - edgeL) / span)) : 0;
        var hardLo = Math.max(0, (l + pad + coverW) - edgeR);
        var hardHi = Math.min(total, (l + pad) - edgeL);
        var pull = Math.max(hardLo, Math.min(hardHi, total * frac));

        el.style.setProperty('--awt-l', pull.toFixed(1) + 'px');

        geom.push({ el: el, x1: l, x2: r, pull: pull,
                    y1: top, y2: top + el.offsetHeight });
      }
    }
    /* A volume is live unless a search is running and it isn't a match. */
    function openable(el){
      var rack = el && el.parentNode;
      if (!rack) return false;
      return !rack.hasAttribute('data-filtering') || el.classList.contains('is-hit');
    }
    function bookAt(clientX, clientY){
      var shelf = mount.querySelector('.awt-shelf');
      if (!shelf) return null;
      /* offsetLeft is measured from the padding box, so the shelf's own border
         has to come off the client coordinates too. */
      var r = shelf.getBoundingClientRect();
      var x = clientX - r.left - shelf.clientLeft;
      var y = clientY - r.top - shelf.clientTop;
      var i, g;
      for (i = 0; i < geom.length; i++){
        g = geom[i];
        /* Slots don't overlap, so a dimmed one means nothing is here. Returning
           null leaves a drag on whatever match it already had open, which is
           what makes sliding skip straight from one match to the next. */
        if (x >= g.x1 && x <= g.x2 && y >= g.y1 && y <= g.y2)
          return openable(g.el) ? g.el : null;
      }
      return null;
    }

    /* ---- a book break must not be stranded at the end of a row ----------
       The rack is one wrapping flex row, so where it breaks is the browser's
       call, and a break could land last on a shelf with its own volumes
       starting on the next one. Filling the leftover space at the end of that
       row with a margin pushes the break down to join them. */
    function tidyBreaks(rack){
      var kids = rack.children, i, el, pass = 0;
      for (i = 0; i < kids.length; i++)
        if (kids[i].hasAttribute('data-shim')){
          kids[i].style.marginRight = '';
          kids[i].removeAttribute('data-shim');
        }
      var shelf = rack.closest('.awt-shelf');
      while (pass++ < 24){
        var moved = false;
        var limit = rack.offsetLeft + rack.clientWidth -
                    (parseFloat(getComputedStyle(rack).paddingRight) || 0);
        kids = rack.children;
        for (i = 0; i < kids.length - 1; i++){
          el = kids[i];
          if (!el.classList.contains('awt-brk')) continue;
          if (el.offsetTop === kids[i + 1].offsetTop) continue;   // break sits with its books
          var prev = el.previousElementSibling;
          if (!prev || prev.hasAttribute('data-shim')) continue;
          var slack = limit - (prev.offsetLeft + prev.offsetWidth);
          /* Only enough to squeeze the break off the end of the row. Filling
             the whole slack made the margin wider than the space prev itself
             was sitting in, so prev wrapped too and carried the gap with it. */
          var bs = getComputedStyle(el);
          var need = el.offsetWidth + (parseFloat(bs.marginLeft) || 0) +
                     (parseFloat(bs.marginRight) || 0) +
                     (parseFloat(getComputedStyle(rack).columnGap) || 0);
          var shim = slack - need + 1.5;
          if (shim < 0.5) continue;
          prev.style.marginRight = shim.toFixed(1) + 'px';
          prev.setAttribute('data-shim', '');
          moved = true;
          break;                                   // layout moved, measure again
        }
        if (!moved) break;
      }
    }

    /* ---- captions that do not fit go onto two lines --------------------
       A caption is absolutely positioned, so it reserves no width and the room
       it gets is only ever whatever its own group happens to occupy. One book
       is about 27px against a caption of 51-55px, so a one-book group used to
       print its caption over the next one. Stacking the year under the name
       halves the width; the year hangs into space that is already empty above
       the books, so the shelf gains no height.

       Only the captions that need it stack: a group with room keeps one line.
       That is also why this re-runs when a book opens — the row steps aside by
       a whole cover width, and the caption of the group holding the open book
       suddenly has about 100px, so it goes back to one line. */
    var CAP_DOT = 13;   /* the next dot is 7px wide and starts 3px left of its break */
    var CAP_HF  = 0.97; /* see below: how tall a book in a stacked group may be */
    function fitCaptions(){
      var rack = mount.querySelector('.awt-shelf__rack');
      if (!rack) return;
      var brks = [].slice.call(rack.querySelectorAll('.awt-brk'));
      if (!brks.length) return;

      /* The natural one-line width, cached on first sight while nothing is
         stacked. paint() rebuilds these elements whenever the data or the size
         changes, so a cached width can never be stale against --awt-scale. */
      var i, b;
      for (i = 0; i < brks.length; i++){
        if (!brks[i].dataset.w){
          brks[i].classList.remove('is-stacked');
          brks[i].dataset.w = Math.ceil(
            brks[i].querySelector('.awt-brk__label').getBoundingClientRect().width);
        }
      }

      /* Where each break sits once its row has stepped aside for an open cover.
         Computed from the class rather than read off getBoundingClientRect, so
         the answer does not depend on how far the transition has got. */
      var cs = getComputedStyle(rack);
      var push = parseFloat(cs.getPropertyValue('--awt-push')) || 0;
      var pull = parseFloat(cs.getPropertyValue('--awt-pull')) || 0;
      var pos = brks.map(function(el){
        var d = el.classList.contains('is-pushed') ? push
              : el.classList.contains('is-pulled') ? -pull : 0;
        return { el: el, x: el.offsetLeft + d, row: el.offsetTop };
      });

      for (i = 0; i < pos.length; i++){
        var next = pos[i + 1];
        var room = (next && next.row === pos[i].row)
          ? next.x - pos[i].x - CAP_DOT
          : rack.clientWidth - pos[i].x - 4;
        var stacked = Number(pos[i].el.dataset.w) > room;
        pos[i].el.classList.toggle('is-stacked', stacked);

        /* A stacked caption hangs its year into the slot the books stand in, so
           the books of that group must not reach the top of theirs. --hf runs
           .90-1.00 and 1.00 does happen; at the largest size that overlaps the
           year by ~1px. Capping only these groups keeps the uneven skyline
           everywhere else, and .97 against 1.00 is ~5px on a 184px book. */
        b = pos[i].el.nextElementSibling;
        while (b && b.classList.contains('awt-book')){
          /* Always written, never removed: --hf IS the generated height, set in
             the style attribute by bookHTML. Deleting it leaves height:calc()
             with nothing to multiply, which computes to nothing and collapses
             the volume to a sliver. Restore the cached original instead. */
          var hf = hfOf(b);
          b.style.setProperty('--hf', String(stacked ? Math.min(CAP_HF, hf) : hf));
          b = b.nextElementSibling;
        }
      }
    }
    /* The generated height, remembered the first time this volume is seen — i.e.
       before anything here has written to it — so capping is reversible. */
    function hfOf(book){
      if (!book.dataset.hf){
        var v = parseFloat(getComputedStyle(book).getPropertyValue('--hf'));
        book.dataset.hf = String(v > 0 ? v : 1);
      }
      return parseFloat(book.dataset.hf) || 1;
    }

    /* Re-tidy and re-measure whenever the shelf changes width. Height changes
       on its own as rows appear, so only a width change counts. */
    var ro = null, lastW = -1;
    function watch(){
      if (ro){ ro.disconnect(); ro = null; }
      var shelf = mount.querySelector('.awt-shelf');
      var rack  = mount.querySelector('.awt-shelf__rack');
      if (!shelf || !rack) return;
      tidyBreaks(rack);
      measure();
      fitCaptions();
      if (typeof ResizeObserver === 'undefined') return;
      lastW = Math.round(shelf.getBoundingClientRect().width);
      ro = new ResizeObserver(function(entries){
        var w = Math.round(entries[0].contentRect.width);
        if (w === lastW) return;
        lastW = w;
        close();
        tidyBreaks(rack);
        measure();
        fitCaptions();
      });
      ro.observe(shelf);
    }

    /* ---- search ---------------------------------------------------------
       Held in the closure rather than read off the input, so a repaint (after
       un-starring, say) can put the dimming straight back. */
    var query = '';
    function applyFilter(){
      var rack = mount.querySelector('.awt-shelf__rack') || mount.querySelector('.awt-list');
      if (!rack) return 0;
      var spines = rack.querySelectorAll('.awt-face--spine'), i;

      if (!query){
        rack.removeAttribute('data-filtering');
        rack.querySelectorAll('.is-hit').forEach(function(n){ n.classList.remove('is-hit'); });
        for (i = 0; i < spines.length; i++) spines[i].disabled = false;
        return 0;
      }

      rack.setAttribute('data-filtering', '');
      var hits = 0, lastBreak = null, breakHit = false;
      Array.prototype.forEach.call(rack.children, function(n){
        if (n.classList.contains('awt-brk')){
          if (lastBreak) lastBreak.classList.toggle('is-hit', breakHit);
          lastBreak = n; breakHit = false; n.classList.remove('is-hit');
          return;
        }
        var hit = (n.getAttribute('data-find') || '').indexOf(query) > -1;
        n.classList.toggle('is-hit', hit);
        var spine = n.querySelector ? n.querySelector('.awt-face--spine') : null;
        if (spine) spine.disabled = !hit;      /* keeps Tab on the matches */
        if (hit){ hits++; breakHit = true; }
      });
      if (lastBreak) lastBreak.classList.toggle('is-hit', breakHit);

      /* a volume the search just excluded shouldn't stay open */
      var open = mount.querySelector('.awt-book.is-open');
      if (open && !open.classList.contains('is-hit')) close();
      return hits;
    }

    /* ---- mouse ----------------------------------------------------------
       Hover the volume the cursor is over, but never close on the way between
       two of them. A flat cover keeps one column gap plus one pad of air either
       side, and that air turns out to be exactly constant however far the cover
       has had to travel:

           next volume's left edge  -  cover's right edge
             = (l + w + colGap + push) - (l + pad - pull + coverW)
             = w + colGap + (push + pull) - pad - coverW
             = colGap + pad          (because push + pull is fixed)

       8px, at every position on every shelf. Reading those 8px as "nothing
       here, close everything" is what broke a sweep: the cursor fell into the
       gap, the row snapped back to rest, and the cursor came down four or five
       volumes further along, skipping the ones between. Holding the current one
       open across the gap makes a sweep advance one volume at a time — and it
       leaves the whole cover as somewhere the cursor can rest, so its Open link
       can be reached without the shelf moving underneath. */
    function slotOf(el){
      for (var i = 0; i < geom.length; i++) if (geom[i].el === el) return geom[i];
      return null;
    }
    function rowOf(g){
      var out = [], i;
      for (i = 0; i < geom.length; i++)
        if (geom[i].y1 === g.y1 && openable(geom[i].el)) out.push(geom[i]);
      return out;
    }
    mount.addEventListener('pointermove', function(e){
      if ((e.pointerType || 'mouse') !== 'mouse') return;

      /* Over a volume — including anywhere on an open cover, which is why the
         cover is a safe place to rest and walk to its Open link. */
      var hit = e.target.closest && e.target.closest('.awt-book');
      if (hit && openable(hit)){ openBook(hit); return; }

      var open = mount.querySelector('.awt-book.is-open');
      if (!open){
        var seed = bookAt(e.clientX, e.clientY);
        if (seed) openBook(seed);
        return;
      }

      /* Not over a volume. That covers two quite different situations, and
         treating them alike was wrong: holding the volume open for ANY empty
         point meant the cursor could sit on the plank, in the air between two
         shelves, in the frame padding or past the end of a part-filled row and
         the volume stayed open. Only the first case should hold. */
      var g = slotOf(open);
      if (!g){ close(); return; }
      var shelf = mount.querySelector('.awt-shelf');
      var r = shelf.getBoundingClientRect();
      var x = e.clientX - r.left - shelf.clientLeft;
      var y = e.clientY - r.top - shelf.clientTop;

      /* Left this shelf altogether — the plank, the air above or below it, or
         the padding at the top and bottom of the case. */
      if (y < g.y1 || y > g.y2){ close(); return; }

      var row = rowOf(g), k = row.indexOf(g);
      if (k < 0){ close(); return; }

      /* Ran off the end of the row, into space no volume occupies. */
      var slack = 24;                       /* the air around a cover, and a break's margins */
      if (x < row[0].x1 - slack || x > row[row.length - 1].x2 + slack){ close(); return; }

      /* Genuinely in the air beside the cover. Step exactly one volume in the
         direction of travel — never more, so nothing is skipped, and the next
         cover comes back under the cursor ready for the following move. One
         step per event is what handles the tail of a shelf, where --awt-l is
         climbing and the volumes drift left faster than a rightward cursor
         advances, so it can otherwise sail past the last two or three. */
      var L = g.x1 + geomPad - g.pull, R = L + geomCoverW;
      if (x > R && k + 1 < row.length) openBook(row[k + 1].el);
      else if (x < L && k > 0) openBook(row[k - 1].el);
    });
    mount.addEventListener('pointerleave', function(e){
      if ((e.pointerType || 'mouse') !== 'mouse') return;
      close();
    });

    /* ---- keyboard ------------------------------------------------------- */
    mount.addEventListener('focusin', function(e){
      var book = e.target.closest('.awt-book');
      if (book) openBook(book);
    });
    mount.addEventListener('focusout', function(e){
      if (!mount.contains(e.relatedTarget)) close();
    });
    mount.addEventListener('keydown', function(e){
      if (e.key === 'Escape') close();
    });

    /* ---- finger: drag along the shelf to browse, lift and tap to open ---- */
    var lastPointer = 'mouse';
    var touch = null;
    document.addEventListener('pointerdown', function(e){
      lastPointer = e.pointerType || 'mouse';
    }, true);

    mount.addEventListener('pointerdown', function(e){
      if ((e.pointerType || 'mouse') === 'mouse') return;
      /* A flat cover reaches past its own book's slot, so slot-testing a finger
         that landed on it would pick the NEXT book and swap the cover away
         underneath itself. When the finger is already on the open volume, leave
         the shelf alone and let the click decide: a control on the cover, or a
         second tap that shuts it. */
      var open = mount.querySelector('.awt-book.is-open');
      var domBook = e.target.closest('.awt-book');
      /* Test the open cover's own box as well as the hit target. The flat cover
         reaches across its neighbours' at-rest slots, so if anything ever stops
         it receiving the event the slot fallback below would open whichever
         neighbour happens to lie underneath rather than closing this one. */
      touch = { x: e.clientX, dragged: false,
                onOpen: !!open && (open === domBook || overCover(open, e.clientX, e.clientY)) };
      if (touch.onOpen) return;
      /* For a tap, the real hit target beats the at-rest slot: while something
         is open its neighbours have stepped aside, and a finger should reach
         the spine it can actually see. Dragging still goes by slot, so the
         cover keeps following the finger. */
      var book = domBook || bookAt(e.clientX, e.clientY);
      if (book) openBook(book); else close();
    });
    mount.addEventListener('pointermove', function(e){
      if (!touch || (e.pointerType || 'mouse') === 'mouse') return;
      if (Math.abs(e.clientX - touch.x) > 6) touch.dragged = true;
      if (touch.onOpen && !touch.dragged) return;    // a tap, not a browse
      var book = bookAt(e.clientX, e.clientY);
      if (book) openBook(book);
    });
    mount.addEventListener('pointercancel', function(){ touch = null; });
    /* Opening a book is browsing, not choosing. Nothing a finger does to the
       shelf navigates except a deliberate tap on Open or the star of a cover
       that is already flat — not a tap on a spine, not the end of a drag, and
       not a tap on the blank part of a cover. */
    mount.addEventListener('click', function(e){
      if (lastPointer === 'mouse') return;
      var t = touch; touch = null;
      var act = e.target.closest('.awt-cover__open,.awt-cover__unstar');
      if (act && act.closest('.awt-book.is-open') && !(t && t.dragged)) return;
      /* Tapping the open volume again puts it back on the shelf, so closing one
         doesn't mean hunting for bare background to tap. */
      if (t && t.onOpen && !t.dragged) close();
      e.preventDefault();
    }, true);
    document.addEventListener('pointerdown', function(e){
      if ((e.pointerType || 'mouse') !== 'mouse' && !mount.contains(e.target)) close();
    });

    return {
      render: paint,
      setView: function(v){ view = v; paint(); },
      filter: function(q){ query = String(q || '').trim().toLowerCase(); return applyFilter(); },
      replace: function(list){ data = list.slice(); paint(); }
    };
  };
})();
