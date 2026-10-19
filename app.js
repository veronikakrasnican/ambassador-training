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
  const PRIVACY_URL = "https://www.academicintegrity.eu/wp/privacy-policy/";
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

  // Unsaved drafts are kept in this browser, so text survives a reload or a closed tab.
  const draftKey = (unitId, key) => "draft|" + S.user.id + "|" + unitId + "|" + key;
  function getDraft(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function setDraft(k, v) { try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); } catch (e) {} }
  function bindDraft(ta, k, savedText) {
    const d = getDraft(k);
    let note = null;
    if (d != null && d !== savedText) {
      ta.value = d;
      note = el("p", { class: "small muted draft-note" }, "We restored text you hadn't saved yet. Save it to keep it.");
    }
    ta.addEventListener("input", () => setDraft(k, ta.value === savedText ? "" : ta.value));
    return note;
  }

  // An answer must contain at least one letter or number ("-" or "." doesn't count).
  const hasContent = t => /[\p{L}\p{N}]/u.test(t || "");
  const MIN_LONG = 20; // minimum characters for field missions and reflections
  const longEnough = t => hasContent(t) && t.replace(/\s+/g, " ").trim().length >= MIN_LONG;

  // Which steps must be answered: decisions, tasks and reflections.
  function isAnswered(u, st) {
    if (st.type === "decision") return !!S.decisions[u.id + "|" + st.caseNo];
    if (st.type === "task") return !!S.responses[respKey(u.id, st.kind, st.key)];
    if (st.type === "reflection") return !!S.responses[respKey(u.id, "reflection", "main")];
    return true;
  }
  // The furthest step a student can open: the first unanswered step (field missions don't block moving on,
  // because they can take weeks, but they do block completing the unit).
  function gateIdx(u) {
    const i = u.steps.findIndex(st => st.kind !== "field_mission" && !isAnswered(u, st));
    return i === -1 ? u.steps.length - 1 : i;
  }

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
      el("p", { class: "small muted", style: "margin:6px 0 0" }, "We use your email address only to sign you in and to send you messages about this training. Read our ",
        el("a", { href: PRIVACY_URL, target: "_blank", rel: "noopener" }, "privacy policy"), "."),
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
  function detailFields(cur = {}) {
    const f = (id, v) => { const i = el("input", { type: "text", id, required: true, maxlength: 120 }); i.value = v || ""; return i; };
    const name = f("name", cur.full_name), inst = f("inst", cur.institution), country = f("country", cur.country);
    const level = el("select", { id: "level", required: true },
      el("option", { value: "" }, "Choose one"),
      el("option", { value: "bachelor" }, "Bachelor's"),
      el("option", { value: "master" }, "Master's"),
      el("option", { value: "phd" }, "PhD"),
      el("option", { value: "other" }, "Other"));
    level.value = cur.study_level || "";
    const nodes = [
      el("label", { class: "field", for: "name" }, "Full name"), name,
      el("p", { class: "small muted", style: "margin:4px 0 0" }, "As you'd like it to appear on your badge."),
      el("label", { class: "field", for: "inst" }, "Institution"), inst,
      el("p", { class: "small muted", style: "margin:4px 0 0" }, "Your university or college, written out in full. It also appears on your badge."),
      el("label", { class: "field", for: "country" }, "Country"), country,
      el("label", { class: "field", for: "level" }, "Level of study"), level];
    const values = () => ({ full_name: name.value.trim(), institution: inst.value.trim(), country: country.value.trim(), study_level: level.value });
    return { nodes, values };
  }

  function renderProfile() {
    const d = detailFields(S.student);
    const out = el("div");
    const form = el("form", { onsubmit: async e => {
      e.preventDefault(); out.replaceChildren();
      const v = d.values();
      const { data, error } = await sb.from("students").update(v).eq("id", S.user.id).select().single();
      if (error) { out.append(msg("We couldn't save your details: " + error.message)); return; }
      S.student = data; renderWho();
      out.append(msg("Saved. Your badge now shows the new details.", "ok"));
    } },
      el("h2", {}, "My details"),
      ...d.nodes,
      el("label", { class: "field" }, "Email address"),
      el("p", { style: "margin:4px 0 0" }, S.user.email),
      el("p", { class: "small muted", style: "margin:4px 0 0" }, "Your progress is linked to this address, so it can't be changed here. If you need to change it, write to ",
        el("a", { href: "mailto:" + CFG.SUPPORT_EMAIL }, CFG.SUPPORT_EMAIL), "."),
      el("div", { class: "actions" }, el("button", { class: "btn primary", type: "submit" }, "Save changes"),
        el("button", { class: "btn", type: "button", onclick: () => go("#/") }, "Back to modules")),
      out);
    show(el("div", { class: "unit-head" }, el("p", { class: "kicker" }, el("button", { class: "btn link", onclick: () => go("#/") }, "All modules"))),
      el("section", { class: "panel" }, form));
  }

  function renderOnboarding() {
    const d = detailFields();
    const consent = el("input", { type: "checkbox", id: "consent", required: true });
    const out = el("div");
    const form = el("form", { onsubmit: async e => {
      e.preventDefault(); out.replaceChildren();
      const { error } = await sb.from("students").insert({
        id: S.user.id, email: S.user.email, ...d.values(), consent_at: new Date().toISOString()
      });
      if (error) { out.append(msg("We couldn't save your details: " + error.message)); return; }
      await boot();
    } },
      el("h2", {}, "Welcome, new ambassador"),
      el("p", {}, "Tell us a little about yourself. This helps ENAI give you useful feedback."),
      ...d.nodes,
      el("div", { class: "check" }, consent,
        el("label", { for: "consent" }, "I agree that ENAI stores my details, progress and answers to run this training and give me feedback. My answers to decisions are shown to other ambassadors only as anonymous percentages. I can ask for my data to be deleted at any time by writing to ",
          el("a", { href: "mailto:" + CFG.SUPPORT_EMAIL }, CFG.SUPPORT_EMAIL), ". I have read the ",
          el("a", { href: PRIVACY_URL, target: "_blank", rel: "noopener" }, "ENAI privacy policy"), ".")),
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
          el("div", { class: "small muted" }, (() => {
            const of = kind => { const all = S.units.filter(u => u.kind === kind); return all.filter(u => unitState(u.id) === "completed").length + " of " + all.length; };
            return of("unit") + " units and " + of("reflection") + " reflections completed";
          })()),
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
    const completed = unitState(id) === "completed";
    const gate = completed ? u.steps.length - 1 : gateIdx(u);
    if (stepIdx > gate) {
      if (location.hash !== "#/unit/" + id + "/" + gate) { history.replaceState(null, "", "#/unit/" + id + "/" + gate); }
      stepIdx = gate;
    }
    const flash = S.flash; S.flash = null;
    const step = u.steps[stepIdx];
    const isLast = stepIdx === u.steps.length - 1;
    if (prog && prog.status !== "completed" && Number(prog.current_step || 0) < stepIdx) saveProgress(id, { current_step: String(stepIdx) });

    const head = el("div", { class: "unit-head" },
      el("p", { class: "kicker" }, el("button", { class: "btn link", onclick: () => go("#/") }, "All modules"), " · Module " + u.moduleNo),
      el("h2", {}, (u.kind === "unit" ? u.id + " " : "") + u.title),
      u.intro && stepIdx === 0 ? el("p", { class: "intro" }, u.intro) : null,
      u.steps.length > 1 ? el("div", { class: "steps", role: "navigation", "aria-label": "Step " + (stepIdx + 1) + " of " + u.steps.length },
        ...u.steps.map((st, i) => {
          const reached = completed || (i <= gate && i <= Math.max(stepIdx, Number((S.progress[id] || {}).current_step || 0)));
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
    show(head, flash ? msg(flash) : null, card);
  }

  async function completeUnit(u) {
    if (unitState(u.id) !== "completed") {
      const missing = u.steps.findIndex(st => !isAnswered(u, st));
      if (missing !== -1) {
        const st = u.steps[missing];
        S.flash = st.kind === "field_mission"
          ? "To complete this unit, finish the field mission: write a short description or upload a file. Everything else in this unit is saved, so you can come back to it any time."
          : "Please answer this step to complete the unit.";
        go("#/unit/" + u.id + "/" + missing);
        return;
      }
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
    if (step.choice) return renderChoice(u, step, card, nextBtn);
    const prev = S.responses[respKey(u.id, step.kind, step.key)];
    const isFM = step.kind === "field_mission";
    const ta = el("textarea", { id: "answer", "aria-label": "Your answer" });
    const savedText = prev ? prev.answer.text || "" : "";
    ta.value = savedText;
    const dk = draftKey(u.id, step.key);
    const draftNote = bindDraft(ta, dk, savedText);
    const out = el("div");
    const reveal = step.reveal ? mdBlock(step.reveal, "reveal") : null;
    if (reveal && !prev) reveal.classList.add("hidden");
    let files = prev && prev.answer.files ? prev.answer.files.slice() : [];
    const saveBtn = el("button", { class: "btn", onclick: async () => {
      const text = ta.value.trim();
      if (isFM ? !(longEnough(text) || files.length) : !hasContent(text)) {
        out.replaceChildren(msg(isFM ? "Describe what you found in at least a sentence, or upload a file." : "Write your answer first."));
        return;
      }
      const err = await saveResponse(u.id, step.kind, step.key, isFM ? { text, files } : { text });
      out.replaceChildren(err ? msg("Your answer couldn't be saved: " + err.message) : msg("Saved.", "ok"));
      if (!err) { setDraft(dk, ""); if (draftNote) draftNote.remove(); nextBtn.disabled = false; if (reveal) reveal.classList.remove("hidden"); }
    } }, step.reveal && !prev ? "Save and show answers" : "Save answer");
    card.append(el("h3", {}, step.title), mdBlock(step.md));

    if (isFM) card.append(el("p", { class: "small muted" }, prev
      ? "Thanks, your field mission is saved. You can come back and add more at any time."
      : "To complete this unit, write a few sentences about what you found or upload a file. If you need more time, continue to the next step now and come back when you've done the mission."));
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
    card.append(...[ta, draftNote, uploader, el("div", { class: "actions" }, saveBtn), out].filter(Boolean));
    if (reveal) card.append(reveal);
    appendFeedback(card, prev);
    if (!prev && step.kind !== "field_mission") nextBtn.disabled = true;
  }

  function renderChoice(u, step, card, nextBtn) {
    const C = step.choice;
    const prev = S.responses[respKey(u.id, step.kind, step.key)];
    const picks = Object.assign({}, prev && prev.answer.choices ? prev.answer.choices : {});
    let checked = !!(prev && prev.answer.choices);
    const out = el("div");
    const reveal = step.reveal ? mdBlock(step.reveal, "reveal") : null;
    if (reveal && !prev) reveal.classList.add("hidden");
    const list = el("ul", { class: "tf" });
    const allPicked = () => C.items.every(it => picks[it.no]);
    const saveBtn = el("button", { class: "btn", onclick: async () => {
      if (!allPicked()) { out.replaceChildren(msg("Choose an answer for every item.")); return; }
      const text = C.items.map(it => it.no + ". " + it.text + " → " + picks[it.no]).join("\n");
      const err = await saveResponse(u.id, step.kind, step.key, { text, choices: picks });
      out.replaceChildren(err ? msg("Your answers couldn't be saved: " + err.message) : msg("Saved.", "ok"));
      if (!err) { checked = true; draw(); nextBtn.disabled = false; if (reveal) reveal.classList.remove("hidden"); }
    } }, C.graded ? "Check my answers" : "Save and compare");
    function draw() {
      list.replaceChildren(...C.items.map(it => {
        const mine = picks[it.no];
        const right = C.graded && checked && mine && it.answer ? mine === it.answer : null;
        return el("li", {},
          el("span", { class: "stmt" }, it.no + ". " + it.text),
          el("span", { class: "choices", role: "group", "aria-label": "Item " + it.no },
            ...C.options.map(v => el("button", { class: "btn small", type: "button", "aria-pressed": mine === v ? "true" : "false",
              onclick: () => { picks[it.no] = v; checked = false; out.replaceChildren(); draw(); } }, v))),
          right == null ? null : el("span", { class: "mark " + (right ? "ok" : "no") }, right ? "✓ Correct" : "✗ " + (C.wrong[it.answer] || it.answer)));
      }));
      saveBtn.disabled = !allPicked();
    }
    card.append(el("h3", {}, step.title));
    if (step.md) card.append(mdBlock(step.md));
    card.append(el("p", { class: "small muted" }, C.graded ? "Choose an answer for each item, then check your answers." : "Choose an answer for each item, then compare with how others see it."), list,
      el("div", { class: "actions" }, saveBtn), out);
    draw();
    if (reveal) card.append(reveal);
    appendFeedback(card, prev);
    if (!prev) nextBtn.disabled = true;
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
    const savedText = prev ? prev.answer.text || "" : "";
    ta.value = savedText;
    const dk = draftKey(u.id, "reflection");
    const draftNote = bindDraft(ta, dk, savedText);
    const out = el("div");
    card.append(el("h3", {}, "Your reflection"), mdBlock(step.md), ta, draftNote,
      el("div", { class: "actions" }, el("button", { class: "btn", onclick: async () => {
        if (!longEnough(ta.value)) { out.replaceChildren(msg(ta.value.trim() ? "Please write a bit more: at least a full sentence." : "Write your reflection first.")); return; }
        const err = await saveResponse(u.id, "reflection", "main", { text: ta.value.trim() });
        out.replaceChildren(err ? msg("Your reflection couldn't be saved: " + err.message) : msg("Saved. An ENAI representative will reply with feedback.", "ok"));
        if (!err) { setDraft(dk, ""); if (draftNote) draftNote.remove(); nextBtn.disabled = false; }
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
      el("p", { class: "intro" }, "Your own quick guide to where students at your institution can get help."),
      el("p", {}, "Some tasks in the training ask you to look up real contacts, links and rules at your institution (in units " + items.map(x => x.u.id).join(", ") + "). Whatever you write in those tasks is collected here automatically, so you don't have to copy anything."),
      el("p", {}, "During your year as an ambassador, open this page when a student asks you something: most questions can be answered by pointing to the right page or person. You can edit any section at any time."),
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
  let logoDataUrl = null;
  async function getLogo() {
    if (logoDataUrl) return logoDataUrl;
    const blob = await (await fetch("assets/logo.png")).blob();
    logoDataUrl = await new Promise(res => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(blob); });
    return logoDataUrl;
  }

  function badgeSvg(name, inst, date, logo) {
    const fs = (t, max, w) => Math.max(9, Math.min(max, Math.floor(w / (0.56 * Math.max(1, String(t).length)))));
    // Long institution names wrap onto two lines, split at the space nearest the middle.
    let instLines = inst ? [inst] : [];
    if (inst && inst.length > 38 && inst.includes(" ")) {
      const mid = inst.length / 2; let cut = -1;
      for (let i = 0; i < inst.length; i++) if (inst[i] === " " && (cut < 0 || Math.abs(i - mid) < Math.abs(cut - mid))) cut = i;
      instLines = [inst.slice(0, cut).replace(/,$/, ","), inst.slice(cut + 1)];
    }
    const instSize = instLines.length ? Math.min(...instLines.map(l => fs(l, 14, 250))) : 14;
    const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
    return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 400 400" role="img" aria-label="ENAI Student Ambassador badge for ${esc(name)}">
  <circle cx="200" cy="200" r="192" fill="#FFFCF6" stroke="#3D7D83" stroke-width="9"/>
  <circle cx="200" cy="200" r="172" fill="none" stroke="#A0C8C4" stroke-width="2.5"/>
  <image href="${logo}" xlink:href="${logo}" x="110" y="26" width="180" height="180"/>
  <text x="200" y="232" text-anchor="middle" font-family="Zilla Slab, Georgia, serif" font-size="22" font-weight="700" fill="#464847">Core Training Completed</text>
  <path d="M140 246 C 175 238, 225 252, 260 242" fill="none" stroke="#54A4AC" stroke-width="4" stroke-linecap="round"/>
  <text x="200" y="280" text-anchor="middle" font-family="Inter, Arial, sans-serif" font-size="${fs(name, 20, 290)}" font-weight="600" fill="#3D7D83">${esc(name)}</text>
  ${instLines.map((l, i) => `<text x="200" y="${302 + i * 16}" text-anchor="middle" font-family="Inter, Arial, sans-serif" font-size="${instSize}" fill="#464847">${esc(l)}</text>`).join("")}
  <text x="200" y="${inst ? 322 + (instLines.length - 1) * 14 : 311}" text-anchor="middle" font-family="Inter, Arial, sans-serif" font-size="13" fill="#7E817F">${esc(date)}</text>
  <text x="200" y="${instLines.length > 1 ? 356 : 349}" text-anchor="middle" font-family="Inter, Arial, sans-serif" font-size="12" letter-spacing="0.5" fill="#7E817F">academicintegrity.eu</text>
</svg>`;
  }

  async function socialImage(name, inst, date) {
    try { await Promise.all([document.fonts.load('700 64px "Zilla Slab"'), document.fonts.load('600 40px "Inter"'), document.fonts.load('400 28px "Inter"')]); } catch (e) {}
    const W = 1200, H = 627, c = document.createElement("canvas");
    c.width = W; c.height = H;
    const g = c.getContext("2d");
    g.fillStyle = "#FFFCF6"; g.fillRect(0, 0, W, H);
    g.fillStyle = "#ECEBDF"; g.beginPath(); g.ellipse(250, 120, 420, 330, 0, 0, Math.PI * 2); g.fill();
    const img = new Image(); img.src = await getLogo(); await img.decode();
    g.drawImage(img, 60, 113, 400, 400);
    const x = 500;
    g.fillStyle = "#464847"; g.font = '400 30px "Inter", Arial, sans-serif';
    g.fillText("I've completed the", x, 175);
    const fit = (text, weight, size, family, maxW) => { let f = size; do { g.font = weight + " " + f + "px " + family; f -= 2; } while (g.measureText(text).width > maxW && f > 16); };
    fit("ENAI Student Ambassador", "700", 60, '"Zilla Slab", Georgia, serif', 660);
    g.fillText("ENAI Student Ambassador", x, 250);
    g.fillText("Training", x, 318);
    g.strokeStyle = "#54A4AC"; g.lineWidth = 7; g.lineCap = "round";
    g.beginPath(); g.moveTo(x + 4, 345); g.bezierCurveTo(x + 120, 330, x + 260, 360, x + 420, 338); g.stroke();
    g.fillStyle = "#3D7D83"; fit(name, "600", 40, '"Inter", Arial, sans-serif', 660);
    g.fillText(name, x, 410);
    if (inst) { g.fillStyle = "#464847"; fit(inst, "400", 28, '"Inter", Arial, sans-serif', 660); g.fillText(inst, x, 450); }
    g.fillStyle = "#7E817F"; fit(date + "  ·  European Network for Academic Integrity", "400", 24, '"Inter", Arial, sans-serif', 660);
    g.fillText(date + "  ·  European Network for Academic Integrity", x, inst ? 492 : 465);
    g.font = '400 24px "Inter", Arial, sans-serif';
    g.fillText("academicintegrity.eu", x, inst ? 530 : 505);
    g.fillStyle = "#A0C8C4"; g.fillRect(0, H - 14, W, 14);
    return new Promise(res => c.toBlob(res, "image/png"));
  }

  function download(blob, filename) {
    const a = el("a", { href: URL.createObjectURL(blob), download: filename });
    document.body.append(a); a.click(); a.remove();
  }

  async function renderBadge() {
    if (!S.student.badge_awarded_at) { go("#/"); return; }
    const name = S.student.full_name || S.user.email;
    const date = fmtDate(S.student.badge_awarded_at);
    show(el("p", { class: "muted" }, "Preparing your badge…"));
    const inst = S.student.institution || "";
    const svg = badgeSvg(name, inst, date, await getLogo());
    const postText = "I'm proud to share that I've completed the ENAI Student Ambassador Training! 🎓\n\n" +
      "Through a series of real case files I explored academic integrity in practice: grey zones, learning with AI, contract cheating, why students cut corners, and how integrity procedures work. " +
      "As an ENAI Student Ambassador, I'm here to support fellow students with honest, practical answers.\n\n" +
      "Thank you to the European Network for Academic Integrity (ENAI) for the training. Learn more at https://www.academicintegrity.eu\n\n" +
      "#AcademicIntegrity #ENAI #StudentAmbassador #HigherEducation";
    const ta = el("textarea", { "aria-label": "Post text", style: "min-height:190px" });
    ta.value = postText;
    const out = el("div");
    const preview = el("img", { alt: "Image for social media", style: "width:100%;border-radius:12px;border:1px solid var(--line);margin:6px 0 4px" });
    socialImage(name, inst, date).then(blob => { preview.src = URL.createObjectURL(blob); preview._blob = blob; });

    show(
      el("section", { class: "panel badge-wrap" },
        el("h2", {}, "You've finished the core training"),
        el("div", { html: svg }),
        el("p", {}, "Congratulations, and thank you. Your answer kit is ready for the year ahead. You don't have to know everything, and you're never alone in this role."),
        el("div", { class: "actions", style: "justify-content:center" },
          el("button", { class: "btn primary", onclick: () => download(new Blob([svg], { type: "image/svg+xml" }), "ENAI-Ambassador-badge.svg") }, "Download badge"),
          el("button", { class: "btn", onclick: () => go("#/kit") }, "My answer kit"),
          el("button", { class: "btn", onclick: () => go("#/") }, "Back to modules")),
        el("p", { class: "small muted" }, "Is your name or institution wrong? ", el("a", { href: "#/profile" }, "Edit your details"), ", then come back here.")),
      el("section", { class: "panel" },
        el("h2", { style: "margin-top:0" }, "Share it on LinkedIn"),
        el("p", {}, "Want to let others know? Here's a ready-made image and post. Sharing is completely optional."),
        preview,
        el("ol", { class: "share-steps" },
          el("li", {}, el("button", { class: "btn", onclick: async () => {
            const blob = preview._blob || await socialImage(name, inst, date);
            download(blob, "ENAI-Ambassador-LinkedIn.png");
          } }, "Download the image")),
          el("li", {}, "Copy the post text (edit it as you like):", ta,
            el("div", { class: "actions", style: "margin-top:8px" }, el("button", { class: "btn", onclick: async () => {
              try { await navigator.clipboard.writeText(ta.value); out.replaceChildren(msg("Text copied.", "ok")); }
              catch (e) { ta.select(); out.replaceChildren(msg("Press Ctrl+C (or ⌘+C) to copy the selected text.", "ok")); }
            } }, "Copy text")), out),
          el("li", {}, el("a", { class: "btn primary", href: "https://www.linkedin.com/feed/?shareActive=true&text=" + encodeURIComponent(postText), target: "_blank", rel: "noopener", style: "text-decoration:none;display:inline-block" }, "Open LinkedIn"),
            el("p", { class: "small muted", style: "margin:8px 0 0" }, "LinkedIn opens a new post with the text. Paste your own version if you edited it, then add the downloaded image with the photo icon and post.")))));
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
    if (parts[0] === "profile") return renderProfile();
    renderHome();
  }

  function renderWho() {
    $who.replaceChildren(
      el("div", {}, S.student && S.student.full_name ? S.student.full_name : S.user.email),
      S.student && S.student.institution ? el("div", { class: "small" }, S.student.institution) : null,
      el("div", {},
        S.student ? el("a", { class: "btn link small", href: "#/profile" }, "My details") : null,
        S.student ? " · " : null,
        el("button", { class: "btn link small", onclick: async () => { await sb.auth.signOut(); } }, "Sign out")));
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
  // Supabase also fires SIGNED_IN when the tab regains focus. Only reload when the user actually changes,
  // otherwise the page re-renders and unsaved text is lost.
  sb.auth.onAuthStateChange((event, session) => {
    if (event !== "SIGNED_IN" && event !== "SIGNED_OUT") return;
    const newId = session && session.user ? session.user.id : null;
    const curId = S.user ? S.user.id : null;
    if (newId !== curId) setTimeout(boot, 0);
  });

  (async () => {
    show(el("p", { class: "muted" }, "Loading…"));
    await loadContent();
    await boot();
  })();
})();
