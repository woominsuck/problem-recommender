/* ============================================================
   1단계  TF-IDF 벡터 공간 모형
   ============================================================ */
const W_TAG = 1.0;   // 개념태그 가중치
const W_SUB = 0.9;   // 소단원 가중치
const W_UNIT = 0.45; // 단원 가중치 (넓은 범주라 낮게)

/* 문제 하나를 토큰 가방(bag of terms)으로 변환 */
function tokenize(p){
  const bag = {};
  p.tags.forEach(function(t){ bag[t] = (bag[t] || 0) + W_TAG; });
  bag['소단원:' + p.sub] = W_SUB;
  bag['단원:' + p.unit] = W_UNIT;
  bag['유형:' + p.type] = W_SUB;
  return bag;
}

const N = PROBLEMS.length;
const BAGS = PROBLEMS.map(tokenize);

/* 문서빈도 df 계산 */
const DF = {};
BAGS.forEach(function(bag){
  Object.keys(bag).forEach(function(t){ DF[t] = (DF[t] || 0) + 1; });
});

/* IDF = log(N / df).  전체 문서에 등장하는 어휘는 0이 되어 신호가 사라진다. */
const IDF = {};
Object.keys(DF).forEach(function(t){ IDF[t] = Math.log(N / DF[t]); });

const VOCAB = Object.keys(IDF).sort();

/* 가방 -> 정규화된 tf-idf 벡터 (희소 객체).  useIdf=false 면 tf만 사용 */
function toVector(bag, useIdf){
  const v = {};
  let norm = 0;
  Object.keys(bag).forEach(function(t){
    if(IDF[t] === undefined) return;
    const w = bag[t] * (useIdf === false ? 1 : IDF[t]);
    if(w === 0) return;
    v[t] = w;
    norm += w * w;
  });
  norm = Math.sqrt(norm);
  if(norm > 0) Object.keys(v).forEach(function(t){ v[t] /= norm; });
  return v;
}

function cosine(a, b){
  let s = 0;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  const small = ka.length < kb.length ? ka : kb;
  const big = ka.length < kb.length ? b : a;
  const src = ka.length < kb.length ? a : b;
  small.forEach(function(t){ if(big[t] !== undefined) s += src[t] * big[t]; });
  return s;
}

/* 문서 벡터를 IDF 적용/미적용 두 버전으로 미리 계산 */
const DOCVEC = BAGS.map(function(b){ return toVector(b, true); });
const DOCVEC_NOIDF = BAGS.map(function(b){ return toVector(b, false); });
const IDX = {};
PROBLEMS.forEach(function(p, i){ IDX[p.id] = i; });

/* 문제간 유사도 (MMR 에서 사용) — 필요할 때 계산하고 캐시 */
const SIMCACHE = {};
function docSim(i, j){
  if(i === j) return 1;
  const k = i < j ? i + ':' + j : j + ':' + i;
  if(SIMCACHE[k] === undefined) SIMCACHE[k] = cosine(DOCVEC[i], DOCVEC[j]);
  return SIMCACHE[k];
}

/* ============================================================
   2단계  적응적 질문 선택 — 정보 이득(엔트로피)
   ============================================================ */

/* 후보 집합의 엔트로피. 균등분포 가정이므로 H = log2|S| */
function entropy(size){ return size > 0 ? Math.log2(size) : 0; }

const DIFF_BUCKETS = [
  {label:'쉬움', hint:'1~2', test:function(p){ return p.diff <= 2; }, target:1.6},
  {label:'보통', hint:'3',   test:function(p){ return p.diff === 3; }, target:3.0},
  {label:'어려움', hint:'4~5', test:function(p){ return p.diff >= 4; }, target:4.5}
];
const TIME_BUCKETS = [
  {label:'6분 이내', test:function(p){ return p.time <= 6; }, target:5},
  {label:'7~12분',  test:function(p){ return p.time >= 7 && p.time <= 12; }, target:9},
  {label:'13분 이상', test:function(p){ return p.time >= 13; }, target:18}
];

/* ------------------------------------------------------------
   [설계 노트]  정보 이득만으로 질문을 고르면 안 되는 이유

   (1) 고차원 속성 편향
       순수 정보 이득은 값의 종류가 많은 속성을 항상 고른다. 이 은행에서
       소단원은 81종이라 IG가 6.21 bit로 압도적이었고, 그 결과 선택지
       81개짜리 질문 하나로 끝나 버렸다. ID3가 가진 것과 같은 결함이다.

       C4.5는 이득비 IG / H(split) 로 보정하지만 여기서는 통하지 않는다.
       후보 집합의 엔트로피를 균등분포로 두면

           IG = log2|S| − Σ p_v log2|S_v| = −Σ p_v log2 p_v = H(split)

       이므로 이득비가 항상 정확히 1이 되어 아무것도 구별하지 못한다.

   (2) 애초에 목표가 틀렸다
       IG 최대화는 후보를 1개까지 줄이려 한다. 그런데 후보가 1개가 되면
       뒤에 붙은 순위화와 다양화가 할 일이 없어진다. 우리가 원하는 것은
       불확실성을 0으로 만드는 것이 아니라 후보를 TARGET개 내외의
       대역에 안착시키는 것이다.

   그래서 선택 기준을 목표 대역 비용의 최소화로 바꾼다.

           cost(q) = Σ p_v · | log2|S_v| − log2 TARGET |

       후보를 너무 많이 남기는 질문과 너무 적게 남기는 질문이 함께
       벌점을 받는다. 이 비용 함수는 (1)의 편향도 자동으로 해소한다.
       소단원은 대부분의 선택지가 문제 1~2개만 남기므로 비용이 3.0 근처로
       치솟아 후보에서 밀려난다. 정보 이득 자체는 참고 지표로 계속 계산한다.
   ------------------------------------------------------------ */
