(function () {
  const CFG = window.APP_CONFIG;
  const sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
  });
  const $app = document.getElementById("app");
  const $who = document.getElementById("who");
  const $lead = document.getElementById("lead");

  const S = {
    user: null, student: null, course: [], units: [], unitById: {},
    progress: {}, responses: {}, decisions: {}, feedback: [], contentErrors: []
  };

  // ---------- helpers ----------
  const md = text => window.marked.parse(text || "");
  function el(tag, attrs = {}, ...children) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === "class") n.className = v;
      else if (k === "html") n.innerHTML = v;
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? "" : v);
    }
    for (const c of children.flat()) if (c != null && c !== false) n.append(c.nodeType ? c : document.createTextNode(String(c)));
    return n;
  }
  const mdBlock = (text, cls = "") => el("div", { class: ("md " + cls).trim(), html: md(text) });
  function show(...nodes) { $app.replaceChildren(...nodes.filter(Boolean)); window.scrollTo({ top: 0 }); }
  function msg(text, type = "err") { return el("div", { class: "msg " + type, role: type === "err" ? "alert" : "status" }, text); }
  function go(hash) { if (location.hash === hash) route(); else location.hash = hash; }
  const respKey = (unitId, kind, key) => unitId + "|" + kind + "|" + key;
  const fmtDate = d => new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });

  // ---------- content ----------
  async function loadContent() {
    S.course = []; S.units = []; S.unitById = {}; S.contentErrors = [];
    const results = await Promise.all(CFG.MODULE_FILES.map(async (path, i) => {
      try {
        const r = await fetch(path, { cache: "no-cache" });
        if (!r.ok) throw new Error(r.status);
        return window.CourseParser.parseModule(await r.text(), i + 1);
      } catch (e) { S.contentErrors.push(path); return null; }
    }));
    for (const m of results.filter(Boolean).sort((a, b) => a.moduleNo - b.moduleNo)) {
      S.course.push(m);
      for (const u of m.units) { S.units.push(u); S.unitById[u.id] = u; }
    }
  }

  // ---------- data ----------
  async function loadState() {
    const uid = S.user.id;
    const [p, r, d, f] = await Promise.all([
      sb.from("progress").select("*").eq("student_id", uid),
      sb.from("responses").select("id, unit_id, kind, prompt_key, answer, updated_at").eq("student_id", uid),
      sb.from("decisions").select("*").eq("student_id", uid),
      sb.from("feedback").select("id, body, created_at, read_at, response_id, responses!inner(unit_id, student_id, kind, prompt_key)").eq("responses.student_id", uid)
    ]);
    S.progress = {}; (p.data || []).forEach(x => S.progress[x.unit_id] = x);
    S.responses = {}; (r.data || []).forEach(x => S.responses[respKey(x.unit_id, x.kind, x.prompt_key)] = x);
    S.decisions = {}; (d.data || []).forEach(x => S.decisions[x.unit_id + "|" + x.case_no] = x);
    S.feedback = f.data || [];
  }

  async function saveProgress(unitId, patch) {
    const row = { student_id: S.user.id, unit_id: unitId, ...patch };
    const { data, error } = await sb.from("progress").upsert(row, { onConflict: "student_id,unit_id" }).select().single();
    if (!error) S.progress[unitId] = data;
    return error;
  }

  async function saveResponse(unitId, kind, key, answer) {
    const row = { student_id: S.user.id, unit_id: unitId, kind, prompt_key: key, answer, updated_at: new Date().toISOString() };
    const { data, error } = await sb.from("responses").upsert(row, { onConflict: "student_id,unit_id,kind,prompt_key" }).select().single();
    if (!error) S.responses[respKey(unitId, kind, key)] = data;
    return error;
  }

  // ---------- auth ----------
  function renderLogin(note) {
    $who.textContent = "";
    $lead.textContent = "Short case files on academic integrity, to take at your own pace.";
    const email = el("input", { type: "email", id: "email", autocomplete: "email", required: true, placeholder: "you@university.eu" });
    const out = el("div");
    const form = el("form", { onsubmit: async e => {
      e.preventDefault();
      const btn = form.querySelector("button"); btn.disabled = true; out.replaceChildren();
      const { error } = await sb.auth.signInWithOtp({ email: email.value.trim(), options: { emailRedirectTo: location.origin + location.pathname } });
      btn.disabled = false;
      if (error) { out.append(msg("We couldn't send the email: " + error.message)); return; }
      renderCode(email.value.trim());
    } },
      el("h2", {}, "Sign in"),
      el("p", {}, "Enter your email address. We'll send you a sign-in link, so there's no password to remember. Your progress is saved, and you can continue any time."),
      el("label", { class: "field", for: "email" }, "Email address"), email,
      el("p", { class: "small muted", style: "margin:8px 0 0" }, "Always use the same email address. Your progress is saved to it, and a different address starts a new, empty account."),
      el("div", { class: "actions" }, el("button", { class: "btn primary", type: "submit" }, "Send sign-in link")),
      out
    );
    show(el("section", { class: "panel" }, form), note ? msg(note, "ok") : null);
  }

  function renderCode(address) {
    const out = el("div");
    const resend = el("button", { class: "btn", type: "button", onclick: async () => {
      resend.disabled = true; out.replaceChildren();
      const { error } = await sb.auth.signInWithOtp({ email: address, options: { emailRedirectTo: location.origin + location.pathname } });
      out.append(error ? msg("We couldn't send the email: " + error.message) : msg("We sent a new link.", "ok"));
      setTimeout(() => { resend.disabled = false; }, 60000);
    } }, "Send the link again");
    show(el("section", { class: "panel" },
      el("h2", {}, "Check your email"),
      el("p", {}, "We sent a sign-in link to ", el("b", {}, address), ". Click the link in the email and you'll come straight back here, signed in."),
      el("p", { class: "small muted" }, "The link works once and expires after an hour. If the email isn't there in a few minutes, check your spam folder."),
      el("div", { class: "actions" }, resend,
        el("button", { class: "btn link", type: "button", onclick: () => renderLogin() }, "Use a different email")),
      out));
  }

  // ---------- onboarding ----------
  function renderOnboarding() {
    const f = id => el("input", { type: "text", id, required: true });
    const name = f("name"), inst = f("inst"), country = f("country");
    const level = el("select", { id: "level", required: true },
      el("option", { value: "" }, "Choose one"),
      el("option", { value: "bachelor" }, "Bachelor's"),
      el("option", { value: "master" }, "Master's"),
      el("option", { value: "phd" }, "PhD"),
      el("option", { value: "other" }, "Other"));
    const consent = el("input", { type: "checkbox", id: "consent", required: true });
    const out = el("div");
    const form = el("form", { onsubmit: async e => {
      e.preventDefault(); out.replaceChildren();
      const { error } = await sb.from("students").insert({
        id: S.user.id, email: S.user.email, full_name: name.value.trim(), institution: inst.value.trim(),
        country: country.value.trim(), study_level: level.value, consent_at: new Date().toISOString()
      });
      if (error) { out.append(msg("We couldn't save your details: " + error.message)); return; }
      await boot();
    } },
      el("h2", {}, "Welcome, new ambassador"),
      el("p", {}, "Tell us a little about yourself. This helps ENAI give you useful feedback."),
      el("label", { class: "field", for: "name" }, "Full name"), name,
      el("label", { class: "field", for: "inst" }, "Institution"), inst,
      el("label", { class: "field", for: "country" }, "Country"), country,
      el("label", { class: "field", for: "level" }, "Level of study"), level,
      el("div", { class: "check" }, consent,
        el("label", { for: "consent" }, "I agree that ENAI stores my details, progress and answers to run this training and give me feedback. My answers to decisions are shown to other ambassadors only as anonymous percentages. I can ask for my data to be deleted at any time by writing to ",
          el("a", { href: "mailto:" + CFG.SUPPORT_EMAIL }, CFG.SUPPORT_EMAIL), ".")),
      el("div", { class: "actions" }, el("button", { class: "btn primary", type: "submit" }, "Start the training")),
      out
    );
    show(el("section", { class: "panel" }, form));
  }

  // ---------- home ----------
  function unitState(id) { const p = S.progress[id]; return p ? p.status : "not_started"; }
  function nextUnit() { return S.units.find(u => unitState(u.id) !== "completed"); }

  function renderHome() {
    const done = S.units.filter(u => unitState(u.id) === "completed").length;
    const pct = S.units.length ? Math.round(100 * done / S.units.length) : 0;
    const next = nextUnit();
    const unread = S.feedback.filter(f => !f.read_at);
    const nodes = [];

    if (S.contentErrors.length) nodes.push(msg("Some modules couldn't be loaded (" + S.contentErrors.join(", ") + "). Please let ENAI know."));

    nodes.push(el("section", { class: "panel" },
      el("div", { class: "overall" },
        el("div", { class: "num" }, pct + "%"),
        el("div", { style: "flex:1" },
          el("div", { class: "small muted" }, done + " of " + S.units.length + " units completed"),
          el("div", { class: "bar", role: "progressbar", "aria-valuenow": pct, "aria-valuemin": 0, "aria-valuemax": 100 }, el("span", { style: "width:" + pct + "%" })))),
      el("div", { class: "actions" },
        next ? el("button", { class: "btn primary", onclick: () => go("#/unit/" + next.id) },
          unitState(next.id) === "in_progress" ? "Continue " + next.id + " " + next.title : (done ? "Start " : "Begin with ") + next.id + " " + next.title) : null,
        done || Object.keys(S.responses).length ? el("button", { class: "btn", onclick: () => go("#/summary") }, "My summary") : null,
        el("button", { class: "btn", onclick: () => go("#/kit") }, "My answer kit"),
        S.student.badge_awarded_at ? el("button", { class: "btn", onclick: () => go("#/badge") }, "View your badge") : null)
    ));

    if (unread.length) {
      nodes.push(el("section", { class: "panel" },
        el("h3", {}, unread.length === 1 ? "You have new feedback" : "You have " + unread.length + " new pieces of feedback"),
        el("p", {}, "An ENAI representative replied to one of your answers. Open it to read the feedback."),
        el("div", { class: "actions" }, ...unread.filter((f, i, a) => a.findIndex(x => x.response_id === f.response_id) === i).map(f => {
          const uid = f.responses.unit_id, u = S.unitById[uid];
          const idx = u ? Math.max(0, u.steps.findIndex(st => st.key === f.responses.prompt_key)) : 0;
          return el("button", { class: "btn", onclick: () => go("#/unit/" + uid + "/" + idx) }, u ? (u.kind === "unit" ? u.id + " " : "") + u.title : uid);
        }))));
    }

    for (const m of S.course) {
      const mUnits = m.units;
      const mDone = mUnits.filter(u => unitState(u.id) === "completed").length;
      nodes.push(el("section", { class: "module" },
        el("h2", {}, "Module " + m.moduleNo + ": " + m.moduleTitle),
        el("div", { class: "meta" }, mDone + " of " + mUnits.length + " done"),
        ...mUnits.map(u => {
          const st = unitState(u.id);
          const label = st === "completed" ? "Done" : st === "in_progress" ? "In progress" : "Not started";
          return el("button", { class: "unit-row " + st + (u.kind === "reflection" ? " reflection" : ""), onclick: () => go("#/unit/" + u.id) },
            el("span", { class: "dot", "aria-hidden": "true" }),
            el("span", { class: "id" }, u.kind === "reflection" ? "✎" : u.id),
            el("span", { class: "t" }, u.title),
            el("span", { class: "state" }, label));
        })));
    }
    $lead.textContent = done === 0 ? "Short case files on academic integrity, to take at your own pace." : "Welcome back. Pick up where you left off, or choose any unit.";
    show(...nodes);
  }

  // ---------- unit ----------
  async function renderUnit(id, stepIdx) {
    const u = S.unitById[id];
    if (!u) { go("#/"); return; }
    const prog = S.progress[id];
    if (!prog) await saveProgress(id, { status: "in_progress", current_step: "0" });
    if (stepIdx == null) {
      stepIdx = prog && prog.status !== "completed" ? Math.min(Number(prog.current_step || 0), u.steps.length - 1) : 0;
    }
    stepIdx = Math.max(0, Math.min(stepIdx, u.steps.length - 1));
    const step = u.steps[stepIdx];
    const isLast = stepIdx === u.steps.length - 1;
    if (prog && prog.status !== "completed" && Number(prog.current_step || 0) < stepIdx) saveProgress(id, { current_step: String(stepIdx) });

    const head = el("div", { class: "unit-head" },
      el("p", { class: "kicker" }, el("button", { class: "btn link", onclick: () => go("#/") }, "All modules"), " · Module " + u.moduleNo),
      el("h2", {}, (u.kind === "unit" ? u.id + " " : "") + u.title),
      u.intro && stepIdx === 0 ? el("p", { class: "intro" }, u.intro) : null,
      u.steps.length > 1 ? el("div", { class: "steps", role: "navigation", "aria-label": "Step " + (stepIdx + 1) + " of " + u.steps.length },
        ...u.steps.map((st, i) => {
          const reached = unitState(id) === "completed" || i <= Math.max(stepIdx, Number((S.progress[id] || {}).current_step || 0));
          return el("button", { class: (i < stepIdx ? "done" : i === stepIdx ? "now" : "") + (reached ? " reach" : ""), disabled: !reached,
            title: "Step " + (i + 1) + ": " + st.title, "aria-label": "Step " + (i + 1) + ": " + st.title,
            onclick: () => go("#/unit/" + id + "/" + i) });
        })) : null);

    const card = el("section", { class: "panel" });
    const nav = el("div", { class: "actions" });
    const back = stepIdx > 0 ? el("button", { class: "btn", onclick: () => go("#/unit/" + id + "/" + (stepIdx - 1)) }, "Back") : null;
    const nextBtn = el("button", { class: "btn primary", onclick: async () => {
      if (isLast) await completeUnit(u);
      else go("#/unit/" + id + "/" + (stepIdx + 1));
    } }, isLast ? (unitState(id) === "completed" ? "Back to modules" : "Complete unit") : "Next");
    nav.append(back || "", el("span", { class: "spacer" }), nextBtn);

    if (step.type === "decision") renderDecision(u, step, card, nextBtn);
    else if (step.type === "task") renderTask(u, step, card, nextBtn);
    else if (step.type === "reflection") renderReflection(u, step, card, nextBtn);
    else if (step.type === "compare") renderCompare(u, step, card);
    else if (step.type === "takeaway") card.append(el("h3", {}, "Takeaway"), mdBlock(step.md, "takeaway"));
    else card.append(el("h3", {}, step.title), mdBlock(step.md));

    card.append(nav);
    show(head, card);
  }

  async function completeUnit(u) {
    if (unitState(u.id) !== "completed") {
      await saveProgress(u.id, { status: "completed", completed_at: new Date().toISOString(), current_step: String(u.steps.length - 1) });
      const { data } = await sb.rpc("check_badge");
      if (data && !S.student.badge_awarded_at) { S.student.badge_awarded_at = data; go("#/badge"); return; }
    }
    go("#/");
  }

  function renderDecision(u, step, card, nextBtn) {
    const key = u.id + "|" + step.caseNo;
    const existing = S.decisions[key];
    card.append(el("h3", {}, "Your decision"), mdBlock(step.md));
    const opts = el("div", { class: "options", role: "group", "aria-label": "Options" });
    const after = el("div");
    card.append(opts, after);

    function drawOptions(chosen) {
      opts.replaceChildren(...step.options.map(o => el("button", {
        class: "option" + (chosen === o.letter ? " chosen" : ""), disabled: !!chosen,
        "aria-pressed": chosen === o.letter ? "true" : "false",
        onclick: () => choose(o.letter)
      }, el("span", { class: "l" }, o.letter), el("span", {}, o.label))));
    }

    async function choose(letter) {
      opts.querySelectorAll("button").forEach(b => b.disabled = true);
      const row = { student_id: S.user.id, unit_id: u.id, case_no: step.caseNo, first_choice: letter };
      const { data, error } = await sb.from("decisions").insert(row).select().single();
      if (error) { after.replaceChildren(msg("Your choice couldn't be saved: " + error.message)); drawOptions(null); return; }
      S.decisions[key] = data;
      drawOptions(letter);
      await drawAfter(data);
    }

    async function drawAfter(dec) {
      nextBtn.disabled = false;
      const { data: stats } = await sb.rpc("decision_stats", { p_unit_id: u.id, p_case_no: step.caseNo });
      const byLetter = {}; (stats || []).forEach(s => byLetter[s.choice] = s);
      const total = (stats || []).reduce((a, s) => a + Number(s.votes), 0);
      const peer = el("div", { class: "peer" },
        el("p", { class: "small muted" }, total > 1 ? "How ambassadors chose (" + total + " answers so far):" : "You're one of the first to answer. The peer view fills in as others take this unit."),
        ...step.options.map(o => {
          const pc = byLetter[o.letter] ? Number(byLetter[o.letter].percent) : 0;
          return el("div", { class: "r" + (o.letter === dec.first_choice ? " mine" : "") },
            el("b", {}, o.letter), el("div", { class: "bar" }, el("span", { style: "width:" + pc + "%" })), el("span", {}, pc + "%"));
        }));

      const deb = mdBlock(step.debrief, "debrief");
      deb.querySelectorAll("li").forEach(li => { if (li.textContent.trim().startsWith(dec.first_choice + ".")) li.classList.add("mine"); });

      const second = el("div", { class: "second" },
        el("p", { class: "small" }, el("b", {}, "Would you change your answer now?"), " Optional. Your first choice stays saved."),
        el("div", { class: "row" }, ...step.options.map(o => el("button", {
          class: "btn" + (dec.second_choice === o.letter ? " primary" : ""),
          onclick: async ev => {
            const { data, error } = await sb.from("decisions").update({ second_choice: o.letter })
              .eq("student_id", S.user.id).eq("unit_id", u.id).eq("case_no", step.caseNo).select().single();
            if (!error) { S.decisions[key] = data; second.querySelectorAll(".row .btn").forEach(b => b.classList.remove("primary")); ev.target.classList.add("primary"); }
          } }, o.letter))));
      after.replaceChildren(peer, el("h3", {}, "Debrief"), deb, second);
    }

    if (existing) { drawOptions(existing.first_choice); drawAfter(existing); }
    else { drawOptions(null); nextBtn.disabled = true; }
  }

  function renderTask(u, step, card, nextBtn) {
    const prev = S.responses[respKey(u.id, step.kind, step.key)];
    const ta = el("textarea", { id: "answer", "aria-label": "Your answer" });
    ta.value = prev ? prev.answer.text || "" : "";
    const out = el("div");
    const reveal = step.reveal ? mdBlock(step.reveal, "reveal") : null;
    if (reveal && !prev) reveal.classList.add("hidden");
    let files = prev && prev.answer.files ? prev.answer.files.slice() : [];
    const saveBtn = el("button", { class: "btn", onclick: async () => {
      if (!ta.value.trim() && !files.length) { out.replaceChildren(msg("Write your answer first.")); return; }
      const err = await saveResponse(u.id, step.kind, step.key, step.kind === "field_mission" ? { text: ta.value.trim(), files } : { text: ta.value.trim() });
      out.replaceChildren(err ? msg("Your answer couldn't be saved: " + err.message) : msg("Saved.", "ok"));
      if (!err) { nextBtn.disabled = false; if (reveal) reveal.classList.remove("hidden"); }
    } }, step.reveal && !prev ? "Save and show answers" : "Save answer");
    card.append(el("h3", {}, step.title), mdBlock(step.md));

    if (step.kind === "field_mission") card.append(el("p", { class: "small muted" }, "You can save what you have now and come back to add more later."));
    if (step.hasExample) card.append(el("p", { class: "small muted" }, "After you save, the next page shows an example to compare with."));
    let uploader = null;
    if (step.kind === "field_mission") {
      const list = el("ul", { class: "files" });
      const drawFiles = () => list.replaceChildren(...files.map((f, i) => el("li", {}, fileLink(f), " ",
        el("button", { class: "btn link small", onclick: async () => {
          await sb.storage.from("field-missions").remove([f.path]);
          files.splice(i, 1); drawFiles();
          await saveResponse(u.id, step.kind, step.key, { text: ta.value.trim(), files });
        } }, "Remove"))));
      const input = el("input", { type: "file", accept: "image/png,image/jpeg,image/webp,image/gif,application/pdf", id: "fm-file" });
      input.addEventListener("change", async () => {
        const f = input.files[0]; if (!f) return;
        if (f.size > 5 * 1024 * 1024) { out.replaceChildren(msg("The file is too large. The limit is 5 MB.")); input.value = ""; return; }
        out.replaceChildren(msg("Uploading…", "ok"));
        const safe = f.name.replace(/[^A-Za-z0-9._-]+/g, "_").slice(-80);
        const path = S.user.id + "/" + u.id + "-" + step.key + "-" + Date.now() + "-" + safe;
        const { error } = await sb.storage.from("field-missions").upload(path, f, { contentType: f.type });
        input.value = "";
        if (error) { out.replaceChildren(msg("Upload failed: " + error.message)); return; }
        files.push({ path, name: f.name });
        drawFiles();
        const err = await saveResponse(u.id, step.kind, step.key, { text: ta.value.trim(), files });
        out.replaceChildren(err ? msg("Uploaded, but couldn't save: " + err.message) : msg("File uploaded and saved.", "ok"));
        if (!err) nextBtn.disabled = false;
      });
      drawFiles();
      uploader = el("div", { class: "upload" },
        el("label", { class: "field", for: "fm-file" }, "Add a screenshot or PDF (optional, max 5 MB)"),
        el("p", { class: "small muted", style: "margin:0 0 6px" }, "Remove names and personal details before uploading. Only you and ENAI can see your files."),
        input, list);
    }
    card.append(ta, uploader, el("div", { class: "actions" }, saveBtn), out);
    if (reveal) card.append(reveal);
    appendFeedback(card, prev);
    if (!prev && step.kind !== "field_mission") nextBtn.disabled = true;
  }

  function renderCompare(u, step, card) {
    const prev = S.responses[respKey(u.id, step.kind, step.key)];
    card.append(el("h3", {}, "Compare with an example"),
      el("p", { class: "small muted" }, "Your answer"),
      el("div", { class: "md" }, el("blockquote", {}, el("p", { style: "white-space:pre-wrap" }, prev ? prev.answer.text : "You haven't saved an answer yet."))),
      el("p", { class: "small muted", style: "margin-top:16px" }, "One possible answer"),
      mdBlock(step.md),
      el("p", { class: "small muted" }, "There's no single right version. What's similar, and what would you keep from yours?"));
  }

  function renderReflection(u, step, card, nextBtn) {
    const prev = S.responses[respKey(u.id, "reflection", "main")];
    const ta = el("textarea", { id: "answer", "aria-label": "Your reflection", style: "min-height:200px" });
    ta.value = prev ? prev.answer.text || "" : "";
    const out = el("div");
    card.append(el("h3", {}, "Your reflection"), mdBlock(step.md), ta,
      el("div", { class: "actions" }, el("button", { class: "btn", onclick: async () => {
        if (!ta.value.trim()) { out.replaceChildren(msg("Write your reflection first.")); return; }
        const err = await saveResponse(u.id, "reflection", "main", { text: ta.value.trim() });
        out.replaceChildren(err ? msg("Your reflection couldn't be saved: " + err.message) : msg("Saved. An ENAI representative will reply with feedback.", "ok"));
        if (!err) nextBtn.disabled = false;
      } }, prev ? "Update reflection" : "Send reflection")), out);
    if (!prev) nextBtn.disabled = true;

    appendFeedback(card, prev);
  }

  function appendFeedback(card, resp) {
    if (!resp) return;
    for (const f of S.feedback.filter(x => x.response_id === resp.id)) {
      card.append(el("div", { class: "feedback" }, el("div", { class: "who" }, "Feedback from ENAI · " + fmtDate(f.created_at)), mdBlock(f.body)));
      if (!f.read_at) sb.from("feedback").update({ read_at: new Date().toISOString() }).eq("id", f.id).then(() => { f.read_at = new Date().toISOString(); });
    }
  }

  function fileLink(f) {
    const a = el("a", { href: "#", class: "file-link" }, "📎 " + f.name);
    a.addEventListener("click", async ev => {
      ev.preventDefault();
      const win = window.open("", "_blank");
      const { data, error } = await sb.storage.from("field-missions").createSignedUrl(f.path, 600);
      if (error) { if (win) win.close(); alert("Couldn't open the file: " + error.message); return; }
      if (win) win.location = data.signedUrl; else location.href = data.signedUrl;
    });
    return a;
  }

  // ---------- answer kit ----------
  const KIT_LABELS = {
    "1.4": "Your institution: policy, AI rules and student support",
    "3.3": "Reusing your own work",
    "3.4": "Writing and referencing support",
    "6.2": "Wellbeing and emergency support",
    "7.3": "How integrity cases work, plus national guidance"
  };
  function linkify(text) {
    const frag = document.createDocumentFragment();
    const re = /(https?:\/\/[^\s)]+|www\.[^\s)]+|[\w.+-]+@[\w-]+\.[\w.-]+)/g;
    let last = 0, m;
    while ((m = re.exec(text))) {
      if (m.index > last) frag.append(text.slice(last, m.index));
      const t = m[0];
      const href = t.includes("@") && !t.startsWith("http") ? "mailto:" + t : (t.startsWith("http") ? t : "https://" + t);
      frag.append(el("a", { href, target: "_blank", rel: "noopener" }, t));
      last = m.index + t.length;
    }
    if (last < text.length) frag.append(text.slice(last));
    return frag;
  }
  function kitSteps() {
    const out = [];
    for (const u of S.units) u.steps.forEach((st, i) => {
      if (st.type === "task" && (/answer kit/i.test(st.title + " " + st.md) || u.id === "3.4")) out.push({ u, st, i });
    });
    return out;
  }
  function renderKit() {
    const items = kitSteps();
    const filled = items.filter(x => S.responses[respKey(x.u.id, x.st.kind, x.st.key)]).length;
    const nodes = [el("div", { class: "unit-head" },
      el("p", { class: "kicker" }, el("button", { class: "btn link", onclick: () => go("#/") }, "All modules")),
      el("h2", {}, "My answer kit"),
      el("p", { class: "intro" }, "Everything you've collected during the training, in one place. Keep it open when a student asks you something: most questions can be answered by pointing to the right page or person."),
      el("p", { class: "small muted" }, filled + " of " + items.length + " sections filled in"))];
    for (const { u, st, i } of items) {
      const r = S.responses[respKey(u.id, st.kind, st.key)];
      nodes.push(el("section", { class: "panel" },
        el("h3", {}, KIT_LABELS[u.id] || st.title),
        el("p", { class: "small muted", style: "margin-top:-4px" }, "From " + u.id + " " + u.title),
        r && r.answer.text ? el("div", { class: "kit-text" }, linkify(r.answer.text)) : el("p", { class: "muted" }, "Not filled in yet."),
        r && r.answer.files && r.answer.files.length ? el("p", { class: "small" }, ...r.answer.files.flatMap(f => [fileLink(f), " "])) : null,
        el("div", { class: "actions" }, el("button", { class: "btn" + (r ? "" : " primary"), onclick: () => go("#/unit/" + u.id + "/" + i) }, r ? "Edit" : "Fill in now"))));
    }
    nodes.push(el("section", { class: "panel" },
      el("h3", {}, "International documents"),
      el("ul", {},
        el("li", {}, el("a", { href: "https://allea.org/code-of-conduct/", target: "_blank", rel: "noopener" }, "The European Code of Conduct for Research Integrity"), " (ALLEA)"),
        el("li", {}, el("a", { href: "https://www.academicintegrity.eu/wp/dubai-accord-on-academic-integrity-in-the-age-of-artificial-intelligence/", target: "_blank", rel: "noopener" }, "The Dubai Accord on Academic Integrity in the Age of AI")),
        el("li", {}, el("a", { href: "https://www.academicintegrity.eu", target: "_blank", rel: "noopener" }, "ENAI resources and materials")))),
      el("section", { class: "panel" },
        el("h3", {}, "Need backup?"),
        el("p", {}, "You don't have to know everything. Contact ENAI at ", el("a", { href: "mailto:" + CFG.SUPPORT_EMAIL }, CFG.SUPPORT_EMAIL), ".")));
    show(...nodes);
  }

  // ---------- summary ----------
  function debriefFor(step, letter) {
    const line = (step.debrief || "").split("\n").find(l => new RegExp("^[-*]\\s+\\*\\*" + letter + "\\.").test(l.trim()));
    return line ? line.trim().replace(/^[-*]\s+/, "") : "";
  }

  function renderSummary() {
    const nodes = [el("div", { class: "unit-head" },
      el("p", { class: "kicker" }, el("button", { class: "btn link", onclick: () => go("#/") }, "All modules")),
      el("h2", {}, "My summary"),
      el("p", { class: "intro" }, "Everything you've worked on: each case and question, the choices you made and the answers you wrote. Use the links to jump back to any step."))];
    let any = false;
    for (const m of S.course) {
      const cards = [];
      for (const u of m.units) {
        const items = [];
        u.steps.forEach((st, i) => {
          const jump = el("div", { class: "actions", style: "margin-top:8px" }, el("button", { class: "btn small", onclick: () => go("#/unit/" + u.id + "/" + i) }, "Open this step"));
          if (st.type === "decision") {
            const d = S.decisions[u.id + "|" + st.caseNo];
            if (!d) return;
            let caseStep = null;
            for (let j = i - 1; j >= 0; j--) { if (/^case file/i.test(u.steps[j].title)) { caseStep = u.steps[j]; break; } if (u.steps[j].type === "decision") break; }
            const changed = d.second_choice && d.second_choice !== d.first_choice;
            items.push(el("div", { class: "sum-item" },
              caseStep ? el("div", {}, el("div", { class: "sum-label" }, caseStep.title), mdBlock(caseStep.md)) : null,
              el("div", { class: "sum-label" }, "The question"), mdBlock(st.md),
              el("ul", { class: "sum-options" }, ...st.options.map(o => {
                const tags = [];
                if (o.letter === d.first_choice) tags.push(changed ? "your first choice" : "your choice");
                if (changed && o.letter === d.second_choice) tags.push("your answer after the debrief");
                return el("li", { class: tags.length ? "mine" : "" }, el("b", {}, o.letter + ". "), o.label, tags.length ? el("span", { class: "tag" }, tags.join(" · ")) : null);
              })),
              el("div", { class: "sum-label" }, "Debrief for your choice"),
              mdBlock(debriefFor(st, d.first_choice)),
              changed ? mdBlock(debriefFor(st, d.second_choice)) : null,
              jump));
          } else if (st.type === "task" || st.type === "reflection") {
            const r = S.responses[respKey(u.id, st.type === "reflection" ? "reflection" : st.kind, st.type === "reflection" ? "main" : st.key)];
            if (!r) return;
            const cmp = st.type === "task" ? u.steps.find(x => x.type === "compare" && x.key === st.key) : null;
            const fbs = S.feedback.filter(f => f.response_id === r.id);
            items.push(el("div", { class: "sum-item" },
              el("div", { class: "sum-label" }, st.type === "reflection" ? "Reflection question" : st.title), mdBlock(st.md),
              el("div", { class: "sum-label" }, "Your answer"),
              el("div", { class: "md" }, el("blockquote", {}, el("p", { style: "white-space:pre-wrap" }, r.answer.text || ""))),
              r.answer.files && r.answer.files.length ? el("p", { class: "small" }, ...r.answer.files.flatMap(f => [fileLink(f), " "])) : null,
              st.reveal ? el("div", {}, el("div", { class: "sum-label" }, "Suggested answer"), mdBlock(st.reveal)) : null,
              cmp ? el("div", {}, el("div", { class: "sum-label" }, "Example to compare"), mdBlock(cmp.md)) : null,
              ...fbs.map(f => el("div", { class: "feedback" }, el("div", { class: "who" }, "Feedback from ENAI · " + fmtDate(f.created_at)), mdBlock(f.body))),
              jump));
          }
        });
        const stt = unitState(u.id);
        if (!items.length && stt === "not_started") continue;
        const takeaway = u.steps.find(x => x.type === "takeaway");
        cards.push(el("section", { class: "panel" },
          el("h3", {}, (u.kind === "unit" ? u.id + " " : "") + u.title),
          el("p", { class: "small muted", style: "margin-top:-4px" }, stt === "completed" ? "Completed" : "In progress"),
          ...items,
          takeaway && stt === "completed" ? el("div", { class: "sum-item" }, el("div", { class: "sum-label" }, "Takeaway"), mdBlock(takeaway.md, "takeaway")) : null,
          el("div", { class: "actions" }, el("button", { class: "btn", onclick: () => go("#/unit/" + u.id + "/0") }, "Open unit"))));
      }
      if (cards.length) { any = true; nodes.push(el("h2", {}, "Module " + m.moduleNo + ": " + m.moduleTitle), ...cards); }
    }
    if (!any) nodes.push(el("p", { class: "muted" }, "Nothing here yet. Start a unit and your choices and answers will appear here."));
    show(...nodes);
  }

  // ---------- badge ----------
  function badgeSvg(name, date) {
    const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" role="img" aria-label="ENAI Ambassador badge for ${esc(name)}">
  <circle cx="200" cy="200" r="190" fill="#FFFCF6" stroke="#3D7D83" stroke-width="10"/>
  <circle cx="200" cy="200" r="168" fill="none" stroke="#A0C8C4" stroke-width="3"/>
  <path d="M110 120 C 150 95, 250 140, 290 110" fill="none" stroke="#54A4AC" stroke-width="6" stroke-linecap="round"/>
  <text x="200" y="88" text-anchor="middle" font-family="Inter, Arial, sans-serif" font-size="18" font-weight="600" fill="#3D7D83">ENAI</text>
  <text x="200" y="175" text-anchor="middle" font-family="Zilla Slab, Georgia, serif" font-size="34" font-weight="700" fill="#464847">Student</text>
  <text x="200" y="213" text-anchor="middle" font-family="Zilla Slab, Georgia, serif" font-size="34" font-weight="700" fill="#464847">Ambassador</text>
  <text x="200" y="246" text-anchor="middle" font-family="Inter, Arial, sans-serif" font-size="15" fill="#7E817F">Core training completed</text>
  <text x="200" y="296" text-anchor="middle" font-family="Inter, Arial, sans-serif" font-size="19" font-weight="600" fill="#3D7D83">${esc(name)}</text>
  <text x="200" y="322" text-anchor="middle" font-family="Inter, Arial, sans-serif" font-size="14" fill="#7E817F">${esc(date)}</text>
</svg>`;
  }

  function renderBadge() {
    if (!S.student.badge_awarded_at) { go("#/"); return; }
    const svg = badgeSvg(S.student.full_name || S.user.email, fmtDate(S.student.badge_awarded_at));
    const dl = () => {
      const a = el("a", { href: URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" })), download: "ENAI-Ambassador-badge.svg" });
      document.body.append(a); a.click(); a.remove();
    };
    show(el("section", { class: "panel badge-wrap" },
      el("h2", {}, "You've finished the core training"),
      el("div", { html: svg }),
      el("p", {}, "Congratulations, and thank you. Your answer kit is ready for the year ahead. You don't have to know everything, and you're never alone in this role."),
      el("div", { class: "actions", style: "justify-content:center" },
        el("button", { class: "btn primary", onclick: dl }, "Download badge"),
        el("button", { class: "btn", onclick: () => go("#/") }, "Back to modules"))));
  }

  // ---------- routing ----------
  async function route() {
    if (!S.user) return renderLogin();
    if (!S.student) return renderOnboarding();
    const parts = location.hash.replace(/^#\/?/, "").split("/");
    if (parts[0] === "unit" && parts[1]) return renderUnit(decodeURIComponent(parts[1]), parts[2] != null ? Number(parts[2]) : null);
    if (parts[0] === "badge") return renderBadge();
    if (parts[0] === "summary") return renderSummary();
    if (parts[0] === "kit") return renderKit();
    renderHome();
  }

  function renderWho() {
    $who.replaceChildren(
      el("div", {}, S.student && S.student.full_name ? S.student.full_name : S.user.email),
      el("button", { class: "btn link small", onclick: async () => { await sb.auth.signOut(); } }, "Sign out"));
  }

  async function boot() {
    const { data: { session } } = await sb.auth.getSession();
    S.user = session ? session.user : null;
    if (!S.user) { S.student = null; return route(); }
    const { data: st } = await sb.from("students").select("*").eq("id", S.user.id).maybeSingle();
    S.student = st || null;
    renderWho();
    if (S.student) await loadState();
    route();
  }

  window.addEventListener("hashchange", route);
  sb.auth.onAuthStateChange((event) => {
    if (event === "SIGNED_IN" || event === "SIGNED_OUT") boot();
  });

  (async () => {
    show(el("p", { class: "muted" }, "Loading…"));
    await loadContent();
    await boot();
  })();
})();
