// 전국 행사 수집기: KOPIS(공연) + 관광공사(축제) + 문화정보원(공연·전시·체험)
// → data/<지역>.json, data/index.json 생성. 상세 정보는 state/ 에 캐시해 호출 수를 아낀다.
// 실행: KOPIS_KEY=... DATA_KEY=... node collect.js
const fs = require('fs');
const path = require('path');

const KOPIS_KEY = process.env.KOPIS_KEY;
const DATA_KEY = process.env.DATA_KEY;
if (!KOPIS_KEY || !DATA_KEY) { console.error('KOPIS_KEY, DATA_KEY 환경변수가 필요합니다'); process.exit(1); }

const DAYS_AHEAD = 45;          // 오늘부터 45일 안에 진행되는 행사
const DETAIL_TTL_DAYS = 7;      // 상세 정보 재조회 주기
const BUDGET = { kopis: 4000, culture: 900, tour: 900 }; // 1회 실행당 상세 호출 상한
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const STATE_DIR = path.join(ROOT, 'state');

// ---------- 공통 ----------
const kst = () => new Date(Date.now() + 9 * 3600e3);
const ymd = d => d.toISOString().slice(0, 10).replace(/-/g, '');
const TODAY = ymd(kst());
const UNTIL = ymd(new Date(kst().getTime() + DAYS_AHEAD * 86400e3));
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 공공데이터포털은 초당 요청 제한(코드 23)이 있어 걸리면 쉬었다 재시도, 일일 한도(코드 22)면 포기
let dailyLimitHit = false;
async function get(url, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
      const text = await Promise.race([res.text(), sleep(20000).then(() => { throw new Error('body timeout'); })]);
      if (/LIMITED_NUMBER_OF_SERVICE_REQUESTS_EXCEEDS|returnReasonCode>22</.test(text)) { dailyLimitHit = true; return null; }
      if (/LIMITED_NUMBER_OF_SERVICE_REQUESTS_PER_SECOND|returnReasonCode>23</.test(text)) { await sleep(1500 * (i + 1)); continue; }
      if (res.ok) return text;
      if (res.status === 429) await sleep(5000);
    } catch (e) { /* 재시도 */ }
    await sleep(1000 * (i + 1));
  }
  return null;
}

// 평평한 XML 파서: 태그 → 값 (반복 태그는 배열)
const unxml = s => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').trim();
function xmlItems(xml, tag) {
  const out = [];
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g');
  let m;
  while ((m = re.exec(xml))) {
    const o = {};
    const fre = /<(\w+)>([^<]*(?:<!\[CDATA\[[\s\S]*?\]\]>[^<]*)?)<\/\1>/g;
    let f;
    while ((f = fre.exec(m[1]))) {
      const v = unxml(f[2]);
      if (o[f[1]] === undefined) o[f[1]] = v;
      else o[f[1]] = [].concat(o[f[1]], v);
    }
    out.push(o);
  }
  return out;
}

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) { const k = i++; await fn(items[k], k); }
  }));
}

