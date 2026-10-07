(function () {
  const CFG = window.APP_CONFIG;
  const sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
  });
  const $app = document.getElementById("app");
  const $who = document.getElementById("who");
  const INACTIVE_DAYS = 21;
  const D = { modules: [], units: [], students: [], progress: [], responses: [], feedback: [] };
  let view = "overview", detailId = null, showAnswered = false, filter = "";

  // ---------- helpers ----------
  function el(tag, attrs = {}, ...children) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === "class") n.className = v;
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? "" : v);
    }
    for (const c of children.flat()) if (c != null && c !== false) n.append(c.nodeType ? c : document.createTextNode(String(c)));
    return n;
  }
  const show = (...nodes) => $app.replaceChildren(...nodes.filter(Boolean));
  const msg = (t, type = "err") => el("div", { class: "msg " + type }, t);
  const fmt = d => d ? new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "–";
  const daysAgo = d => Math.floor((Date.now() - new Date(d).getTime()) / 86400000);
  const levelLabel = l => ({ bachelor: "Bachelor's", master: "Master's", phd: "PhD", other: "Other" }[l] || "–");
  const answerText = r => (r && r.answer && (r.answer.text || JSON.stringify(r.answer))) || "";

  // ---------- data ----------
  async function load() {
    const [m, u, s, p, r, f] = await Promise.all([
      sb.from("modules").select("*").order("id"),
      sb.from("units").select("*").order("sort_order"),
      sb.from("students").select("*").order("joined_at"),
      sb.from("progress").select("*"),
      sb.from("responses").select("*").order("created_at"),
      sb.from("feedback").select("*").order("created_at")
    ]);
    const err = [m, u, s, p, r, f].find(x => x.error);
    if (err) throw err.error;
    Object.assign(D, { modules: m.data, units: u.data, students: s.data, progress: p.data, responses: r.data, feedback: f.data });
  }

  function studentStats(st) {
    const mine = D.progress.filter(p => p.student_id === st.id);
    const done = new Set(mine.filter(p => p.status === "completed").map(p => p.unit_id));
    const perModule = D.modules.map(m => {
      const us = D.units.filter(u => u.module_id === m.id);
      return { id: m.id, done: us.filter(u => done.has(u.id)).length, total: us.length };
    });
    const pct = D.units.length ? Math.round(100 * done.size / D.units.length) : 0;
    const inactive = pct < 100 && daysAgo(st.last_active_at) >= INACTIVE_DAYS;
    return { perModule, pct, done: done.size, inactive };
  }

  const pendingReflections = () => D.responses.filter(r => r.kind === "reflection" && !D.feedback.some(f => f.response_id === r.id));

  // ---------- auth ----------
  function renderLogin(note) {
    const email = el("input", { type: "email", required: true, placeholder: "you@academicintegrity.eu" });
    const out = el("div");
    const form = el("form", { onsubmit: async e => {
      e.preventDefault(); out.replaceChildren();
      const { error } = await sb.auth.signInWithOtp({ email: email.value.trim(), options: { emailRedirectTo: location.origin + location.pathname } });
      out.append(error ? msg("Couldn't send the link: " + error.message) : msg("Check your email and click the sign-in link.", "ok"));
    } },
      el("h2", {}, "Admin sign in"),
      el("p", {}, "Sign in with an admin email address. You'll get a sign-in link by email."),
      el("label", { class: "field" }, "Email address"), email,
      el("div", { class: "actions" }, el("button", { class: "btn primary", type: "submit" }, "Send sign-in link")), out);
    show(el("section", { class: "panel" }, form), note ? msg(note) : null);
  }

  // ---------- views ----------
  function tabs() {
    const pending = pendingReflections().length;
    const t = (id, label) => el("button", { class: "btn" + (view === id ? " on" : ""), onclick: () => { view = id; render(); } }, label);
    return el("div", { class: "tabs" }, t("overview", "Overview"), t("inbox", "Feedback inbox" + (pending ? " (" + pending + ")" : "")),
      el("button", { class: "btn link", onclick: async () => { await refresh(); } }, "Refresh"));
  }

  function renderOverview() {
    const rows = D.students
      .filter(s => !filter || [s.full_name, s.email, s.institution, s.country].join(" ").toLowerCase().includes(filter.toLowerCase()))
      .map(s => ({ s, st: studentStats(s) }));
    const all = D.students.map(s => studentStats(s));
    const finished = all.filter(x => x.pct === 100).length;
    const inactive = all.filter(x => x.inactive).length;
    const started = D.students.length - all.filter(x => x.done === 0).length;

    const stats = el("div", { class: "stats" },
      ...[["Ambassadors", D.students.length], ["Started", started], ["Finished (badge)", finished], ["Inactive " + INACTIVE_DAYS + "+ days", inactive], ["Reflections to answer", pendingReflections().length]]
        .map(([l, n]) => el("div", { class: "stat" }, el("div", { class: "n" }, n), el("div", { class: "l" }, l))));

    const search = el("input", { type: "text", placeholder: "Search name, institution, country", value: filter });
    search.addEventListener("input", () => { filter = search.value; const pos = search.selectionStart; render(); const s2 = $app.querySelector(".filters input"); s2.focus(); s2.setSelectionRange(pos, pos); });

    const head = el("tr", {}, el("th", {}, "Ambassador"), el("th", {}, "Institution"), el("th", {}, "Country"), el("th", {}, "Level"),
      ...D.modules.map(m => el("th", { title: m.title }, "M" + m.id)), el("th", {}, "Total"), el("th", {}, "Last active"), el("th", {}, "Badge"));
    const body = rows.map(({ s, st }) => el("tr", { onclick: () => { detailId = s.id; view = "detail"; render(); } },
      el("td", {}, s.full_name || s.email), el("td", {}, s.institution || "–"), el("td", {}, s.country || "–"), el("td", {}, levelLabel(s.study_level)),
      ...st.perModule.map(pm => el("td", {}, el("span", { class: "cell" + (pm.done === pm.total ? " full" : pm.done ? " part" : "") }, pm.done + "/" + pm.total))),
      el("td", {}, st.pct + "%"),
      el("td", { class: st.inactive ? "flag" : "" }, fmt(s.last_active_at) + (st.inactive ? " · inactive" : "")),
      el("td", {}, s.badge_awarded_at ? fmt(s.badge_awarded_at) : "–")));

    show(tabs(), stats,
      el("div", { class: "filters" }, search, el("button", { class: "btn", onclick: exportCsv }, "Download CSV")),
      D.students.length ? el("div", { class: "scroll" }, el("table", { class: "grid" }, el("thead", {}, head), el("tbody", {}, ...body)))
        : el("p", { class: "muted" }, "No ambassadors have signed up yet."));
  }

  function replyBox(resp) {
    const ta = el("textarea", { "aria-label": "Your feedback" });
    const out = el("div");
    return el("div", {}, ta, el("div", { class: "actions" }, el("button", { class: "btn primary", onclick: async () => {
      if (!ta.value.trim()) { out.replaceChildren(msg("Write your feedback first.")); return; }
      const { error } = await sb.from("feedback").insert({ response_id: resp.id, body: ta.value.trim() });
      if (error) { out.replaceChildren(msg("Couldn't save: " + error.message)); return; }
      await refresh();
    } }, "Send feedback")), out);
  }

  function responseItem(r, withStudent) {
    const st = D.students.find(s => s.id === r.student_id) || {};
    const unit = D.units.find(u => u.id === r.unit_id) || { title: r.unit_id };
    const fbs = D.feedback.filter(f => f.response_id === r.id);
    const kindLabel = { reflection: "Reflection", your_turn: "Your turn", quiz: "Quiz", field_mission: "Field mission" }[r.kind] || r.kind;
    return el("div", { class: "item" },
      el("div", { class: "meta" }, (withStudent ? (st.full_name || st.email) + " · " + (st.institution || "") + " · " : "") + kindLabel + " · " + (unit.kind === "unit" ? unit.id + " " : "") + unit.title + " · " + fmt(r.updated_at || r.created_at)),
      el("div", { class: "answer" }, answerText(r)),
      ...fbs.map(f => el("div", { class: "feedback" }, el("div", { class: "who" }, "Feedback · " + fmt(f.created_at) + (f.read_at ? " · read" : " · not read yet")), el("div", { class: "answer" }, f.body))),
      r.kind === "reflection" || fbs.length === 0 ? replyBox(r) : null);
  }

  function renderInbox() {
    const list = showAnswered ? D.responses.filter(r => r.kind === "reflection") : pendingReflections();
    const toggle = el("label", { class: "check" }, el("input", { type: "checkbox", checked: showAnswered, onchange: e => { showAnswered = e.target.checked; render(); } }), "Show reflections that already have feedback");
    show(tabs(), toggle,
      list.length ? el("div", { style: "margin-top:14px" }, ...list.map(r => responseItem(r, true)))
        : el("p", { class: "muted", style: "margin-top:14px" }, showAnswered ? "No reflections yet." : "All reflections have feedback. Nice work."));
  }

  function renderDetail() {
    const s = D.students.find(x => x.id === detailId);
    if (!s) { view = "overview"; return render(); }
    const st = studentStats(s);
    const prog = id => (D.progress.find(p => p.student_id === s.id && p.unit_id === id) || {}).status || "not_started";
    const resps = D.responses.filter(r => r.student_id === s.id);
    show(tabs(),
      el("button", { class: "btn link", onclick: () => { view = "overview"; render(); } }, "← All ambassadors"),
      el("section", { class: "panel", style: "margin-top:10px" },
        el("h2", { style: "margin-top:0" }, s.full_name || s.email),
        el("p", {}, [s.email, s.institution, s.country, levelLabel(s.study_level)].filter(Boolean).join(" · ")),
        el("p", { class: "small muted" }, "Joined " + fmt(s.joined_at) + " · last active " + fmt(s.last_active_at) + " · " + st.pct + "% complete" + (s.badge_awarded_at ? " · badge " + fmt(s.badge_awarded_at) : "")),
        ...D.modules.map(m => el("div", { style: "margin-top:10px" },
          el("b", {}, "Module " + m.id + ": " + m.title), el("div", { class: "small" },
            D.units.filter(u => u.module_id === m.id).map(u => (u.kind === "unit" ? u.id : "R") + " " + ({ completed: "✓", in_progress: "…", not_started: "–" }[prog(u.id)])).join("   "))))),
      el("h2", {}, "Answers"),
      resps.length ? el("div", {}, ...resps.map(r => responseItem(r, false))) : el("p", { class: "muted" }, "No written answers yet."));
  }

  function exportCsv() {
    const esc = v => '"' + String(v == null ? "" : v).replace(/"/g, '""') + '"';
    const lines = [["Name", "Email", "Institution", "Country", "Level", ...D.modules.map(m => "Module " + m.id), "Total %", "Last active", "Badge"].map(esc).join(",")];
    for (const s of D.students) {
      const st = studentStats(s);
      lines.push([s.full_name, s.email, s.institution, s.country, levelLabel(s.study_level), ...st.perModule.map(p => p.done + "/" + p.total), st.pct, fmt(s.last_active_at), s.badge_awarded_at ? fmt(s.badge_awarded_at) : ""].map(esc).join(","));
    }
    const a = el("a", { href: URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/csv" })), download: "ambassador-training-progress.csv" });
    document.body.append(a); a.click(); a.remove();
  }

  function render() {
    if (view === "inbox") renderInbox();
    else if (view === "detail") renderDetail();
    else renderOverview();
  }

  async function refresh() {
    try { await load(); render(); } catch (e) { show(msg("Couldn't load data: " + e.message)); }
  }

  async function boot() {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) { $who.textContent = ""; return renderLogin(); }
    $who.replaceChildren(el("div", {}, session.user.email), el("button", { class: "btn link small", onclick: () => sb.auth.signOut() }, "Sign out"));
    const { data: isAdmin } = await sb.rpc("is_admin");
    if (!isAdmin) return renderLogin("This account isn't an admin. Sign in with an admin email address.");
    show(el("p", { class: "muted" }, "Loading…"));
    await refresh();
  }

  sb.auth.onAuthStateChange(ev => { if (ev === "SIGNED_IN" || ev === "SIGNED_OUT") boot(); });
  boot();
})();
