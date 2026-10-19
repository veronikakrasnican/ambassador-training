// Turns a module exported from the Claude Doc (Markdown) into units and steps.
// Structure expected:
//   # Module N: Title
//   ## Unit N.M Title          (or ## Reflection N)
//   *Intro line in italics.*
//   ### Section heading        (Case file, Decision point, Debrief, Your turn..., Takeaway, ...)
// Sections called "Notes" or anything that isn't a unit/reflection are ignored.
(function (global) {
  const REVEAL_RE = /^\*\*(Answer|How others see it|Suggested order):\*\*/i;

  function clean(md) {
    return md
      .replace(/\r\n/g, "\n")
      .replace(/&#32;/g, " ")
      .replace(/\*\*\*\*/g, "")        // merged bold fragments from editing
      .replace(/\\\[/g, "[").replace(/\\\]/g, "]");
  }

  function splitParagraphs(text) {
    return text.trim().split(/\n{2,}/).map(s => s.trim()).filter(Boolean);
  }

  // Which "Your turn" headings become button tasks, matched on the heading text from the Doc.
  // "answers" reads the correct answers from the **Answer:** paragraph; without it, the task isn't marked right or wrong.
  const CHOICE_TASKS = [
    { match: /true or false/i, options: ["True", "False"], wrong: { True: "It's true", False: "It's false" },
      answers: (reveal) => { const out = {}, re = /(\d+)\s+(?:is|are)\s+(true|false)/gi; let a;
        while ((a = re.exec(reveal))) out[a[1]] = a[2].toLowerCase() === "true" ? "True" : "False"; return out; } },
    { match: /red flags/i, options: ["Red flag", "Not a red flag"], wrong: { "Red flag": "It's a red flag", "Not a red flag": "It's not a red flag" },
      answers: (reveal, items) => { const m = reveal.match(/\*\*Answer:\*\*\s*([^.]*?)\s+are red flags/i); if (!m) return {};
        const flagged = (m[1].match(/\d+/g) || []); const out = {};
        items.forEach(it => { out[it.no] = flagged.includes(it.no) ? "Red flag" : "Not a red flag"; }); return out; } },
    { match: /ok, ask first, or not ok/i, options: ["OK", "Ask first", "Not OK"] },
    { match: /learning or replacing/i, options: ["Supports learning", "Ask first", "Replaces learning"] }
  ];

  function parseOptions(debrief) {
    const opts = [];
    const re = /^[-*]\s+\*\*([A-D])\.\s*(.+?)\*\*/gm;
    let m;
    while ((m = re.exec(debrief))) {
      opts.push({ letter: m[1], label: m[2].replace(/[.:]\s*$/, "").trim() });
    }
    return opts;
  }

  function parseModule(raw, fallbackNo) {
    const md = clean(raw);
    const titleMatch = md.match(/^#\s+Module\s+(\d+)\s*:\s*(.+)$/m);
    const moduleNo = titleMatch ? Number(titleMatch[1]) : fallbackNo;
    const moduleTitle = titleMatch ? titleMatch[2].trim() : "Module " + fallbackNo;
    const units = [];

    const parts = md.split(/^##\s+(?!#)/m).slice(1);
    for (const part of parts) {
      const nl = part.indexOf("\n");
      const heading = (nl === -1 ? part : part.slice(0, nl)).trim();
      const body = nl === -1 ? "" : part.slice(nl + 1);

      const um = heading.match(/^Unit\s+(\d+\.\d+)\s+(.+)$/i);
      const rm = heading.match(/^Reflection\s+(\d+)\s*$/i);
      if (!um && !rm) continue;

      const sections = body.split(/^###\s+/m);
      const pre = sections.shift() || "";
      const introMatch = pre.match(/^\s*\*([^*\n][^\n]*?)\*\s*$/m);
      const intro = introMatch ? introMatch[1].trim() : "";
      const preRest = introMatch ? pre.replace(introMatch[0], "").trim() : pre.trim();

      if (rm) {
        units.push({
          id: "R" + rm[1], moduleNo, moduleTitle, kind: "reflection",
          title: "Reflection " + rm[1], intro,
          steps: [{ type: "reflection", title: "Reflection " + rm[1], md: preRest }]
        });
        continue;
      }

      const secs = sections.map(s => {
        const i = s.indexOf("\n");
        return { heading: (i === -1 ? s : s.slice(0, i)).trim(), md: (i === -1 ? "" : s.slice(i + 1)).trim() };
      });

      const steps = [];
      if (preRest) steps.push({ type: "read", title: um[2].trim(), md: preRest });
      let caseNo = 0;
      for (let i = 0; i < secs.length; i++) {
        const s = secs[i];
        const h = s.heading.toLowerCase();
        if (h.startsWith("debrief")) continue; // consumed by its decision point
        if (h.startsWith("decision point")) {
          caseNo += 1;
          const deb = secs.slice(i + 1).find(x => x.heading.toLowerCase().startsWith("debrief"));
          const debMd = deb ? deb.md : "";
          steps.push({ type: "decision", title: "Your decision", md: s.md, debrief: debMd, options: parseOptions(debMd), caseNo });
        } else if (h.startsWith("your turn")) {
          const paras = splitParagraphs(s.md);
          const reveal = paras.filter(p => REVEAL_RE.test(p));
          const examples = [];
          let prompt = [];
          paras.filter(p => !REVEAL_RE.test(p)).forEach((p, j, arr) => {
            const prev = j > 0 ? arr[j - 1] : "";
            const isQuote = p.startsWith(">");
            if (isQuote && (/^>\s*\*?Example/i.test(p) || /example:\s*$/i.test(prev))) examples.push(p.replace(/^>\s*\*?Example:\*?\s*/i, "> "));
            else prompt.push(p);
          });
          if (examples.length) {
            prompt = prompt.map(p => p.replace(/\s*(Then compare it with (this|the) example( below)?[.:]|For example:)\s*$/i, "")).filter(Boolean);
          }
          const key = "s" + i;
          const task = {
            type: "task", title: s.heading, md: prompt.join("\n\n"), reveal: reveal.join("\n\n"),
            kind: h.includes("field mission") ? "field_mission" : "your_turn", key, hasExample: examples.length > 0
          };
          // Sorting tasks with a numbered list get one row of buttons per item instead of a text box.
          const choice = CHOICE_TASKS.find(c => c.match.test(s.heading));
          if (choice) {
            const items = [];
            const rest = [];
            task.md.split("\n").forEach(line => {
              const m = line.match(/^\s*(\d+)\.\s+(.+)$/);
              if (m) items.push({ no: m[1], text: m[2].trim() });
              else rest.push(line);
            });
            if (items.length) {
              const correct = choice.answers ? choice.answers(task.reveal, items) : {};
              task.choice = { options: choice.options, wrong: choice.wrong || {}, graded: !!choice.answers,
                items: items.map(it => ({ ...it, answer: correct[it.no] || null })) };
              task.md = rest.join("\n").trim();
            }
          }
          steps.push(task);
          if (examples.length) steps.push({ type: "compare", title: "Compare with an example", md: examples.join("\n\n"), key, kind: h.includes("field mission") ? "field_mission" : "your_turn" });
        } else if (h.startsWith("takeaway")) {
          steps.push({ type: "takeaway", title: "Takeaway", md: s.md });
        } else {
          steps.push({ type: "read", title: s.heading, md: s.md });
        }
      }
      units.push({ id: um[1], moduleNo, moduleTitle, kind: "unit", title: um[2].trim(), intro, steps });
    }
    return { moduleNo, moduleTitle, units };
  }

  global.CourseParser = { parseModule, parseOptions };
  if (typeof module !== "undefined") module.exports = global.CourseParser;
})(typeof window !== "undefined" ? window : globalThis);