const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, o, pretty) => fs.writeFileSync(f, JSON.stringify(o, null, pretty ? 1 : 0));
const fresh = c => c && (Date.now() - c.at) / 86400e3 < DETAIL_TTL_DAYS;
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', middot: '·', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', ndash: '–', mdash: '—', hellip: '…', times: '×', sup2: '²', sup3: '³', bull: '•', lrm: '', rlm: '' };
function decode(s) {
  for (let i = 0; i < 3 && /&[a-z0-9#]+;/i.test(s); i++)
    s = s.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
      .replace(/&([a-z0-9]+);/gi, (m, n) => (n in ENT ? ENT[n] : m));
  return s;
}
const clean = s => decode(decode(s || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

// ---------- 지역 ----------
const REGIONS = [
  ['seoul', '서울', /^서울/], ['busan', '부산', /^부산/], ['daegu', '대구', /^대구/],
  ['incheon', '인천', /^인천/], ['gwangju', '광주', /^광주/], ['daejeon', '대전', /^대전/],
  ['ulsan', '울산', /^울산/], ['sejong', '세종', /^세종/], ['gyeonggi', '경기', /^경기/],
  ['gangwon', '강원', /^강원/], ['chungbuk', '충북', /^(충북|충청북)/], ['chungnam', '충남', /^(충남|충청남)/],
  ['jeonbuk', '전북', /^(전북|전라북)/], ['jeonnam', '전남', /^(전남|전라남)/], ['gyeongbuk', '경북', /^(경북|경상북)/],
  ['gyeongnam', '경남', /^(경남|경상남)/], ['jeju', '제주', /^제주/],
];
// 2026 광주·전남 통합: '전남광주통합…' 은 주소에 '○구' 가 있으면 광주(자치구), 아니면 전남(시·군)
const GJ_GU = /(^|[\s\[(])(동|서|남|북|광산)구($|[\s\])])/;
const JN_SIGUN = /(^|[\s\[(])(목포|여수|순천|나주|광양|담양|곡성|구례|고흥|보성|화순|장흥|강진|해남|영암|무안|함평|영광|장성|완도|진도|신안)(시|군)?($|[\s\])])/;
function regionOf(areaText, detailText) {
  const a = (areaText || '').trim();
  // 광주·전남은 출처마다 '광주', '전남', '전남광주통합…' 이 뒤섞여 있어 주소·시군구로 다시 가른다
  if (/^(전남광주|광주|전남|전라남)/.test(a)) {
    const d = detailText || '';
    if (GJ_GU.test(d) || /광주광역시/.test(d)) return 'gwangju';
    if (JN_SIGUN.test(d) || /전라남도/.test(d)) return 'jeonnam';
    return /^(전남광주|광주)/.test(a) ? 'gwangju' : 'jeonnam';
  }
  for (const [code, , re] of REGIONS) if (re.test(a)) return code;
  return null;
}

// ---------- 가격 ----------
function priceOf(raw) {
  const t = clean(raw);
  if (!t) return '';
  if (/^[\s\-·*]*(전석\s*)?무료/.test(t)) return '무료';
  const nums = [...t.matchAll(/(\d{1,3}(?:,\d{3})+|\d{4,})\s*원/g)].map(m => +m[1].replace(/,/g, '')).filter(n => n > 0);
  if (nums.length) {
    const min = Math.min(...nums);
    return min.toLocaleString('ko-KR') + '원' + (new Set(nums).size > 1 ? '~' : '');
  }
  if (/무료|무 료|free/i.test(t)) return '무료';
  return t.length <= 14 && /[가-힣\d]/.test(t) ? t : '';
}

// ---------- 분류 ----------
const KOPIS_GENRE = { '대중음악': '콘서트', '서양음악(클래식)': '클래식', '한국음악(국악)': '국악', '뮤지컬': '뮤지컬', '연극': '연극', '무용(서양/한국무용)': '무용', '대중무용': '무용', '서커스/마술': '서커스·마술', '복합': '공연' };
function cultureCat(realm) {
  if (realm === '전시') return ['전시', '전시'];
  if (realm === '행사/축제') return ['축제', '행사'];
  if (realm === '교육/체험') return ['체험', '체험'];
  const g = { '음악/콘서트': '콘서트', '뮤지컬/오페라': '뮤지컬', '연극': '연극', '무용/발레': '무용', '국악': '국악', '아동/가족': '가족' }[realm];
  return ['공연', g || '공연'];
}

// ---------- KOPIS ----------
async function collectKopis(cache) {
  const list = [];
  for (let page = 1; page < 100; page++) {
    const xml = await get(`http://www.kopis.or.kr/openApi/restful/pblprfr?service=${KOPIS_KEY}&stdate=${TODAY}&eddate=${UNTIL}&cpage=${page}&rows=100`);
    if (!xml) break;
    const items = xmlItems(xml, 'db');
    list.push(...items);
    if (items.length < 100) break;
  }
  console.log('KOPIS 목록', list.length);
  let calls = 0;
  const need = list.filter(x => !fresh(cache.kopis[x.mt20id])).slice(0, BUDGET.kopis);
  // KOPIS 는 초당 10회를 넘기면 서비스가 중지된다 → 동시 2개 + 250ms 간격 (초당 약 6회)
  await pool(need, 2, async x => {
    await sleep(250);
    const xml = await get(`http://www.kopis.or.kr/openApi/restful/pblprfr/${x.mt20id}?service=${KOPIS_KEY}`); calls++;
    const d = xml && xmlItems(xml, 'db')[0];
    if (d) cache.kopis[x.mt20id] = { at: Date.now(), d };
  });
  // 통합특별시 공연장은 주소를 봐야 광주/전남을 가른다
  const fac = [...new Set(list.filter(x => /^전남광주/.test(x.area)).map(x => cache.kopis[x.mt20id]?.d?.mt10id).filter(Boolean))]
    .filter(id => !cache.place[id]);
  await pool(fac, 2, async id => {
    await sleep(250);
    const xml = await get(`http://www.kopis.or.kr/openApi/restful/prfplc/${id}?service=${KOPIS_KEY}`); calls++;
    const d = xml && xmlItems(xml, 'db')[0];
    if (d) cache.place[id] = { adres: d.adres, la: d.la, lo: d.lo };
  });
  console.log('KOPIS 상세 호출', calls);

  return list.map(x => {
    const d = cache.kopis[x.mt20id]?.d || {};
    const pl = cache.place[d.mt10id] || {};
    const region = regionOf(x.area, pl.adres);
    if (!region) return null;
    const sty = clean(d.sty);
    const genre = KOPIS_GENRE[x.genrenm] || x.genrenm || '공연';
    const rel = [].concat(d.relateurl || []);
    return {
      id: 'K' + x.mt20id, src: 'KOPIS', cat: '공연', genre,
      title: x.prfnm, start: x.prfpdfrom.replace(/\./g, ''), end: x.prfpdto.replace(/\./g, ''),
      place: x.fcltynm, addr: pl.adres || '', region,
      price: priceOf(d.pcseguidance), priceText: clean(d.pcseguidance),
      img: x.poster || '', imgs: [].concat(d.styurl || []).slice(0, 6),
      intro: sty.slice(0, 400), cast: clean(d.prfcast).replace(/\s*등$/, '').slice(0, 80),
      time: clean(d.dtguidance).slice(0, 80), age: d.prfage || '', runtime: d.prfruntime || '',
      url: rel[0] || `https://www.kopis.or.kr/por/db/pblprfr/pblprfrView.do?mt20Id=${x.mt20id}`,
      tel: '', lat: +pl.la || null, lng: +pl.lo || null,
    };
  }).filter(Boolean);
}

// ---------- 문화정보원 ----------
async function collectCulture(cache) {
  const list = [];
  for (let page = 1; page < 50; page++) {
    const xml = await get(`https://apis.data.go.kr/B553457/cultureinfo/period2?serviceKey=${DATA_KEY}&PageNo=${page}&numOfrows=500&from=${TODAY}&to=${UNTIL}`);
    if (!xml || !/<resultCode>00</.test(xml)) { if (xml) console.log('문화정보원 오류', xml.slice(0, 200)); break; }
    const items = xmlItems(xml, 'item');
    list.push(...items);
    if (items.length < 500) break;
  }
  console.log('문화정보원 목록', list.length);
  let calls = 0;
  const need = list.filter(x => !fresh(cache.culture[x.seq])).slice(0, BUDGET.culture);
  await pool(need, 1, async x => {
    if (dailyLimitHit) return;
    await sleep(250);
    const xml = await get(`https://apis.data.go.kr/B553457/cultureinfo/detail2?serviceKey=${DATA_KEY}&seq=${x.seq}`); calls++;
    const d = xml && /<resultCode>00</.test(xml) && xmlItems(xml, 'item')[0];
    if (d) cache.culture[x.seq] = { at: Date.now(), d };
  });
  console.log('문화정보원 상세 호출', calls);

  return list.map(x => {
    const d = cache.culture[x.seq]?.d || {};
    const region = regionOf(x.area, `${d.placeAddr || ''} ${x.sigungu || ''} ${(x.title.match(/^\[([^\]]+)\]/) || [])[1] || ''}`);
    if (!region) return null;
    const [cat, genre] = cultureCat(x.realmName);
    return {
      id: 'C' + x.seq, src: '문화포털', cat, genre,
      title: x.title, start: x.startDate, end: x.endDate,
      place: x.place, addr: d.placeAddr || '', region,
      price: priceOf(d.price), priceText: clean(d.price),
      img: d.imgUrl || x.thumbnail || '', imgs: [],
      intro: clean(d.contents1).slice(0, 400), cast: '', time: '', age: '', runtime: '',
      url: d.url || `https://www.culture.go.kr/oneeye/oneEyeView.do?seq=${x.seq}`,
      tel: clean(d.phone), lat: +x.gpsY || null, lng: +x.gpsX || null,
    };
  }).filter(Boolean);
}

// ---------- 관광공사 ----------
async function collectTour(cache) {
  const base = 'https://apis.data.go.kr/B551011/KorService2';
  const q = `serviceKey=${DATA_KEY}&MobileOS=IOS&MobileApp=EventWidget&_type=json`;
  const list = [];
  for (let page = 1; page < 20; page++) {
    const txt = await get(`${base}/searchFestival2?${q}&numOfRows=500&pageNo=${page}&eventStartDate=${TODAY}`);
    let items = [];
    try { items = [].concat(JSON.parse(txt).response.body.items.item || []); } catch { console.log('관광공사 오류', (txt || '').slice(0, 200)); }
    list.push(...items);
    if (items.length < 500) break;
  }
  const inWindow = list.filter(x => x.eventstartdate <= UNTIL);
  console.log('관광공사 목록', inWindow.length);
  let calls = 0;
  const need = inWindow.filter(x => !fresh(cache.tour[x.contentid])).slice(0, Math.floor(BUDGET.tour / 2));
  await pool(need, 1, async x => {
    if (dailyLimitHit) return;
    await sleep(250);
    const c = await get(`${base}/detailCommon2?${q}&contentId=${x.contentid}`);
    await sleep(250);
    const i = await get(`${base}/detailIntro2?${q}&contentId=${x.contentid}&contentTypeId=15`);
    calls += 2;
    try {
      cache.tour[x.contentid] = {
        at: Date.now(),
        c: JSON.parse(c).response.body.items.item[0],
        i: JSON.parse(i).response.body.items.item[0],
      };
    } catch { /* 다음 실행에 재시도 */ }
  });
  console.log('관광공사 상세 호출', calls);

  return inWindow.map(x => {
    const { c = {}, i = {} } = cache.tour[x.contentid] || {};
    const region = regionOf(x.addr1, x.addr1);
    if (!region) return null;
    const home = (clean(c.homepage).match(/https?:\/\/[^\s"']+/) || [])[0];
    return {
      id: 'T' + x.contentid, src: '관광공사', cat: '축제', genre: '축제',
      title: x.title, start: x.eventstartdate, end: x.eventenddate,
      place: clean(i.eventplace) || x.addr2 || x.addr1, addr: [x.addr1, x.addr2].filter(Boolean).join(' '), region,
      price: priceOf(i.usetimefestival) || (/무료/.test(i.usetimefestival || '') ? '무료' : ''), priceText: clean(i.usetimefestival),
      img: x.firstimage || '', imgs: [],
      intro: clean(c.overview).slice(0, 400), cast: '', time: clean(i.playtime).slice(0, 80),
      age: clean(i.agelimit), runtime: '',
      url: home || `https://korean.visitkorea.or.kr/detail/fes_detail.do?cotid=${x.contentid}`,
      tel: clean(x.tel), lat: +x.mapy || null, lng: +x.mapx || null,
    };
  }).filter(Boolean);
}

// ---------- 합치기 ----------
// 제목 앞뒤의 지역 꼬리표 '[광주]', '[전남 광주]', '[양구]' 등을 뗀다
const SIDO = '서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충남|전북|전남|경북|경남|제주';
const REGION_TAG = new RegExp(`^(${SIDO})|(시|군|구)$|^[가-힣]{2}$`);
function stripRegionTag(t) {
  return t.replace(/^\s*\[([^\]]{1,12})\]\s*/, (m, x) => (REGION_TAG.test(x.trim()) ? '' : m))
    .replace(/\s*\[([^\]]{1,12})\]\s*$/, (m, x) => (REGION_TAG.test(x.trim()) ? '' : m)).trim();
}

const normTitle = t => stripRegionTag(t).replace(/\[[^\]]*\]|\([^)]*\)|제\s*\d+\s*회|20\d\d|〈|〉|<|>|「|」|『|』|《|》|\s|[-–:·,.'"!?“”‘’]/g, '').toLowerCase();
function bigrams(s) { const b = new Set(); for (let i = 0; i < s.length - 1; i++) b.add(s.slice(i, i + 2)); return b; }
function similar(a, b) {
  const x = normTitle(a), y = normTitle(b);
  if (!x || !y) return false;
  if (Math.min(x.length, y.length) >= 6 && (x.includes(y) || y.includes(x))) return true;
  // 같은 축제의 다른 작품('…연극제, 치마저고리' / '…연극제, 총과 꽃의 춤')이 합쳐지지 않게 합집합 기준으로 본다
  const A = bigrams(x), B = bigrams(y);
  let n = 0; for (const g of A) if (B.has(g)) n++;
  return n / (A.size + B.size - n) >= 0.6;
}

function merge(all) {
  // 같은 지역·같은 기간에 제목이 비슷하면 하나로. 정보가 많은 쪽을 남기고 빈칸은 다른 쪽으로 채움.
  // id 는 출처 우선순위(KOPIS > 관광공사 > 문화포털)로 고정해서, 실행마다 바뀌어 알림이 다시 뜨는 일을 막는다
  const score = e => (e.intro && !e.introAuto ? 3 : 0) + (e.price ? 2 : 0) + (e.img ? 1 : 0) + (e.src === 'KOPIS' ? 1 : 0);
  const rank = e => ({ K: 0, T: 1, C: 2 }[e.id[0]]);
  const groups = new Map();
  const out = [];
  for (const e of all) {
    const k = `${e.region}|${e.start}|${e.end}`;
    const list = groups.get(k) || [];
    const o = list.find(x => similar(x.title, e.title));
    if (!o) { list.push(e); groups.set(k, list); out.push(e); continue; }
    const [a, b] = score(e) > score(o) ? [e, o] : [o, e];
    const id = rank(a) <= rank(b) ? a.id : b.id;
    const merged = { ...a };
    for (const f of Object.keys(b)) if (!merged[f] || (Array.isArray(merged[f]) && !merged[f].length)) merged[f] = b[f];
    merged.id = id;
    Object.keys(o).forEach(f => delete o[f]);
    Object.assign(o, merged);
  }
  return out;
}

// 소개글이 비어 있으면 아는 정보로 한 줄을 만든다
function fillIntro(e) {
  if (e.intro) return;
  const bits = [];
  if (e.cast) bits.push(`출연 ${e.cast}`);
  if (e.time) bits.push(e.time);
  if (e.runtime) bits.push(`${e.runtime}`);
  if (e.age) bits.push(e.age);
  e.intro = bits.join(' · ');
  e.introAuto = true;
}

(async () => {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const cache = {
    kopis: readJson(path.join(STATE_DIR, 'kopis.json'), {}),
    culture: readJson(path.join(STATE_DIR, 'culture.json'), {}),
    tour: readJson(path.join(STATE_DIR, 'tour.json'), {}),
    place: readJson(path.join(STATE_DIR, 'place.json'), {}),
  };
  const seen = readJson(path.join(STATE_DIR, 'seen.json'), {});

  const saveCache = () => { for (const k of Object.keys(cache)) writeJson(path.join(STATE_DIR, `${k}.json`), cache[k]); };
  const results = await Promise.allSettled([collectKopis(cache), collectCulture(cache), collectTour(cache)].map(p => p.finally(saveCache)));
  if (dailyLimitHit) console.log('공공데이터포털 일일 한도 도달 - 남은 상세는 다음 실행에서');
  const parts = results.map((r, i) => {
    if (r.status === 'fulfilled') return r.value;
    console.log(['KOPIS', '문화정보원', '관광공사'][i], '실패:', r.reason?.message);
    return null;
  });

  // 한 출처가 통째로 실패했으면 그 출처는 지난번 결과를 재사용 (빈 위젯 방지)
  const prev = readJson(path.join(DATA_DIR, 'all.json'), { events: [] }).events;
  const srcNames = ['KOPIS', '문화포털', '관광공사'];
  const all = parts.flatMap((p, i) => p && p.length ? p : prev.filter(e => e.src === srcNames[i] && e.end >= TODAY));

  // 권리자 요청 제외 목록 (blocklist.json)
  const block = readJson(path.join(ROOT, 'blocklist.json'), { ids: [], noImage: [] });
  const blockIds = new Set(block.ids || []), noImage = new Set(block.noImage || []);
  const NOT_EVENT = /모집|서포터즈|공모전|채용|지원사업|확산사업|역량강화사업|수강생|교육생/;
  for (const e of all) for (const f of ['title', 'place', 'addr', 'cast', 'time', 'intro', 'priceText', 'tel', 'age', 'url', 'img']) if (e[f]) e[f] = clean(e[f]);
  let events = merge(all).filter(e => e.end >= TODAY && e.start <= UNTIL && !NOT_EVENT.test(e.title) && !blockIds.has(e.id));
  for (const e of events) if (noImage.has(e.id)) { e.img = ''; e.imgs = []; }
  for (const e of events) {
    e.title = stripRegionTag(e.title) || e.title;
    // '전남광주통합특별시 예술의전당 (구. 광주예술의전당)' → '광주 예술의전당'
    e.place = (e.place || '').replace(/\s*\(구\.?[^)]*\)/g, '')
      .replace(/^전남광주통합특별시\s+/, e.region === 'gwangju' ? '광주 ' : '전남 ').trim();
  }
  events.forEach(fillIntro);
  // 맨 처음 실행에서 본 행사는 '새로 등록'으로 치지 않는다
  const firstRun = !Object.keys(seen).length;
  for (const e of events) { if (!seen[e.id]) seen[e.id] = firstRun ? 'init' : TODAY; e.added = seen[e.id] === 'init' ? '' : seen[e.id]; }
  events.sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end));

  // 오래된 캐시 정리
  const live = new Set(events.map(e => e.id));
  for (const [k, pre] of [['kopis', 'K'], ['culture', 'C'], ['tour', 'T']])
    for (const id of Object.keys(cache[k])) if (!live.has(pre + id) && Date.now() - cache[k][id].at > 30 * 86400e3) delete cache[k][id];
  for (const id of Object.keys(seen)) if (!live.has(id) && seen[id] < ymd(new Date(Date.now() - 60 * 86400e3))) delete seen[id];

  const updated = kst().toISOString().slice(0, 16).replace('T', ' ');
  const index = { updated, today: TODAY, regions: [] };
  for (const [code, name] of REGIONS) {
    const list = events.filter(e => e.region === code);
    writeJson(path.join(DATA_DIR, `${code}.json`), { updated, region: code, name, events: list });
    index.regions.push({ code, name, count: list.length });
  }
  writeJson(path.join(DATA_DIR, 'all.json'), { updated, events });
  writeJson(path.join(DATA_DIR, 'index.json'), index, true);
  for (const k of Object.keys(cache)) writeJson(path.join(STATE_DIR, `${k}.json`), cache[k]);
  writeJson(path.join(STATE_DIR, 'seen.json'), seen);

  console.log(`완료 ${updated} · 총 ${events.length}건`);
  console.log(index.regions.map(r => `${r.name} ${r.count}`).join(' / '));
})();