const MAXOPT = 7;      // 한 질문에 보여줄 선택지 상한 (UI 보호용)
const TARGET = 8;      // 목표 후보 대역
const H_TARGET = Math.log2(TARGET);

function bandCost(size){ return Math.abs(entropy(size) - H_TARGET); }

/* 선택지가 너무 많으면 큰 것만 남기고 나머지는 '그 외'로 묶는다 */
function capOptions(opts, label){
  if(opts.length <= MAXOPT) return opts;
  const sorted = opts.slice().sort(function(a, b){ return b.count - a.count; });
  const keep = sorted.slice(0, MAXOPT - 1);
  const merged = sorted.slice(MAXOPT - 1);
  let subset = [], count = 0;
  merged.forEach(function(o){ subset = subset.concat(o.subset); count += o.count; });
  keep.push({
    label: '그 외 ' + merged.length + '개 ' + label,
    value: '__other__', count: count, subset: subset, other: true
  });
  return keep;
}

/* 후보 집합 S(문제 배열)에 대해 물어볼 수 있는 질문들을 만든다 */
function buildQuestions(S, asked){
  const qs = [];

  function categorical(key, text, valuesOf, otherLabel){
    if(asked[key]) return;
    const groups = {};
    S.forEach(function(p){
      const v = valuesOf(p);
      (groups[v] = groups[v] || []).push(p);
    });
    const keys = Object.keys(groups);
    if(keys.length < 2) return;   // 갈라지지 않는 질문은 정보 이득 0
    const opts = keys.sort().map(function(v){
      return {label:v, value:v, count:groups[v].length, subset:groups[v]};
    });
    qs.push({key:key, text:text, options: capOptions(opts, otherLabel || '항목')});
  }

  categorical('unit', '어느 단원의 문제를 원하세요?', function(p){ return p.unit; }, '단원');
  categorical('sub', '더 좁혀볼까요. 어느 주제가 좋을까요?', function(p){ return p.sub; }, '주제');
  categorical('type', '어떤 형태의 문제를 원하세요?', function(p){ return p.type; }, '유형');

  /* 난이도 / 시간은 구간으로 묶어 묻는다 */
  if(!asked.diff){
    const opts = DIFF_BUCKETS.map(function(b){
      const sub = S.filter(b.test);
      return {label:b.label, hint:b.hint, value:b.label, count:sub.length, subset:sub, target:b.target};
    }).filter(function(o){ return o.count > 0; });
    if(opts.length >= 2) qs.push({key:'diff', text:'어느 정도 난이도가 좋을까요?', options:opts});
  }
  if(!asked.time){
    const opts = TIME_BUCKETS.map(function(b){
      const sub = S.filter(b.test);
      return {label:b.label, value:b.label, count:sub.length, subset:sub, target:b.target};
    }).filter(function(o){ return o.count > 0; });
    if(opts.length >= 2) qs.push({key:'time', text:'한 문제에 쓸 수 있는 시간은 어느 정도인가요?', options:opts});
  }

  /* 개념태그 예/아니오 질문.
     후보를 절반 가까이 가르는 태그가 정보 이득이 크므로 자동으로 선택된다. */
  const tagCount = {};
  S.forEach(function(p){ p.tags.forEach(function(t){ tagCount[t] = (tagCount[t] || 0) + 1; }); });
  Object.keys(tagCount).forEach(function(t){
    if(asked['tag:' + t]) return;
    const c = tagCount[t];
    if(c < 2 || c > S.length - 2) return;    // 한쪽이 너무 작으면 질문 가치가 없다
    const yes = S.filter(function(p){ return p.tags.indexOf(t) >= 0; });
    const no  = S.filter(function(p){ return p.tags.indexOf(t) < 0; });
    qs.push({
      key: 'tag:' + t,
      tag: t,
      text: '‘' + t + '’ 개념이 들어간 문제를 원하세요?',
      options: [
        {label:'네, 그 개념으로', value:'yes', count:yes.length, subset:yes},
        {label:'아니요, 빼고', value:'no', count:no.length, subset:no}
      ]
    });
  });

  /* 정보 이득  IG   = H(S) − Σ p_v · H(S_v)      — 참고 지표
     목표 비용  cost = Σ p_v · |log2|S_v| − log2 TARGET|  — 실제 선택 기준 */
  const H = entropy(S.length);
  qs.forEach(function(q){
    let rem = 0, cost = 0;
    q.options.forEach(function(o){
      const p = o.count / S.length;
      rem  += p * entropy(o.count);
      cost += p * bandCost(o.count);
    });
    q.ig = H - rem;
    q.remain = rem;
    q.cost = cost;
    q.k = q.options.length;
    q.eff = q.k > 1 ? q.ig / Math.log2(q.k) : 0;
  });

  qs.sort(function(a, b){ return (a.cost - b.cost) || (b.ig - a.ig); });
  return qs;
}

