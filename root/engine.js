// Test Engine - LMS for Prelims Sprint
(function() {
  const QUESTIONS = window.QUESTIONS;
  const STORAGE_KEY = 'prelims-sprint-engine-v1';

  // Load saved state
  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const s = JSON.parse(raw);
        if (!s.mined) s.mined = {};
        return s;
      }
    } catch (e) {}
    return { answers: {}, bookmarks: {}, mined: {}, lastIdx: 0, filters: { subject: 'all', topic: 'all', area: 'all', search: '', shuffle: false, bookmarksOnly: false, incorrectOnly: false }, mode: 'practice' };
  }

  // Effective answer: pre-set or mined
  function effAnswer(q) {
    if (q.answer) return q.answer;
    const m = state.mined[q.id];
    return m ? m.answer : null;
  }
  function effExplanation(q) {
    if (q.explanation) return q.explanation;
    const m = state.mined[q.id];
    return m ? m.explanation : null;
  }

  // Mine a solution using window.claude.complete
  async function mineSolution(q) {
    const opts = ['a','b','c','d'].map(k => `(${k}) ${q.options[k]}`).join('\n');
    let prompt = `You are helping answer a UPSC Prelims MCQ. Below is the question, the four options, and reference notes from the study slide where the question appears. Use the notes as the primary source of truth when relevant.

Question:
${q.question}

Options:
${opts}
`;
    if (q.context) {
      prompt += `\nReference notes from the slide:\n"""${q.context}"""\n`;
    }
    prompt += `\nRespond ONLY as a single line of JSON, no other text, no markdown fences:
{"answer":"<a|b|c|d>","explanation":"<2-4 sentence explanation citing the relevant facts>"}`;

    const resp = await window.claude.complete(prompt);
    // Parse JSON. Tolerate stray text.
    let text = resp.trim();
    const m = text.match(/\{[\s\S]*\}/);
    if (m) text = m[0];
    let parsed;
    try { parsed = JSON.parse(text); }
    catch (e) {
      // Try to extract answer letter manually
      const letterM = resp.match(/\b([a-d])\b/i);
      parsed = { answer: letterM ? letterM[1].toLowerCase() : null, explanation: resp.slice(0, 600) };
    }
    if (!parsed.answer || !'abcd'.includes(parsed.answer)) {
      throw new Error('Could not determine answer');
    }
    state.mined[q.id] = { answer: parsed.answer.toLowerCase(), explanation: parsed.explanation || '', minedAt: Date.now() };
    saveState();
    return state.mined[q.id];
  }
  function saveState() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) {}
  }

  const state = loadState();

  // Bulk mining state (not persisted across reload — it's a session operation)
  const bulk = {
    running: false,
    stopRequested: false,
    queue: [],
    total: 0,
    done: 0,
    ok: 0,
    failed: 0,
    failedIds: [],
  };

  async function runBulkMining() {
    // Build queue: every question that doesn't have an answer yet and is mineable
    bulk.queue = QUESTIONS.filter(q => !q.answer && q.mineable && !state.mined[q.id]);
    bulk.total = bulk.queue.length;
    bulk.done = 0;
    bulk.ok = 0;
    bulk.failed = 0;
    bulk.failedIds = [];
    bulk.running = true;
    bulk.stopRequested = false;
    renderMineAllUI();

    const CONCURRENCY = 3;
    let idx = 0;
    async function worker() {
      while (idx < bulk.queue.length && !bulk.stopRequested) {
        const q = bulk.queue[idx++];
        try {
          await mineSolution(q);
          bulk.ok++;
        } catch (e) {
          bulk.failed++;
          bulk.failedIds.push(q.id);
        }
        bulk.done++;
        renderMineAllUI();
        // Re-render the current question card if it's the one we just mined
        const cur = currentList[currentIdx];
        if (cur && cur.id === q.id) renderQuestion();
      }
    }
    const workers = [];
    for (let i = 0; i < CONCURRENCY; i++) workers.push(worker());
    await Promise.all(workers);

    bulk.running = false;
    renderMineAllUI();
    // Full re-render so newly-mined answers reflect in stats/grid
    renderMain();
  }

  function renderMineAllUI() {
    const btn = $('#mine-all-btn');
    const status = $('#mine-all-status');
    if (!btn || !status) return;

    const remaining = QUESTIONS.filter(q => !q.answer && q.mineable && !state.mined[q.id]).length;
    const totalMineable = QUESTIONS.filter(q => !q.answer && q.mineable).length;
    const mined = totalMineable - remaining;

    if (bulk.running) {
      btn.className = 'btn danger';
      btn.textContent = bulk.stopRequested ? 'Stopping…' : '■ Stop';
      btn.disabled = bulk.stopRequested ? '' : null;
      btn.onclick = () => { bulk.stopRequested = true; renderMineAllUI(); };
      const pct = bulk.total ? Math.round(bulk.done / bulk.total * 100) : 0;
      status.innerHTML =
        `<div><strong>${bulk.done}</strong> / ${bulk.total} processed · ${bulk.ok} ok · ${bulk.failed} failed</div>` +
        `<div class="mine-progress"><div style="width:${pct}%"></div></div>`;
    } else {
      btn.className = 'btn primary';
      btn.disabled = remaining === 0 ? '' : null;
      btn.style.width = '100%';
      btn.textContent = remaining === 0 ? '✓ All mined' : `✦ Mine all (${remaining})`;
      btn.onclick = () => {
        if (remaining === 0) return;
        if (!confirm(`Mine answers for ${remaining} unanswered question${remaining === 1 ? '' : 's'}? This calls Claude once per question and may take a few minutes.`)) return;
        runBulkMining();
      };
      if (totalMineable === 0) {
        status.textContent = 'Nothing to mine.';
      } else if (remaining === 0) {
        status.innerHTML = `<div>${mined} / ${totalMineable} mined.</div>` +
          (bulk.failedIds.length ? `<div style="color:var(--wrong)">${bulk.failedIds.length} failed last run.</div>` : '');
      } else {
        status.innerHTML = `<div>${mined} of ${totalMineable} already mined.</div>` +
          (bulk.failedIds.length ? `<div style="color:var(--wrong)">${bulk.failedIds.length} failed in last run — click to retry.</div>` : '');
      }
    }
  }

  // Build filter option lists
  function uniqueWithCounts(items, field) {
    const counts = {};
    for (const q of items) counts[q[field]] = (counts[q[field]]||0) + 1;
    return Object.entries(counts).sort((a,b)=>b[1]-a[1]);
  }
  
  function getFiltered() {
    let list = QUESTIONS.slice();
    const f = state.filters;
    if (f.subject !== 'all') list = list.filter(q => q.subject === f.subject);
    if (f.topic !== 'all') list = list.filter(q => q.topic === f.topic);
    if (f.area !== 'all') list = list.filter(q => q.area === f.area);
    if (f.bookmarksOnly) list = list.filter(q => state.bookmarks[q.id]);
    if (f.incorrectOnly) list = list.filter(q => {
      const a = state.answers[q.id];
      const ans = effAnswer(q);
      return a && ans && a.choice !== ans;
    });
    if (f.search) {
      const s = f.search.toLowerCase();
      list = list.filter(q =>
        q.question.toLowerCase().includes(s) ||
        Object.values(q.options).some(v=>v.toLowerCase().includes(s)) ||
        (q.explanation||'').toLowerCase().includes(s)
      );
    }
    if (f.shuffle) {
      // Deterministic shuffle by id for stability within session
      list = list.slice().sort((a,b)=>{
        const ha = ((a.id*9301+49297) % 233280);
        const hb = ((b.id*9301+49297) % 233280);
        return ha - hb;
      });
    }
    return list;
  }

  let currentList = [];
  let currentIdx = 0;

  function $(sel) { return document.querySelector(sel); }
  function el(tag, props={}, children=[]) {
    const e = document.createElement(tag);
    for (const k in props) {
      if (k === 'class') e.className = props[k];
      else if (k === 'html') e.innerHTML = props[k];
      else if (k === 'text') e.textContent = props[k];
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), props[k]);
      else if (k === 'data') for (const d in props[k]) e.dataset[d] = props[k][d];
      else e.setAttribute(k, props[k]);
    }
    for (const c of (Array.isArray(children) ? children : [children])) {
      if (c == null) continue;
      e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return e;
  }

  function renderFilterList(containerId, field, allLabel) {
    const container = $('#' + containerId);
    container.innerHTML = '';
    // "All" option
    const totalCount = QUESTIONS.filter(q => {
      // For counts, respect other filters except this one
      const f = state.filters;
      if (field !== 'subject' && f.subject !== 'all' && q.subject !== f.subject) return false;
      return true;
    }).length;

    function makeItem(value, label, count) {
      const item = el('div', {
        class: 'filter-item' + (state.filters[field] === value ? ' active' : ''),
        onclick: () => {
          state.filters[field] = value;
          // Reset dependent filters when subject changes
          if (field === 'subject') {
            state.filters.topic = 'all';
            state.filters.area = 'all';
          }
          saveState();
          currentIdx = 0;
          renderAll();
        }
      }, [
        el('span', { text: label }),
        el('span', { class: 'count', text: String(count) })
      ]);
      container.appendChild(item);
    }

    // All
    makeItem('all', allLabel, getCountForFilter(field, 'all'));
    
    // Build value set based on current subject filter
    const baseList = (field === 'subject') ? QUESTIONS : QUESTIONS.filter(q => state.filters.subject === 'all' || q.subject === state.filters.subject);
    const counts = {};
    for (const q of baseList) counts[q[field]] = (counts[q[field]]||0) + 1;
    
    const sorted = Object.entries(counts).sort((a,b)=>b[1]-a[1]);
    for (const [val, cnt] of sorted) {
      makeItem(val, val, cnt);
    }
  }

  function getCountForFilter(field, value) {
    let list = QUESTIONS.slice();
    if (field !== 'subject' && state.filters.subject !== 'all') list = list.filter(q => q.subject === state.filters.subject);
    if (value !== 'all') list = list.filter(q => q[field] === value);
    return list.length;
  }

  function renderSidebar() {
    renderFilterList('filter-subject', 'subject', 'All subjects');
    renderFilterList('filter-topic', 'topic', 'All topics');
    renderFilterList('filter-area', 'area', 'All worksheets');

    // toggles
    const setToggle = (id, key) => {
      const node = $('#' + id);
      node.classList.toggle('on', !!state.filters[key]);
      node.onclick = () => {
        state.filters[key] = !state.filters[key];
        saveState();
        currentIdx = 0;
        renderAll();
      };
    };
    setToggle('toggle-shuffle', 'shuffle');
    setToggle('toggle-bookmarks', 'bookmarksOnly');
    setToggle('toggle-incorrect', 'incorrectOnly');

    // search
    const search = $('#search');
    search.value = state.filters.search || '';
    search.oninput = (e) => {
      state.filters.search = e.target.value;
      saveState();
      currentIdx = 0;
      renderMain();
    };

    // reset
    $('#reset-progress').onclick = () => {
      if (confirm('Reset all answers and bookmarks? This cannot be undone.')) {
        state.answers = {};
        state.bookmarks = {};
        currentIdx = 0;
        saveState();
        renderAll();
      }
    };
  }

  function renderStats() {
    const total = Object.keys(state.answers).length;
    let correct = 0;
    for (const id in state.answers) {
      const q = QUESTIONS.find(x => x.id == id);
      if (q && state.answers[id].choice === effAnswer(q)) correct++;
    }
    const wrong = total - correct;
    $('#stat-total').textContent = total;
    $('#stat-correct').textContent = correct;
    $('#stat-wrong').textContent = wrong;
    $('#stat-acc').textContent = total ? Math.round(correct/total*100) + '%' : '—';
  }

  function formatQuestionText(text) {
    // Render numbered statements on their own lines
    let out = text
      .replace(/\s*(\d+)\.\s/g, '\n$1. ')
      .replace(/(Which of the statements given above)/i, '\n$1')
      .replace(/(Select the correct answer)/i, '\n$1')
      .replace(/(How many of the (?:above|statements))/i, '\n$1')
      .replace(/(Which one of the following)/i, '\n$1')
      .replace(/(Which of the following)/i, '\n$1')
      .replace(/(Consider the following)/i, '$1')
      .replace(/\n+/g, '\n');
    return out.trim();
  }

  function renderQuestion() {
    const container = $('#qcontainer');
    container.innerHTML = '';

    if (currentList.length === 0) {
      container.appendChild(el('div', { class: 'empty' }, [
        el('div', { class: 'big', text: 'No questions match.' }),
        el('div', { text: 'Try clearing some filters.' })
      ]));
      return;
    }

    if (currentIdx >= currentList.length) currentIdx = 0;
    const q = currentList[currentIdx];
    const userAns = state.answers[q.id];
    const isAnswered = !!userAns;
    const revealMode = state.mode === 'reveal';
    const correctAns = effAnswer(q);
    const explanation = effExplanation(q);
    const hasSolution = !!correctAns;
    const shouldReveal = (isAnswered || revealMode) && hasSolution;
    const needsMining = !hasSolution && q.mineable;

    const tags = el('div', { class: 'tags' }, [
      el('span', { class: 'tag subject', text: q.subject }),
      el('span', { class: 'tag', text: q.topic }),
      el('span', { class: 'tag lot', text: q.area }),
    ]);
    if (needsMining) tags.appendChild(el('span', { class: 'tag mineable', text: '✦ needs mining' }));

    const head = el('div', { class: 'qhead' }, [
      el('div', { class: 'qnum', text: 'Q' + q.id.toString().padStart(3, '0') }),
      tags
    ]);

    const qtext = el('div', { class: 'qtext', text: formatQuestionText(q.question) });

    const optionsBox = el('div', { class: 'options' });
    ['a','b','c','d'].forEach(letter => {
      if (!q.options[letter]) return;
      let cls = 'opt';
      if (userAns && userAns.choice === letter) cls += ' selected';
      if (shouldReveal) {
        cls += ' locked';
        if (letter === correctAns) cls += ' correct';
        else if (userAns && userAns.choice === letter) cls += ' wrong';
      }
      const opt = el('div', {
        class: cls,
        onclick: () => {
          if (shouldReveal && state.mode !== 'reveal') return;
          if (revealMode) return;
          if (isAnswered) return;
          state.answers[q.id] = { choice: letter, ts: Date.now() };
          saveState();
          renderAll();
        }
      }, [
        el('div', { class: 'letter', text: letter.toUpperCase() }),
        el('div', { class: 'opt-body', text: q.options[letter] })
      ]);
      optionsBox.appendChild(opt);
    });

    const card = el('div', { class: 'qcard' }, [head, qtext, optionsBox]);

    // Mining UI: if no answer available yet and question is mineable
    if (!hasSolution && q.mineable) {
      const mineWrap = el('div', { class: 'mine-wrap' });
      const mineState = state.miningInProgress && state.miningInProgress[q.id];
      if (mineState === 'loading') {
        mineWrap.appendChild(el('div', { class: 'mining-status', html: '<span class="spinner"></span> Mining solution from slide notes…' }));
      } else if (mineState === 'error') {
        mineWrap.appendChild(el('div', { class: 'mining-status error', text: 'Mining failed. Try again.' }));
      }
      const btn = el('button', {
        class: 'btn primary mine-btn',
        text: mineState === 'loading' ? 'Mining…' : '✦ Mine solution',
        disabled: mineState === 'loading' ? '' : null,
        onclick: async () => {
          if (!state.miningInProgress) state.miningInProgress = {};
          state.miningInProgress[q.id] = 'loading';
          renderMain();
          try {
            await mineSolution(q);
            delete state.miningInProgress[q.id];
            renderAll();
          } catch (e) {
            state.miningInProgress[q.id] = 'error';
            console.error('Mining failed:', e);
            renderMain();
          }
        }
      });
      if (mineState !== 'loading') mineWrap.appendChild(btn);
      mineWrap.appendChild(el('div', { class: 'mine-hint', text: 'This question came from a slide deck without an explicit answer key. Click to derive the answer from the slide\u2019s reference notes.' }));
      card.appendChild(mineWrap);
    }

    if (shouldReveal && explanation) {
      const exp = el('div', { class: 'explanation' });
      const isMined = !!q.minedAnswer || (!q.explanation && !!state.mined[q.id]);
      const ehText = 'Why ' + correctAns.toUpperCase() + '.' + (isMined ? '  ✦ mined' : '');
      exp.appendChild(el('span', { class: 'eh', text: ehText }));
      const expText = document.createElement('span');
      expText.textContent = explanation;
      exp.appendChild(expText);
      card.appendChild(exp);
    }

    // Footer nav
    const foot = el('div', { class: 'qfoot' }, [
      el('button', {
        class: 'btn', text: '← Previous',
        onclick: () => { if (currentIdx > 0) { currentIdx--; saveState(); renderMain(); } }
      }),
      el('div', { class: 'center', text: `${currentIdx+1} / ${currentList.length}` }),
      el('button', {
        class: 'btn primary', text: 'Next →',
        onclick: () => { if (currentIdx < currentList.length - 1) { currentIdx++; saveState(); renderMain(); } }
      })
    ]);
    card.appendChild(foot);

    container.appendChild(card);

    // Bookmark button
    const bmBtn = $('#bookmark-btn');
    const bm = !!state.bookmarks[q.id];
    bmBtn.innerHTML = (bm ? '★' : '☆') + ' Bookmark';
    bmBtn.style.color = bm ? 'var(--accent)' : '';
    bmBtn.onclick = () => {
      state.bookmarks[q.id] = !bm;
      saveState();
      renderAll();
    };
  }

  function renderQGrid() {
    const grid = $('#qgrid');
    grid.innerHTML = '';
    currentList.forEach((q, i) => {
      let cls = 'cell';
      if (i === currentIdx) cls += ' current';
      const userAns = state.answers[q.id];
      if (userAns) {
        const ans = effAnswer(q);
        if (ans) cls += userAns.choice === ans ? ' answered-correct' : ' answered-wrong';
        else cls += ' answered-unattempted';
      }
      const cell = el('div', {
        class: cls,
        text: String(i + 1),
        title: 'Q' + q.id,
        onclick: () => { currentIdx = i; saveState(); renderMain(); }
      });
      grid.appendChild(cell);
    });
  }

  function renderProgress() {
    const total = currentList.length;
    const answered = currentList.filter(q => state.answers[q.id]).length;
    $('#progress-fill').style.width = total ? (answered/total*100) + '%' : '0%';
    $('#meta-line').textContent = total + ' questions · ' + answered + ' answered in current filter';
  }

  function renderModeToggle() {
    document.querySelectorAll('#mode-toggle .pill').forEach(p => {
      p.classList.toggle('active', p.dataset.mode === state.mode);
      p.onclick = () => {
        state.mode = p.dataset.mode;
        saveState();
        renderAll();
      };
    });
  }

  function renderRandomBtn() {
    $('#random-btn').onclick = () => {
      if (currentList.length === 0) return;
      currentIdx = Math.floor(Math.random() * currentList.length);
      saveState();
      renderMain();
    };
  }

  function renderMain() {
    currentList = getFiltered();
    if (currentIdx >= currentList.length) currentIdx = 0;
    renderQuestion();
    renderQGrid();
    renderProgress();
    renderStats();
  }

  function renderAll() {
    renderSidebar();
    renderModeToggle();
    renderRandomBtn();
    renderMain();
    renderMineAllUI();
  }

  // Keyboard nav
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;
    if (e.key === 'ArrowRight' || e.key === 'j') {
      if (currentIdx < currentList.length - 1) { currentIdx++; saveState(); renderMain(); }
    } else if (e.key === 'ArrowLeft' || e.key === 'k') {
      if (currentIdx > 0) { currentIdx--; saveState(); renderMain(); }
    } else if (['a','b','c','d','1','2','3','4'].includes(e.key.toLowerCase())) {
      const map = { '1':'a','2':'b','3':'c','4':'d' };
      const letter = map[e.key] || e.key.toLowerCase();
      if (!['a','b','c','d'].includes(letter)) return;
      const q = currentList[currentIdx];
      if (!q) return;
      if (state.mode === 'reveal') return;
      if (state.answers[q.id]) return;
      state.answers[q.id] = { choice: letter, ts: Date.now() };
      saveState();
      renderAll();
    }
  });

  renderAll();
})();
