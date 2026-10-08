(function () {
  const CFG = window.APP_CONFIG;
  const sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
  });
  const $app = document.getElementById("app");
  const $who = document.getElementById("who");
  const INACTIVE_DAYS = 21;
  const D = { modules: [], units: [], students: [], progress: [], responses: [], feedback: [], decisions: [] };
  const C = {}; // parsed content per unit id
  let openDecision = null, answersUnit = "";
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
      sb.from("feedback").select("*").order("created_at"),
      sb.from("decisions").select("*")
    ]);
    const err = [m, u, s, p, r, f].find(x => x.error);
    if (err) throw err.error;
    Object.assign(D, { modules: m.data, units: u.data, students: s.data, progress: p.data, responses: r.data, feedback: f.data });
    D.decisions = (await sb.from("decisions").select("*")).data || [];
    if (!Object.keys(C).length) {
      await Promise.all(CFG.MODULE_FILES.map(async (path, i) => {
        try { const t = await (await fetch(path, { cache: "no-cache" })).text(); window.CourseParser.parseModule(t, i + 1).units.forEach(x => C[x.id] = x); } catch (e) {}
      }));
    }
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

  const sName = id => { const st = D.students.find(s => s.id === id) || {}; return st.full_name || st.email || "Unknown"; };
  const decisionSteps = uid => (C[uid] ? C[uid].steps.filter(x => x.type === "decision") : []);
  const optLabel = (uid, caseNo, l) => { const st = decisionSteps(uid).find(x => x.caseNo === caseNo); const o = st && st.options.find(x => x.letter === l); return l + (o ? ". " + o.label : ""); };
  const promptTitle = (uid, key) => { const st = C[uid] && C[uid].steps.find(x => x.key === key); return st ? st.title : key; };

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
    return el("div", { class: "tabs" }, t("overview", "Overview"), t("decisions", "Decisions"), t("answers", "Answers by unit"), t("inbox", "Feedback inbox" + (pending ? " (" + pending + ")" : "")),
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
      el("div", { class: "filters" }, search, el("button", { class: "btn primary", onclick: exportExcel }, "Download full results (Excel)"), el("button", { class: "btn", onclick: exportCsv }, "Download progress (CSV)")),
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
      el("div", { class: "meta" }, (withStudent ? (st.full_name || st.email) + " · " + (st.institution || "") + " · " : "") + (r.kind === "reflection" ? "Reflection" : promptTitle(r.unit_id, r.prompt_key)) + " · " + (unit.kind === "unit" ? unit.id + " " : "") + unit.title + " · " + fmt(r.updated_at || r.created_at)),
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
        accountTools(s),
        el("p", { class: "small muted" }, "Joined " + fmt(s.joined_at) + " · last active " + fmt(s.last_active_at) + " · " + st.pct + "% complete" + (s.badge_awarded_at ? " · badge " + fmt(s.badge_awarded_at) : "")),
        ...D.modules.map(m => el("div", { style: "margin-top:10px" },
          el("b", {}, "Module " + m.id + ": " + m.title), el("div", { class: "small" },
            D.units.filter(u => u.module_id === m.id).map(u => (u.kind === "unit" ? u.id : "R") + " " + ({ completed: "✓", in_progress: "…", not_started: "–" }[prog(u.id)])).join("   "))))),
      el("h2", {}, "Decisions"),
      (() => { const ds = D.decisions.filter(d => d.student_id === s.id).sort((a, b) => a.unit_id.localeCompare(b.unit_id, undefined, { numeric: true }) || a.case_no - b.case_no);
        return ds.length ? el("div", { class: "scroll" }, el("table", { class: "grid" },
          el("thead", {}, el("tr", {}, el("th", {}, "Unit"), el("th", {}, "First choice"), el("th", {}, "After debrief"), el("th", {}, "Changed?"))),
          el("tbody", {}, ...ds.map(d => el("tr", {},
            el("td", {}, d.unit_id + (decisionSteps(d.unit_id).length > 1 ? " · case " + d.case_no : "")),
            el("td", { style: "white-space:normal" }, optLabel(d.unit_id, d.case_no, d.first_choice)),
            el("td", { style: "white-space:normal" }, d.second_choice ? optLabel(d.unit_id, d.case_no, d.second_choice) : "–"),
            el("td", { class: d.second_choice && d.second_choice !== d.first_choice ? "flag" : "" }, d.second_choice ? (d.second_choice !== d.first_choice ? "Yes" : "No") : "–"))))))
          : el("p", { class: "muted" }, "No decisions yet."); })(),
      el("h2", {}, "Answers"),
      resps.length ? el("div", {}, ...resps.map(r => responseItem(r, false))) : el("p", { class: "muted" }, "No written answers yet."));
  }

  function renderDecisions() {
    const blocks = [];
    for (const u of D.units.filter(x => x.kind === "unit")) {
      const cases = decisionSteps(u.id).length ? decisionSteps(u.id).map(x => x.caseNo) : [...new Set(D.decisions.filter(d => d.unit_id === u.id).map(d => d.case_no))];
      for (const c of cases) {
        const rows = D.decisions.filter(d => d.unit_id === u.id && d.case_no === c);
        const n = rows.length;
        const key = u.id + "|" + c;
        const letters = ["A", "B", "C", "D"];
        const pc = (cnt) => n ? Math.round(100 * cnt / n) + "%" : "–";
        const changed = rows.filter(d => d.second_choice && d.second_choice !== d.first_choice);
        const trans = {};
        changed.forEach(d => { const k = d.first_choice + " → " + d.second_choice; trans[k] = (trans[k] || 0) + 1; });
        const top = Object.entries(trans).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => k + " (" + v + ")").join(", ");
        const table = el("div", { class: "scroll" }, el("table", { class: "grid" },
          el("thead", {}, el("tr", {}, el("th", {}, "Option"), el("th", {}, "First choice"), el("th", {}, "Final choice (after debrief)"))),
          el("tbody", {}, ...letters.map(l => el("tr", {},
            el("td", { style: "white-space:normal" }, optLabel(u.id, c, l)),
            el("td", {}, pc(rows.filter(d => d.first_choice === l).length)),
            el("td", {}, pc(rows.filter(d => (d.second_choice || d.first_choice) === l).length)))))));
        const list = openDecision === key ? el("div", { class: "scroll", style: "margin-top:10px" }, el("table", { class: "grid" },
          el("thead", {}, el("tr", {}, el("th", {}, "Ambassador"), el("th", {}, "First choice"), el("th", {}, "After debrief"), el("th", {}, "Changed?"))),
          el("tbody", {}, ...rows.map(d => el("tr", {},
            el("td", {}, sName(d.student_id)), el("td", {}, optLabel(u.id, c, d.first_choice)),
            el("td", {}, d.second_choice ? optLabel(u.id, c, d.second_choice) : "–"),
            el("td", { class: d.second_choice && d.second_choice !== d.first_choice ? "flag" : "" }, d.second_choice ? (d.second_choice !== d.first_choice ? "Yes" : "No, confirmed") : "No second answer")))))) : null;
        blocks.push(el("div", { class: "item" },
          el("div", { class: "meta" }, n + " answers · " + rows.filter(d => d.second_choice).length + " gave a second answer · " + changed.length + " changed their mind" + (top ? " · most common: " + top : "")),
          el("h3", {}, u.id + " " + u.title + (cases.length > 1 ? " · case " + c : "")),
          table,
          n ? el("div", { class: "actions" }, el("button", { class: "btn", onclick: () => { openDecision = openDecision === key ? null : key; render(); } }, openDecision === key ? "Hide individual answers" : "Show individual answers")) : null,
          list));
      }
    }
    show(tabs(), el("p", { class: "muted" }, "First choice is locked when they answer. Final choice is their optional second answer after reading the debrief, or their first choice if they didn't change it."), ...blocks);
  }

  function renderAnswers() {
    const withAnswers = D.units.filter(u => D.responses.some(r => r.unit_id === u.id));
    if (!answersUnit && withAnswers.length) answersUnit = withAnswers[0].id;
    const sel = el("select", { onchange: e => { answersUnit = e.target.value; render(); } },
      ...D.units.map(u => { const n = D.responses.filter(r => r.unit_id === u.id).length;
        return el("option", { value: u.id, selected: u.id === answersUnit }, (u.kind === "unit" ? u.id + " " : "") + u.title + " (" + n + ")"); }));
    const resps = D.responses.filter(r => r.unit_id === answersUnit);
    const groups = {};
    resps.forEach(r => { const k = r.kind + "|" + r.prompt_key; (groups[k] = groups[k] || []).push(r); });
    const decs = D.decisions.filter(d => d.unit_id === answersUnit);
    show(tabs(), el("div", { class: "filters" }, el("label", {}, "Unit "), sel),
      decs.length ? el("p", { class: "small muted" }, decs.length + " decision answers in this unit. See the Decisions tab for the breakdown.") : null,
      ...Object.entries(groups).map(([k, rs]) => el("div", {},
        el("h2", {}, rs[0].kind === "reflection" ? "Reflection" : promptTitle(answersUnit, rs[0].prompt_key)),
        ...rs.map(r => responseItem(r, true)))),
      resps.length ? null : el("p", { class: "muted" }, "No written answers for this unit yet."));
  }

  function accountTools(s) {
    const out = el("div");
    const appUrl = location.origin + location.pathname.replace(/admin\.html$/, "");
    const others = D.students.filter(x => x.id !== s.id);
    const target = el("select", {}, el("option", { value: "" }, "Move this progress to…"),
      ...others.map(x => el("option", { value: x.id }, (x.full_name || x.email) + " · " + x.email)));
    return el("div", { class: "item", style: "margin:12px 0" },
      el("div", { class: "meta" }, "Account tools"),
      el("div", { class: "actions", style: "margin-top:4px" },
        el("button", { class: "btn", onclick: async () => {
          out.replaceChildren();
          const { error } = await sb.auth.signInWithOtp({ email: s.email, options: { emailRedirectTo: appUrl, shouldCreateUser: false } });
          out.append(error ? msg("Couldn't send: " + error.message) : msg("Sign-in link sent to " + s.email + ".", "ok"));
        } }, "Send sign-in link"),
        el("button", { class: "btn", style: "color:var(--warn);border-color:var(--warn)", onclick: async () => {
          if (!confirm("Delete " + (s.full_name || s.email) + " and ALL their progress, answers and feedback? This can't be undone.")) return;
          const { error } = await sb.rpc("admin_delete_student", { p_id: s.id });
          if (error) { out.replaceChildren(msg("Couldn't delete: " + error.message)); return; }
          view = "overview"; detailId = null; await refresh();
        } }, "Delete ambassador")),
      others.length ? el("div", { class: "filters", style: "margin:12px 0 0" }, target,
        el("button", { class: "btn", onclick: async () => {
          if (!target.value) { out.replaceChildren(msg("Choose the account to move the progress to.")); return; }
          const t = D.students.find(x => x.id === target.value);
          if (!confirm("Move all progress and answers from " + s.email + " to " + t.email + ", then delete " + s.email + "?")) return;
          const { error } = await sb.rpc("admin_merge_students", { p_from: s.id, p_to: t.id });
          if (error) { out.replaceChildren(msg("Couldn't merge: " + error.message)); return; }
          detailId = t.id; await refresh();
        } }, "Merge accounts")) : null,
      el("p", { class: "small muted", style: "margin:10px 0 0" }, "Use “Merge accounts” when someone signed in with a different email and lost their progress. Their progress moves to the chosen account and this one is deleted."),
      out);
  }

  function exportExcel() {
    if (!window.XLSX) { alert("The Excel library didn't load. Check your internet connection and try again."); return; }
    const stud = id => D.students.find(s => s.id === id) || {};
    const unitName = id => { const u = D.units.find(x => x.id === id); return u ? (u.kind === "unit" ? u.id + " " : "") + u.title : id; };
    const moduleOf = id => { const u = D.units.find(x => x.id === id); return u ? u.module_id : ""; };
    const order = id => { const u = D.units.find(x => x.id === id); return u ? u.sort_order : 9999; };

    const progress = D.students.map(s => {
      const st = studentStats(s);
      const row = { Name: s.full_name, Email: s.email, Institution: s.institution, Country: s.country, Level: levelLabel(s.study_level), Joined: fmt(s.joined_at) };
      st.perModule.forEach(p => row["Module " + p.id] = p.done + "/" + p.total);
      Object.assign(row, { "Total %": st.pct, "Last active": fmt(s.last_active_at), Badge: s.badge_awarded_at ? fmt(s.badge_awarded_at) : "" });
      return row;
    });

    const decisions = [...D.decisions].sort((a, b) => (stud(a.student_id).full_name || "").localeCompare(stud(b.student_id).full_name || "") || order(a.unit_id) - order(b.unit_id) || a.case_no - b.case_no).map(d => {
      const st = decisionSteps(d.unit_id).find(x => x.caseNo === d.case_no);
      return {
        Name: stud(d.student_id).full_name, Email: stud(d.student_id).email, Module: moduleOf(d.unit_id), Unit: unitName(d.unit_id), Case: d.case_no,
        Question: st ? st.md.replace(/\s+/g, " ").trim() : "",
        "First choice": optLabel(d.unit_id, d.case_no, d.first_choice),
        "After debrief": d.second_choice ? optLabel(d.unit_id, d.case_no, d.second_choice) : "",
        Changed: d.second_choice ? (d.second_choice !== d.first_choice ? "Yes" : "No") : "",
        Answered: fmt(d.created_at)
      };
    });

    const answers = [...D.responses].sort((a, b) => (stud(a.student_id).full_name || "").localeCompare(stud(b.student_id).full_name || "") || order(a.unit_id) - order(b.unit_id)).map(r => {
      const fbs = D.feedback.filter(f => f.response_id === r.id);
      const step = C[r.unit_id] && (r.kind === "reflection" ? C[r.unit_id].steps.find(x => x.type === "reflection") : C[r.unit_id].steps.find(x => x.key === r.prompt_key));
      return {
        Name: stud(r.student_id).full_name, Email: stud(r.student_id).email, Module: moduleOf(r.unit_id), Unit: unitName(r.unit_id),
        Type: { reflection: "Reflection", your_turn: "Your turn", quiz: "Quiz", field_mission: "Field mission" }[r.kind] || r.kind,
        Task: r.kind === "reflection" ? "Reflection" : promptTitle(r.unit_id, r.prompt_key),
        Question: step ? step.md.replace(/\s+/g, " ").trim().slice(0, 32000) : "",
        Answer: answerText(r).slice(0, 32000),
        Feedback: fbs.map(f => f.body).join("\n---\n"),
        "Feedback read": fbs.length ? (fbs.every(f => f.read_at) ? "Yes" : "No") : "",
        Saved: fmt(r.updated_at || r.created_at)
      };
    });

    const wb = XLSX.utils.book_new();
    const add = (rows, name, widths) => {
      const ws = XLSX.utils.json_to_sheet(rows.length ? rows : [{ Info: "No data yet" }]);
      ws["!cols"] = widths.map(w => ({ wch: w }));
      XLSX.utils.book_append_sheet(wb, ws, name);
    };
    add(progress, "Progress", [24, 32, 26, 14, 12, 14, 9, 9, 9, 9, 9, 9, 9, 9, 14, 14]);
    add(decisions, "Decisions", [24, 32, 8, 34, 6, 60, 40, 40, 9, 14]);
    add(answers, "Answers", [24, 32, 8, 34, 13, 34, 60, 70, 50, 13, 14]);
    XLSX.writeFile(wb, "ambassador-training-results-" + new Date().toISOString().slice(0, 10) + ".xlsx");
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
    else if (view === "decisions") renderDecisions();
    else if (view === "answers") renderAnswers();
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
