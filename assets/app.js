/* ============================================================
   저장소 — 배포 환경에서는 localStorage, 막혀 있으면 메모리로 대체
   ============================================================ */
const store = (function(){
  let mem = {}, ok = false;
  try { localStorage.setItem('__t', '1'); localStorage.removeItem('__t'); ok = true; } catch(e){ ok = false; }
  return {
    get: function(k){ try { return ok ? localStorage.getItem(k) : mem[k]; } catch(e){ return mem[k]; } },
    set: function(k, v){ try { if(ok) localStorage.setItem(k, v); else mem[k] = v; } catch(e){ mem[k] = v; } },
    persistent: ok
  };
})();
const LSKEY = 'probrec.v1';

/* ============================================================
   상태
   ============================================================ */
const MAXQ = 4, TOPK = 5, H0 = Math.log2(N);
const PART_COLOR = {sim:'#1F5FA8', type:'#2E6B4F', diff:'#96701A', time:'#8496A5', novel:'#C6D0D9'};
const PART_NAME  = {sim:'개념 유사도', type:'유형', diff:'난이도', time:'분량', novel:'새 문제'};

const state = {
  screen: 'intro',
  answers: {}, asked: {}, trace: [], qcount: 0,
  queryBag: {}, seedTags: [],
  type: null, targetDiff: null, targetTime: null,
  candidates: PROBLEMS.slice(),
  pos: [], neg: [], solved: {},
  lambda: 0.7, useIdf: true,
  prevRank: {}, results: null
};

(function restore(){
  try {
    const o = JSON.parse(store.get(LSKEY) || '{}');
    if(o.solved) state.solved = o.solved;
  } catch(e){}
})();
function persist(){ store.set(LSKEY, JSON.stringify({solved: state.solved})); }

/* ============================================================
   유틸
   ============================================================ */
