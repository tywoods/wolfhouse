/* Luna front desk — day cockpit renderer.
   renderCockpit(mountEl, data)  →  paints the band and keeps the clock live.

   data = {
     venue: "Sunset",
     date: "2026-07-31",          // ISO date of the day being shown
     range: "today",              // "today" | "week" | "next30"  (which range pill is active)
     window: [8, 20],             // optional ribbon window, hours. default: first start -2h → last end +2h
     sessions: [{
       id, name, start: "10:00", end: "12:00",
       booked: 3, capacity: 24,
       boards: 2, wetsuits: 2,
       note: "Edu · day 4 of 4",  // optional line shown as a chip on the live hero
       cancelled: false
     }],
     prep: { boards:{total:8,lesson:4,rental:4}, wetsuits:{total:8,lesson:4,rental:4}, unpaid:9, needReply:0 },
     on: {                        // all optional
       prev, today, next, range(kind), refresh, create(sessionId|null), closeSlot(sessionId), session(sessionId)
     }
   }
*/
(function (global) {
  const pad = (n) => String(n).padStart(2, '0');
  const toMin = (hhmm) => {
    const [h, m] = hhmm.split(':').map(Number);
    return h * 60 + m;
  };
  const fmtDur = (mins) => {
    if (mins < 60) return `${mins} min`;
    const h = Math.floor(mins / 60), m = mins % 60;
    return m ? `${h} h ${m} m` : `${h} h`;
  };
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  function nowMinutes(data) {
    if (typeof data.now === 'number') return data.now; // explicit override (tests, demos, replay)
    // Only treat the clock as "live" when the shown day is actually today.
    const d = new Date();
    const shown = data.date ? new Date(data.date + 'T00:00:00') : d;
    const sameDay = d.toDateString() === shown.toDateString();
    return sameDay ? d.getHours() * 60 + d.getMinutes() : null;
  }

  function classify(data, now) {
    const list = (data.sessions || []).filter((s) => !s.cancelled)
      .map((s) => ({ ...s, s: toMin(s.start), e: toMin(s.end) }))
      .sort((a, b) => a.s - b.s);
    const live = now == null ? null : list.find((x) => now >= x.s && now < x.e) || null;
    const next = now == null ? list[0] || null : list.find((x) => x.s > now) || null;
    return { list, live, next };
  }

  function render(mount, data) {
    const now = nowMinutes(data);
    const { list, live, next } = classify(data, now);
    const on = data.on || {};
    const firstStart = list.length ? Math.min(...list.map((x) => x.s)) : 480;
    const lastEnd = list.length ? Math.max(...list.map((x) => x.e)) : 1200;
    const wanted = data.window || [Math.floor(firstStart / 60) - 2, Math.ceil(lastEnd / 60) + 2];
    // never let a block fall outside the track, whatever window was asked for
    const win = [
      Math.max(0, Math.min(wanted[0], Math.floor(firstStart / 60))),
      Math.min(24, Math.max(wanted[1], Math.ceil(lastEnd / 60)))
    ];
    const spanMin = (win[1] - win[0]) * 60;
    const pct = (min) => ((min - win[0] * 60) / spanMin) * 100;

    mount.className = 'cockpit';
    mount.innerHTML = '';

    /* ----- control bar ----- */
    const bar = el('div', 'ck-bar');
    const nav = el('div', 'ck-seg');
    [['Previous', on.prev], ['Today', on.today, true], ['Next', on.next]].forEach(([label, fn, active]) => {
      const b = el('button', null, label);
      b.type = 'button';
      if (active) b.setAttribute('aria-pressed', 'true');
      if (fn) b.addEventListener('click', fn);
      nav.appendChild(b);
    });
    bar.appendChild(nav);

    const dateWrap = el('div', 'ck-date');
    const dt = data.date ? new Date(data.date + 'T00:00:00') : new Date();
    const isToday = new Date().toDateString() === dt.toDateString();
    dateWrap.appendChild(el('b', null,
      `${isToday ? 'Today' : dt.toLocaleDateString(undefined, { weekday: 'short' })} · ` +
      dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })));
    const guests = list.reduce((n, s) => n + (s.booked || 0), 0);
    dateWrap.appendChild(el('span', null,
      `Schedule for ${data.venue || '—'} · ${list.length} session${list.length === 1 ? '' : 's'} · ${guests} guest${guests === 1 ? '' : 's'}`));
    bar.appendChild(dateWrap);

    const legend = el('div', 'ck-legend');
    legend.innerHTML = '<span><i class="ck-dot ck-dot--luna"></i>Luna</span><span><i class="ck-dot ck-dot--staff"></i>Staff</span>';
    bar.appendChild(legend);

    const right = el('div', 'ck-bar__right');
    const ranges = el('div', 'ck-seg ck-seg--range');
    [['today', 'Today'], ['week', 'Week'], ['next30', 'Next 30 days']].forEach(([key, label]) => {
      const b = el('button', null, label);
      b.type = 'button';
      if ((data.range || 'today') === key) b.setAttribute('aria-pressed', 'true');
      if (on.range) b.addEventListener('click', () => on.range(key));
      ranges.appendChild(b);
    });
    right.appendChild(ranges);
    const refresh = el('button', 'ck-icon-btn', '↻');
    refresh.type = 'button';
    refresh.setAttribute('aria-label', 'Refresh');
    if (on.refresh) refresh.addEventListener('click', on.refresh);
    right.appendChild(refresh);
    const create = el('button', 'ck-cta', 'Create booking');
    create.type = 'button';
    if (on.create) create.addEventListener('click', () => on.create(null));
    right.appendChild(create);
    bar.appendChild(right);
    mount.appendChild(bar);

    /* ----- body ----- */
    const body = el('div', 'ck-body');
    const main = el('div', 'ck-main');

    /* NOW hero */
    const hero = el('div', 'ck-now');
    const heroL = el('div');
    const eyebrow = el('div', 'ck-eyebrow');
    eyebrow.appendChild(el('i', 'ck-pulse'));
    if (live) {
      eyebrow.appendChild(el('span', null, `ON NOW · ENDS ${live.end}`));
      heroL.appendChild(eyebrow);
      heroL.appendChild(el('h2', null, live.name));
      heroL.appendChild(el('div', 'ck-now__sub',
        `${live.start} – ${live.end} · ends in ${fmtDur(live.e - now)}`));
      const chips = el('div', 'ck-chips');
      if (live.boards) chips.appendChild(el('span', 'ck-chip', `✓ ${live.boards} board${live.boards === 1 ? '' : 's'} out`));
      if (live.wetsuits) chips.appendChild(el('span', 'ck-chip', `✓ ${live.wetsuits} wetsuit${live.wetsuits === 1 ? '' : 's'} out`));
      if (!live.boards && !live.wetsuits) chips.appendChild(el('span', 'ck-chip ck-chip--muted', 'no gear needed'));
      if (live.note) chips.appendChild(el('span', 'ck-chip ck-chip--muted', live.note));
      heroL.appendChild(chips);
      hero.appendChild(heroL);

      const seats = el('div', 'ck-seats');
      const ring = el('div', 'ck-ring');
      ring.style.setProperty('--ck-ring-deg', `${Math.round((live.booked / live.capacity) * 360)}deg`);
      const inner = el('i');
      inner.append(document.createTextNode(String(live.booked)), el('span', null, `/${live.capacity}`));
      ring.appendChild(inner);
      seats.appendChild(ring);
      const lbl = el('div', 'ck-seats__label');
      lbl.innerHTML = 'seats<br>booked';
      seats.appendChild(lbl);
      hero.appendChild(seats);
    } else {
      hero.classList.add('ck-now--idle');
      const done = now != null && list.length && now >= Math.max(...list.map((x) => x.e));
      eyebrow.appendChild(el('span', null, done ? 'DAY COMPLETE' : 'NOTHING IN THE WATER'));
      heroL.appendChild(eyebrow);
      heroL.appendChild(el('h2', null, done
        ? `${list.length} session${list.length === 1 ? '' : 's'} run · ${guests} guest${guests === 1 ? '' : 's'}`
        : next ? `First up: ${next.name}` : 'No sessions scheduled'));
      heroL.appendChild(el('div', 'ck-now__sub', done
        ? 'Gear back in, day closed out.'
        : next ? `${next.start} – ${next.end}${now != null ? ` · starts in ${fmtDur(next.s - now)}` : ''}` : 'Add a session to get going.'));
      const chips = el('div', 'ck-chips');
      chips.appendChild(el('span', 'ck-chip', `${data.prep?.boards?.total ?? 0} boards · ${data.prep?.wetsuits?.total ?? 0} wetsuits ${done ? 'used' : 'to prep'}`));
      heroL.appendChild(chips);
      hero.appendChild(heroL);
    }
    main.appendChild(hero);

    /* ribbon */
    const rWrap = el('div');
    const head = el('div', 'ck-ribbon-head');
    head.appendChild(el('b', null, 'The day'));
    head.appendChild(el('span', null, list.map((s) => {
      if (now != null && now >= s.e) return `${s.name.replace(/^Curso /, '')} done`;
      if (live && s.id === live.id) return `${s.name.replace(/^Curso /, '')} in the water`;
      return s.booked ? `${s.name.replace(/^Curso /, '')} ${s.booked}/${s.capacity}` : `${s.name.replace(/^Curso /, '')} empty`;
    }).join(' · ')));
    if (next) {
      const nx = el('span', 'ck-next');
      nx.innerHTML = `next: <strong>${next.name} ${next.start}</strong>${now != null ? ` · in ${fmtDur(next.s - now)}` : ''}`;
      head.appendChild(nx);
    }
    rWrap.appendChild(head);

    const ribbon = el('div', 'ck-ribbon');
    ribbon.appendChild(el('div', 'ck-ribbon__track'));
    list.forEach((s) => {
      const state = now != null && now >= s.e ? 'done' : live && s.id === live.id ? 'live' : s.booked ? 'done' : 'empty';
      const b = el('button', `ck-block ck-block--${state === 'done' && !(now != null && now >= s.e) ? 'done' : state}`);
      b.type = 'button';
      b.style.left = pct(s.s) + '%';
      b.style.width = (((s.e - s.s) / spanMin) * 100) + '%';
      b.textContent = `${s.name.replace(/^Curso /, '')} · ${s.booked}/${s.capacity}${now != null && now >= s.e ? ' ✓' : ''}`;
      b.title = `${s.name} ${s.start}–${s.end}`;
      b.addEventListener('click', () => (s.booked ? on.session && on.session(s.id) : on.create && on.create(s.id)));
      ribbon.appendChild(b);
    });
    if (now != null && now >= win[0] * 60 && now <= win[1] * 60) {
      const needle = el('div', 'ck-needle');
      needle.style.left = pct(now) + '%';
      needle.appendChild(el('b', null, `${pad(Math.floor(now / 60))}:${pad(now % 60)}`));
      ribbon.appendChild(needle);
    }
    const hours = el('div', 'ck-hours');
    for (let h = win[0]; h <= win[1]; h += 2) hours.appendChild(el('span', null, pad(h)));
    ribbon.appendChild(hours);
    rWrap.appendChild(ribbon);
    main.appendChild(rWrap);
    body.appendChild(main);

    /* prep rail */
    const p = data.prep || {};
    const prep = el('div', 'ck-prep');
    prep.appendChild(el('h3', null, "TODAY'S PREP"));
    [['Surfboards', p.boards], ['Wetsuits', p.wetsuits]].forEach(([label, v]) => {
      const row = el('div', 'ck-prep__row');
      row.appendChild(el('span', null, label));
      const val = el('span');
      val.append(el('strong', null, String(v?.total ?? 0)), document.createTextNode(' '),
        el('em', null, `${v?.lesson ?? 0} lesson · ${v?.rental ?? 0} rental`));
      row.appendChild(val);
      prep.appendChild(row);
    });
    prep.appendChild(el('div', 'ck-prep__rule'));
    const unpaid = el('div', 'ck-prep__row ck-prep__row--alert');
    unpaid.appendChild(el('span', null, 'Unpaid / pending'));
    unpaid.appendChild(el('span', 'ck-badge', String(p.unpaid ?? 0)));
    if (on.unpaid) { unpaid.style.cursor = 'pointer'; unpaid.addEventListener('click', on.unpaid); }
    prep.appendChild(unpaid);
    const reply = el('div', 'ck-prep__row ck-prep__row--quiet');
    reply.appendChild(el('span', null, 'Need reply'));
    reply.appendChild(el('span', null, (p.needReply ?? 0) === 0 ? '0 · inbox clear' : String(p.needReply)));
    if (on.inbox) { reply.style.cursor = 'pointer'; reply.addEventListener('click', on.inbox); }
    prep.appendChild(reply);
    body.appendChild(prep);

    mount.appendChild(body);
  }

  function renderCockpit(mount, data) {
    render(mount, data);
    clearInterval(mount.__ckTimer);
    mount.__ckTimer = setInterval(() => render(mount, data), 60000); // keeps needle + countdowns honest
    return { update: (next) => renderCockpit(mount, next || data), destroy: () => clearInterval(mount.__ckTimer) };
  }

  global.renderCockpit = renderCockpit;
})(window);