/* 질문을 더 할 가치가 있는가 — 지금 멈추는 비용보다 나아지는지 본다 */
function shouldAsk(S, qs){
  if(!qs.length) return false;
  return qs[0].cost < bandCost(S.length) - 0.02;
}

/* ============================================================
   3단계  점수 계산
   ============================================================ */
const WEIGHT = {sim:0.46, type:0.14, diff:0.20, time:0.08, novel:0.12};

function scoreOne(p, i, q, useIdf){
  const dv = (useIdf === false) ? DOCVEC_NOIDF[i] : DOCVEC[i];
  const sim = Object.keys(q.vec).length ? cosine(q.vec, dv) : 0.35;
  const type = q.type ? (p.type === q.type ? 1 : 0) : 0.5;
  const diff = q.targetDiff != null ? Math.exp(-Math.abs(p.diff - q.targetDiff) / 1.2) : 0.5;
  const time = q.targetTime != null ? Math.exp(-Math.abs(p.time - q.targetTime) / 6) : 0.5;
  const novel = q.solved[p.id] ? 0 : 1;
  const parts = {
    sim: WEIGHT.sim * sim,
    type: WEIGHT.type * type,
    diff: WEIGHT.diff * diff,
    time: WEIGHT.time * time,
    novel: WEIGHT.novel * novel
  };
  let total = 0;
  Object.keys(parts).forEach(function(k){ total += parts[k]; });
  return {p:p, i:i, total:total, parts:parts, raw:{sim:sim, type:type, diff:diff, time:time, novel:novel}};
}

/* ============================================================
   4단계  MMR — 관련성과 다양성을 동시에 고려한 재순위
   MMR = argmax [ λ·rel(d) − (1−λ)·max sim(d, s) ]
   ============================================================ */
function mmrSelect(scored, lambda, k){
  const pool = scored.slice();
  const chosen = [];
  while(chosen.length < k && pool.length){
    let bestIdx = 0, bestVal = -Infinity, bestPen = 0;
    for(let a = 0; a < pool.length; a++){
      let maxSim = 0;
      chosen.forEach(function(c){
        const s = docSim(pool[a].i, c.i);
        if(s > maxSim) maxSim = s;
      });
      const val = lambda * pool[a].total - (1 - lambda) * maxSim;
      if(val > bestVal){ bestVal = val; bestIdx = a; bestPen = maxSim; }
    }
    const pick = pool.splice(bestIdx, 1)[0];
    pick.mmr = bestVal;
    pick.redundancy = bestPen;
    chosen.push(pick);
  }
  return chosen;
}

/* ============================================================
   5단계  Rocchio 관련성 피드백
   q' = α·q + β·mean(좋았던 문제) − γ·mean(별로였던 문제)
   ============================================================ */
const ROCCHIO = {alpha:1.0, beta:0.75, gamma:0.25};

function rocchio(baseVec, posIds, negIds){
  const out = {};
  Object.keys(baseVec).forEach(function(t){ out[t] = ROCCHIO.alpha * baseVec[t]; });

  function blend(ids, coef){
    if(!ids.length) return;
    ids.forEach(function(id){
      const v = DOCVEC[IDX[id]];
      Object.keys(v).forEach(function(t){
        out[t] = (out[t] || 0) + coef * v[t] / ids.length;
      });
    });
  }
  blend(posIds, ROCCHIO.beta);
  blend(negIds, -ROCCHIO.gamma);

  /* 음수 성분은 잘라내고 다시 정규화 */
  let norm = 0;
  Object.keys(out).forEach(function(t){
    if(out[t] < 0) delete out[t]; else norm += out[t] * out[t];
  });
  norm = Math.sqrt(norm);
  if(norm > 0) Object.keys(out).forEach(function(t){ out[t] /= norm; });
  return out;
}

/* ============================================================
   자유 입력 -> 어휘 매칭
   ============================================================ */
function matchVocab(raw){
  const s = raw.replace(/\s+/g, '');
  if(!s) return [];
  const hits = [];
  VOCAB.forEach(function(t){
    if(t.indexOf(':') >= 0) return;              // 단원/유형 메타 토큰은 제외
    const bare = t.replace(/[·\s]/g, '');
    if(bare.indexOf(s) >= 0 || s.indexOf(bare) >= 0) hits.push(t);
  });
  return hits.sort(function(a, b){ return IDF[b] - IDF[a]; }).slice(0, 6);
}