function esc(s){
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
                  .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function fx(n, d){ return Number(n).toFixed(d == null ? 2 : d); }
const $ = function(id){ return document.getElementById(id); };

function queryVec(){
  const base = toVector(state.queryBag, state.useIdf);
  return rocchio(base, state.pos, state.neg);
}
function qobj(){
  return {
    vec: queryVec(), type: state.type,
    targetDiff: state.targetDiff, targetTime: state.targetTime,
    solved: state.solved
  };
}
function notch(d){
  let h = '<span class="notch" title="난이도 ' + d + '/5">';
  for(let i = 1; i <= 5; i++) h += '<i class="' + (i <= d ? 'on' : '') + '"></i>';
  return h + '</span>';
}

/* ============================================================
   계기판
   ============================================================ */
function drawPanel(){
  const c = state.candidates.length;
  const h = entropy(c);
  const gained = H0 - h;

  $('roCand').textContent = c;
  $('roEnt').innerHTML = fx(h) + '<small> bit</small>';
  $('roGain').innerHTML = fx(gained) + '<small> bit</small>';

  const pct = Math.max(0, Math.min(100, h / H0 * 100));
  $('gfill').style.width = pct + '%';
  $('gmark').style.left = pct + '%';

  /* 눈금은 2의 거듭제곱 = 남은 후보 수.
     양 끝 라벨은 중앙 정렬하면 게이지 밖으로 잘리므로 안쪽으로 붙인다. */
  const maxB = Math.floor(H0);
  let ticks = '';
  for(let b = 0; b <= maxB; b++){
    const cls = b === 0 ? ' class="first"' : (b === maxB ? ' class="last"' : '');
    ticks += '<span' + cls + ' style="left:' + (b / H0 * 100) + '%">' +
             '<i></i><em class="num">' + Math.pow(2, b) + '</em></span>';
  }
  $('gticks').innerHTML = ticks;

  if(!state.trace.length){
    $('gaugeCap').textContent = '눈금은 남은 후보 수입니다';
  } else {
    const parts = [];
    if(state.trace[0].label.indexOf('검색') === 0) parts.push('검색');
    if(state.qcount) parts.push('질문 ' + state.qcount + '개');
    $('gaugeCap').textContent = parts.join(' + ') + ' → 후보 ' + N + '개에서 ' + c + '개로';
  }
}

/* ============================================================
   화면 1 — 시작
   ============================================================ */
const SEED_CHIPS = ['라그랑주승수법','테일러급수','로피탈정리','케일리해밀턴','사이클로이드','곡률','이중적분','수렴판정','대각화','부분적분'];

function renderIntro(){
  const byUnit = {};
  PROBLEMS.forEach(function(p){ byUnit[p.unit] = (byUnit[p.unit] || 0) + 1; });
  const solvedN = Object.keys(state.solved).length;

  $('stage').innerHTML =
    '<p class="lede">찾고 싶은 개념을 적거나 그냥 시작하세요. ' +
    '질문 <b>' + MAXQ + '개 이내</b>로 ' + N + '개 문제를 다섯 개까지 좁혀 드립니다. ' +
    '어떤 질문을 할지는 <b>후보를 목표 대역에 가장 가깝게 데려다 놓는 질문</b>이 무엇인지 매번 다시 계산해서 정합니다.</p>' +

    '<div class="seed">' +
      '<input id="seedInput" placeholder="예: 라그랑주, 급수 수렴, 극좌표 면적" autocomplete="off">' +
      '<button class="go" id="btnStart">추천 시작</button>' +
    '</div>' +
    '<div class="hintline" id="seedHint">입력은 선택 사항입니다. 비워 두면 첫 질문부터 시작합니다.</div>' +
    '<div class="chipset">' + SEED_CHIPS.map(function(t){
        return '<button class="chip" data-seed="' + esc(t) + '">' + esc(t) + '</button>';
      }).join('') + '</div>' +

    '<div class="bankgrid">' +
      Object.keys(byUnit).map(function(u){
        return '<div><span>' + esc(u) + '</span><span class="num">' + byUnit[u] + '</span></div>';
      }).join('') +
      '<div><span>개념 태그</span><span class="num">' + VOCAB.filter(function(t){ return t.indexOf(':') < 0; }).length + '</span></div>' +
      '<div><span>풀어 본 문제</span><span class="num">' + solvedN + '</span></div>' +
    '</div>';

  const input = $('seedInput');
  input.addEventListener('input', function(){
    const hits = matchVocab(input.value);
    $('seedHint').textContent = !input.value.trim()
      ? '입력은 선택 사항입니다. 비워 두면 첫 질문부터 시작합니다.'
      : (hits.length ? '찾은 개념: ' + hits.join(', ') : '해당하는 개념 태그가 없습니다. 다른 말로 적어 보세요.');
  });
  input.addEventListener('keydown', function(e){ if(e.key === 'Enter') start(); });
  $('btnStart').addEventListener('click', start);
  document.querySelectorAll('[data-seed]').forEach(function(b){
    b.addEventListener('click', function(){
      input.value = b.dataset.seed;
      input.dispatchEvent(new Event('input'));
    });
  });

  function start(){
    state.seedTags = matchVocab(input.value);
    state.seedTags.forEach(function(t){ state.queryBag[t] = W_TAG; });

    /* 검색어가 있으면 그 개념을 담은 문제로 먼저 후보를 좁힌다.
       질문으로 훑어 내려가는 경로와 검색으로 바로 찾는 경로를 나눈 것이다. */
    if(state.seedTags.length){
      const hit = PROBLEMS.filter(function(p){
        return p.tags.some(function(t){ return state.seedTags.indexOf(t) >= 0; });
      });
      if(hit.length >= 2){
        state.trace.push({
          label: '검색 “' + state.seedTags.slice(0, 3).join(', ') + '”',
          ig: entropy(N) - entropy(hit.length), before: N, after: hit.length
        });
        state.candidates = hit;
      }
    }
    nextQuestion();
  }
}

/* ============================================================
   화면 2 — 질문
   ============================================================ */
/* 질의 벡터에 들어간 개념어 수. 단원은 범위가 너무 넓어 개념어로 세지 않는다. */
function conceptTerms(){
  return Object.keys(state.queryBag).filter(function(t){ return t.indexOf('단원:') < 0; }).length;
}
/* 답하면 질의 벡터가 풍부해지는 질문인가 — 난이도·분량은 순위에 개념 정보를 주지 못한다 */
function informs(q){
  return !!q.tag || q.key === 'sub' || q.key === 'type';
}

function nextQuestion(){
  const qs = buildQuestions(state.candidates, state.asked);
  if(state.qcount >= MAXQ){ renderResults(); return; }

  /* 1순위 — 후보를 목표 대역으로 데려가는 질문 */
  if(shouldAsk(state.candidates, qs)){
    state.screen = 'question';
    renderQuestion(qs);
    drawPanel();
    return;
  }

  /* 2순위 — 대역은 맞췄지만 질의 벡터가 비어 있으면 순위화가 할 일이 없다.
     이때 묻는 질문은 후보를 깎지 않는다(soft). 목적이 다르기 때문이다.
       · 좁히기 질문 : 후보 집합을 자른다        → 엔트로피를 줄인다
       · 개념 질문   : 질의 벡터에 개념어를 더한다 → 순위를 가른다
     개념 질문까지 하드 필터로 처리하면 후보가 1~2개로 무너져
     순위화와 다양화가 할 일이 없어진다. */
  if(conceptTerms() < 2 && state.candidates.length >= 3){
    /* 선택지 하나가 문제 1개만 가리키는 질문은 제외한다.
       후보 8개에서 소단원을 묻는 것은 문제를 직접 고르라는 말과 같다.
       순위를 가르려면 양쪽에 문제가 실제로 나뉘어 있어야 한다. */
    const inf = qs.filter(function(q){
      if(!informs(q)) return false;
      return q.options.every(function(o){ return o.count >= 2; });
    }).sort(function(a, b){ return b.ig - a.ig; });
    if(inf.length){
      state.screen = 'question';
      renderQuestion(inf, true);
      drawPanel();
      return;
    }
  }
  renderResults();
}

function renderQuestion(qs, soft){
  const q = qs[0];
  const alts = qs.slice(1, 4);

  const why = soft
    ? '이 질문을 고른 이유 — 후보는 이미 ' + state.candidates.length + '개로 충분히 좁았습니다. ' +
      '다만 아직 개념어가 없어 어떤 문제를 먼저 보여줄지 가릴 근거가 없습니다. ' +
      '이 답은 <b>후보를 더 깎지 않고 순위만 조정</b>합니다. 후보를 고르게 가르는 정도가 ' +
      '<b>' + fx(q.ig) + ' bit</b>로 가장 큽니다.'
    : '이 질문을 고른 이유 — 답하면 후보가 목표인 ' + TARGET + '개 내외에 가장 가까워집니다. ' +
      '목표 이탈 비용이 <b>' + fx(q.cost) + '</b>로 가장 낮고 (지금 멈추면 ' + fx(bandCost(state.candidates.length)) + '), ' +
      '얻는 정보는 <b>' + fx(q.ig) + ' bit</b>입니다.';

  $('stage').innerHTML =
    '<div class="step-mark">질문 <span class="num">' + (state.qcount + 1) + '</span> / 최대 <span class="num">' + MAXQ + '</span>' +
      (soft ? ' · 순위 조정용' : '') +
      (state.seedTags.length && state.qcount === 0 ? ' · 시작 개념 ' + esc(state.seedTags.slice(0, 3).join(', ')) : '') +
    '</div>' +
    '<h2 class="q">' + esc(q.text) + '</h2>' +
    '<div class="opts" id="opts">' +
      q.options.map(function(o, i){
        const wide = q.options.length > 4 || o.label.length > 10;
        return '<button class="opt' + (wide ? ' wide' : '') + '" data-i="' + i + '">' +
          '<span class="lab">' + esc(o.label) + (o.hint ? ' <span class="cnt">' + esc(o.hint) + '</span>' : '') + '</span>' +
          '<span class="cnt num">' + o.count + '</span></button>';
      }).join('') +
    '</div>' +
    '<button class="skip" id="btnSkip">상관없어요, 다음 질문</button>' +
    '<div class="why">' + why +
      (alts.length ? '<span class="alt">다음 후보 — ' + alts.map(function(a){
          return esc(labelOf(a)) + (soft ? ' ' + fx(a.ig) + ' bit' : ' 비용 ' + fx(a.cost));
        }).join(' · ') + '</span>' : '') +
    '</div>';

  document.querySelectorAll('#opts .opt').forEach(function(b){
    b.addEventListener('click', function(){ answer(q, q.options[+b.dataset.i], soft); });
  });
  $('btnSkip').addEventListener('click', function(){
    state.asked[q.key] = true;
    /* 건너뛴 질문도 횟수에 넣는다. 넣지 않으면 태그 질문이 수백 개 남아 있어
       계속 건너뛸 수 있고 결과 화면에 도달하지 못한다. */
    state.qcount++;
    state.trace.push({label: labelOf(q) + ' — 건너뜀', ig: 0, before: state.candidates.length, after: state.candidates.length});
    nextQuestion();
  });
}

function labelOf(q){
  if(q.tag) return q.tag;
  return {unit:'단원', sub:'주제', type:'유형', diff:'난이도', time:'분량'}[q.key] || q.key;
}

function answer(q, opt, soft){
  const before = state.candidates.length;
  state.asked[q.key] = true;
  state.answers[q.key] = opt.value;
  state.qcount++;

  /* soft 질문은 후보를 그대로 두고 질의 벡터만 손본다 */
  if(!soft) state.candidates = opt.subset;

  if(opt.other){
    /* '그 외'는 특정 값이 아니므로 질의 벡터에 넣을 개념어가 없다 */
  }
  else if(q.key === 'unit')  state.queryBag['단원:' + opt.value] = W_UNIT;
  else if(q.key === 'sub')   state.queryBag['소단원:' + opt.value] = W_SUB;
  else if(q.key === 'type'){ state.queryBag['유형:' + opt.value] = W_SUB; state.type = opt.value; }
  else if(q.key === 'diff')  state.targetDiff = opt.target;
  else if(q.key === 'time')  state.targetTime = opt.target;
  else if(q.tag && opt.value === 'yes') state.queryBag[q.tag] = W_TAG;

  const after = state.candidates.length;
  state.trace.push({
    label: labelOf(q) + ' = ' + (q.tag ? (opt.value === 'yes' ? '포함' : '제외') : opt.label) +
           (soft ? ' (순위 조정)' : ''),
    ig: entropy(before) - entropy(after),
    before: before, after: after
  });
  nextQuestion();
}

/* ============================================================
   화면 3 — 결과
   ============================================================ */
function computeResults(){
  const q = qobj();
  const scored = state.candidates.map(function(p){ return scoreOne(p, IDX[p.id], q, state.useIdf); });
  scored.sort(function(a, b){ return b.total - a.total; });

  const chosen = mmrSelect(scored, state.lambda, Math.min(TOPK, scored.length));

  if(chosen.length < TOPK){
    const inCand = {};
    state.candidates.forEach(function(p){ inCand[p.id] = 1; });
    const rest = PROBLEMS.filter(function(p){ return !inCand[p.id]; })
                         .map(function(p){ return scoreOne(p, IDX[p.id], q, state.useIdf); });
    rest.sort(function(a, b){ return b.total - a.total; });
    mmrSelect(rest, state.lambda, TOPK - chosen.length).forEach(function(e){
      e.expanded = true; chosen.push(e);
    });
  }
  return {chosen: chosen, scored: scored, q: q};
}

function renderResults(){
  state.screen = 'results';
  const r = computeResults();
  state.results = r;

  const expandedN = r.chosen.filter(function(c){ return c.expanded; }).length;
  const note = state.candidates.length + '개 후보에서 고름' +
    (expandedN ? ' · 후보가 부족해 ' + expandedN + '개는 은행 전체에서 보충' : '') +
    ' · MMR λ ' + fx(state.lambda, 2);

  let html =
    '<div class="reshead"><h2>추천 문제</h2><span class="note">' + esc(note) + '</span>' +
    '<button class="ghost" id="btnDrawer2">내부 보기</button></div>';

  r.chosen.forEach(function(c, i){
    const p = c.p;
    const prev = state.prevRank[p.id];
    let delta = '';
    if(prev != null && prev !== i){
      delta = prev > i
        ? ' <span class="flag done">▲' + (prev - i) + '</span>'
        : ' <span class="flag">▼' + (i - prev) + '</span>';
    }
    html +=
      '<div class="item' + (c.expanded ? '' : '') + '">' +
        '<div class="rank num">' + (i + 1) + '</div>' +
        '<div class="body">' +
          '<div class="meta">' +
            '<span class="num">' + esc(p.id) + '</span><span class="sep">|</span>' +
            '<span>' + esc(p.unit) + ' · ' + esc(p.sub) + '</span><span class="sep">|</span>' +
            '<span>' + esc(p.type) + '</span><span class="sep">|</span>' +
            '<span>난이도 <span class="num">' + p.diff + '</span>' + notch(p.diff) + '</span><span class="sep">|</span>' +
            '<span class="num">' + p.time + '</span><span>분</span>' +
            (state.solved[p.id] ? '<span class="flag done">· 풀어 봤음</span>' : '') +
            (c.expanded ? '<span class="flag">· 후보군 확장</span>' : '') + delta +
          '</div>' +
          '<p class="txt">' + esc(p.text) + '</p>' +
          '<div class="tags">' + p.tags.map(function(t){
              const hit = state.queryBag[t] != null;
              return '<span class="tag' + (hit ? '' : ' dim') + '" title="idf ' + fx(IDF[t]) + '">' + esc(t) + '</span>';
            }).join('') + '</div>' +
          scoreBar(c) +
          '<div class="fb" data-id="' + esc(p.id) + '">' +
            '<button class="pos" data-act="good">이런 문제 좋아요</button>' +
            '<button data-act="easy">너무 쉬워요</button>' +
            '<button data-act="hard">너무 어려워요</button>' +
            '<button data-act="solved"' + (state.solved[p.id] ? ' class="on"' : '') + '>풀었어요</button>' +
          '</div>' +
        '</div>' +
      '</div>';
  });

  html += '<div class="actions">' +
    '<button class="ghost" id="btnMore">질문 더 받기</button>' +
    '<button class="ghost" id="btnAgain">처음부터 다시</button>' +
    '</div>';

  $('stage').innerHTML = html;
  state.prevRank = {};
  r.chosen.forEach(function(c, i){ state.prevRank[c.p.id] = i; });

  document.querySelectorAll('.fb').forEach(function(g){
    g.querySelectorAll('button').forEach(function(b){
      b.addEventListener('click', function(){ feedback(g.dataset.id, b.dataset.act); });
    });
  });
  $('btnDrawer2').addEventListener('click', function(){ toggleDrawer(true); });
  $('btnAgain').addEventListener('click', reset);
  const more = $('btnMore');
  const qs = buildQuestions(state.candidates, state.asked);
  if(qs.length && qs[0].ig >= 0.05 && state.candidates.length > 3){
    more.addEventListener('click', function(){
      /* 목표 대역에 이미 들어왔더라도 사용자가 원하면 더 좁힌다 */
      state.qcount = 0;
      state.screen = 'question';
      renderQuestion(qs);
      drawPanel();
    });
  } else {
    more.disabled = true;
    more.style.opacity = .4;
    more.style.cursor = 'default';
    more.textContent = '더 물어볼 질문이 없습니다';
  }

  drawPanel();
  if($('drawer').classList.contains('open')) renderDrawer();
}

function scoreBar(c){
  const order = ['sim','type','diff','time','novel'];
  const segs = order.map(function(k){
    const w = c.parts[k] * 100;
    return w > 0.3 ? '<i style="width:' + w + '%;background:' + PART_COLOR[k] + '"></i>' : '';
  }).join('');
  const leg = order.map(function(k){
    return '<b><em style="background:' + PART_COLOR[k] + '"></em>' + PART_NAME[k] + ' ' + fx(c.raw[k]) + '</b>';
  }).join('');
  return '<div class="sbar">' + segs + '</div>' +
         '<div class="slegend">' + leg +
         '<b>총점 ' + fx(c.total) + '</b>' +
         (c.redundancy > 0.01 ? '<b>중복 −' + fx(c.redundancy) + '</b>' : '') +
         '</div>';
}

function feedback(id, act){
  function drop(arr){ const k = arr.indexOf(id); if(k >= 0) arr.splice(k, 1); }
  if(act === 'good'){ drop(state.neg); if(state.pos.indexOf(id) < 0) state.pos.push(id); }
  if(act === 'easy'){ drop(state.pos); if(state.neg.indexOf(id) < 0) state.neg.push(id);
    state.targetDiff = Math.min(5, (state.targetDiff == null ? 3 : state.targetDiff) + 0.8); }
  if(act === 'hard'){ drop(state.pos); if(state.neg.indexOf(id) < 0) state.neg.push(id);
    state.targetDiff = Math.max(1, (state.targetDiff == null ? 3 : state.targetDiff) - 0.8); }
  if(act === 'solved'){
    if(state.solved[id]) delete state.solved[id]; else state.solved[id] = 1;
    persist();
  }
  renderResults();
}

function reset(){
  state.screen = 'intro';
  state.answers = {}; state.asked = {}; state.trace = []; state.qcount = 0;
  state.queryBag = {}; state.seedTags = [];
  state.type = null; state.targetDiff = null; state.targetTime = null;
  state.candidates = PROBLEMS.slice();
  state.pos = []; state.neg = []; state.prevRank = {}; state.results = null;
  renderIntro();
  drawPanel();
}

/* ============================================================
   내부 보기 드로어
   ============================================================ */
function toggleDrawer(open){
  const d = $('drawer'), s = $('scrim');
  const on = open == null ? !d.classList.contains('open') : open;
  d.classList.toggle('open', on);
  s.classList.toggle('open', on);
  d.setAttribute('aria-hidden', on ? 'false' : 'true');
  $('btnDrawer').setAttribute('aria-pressed', on ? 'true' : 'false');
  if(on) renderDrawer();
}

/* 지금 시점의 질문 후보들을 비용 순으로 보여 준다 — 발표에서 근거로 쓰기 좋다 */
function questionTable(){
  const qs = buildQuestions(state.candidates, state.asked).slice(0, 6);
  if(!qs.length) return '<div class="empty">더 물어볼 질문이 없습니다.</div>';
  const stop = bandCost(state.candidates.length);
  const asking = qs[0].cost < stop - 0.02;   // 질문이 멈추는 것보다 나은가
  const hl = ' style="color:var(--blue)"';
  return '<table class="idf"><tr><th>질문</th><th>선택지</th><th>비용</th><th>이득</th></tr>' +
    qs.map(function(q, i){
      return '<tr' + (asking && i === 0 ? hl : '') + '>' +
        '<td>' + esc(labelOf(q)) + '</td><td>' + q.k + '</td>' +
        '<td>' + fx(q.cost) + '</td><td>' + fx(q.ig) + '</td></tr>';
    }).join('') +
    '<tr' + (asking ? ' style="color:var(--ink-faint)"' : hl) + '>' +
      '<td>여기서 멈춤</td><td>—</td><td>' + fx(stop) + '</td><td>0.00</td></tr>' +
    '</table>' +
    '<p class="d" style="margin:8px 0 0">파란 줄이 지금 선택된 쪽입니다.</p>';
}

function renderDrawer(){
  const vec = queryVec();
  const comps = Object.keys(vec).sort(function(a, b){ return vec[b] - vec[a]; }).slice(0, 8);
  const vmax = comps.length ? vec[comps[0]] : 1;

  /* 상위 idf 태그를 나열하면 df=1인 태그가 수십 개라 값이 전부 같아 볼 게 없다.
     대신 변별력이 낮은 쪽(흔한 태그)과 지금 질의에 실제로 쓰인 태그를 보여 준다. */
  const bare = VOCAB.filter(function(t){ return t.indexOf(':') < 0; });
  const common = bare.slice().sort(function(a, b){ return DF[b] - DF[a]; }).slice(0, 10);
  const uniqueN = bare.filter(function(t){ return DF[t] === 1; }).length;
  let imax = 0;
  bare.forEach(function(t){ if(IDF[t] > imax) imax = IDF[t]; });
  const used = Object.keys(state.queryBag)
    .filter(function(t){ return t.indexOf(':') < 0; })
    .sort(function(a, b){ return IDF[b] - IDF[a]; });

  function idfRows(list){
    return list.map(function(t){
      return '<tr><td>' + esc(t) + '</td><td>' + DF[t] + '</td><td>' + fx(IDF[t]) + '</td>' +
        '<td class="barcell"><div class="mini" style="width:' + (IDF[t] / imax * 100) + '%"></div></td></tr>';
    }).join('');
  }

  let sim = '';
  if(state.results){
    const noMmr = state.results.scored.slice(0, TOPK);
    const cur = state.results.chosen;
    const same = noMmr.length && cur.length &&
      noMmr.every(function(c, i){ return cur[i] && cur[i].p.id === c.p.id; });
    sim =
      '<div class="sw"><span>λ</span>' +
        '<input type="range" id="lam" min="0" max="1" step="0.05" value="' + state.lambda + '">' +
        '<span class="num">' + fx(state.lambda, 2) + '</span></div>' +
      '<p class="d" style="margin:0">λ이 1이면 점수만 보고, 0이면 서로 다른 문제만 골라 옵니다. ' +
      (same ? '지금은 MMR 적용 전후 순위가 같습니다.' :
        'MMR 없이 뽑으면 ' + noMmr.map(function(c){ return c.p.id; }).join(', ') + ' 순입니다.') + '</p>';
  }

  const trace = state.trace.length
    ? state.trace.map(function(t){
        return '<div class="tr"><span class="l">' + esc(t.label) + '</span>' +
          '<span class="n">' + t.before + ' → ' + t.after + '</span>' +
          '<span class="n">' + fx(t.ig) + ' bit</span></div>';
      }).join('') +
      '<div class="tr" style="border-top:1px solid var(--rule);margin-top:5px;padding-top:6px">' +
        '<span class="l">합계</span><span class="n"></span><span class="n">' +
        fx(H0 - entropy(state.candidates.length)) + ' bit</span></div>'
    : '<div class="empty">아직 답한 질문이 없습니다.</div>';

  $('dbody').innerHTML =
    '<div class="sect"><h3>질의 벡터</h3>' +
      '<p class="d">답변에서 만들어진 검색 질의입니다. 성분 크기 = tf × idf 를 정규화한 값이고, ' +
      '피드백을 주면 Rocchio 공식으로 이 벡터가 이동합니다.</p>' +
      (comps.length ? comps.map(function(t){
        return '<div class="vecbar"><span class="nm" title="' + esc(t) + '">' + esc(t) + '</span>' +
          '<span class="tk"><i style="width:' + (vec[t] / vmax * 100) + '%"></i></span>' +
          '<span class="vv">' + fx(vec[t]) + '</span></div>';
      }).join('') : '<div class="empty">질의가 비어 있습니다. 난이도·분량만으로 정렬됩니다.</div>') +
      '<p class="d" style="margin:10px 0 0">좋아요 ' + state.pos.length + '개 · 별로예요 ' + state.neg.length + '개' +
      (state.targetDiff != null ? ' · 목표 난이도 ' + fx(state.targetDiff, 1) : '') + '</p>' +
    '</div>' +

    '<div class="sect"><h3>다양성 (MMR)</h3>' +
      '<p class="d">상위 문제들이 서로 너무 닮으면 추천이 쓸모없어집니다. ' +
      'MMR은 점수에서 이미 뽑힌 문제와의 유사도를 빼면서 하나씩 고릅니다.</p>' +
      (sim || '<div class="empty">결과 화면에서 확인할 수 있습니다.</div>') +
    '</div>' +

    '<div class="sect"><h3>태그별 변별력 (IDF)</h3>' +
      '<p class="d">태그 ' + bare.length + '개 중 ' + uniqueN + '개는 문제 하나에만 붙어 있어 ' +
      'idf가 최댓값 ' + fx(imax) + '입니다. 이런 태그가 질의에 들어오면 문제 하나를 곧바로 지목합니다. ' +
      '반대로 아래처럼 여러 문제에 걸친 태그는 idf가 낮아 검색 신호로서 힘이 약합니다.</p>' +
      '<div class="togrow"><input type="checkbox" id="useIdf"' + (state.useIdf ? ' checked' : '') + '>' +
        '<label for="useIdf">IDF 적용 — 끄면 모든 태그를 같은 무게로 취급합니다. 발표에서 순위 변화를 비교할 때 쓰세요.</label></div>' +
      '<p class="d" style="margin:0 0 6px">가장 흔한 태그</p>' +
      '<table class="idf"><tr><th>태그</th><th>df</th><th>idf</th><th></th></tr>' + idfRows(common) + '</table>' +
      (used.length
        ? '<p class="d" style="margin:16px 0 6px">지금 질의에 쓰인 태그</p>' +
          '<table class="idf">' + idfRows(used) + '</table>'
        : '') +
    '</div>' +

    '<div class="sect"><h3>엔트로피 추적</h3>' +
      '<p class="d">질문마다 후보가 얼마나 줄었는지, 즉 몇 bit를 얻었는지 기록입니다. ' +
      '전체 은행의 초기 불확실성은 log₂ ' + N + ' = ' + fx(H0) + ' bit입니다.</p>' +
      '<div class="trace">' + trace + '</div>' +
    '</div>' +

    '<div class="sect"><h3>질문 선택 기준</h3>' +
      '<p class="d">정보 이득만 최대화하면 값의 종류가 많은 속성이 항상 이깁니다. ' +
      '소단원은 81종이라 이득이 6.21 bit로 압도적이어서, 선택지 81개짜리 질문 하나로 끝나 버렸습니다. ' +
      'C4.5의 이득비도 여기서는 쓸 수 없습니다. 후보의 엔트로피를 균등분포로 두면 ' +
      '정보 이득과 분할 엔트로피가 항등적으로 같아져 이득비가 늘 1이 되기 때문입니다.</p>' +
      '<p class="d">그래서 후보를 ' + TARGET + '개 대역에 앉히는 것을 목표로 바꿨습니다. ' +
      '비용 = Σ p·|log₂|Sᵥ| − log₂' + TARGET + '| 을 최소화하면 후보를 너무 많이 남기는 질문과 ' +
      '1개까지 줄여 버리는 질문이 함께 벌점을 받습니다.</p>' +
      questionTable() +
    '</div>' +

    '<div class="sect" style="border:none"><h3>학습 이력</h3>' +
      '<p class="d">풀었다고 표시한 문제는 다음 추천에서 점수가 깎입니다. ' +
      (store.persistent ? '이 브라우저에 저장됩니다.' : '지금 환경에서는 저장이 막혀 있어 새로고침하면 사라집니다.') + '</p>' +
      '<p class="d" style="margin:0 0 10px">기록된 문제 ' + Object.keys(state.solved).length + '개</p>' +
      '<button class="ghost" id="btnClear">이력 지우기</button>' +
    '</div>';

  const lam = $('lam');
  if(lam) lam.addEventListener('input', function(){
    state.lambda = +lam.value;
    if(state.screen === 'results') renderResults(); else renderDrawer();
  });
  $('useIdf').addEventListener('change', function(){
    state.useIdf = $('useIdf').checked;
    if(state.screen === 'results') renderResults(); else renderDrawer();
  });
  $('btnClear').addEventListener('click', function(){
    state.solved = {}; persist();
    if(state.screen === 'results') renderResults(); else renderDrawer();
  });
}

/* ============================================================
   시작
   ============================================================ */
$('btnDrawer').addEventListener('click', function(){ toggleDrawer(); });
$('btnClose').addEventListener('click', function(){ toggleDrawer(false); });
$('scrim').addEventListener('click', function(){ toggleDrawer(false); });
$('btnReset').addEventListener('click', function(){ toggleDrawer(false); reset(); });
document.addEventListener('keydown', function(e){
  if(e.key === 'Escape') toggleDrawer(false);
});

$('subline').textContent = '고급수학 · 문제 ' + N + '개 · 개념 태그 ' +
  VOCAB.filter(function(t){ return t.indexOf(':') < 0; }).length + '개';

renderIntro();
drawPanel();
