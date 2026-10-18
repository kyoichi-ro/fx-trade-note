/* =========================================================
   js/entry-form.js
   S-02 エントリー記録の「画面に依存しない部分」（design.md 14.1、docs/fx-rules.md 5・8・11章、T-17 の下書きの形の拡張＝T-18）。

   【なぜ画面ファイル（screens/entry.js）と分けたのか】
   「任意項目の入力欄をどう読むか」「リスクリワードの欄に何を出すか」「どの入力にどの警告を出すか」「セッションをいつ自動で直すか」
   「下書きをどう読み直すか」は、画面を開かなくても Node.js のテストで確かめられる形にしておきたいため（js/close-form.js と同じ考え方）。
   ここは document も IndexedDB も localStorage も触らない純粋な関数だけ（画面はこの結果を並べて描くだけ）。
   RR・損切り幅・利確幅の計算は calc.js を呼ぶだけで、ここに式は書かない（画面の即時表示と保存で同じ結果になるようにするため）。

   【入力欄の値（fields）の形】下書き（drafts）にもそのまま保存する。入力した文字のまま持つ（architecture 6.5）：
     必須  accountType / pair / side / entryPrice / lots / entryAt … T-17 のとおり
     任意  slPrice / tpPrice  … 入力欄の文字
           entryReasons       … 根拠の配列（複数選択）
           timeframe          … 時間足（'M1'〜'W1'。空文字＝未選択）
           session            … セッション（'tokyo' など。空文字＝未選択。日時から自動判定した値か、手で選んだ値）
           emotion            … 感情（空文字＝未選択）
           tags / memo        … タグの配列・メモ
   キー名は requirements 6.1 に合わせている。T-17 の下書き（任意項目のキーがない）も、足りないキーを初期値で補って読める。
   ========================================================= */
import { parsePrice, parseLots, isFarFromEntry, isOutOfPriceRange, isLargeQuantity } from './validate.js';
import { calcRiskReward, calcSlTpPips, judgeSession } from './calc.js';
import { TIMEFRAME_LABELS, getPairSpec } from './master.js';
import { fromInputValue } from './datetime.js';
import { formatPipsDistance, formatLotUnitWords } from './format.js';

/** 必須グループの欄の並び（画面の上から＝エラーを探す順・フォーカスを移す順） */
export const ENTRY_REQUIRED_KEYS = Object.freeze(['accountType', 'pair', 'side', 'entryPrice', 'lots', 'entryAt']);

/** 詳細（任意）の中の欄の並び（必須の次に、画面の上から） */
export const ENTRY_OPTIONAL_FIELDS = Object.freeze(['slPrice', 'tpPrice']);

/** 時間足の保存値の並び（短い順。画面の表示名は master.js の TIMEFRAME_LABELS） */
export const TIMEFRAMES = Object.freeze(Object.keys(TIMEFRAME_LABELS));

/** セッションの保存値の並び（画面のセグメントの並び：design 14.1.4） */
export const SESSIONS = Object.freeze(['tokyo', 'london', 'newyork', 'other']);

/** 入力画面のセグメントに出すセッション名。「NY」はセグメント幅の都合の略（詳細画面では「ニューヨーク」：design 14.1.4） */
export const SESSION_SEGMENT_LABELS = Object.freeze({ tokyo: '東京', london: 'ロンドン', newyork: 'NY', other: 'その他' });

/** 損切り・利確の欄の名前（E-01〜E-04・W-06 の文の先頭に付ける：design 14.1.8） */
export const SL_LABEL = 'SL（損切り）';
export const TP_LABEL = 'TP（利確）';

const isString = (v) => typeof v === 'string';

/** 文字の配列から、文字でないものと重複を取り除く（壊れた下書きで画面が止まらないように） */
function cleanStrings(v) {
  return Array.isArray(v) ? [...new Set(v.filter(isString))] : [];
}

/* ---------------------------------------------------------
   必須グループの入力チェック（design 14.1.8。T-22 で entry.js から移した：編集画面でも同じ文言・同じ判定を使うため）
   --------------------------------------------------------- */

/** 価格の欄の名前（E-01〜E-04・W-06 の文の先頭に付ける：design 14.1.8） */
export const PRICE_LABEL = 'エントリー価格';

const PRICE_ERRORS = {
  'E-01': `${PRICE_LABEL}：数値で入力してください`,
  'E-02': `${PRICE_LABEL}：0より大きい値を入力してください`,
  'E-03': `${PRICE_LABEL}：価格は小数第3位までで入力してください`,
  'E-04': `${PRICE_LABEL}：価格は小数第5位までで入力してください`,
};
const LOTS_ERRORS = {
  'E-05': 'ロット：0より大きい値を入力してください',
  'E-06': 'ロット：ロットは小数第2位までで入力してください',
};

/**
 * ロット欄の見本（T-33：U-01）。前回値がないとき（その口座で初めての記録）だけ見える。
 * 「0.1」のような数字にすると入力済みの値に見え、そのまま保存して「ロットを入力してください」になるため、数字でない文字にする。
 */
export const LOTS_PLACEHOLDER = '必須';

/**
 * 記録が1件もないときに、ロットの行の下に出す1行（T-33：U-02）。損益（円）が業者の表示と1桁ずれる原因
 * （1lot の通貨数の設定）に、最初の記録の前に気づけるようにする。数値は設定の今の値（選んだ口座の 1lot の通貨数）。
 * 口座を選んでいないときは、両方の口座が同じ値ならその値、違えば両方を出す。値が読めなければ ''（出さない）。
 * @param {string} accountType 'demo' | 'real' | ''（未選択）
 * @param {{ demo: (number|null), real: (number|null) }} lotUnitSizes 設定の 1lot の通貨数
 * @returns {string}
 */
export function lotUnitHint(accountType, lotUnitSizes) {
  const ok = (n) => Number.isFinite(n) && n > 0;
  const tail = '通貨で計算します（設定で変更）';
  if (accountType === 'demo' || accountType === 'real') {
    const n = lotUnitSizes[accountType];
    return ok(n) ? `1lot＝${formatLotUnitWords(n)}${tail}` : '';
  }
  const { demo, real } = lotUnitSizes;
  if (!ok(demo) || !ok(real)) return '';
  if (demo === real) return `1lot＝${formatLotUnitWords(demo)}${tail}`;
  return `1lot＝本番${formatLotUnitWords(real)}・デモ${formatLotUnitWords(demo)}${tail}`;
}

/** 価格の見本：JPYペア「0.000」、非JPYペア「0.00000」（入力できる桁数に合わせる：design 14.1.5）。通貨ペア未選択は JPY 相当 */
export function pricePlaceholder(pair) {
  const digits = pair ? getPairSpec(pair).maxInputDecimals : 3;
  return `0.${'0'.repeat(digits)}`;
}

/**
 * 必須グループの全項目を確かめ、エラー・警告を欄の上からの順に返す。
 * @param {object} f 入力欄の文字（fields）
 * @param {{ lotUnitSize?: (number|null) }} [opts] W-04（数量が大きすぎる）の判定に使う 1lot の通貨数。
 *   新規は「選んだ口座の今の設定値」、編集は「保存される 1lot の通貨数」（口座を変えなければ記録時の値）。null なら W-04 は出さない
 * @returns {{ field: string, type: 'error'|'warning', text: string }[]}
 */
export function checkRequiredFields(f, { lotUnitSize = null } = {}) {
  const out = [];
  const err = (field, text) => out.push({ field, type: 'error', text });
  const warn = (field, text) => out.push({ field, type: 'warning', text });

  if (!f.accountType) err('accountType', 'デモか本番を選んでください');
  if (!f.pair) err('pair', '通貨ペアを選んでください');
  if (!f.side) err('side', '買いか売りを選んでください');

  // 価格：通貨ペアが未選択のときは桁数を決められないので、数値として読めるか・0より大きいかだけを見る
  // （桁の上限が大きい非JPYペアの規則で読み、E-01・E-02 だけを使う。桁数は通貨ペアを選んだ時点でその場で再チェックする）
  const price = parsePrice(f.entryPrice, f.pair || 'EUR/USD');
  if (price.empty) err('entryPrice', 'エントリー価格を入力してください');
  else if (!price.ok && (f.pair || price.error === 'E-01' || price.error === 'E-02')) err('entryPrice', PRICE_ERRORS[price.error]);
  else if (price.ok && f.pair && isOutOfPriceRange(price.value, f.pair)) {
    warn('entryPrice', `${PRICE_LABEL}：${f.pair} の価格としては大きく外れています。通貨ペアと桁を確認してください。`);
  }

  const lots = parseLots(f.lots);
  if (lots.empty) err('lots', 'ロットを入力してください');
  else if (!lots.ok) err('lots', LOTS_ERRORS[lots.error]);
  else if (lotUnitSize != null && isLargeQuantity(lots.value, lotUnitSize)) {
    warn('lots', '数量が非常に大きくなっています。ロットと1lotの通貨数を確認してください。');
  }

  if (!fromInputValue(f.entryAt)) err('entryAt', '日時を入力してください');
  return out;
}

/* ---------------------------------------------------------
   セッション（fx-rules 11.7「再判定のタイミング」）
   --------------------------------------------------------- */

/**
 * 日時欄の値（'2026-10-15T21:30'）から、セッションを自動判定する。日時が空・読めないときは ''（未選択）。
 * 日時欄の値は日本時間として保存形式に直してから判定する（タイムゾーンのない文字を judgeSession にそのまま渡さない：fx-rules 11.7）。
 */
export function autoSession(entryAtInput) {
  return judgeSession(fromInputValue(entryAtInput)) ?? '';
}

/**
 * エントリー日時を変えたときの、セッション欄の新しい値（fx-rules 11.7「再判定のタイミング」）。
 * ・変更前の日時での判定結果と今のセッションが同じなら「自動のまま」とみなし、新しい日時で判定し直す
 * ・違えば手で変えたものとみなし、そのまま残す（手動の選択を優先して上書きしない）
 * 「手で選んだか」を記録する新しいキーは作らない（保存データの形を増やさないため：fx-rules 11.7）。
 * @param {string} prevEntryAt 変更前の日時欄の値
 * @param {string} nextEntryAt 変更後の日時欄の値
 * @param {string} session 今のセッション欄の値（'' は未選択）
 * @returns {string}
 */
export function nextSession(prevEntryAt, nextEntryAt, session) {
  return session === autoSession(prevEntryAt) ? autoSession(nextEntryAt) : session;
}

/** セッション欄の下の説明（design 14.1.4）。今の日時の判定と同じなら「自動」、違えば「手動」。日時が空なら案内 */
export function sessionNote(fields) {
  const auto = autoSession(fields.entryAt);
  if (auto === '' && fields.session === '') return 'エントリー日時を入れると自動で判定します。';
  return fields.session === auto ? 'エントリー日時から自動で判定しました。' : '手動で選択しました。';
}

/* ---------------------------------------------------------
   入力欄の初期値・下書きの読み込み・「変更あり」の判定
   --------------------------------------------------------- */

/**
 * 任意項目の初期値。セッションは日時欄の値から自動判定する（design 14.1.5 ⑩）。
 * @param {string} entryAtInput 日時欄の値
 */
export function defaultOptionalFields(entryAtInput) {
  return {
    slPrice: '', tpPrice: '', entryReasons: [], timeframe: '', session: autoSession(entryAtInput), emotion: '', tags: [], memo: '',
  };
}

/** 初期値のコピー（配列を共有しない：初期値と入力中の値が同じ配列を指して、比べられなくなるのを防ぐ） */
export function cloneFields(f) {
  return { ...f, entryReasons: [...f.entryReasons], tags: [...f.tags] };
}

/**
 * 下書きの fields を、知っている項目だけ取り出す（形が違う項目は初期値のまま。壊れた下書きで画面が止まらないように）。
 * T-17 までの下書きには任意項目のキーがない。足りないキーは初期値で補う（後方互換）。
 * セッションだけは、下書きに値がなければ「下書きの日時」から自動判定する（今の時刻の初期値を持ち込むと、日時とちぐはぐになるため）。
 * @param {object|null} draft
 * @param {object} defaults 必須・任意すべての初期値（defaultOptionalFields を含む）
 */
export function fieldsFromEntryDraft(draft, defaults) {
  const out = cloneFields(defaults);
  const src = (draft && draft.fields) || {};
  for (const k of [...ENTRY_REQUIRED_KEYS, 'slPrice', 'tpPrice', 'emotion', 'memo']) {
    if (isString(src[k])) out[k] = src[k];
  }
  if (!['demo', 'real', ''].includes(out.accountType)) out.accountType = defaults.accountType;
  if (!['buy', 'sell', ''].includes(out.side)) out.side = '';
  if (isString(src.timeframe) && (src.timeframe === '' || TIMEFRAMES.includes(src.timeframe))) out.timeframe = src.timeframe;
  if (Array.isArray(src.entryReasons)) out.entryReasons = cleanStrings(src.entryReasons);
  if (Array.isArray(src.tags)) out.tags = cleanStrings(src.tags);
  out.session = isString(src.session) && (src.session === '' || SESSIONS.includes(src.session)) ? src.session : autoSession(out.entryAt);
  return out;
}

/**
 * 初期値から変わっているか（キャンセル時の破棄確認・下書きを作るかの判定：design 14.1.6・14.1.10）。
 * 根拠・タグは選んだ順ではなく中身で比べる（外して付け直しただけで「変更あり」にしないため）。
 * セッションは日時を変えると自動で変わるので、手で選び直さない限り日時の変更と一緒に扱われる。
 */
export function isEntryChanged(initial, fields) {
  const key = (f) => JSON.stringify([
    ...ENTRY_REQUIRED_KEYS.map((k) => f[k]),
    f.slPrice, f.tpPrice, [...f.entryReasons].sort(), f.timeframe, f.session, f.emotion, [...f.tags].sort(), f.memo,
  ]);
  return key(initial) !== key(fields);
}

/** 「詳細（任意）」の中身の一覧（開いているとき・何も入っていないとき：design 14.1.4。画像は T-24 で足した） */
export const ENTRY_DETAILS_LIST = 'SL・TP、根拠、感情、タグ、メモ、画像';

/**
 * 「詳細（任意）」を閉じているときの2行目。値が入っている項目名を出す（design 14.1.4）。例「SL・TP、メモ 入力済み」。
 * セッションは日時から自動で入っているので数えない（手で選び直したときだけ数える）。何も入っていなければ中身の一覧。
 * 画像は入力欄の文字（fields）には入らない（IndexedDB の images にある）ので、追加した枚数を imageCount で受け取る（T-24）。
 * @param {object} f
 * @param {number} [imageCount] この入力で追加した画像の枚数
 */
export function entryDetailsSummary(f, imageCount = 0) {
  const filled = [];
  if (f.slPrice !== '' || f.tpPrice !== '') filled.push('SL・TP');
  if (f.entryReasons.length > 0) filled.push('根拠');
  if (f.timeframe) filled.push('時間足');
  if (f.session !== autoSession(f.entryAt)) filled.push('セッション');
  if (f.emotion) filled.push('感情');
  if (f.tags.length > 0) filled.push('タグ');
  if (f.memo !== '') filled.push('メモ');
  if (imageCount > 0) filled.push('画像');
  return filled.length > 0 ? `${filled.join('、')} 入力済み` : ENTRY_DETAILS_LIST;
}

/* ---------------------------------------------------------
   損切り・利確の読み取り・リスクリワードの表示・警告（design 14.1.7・14.1.8、fx-rules 5・8章）
   --------------------------------------------------------- */

/** 空欄・数値でない・桁数超過などは「値なし」。画面の表示と保存で同じ読み方にするため、ここ1か所で読む */
function levelValue(r) {
  return r.ok && !r.empty ? r.value : null;
}

const LEVEL_ERRORS = (label) => ({
  'E-01': `${label}：数値で入力してください`,
  'E-02': `${label}：0より大きい値を入力してください`,
  'E-03': `${label}：価格は小数第3位までで入力してください`,
  'E-04': `${label}：価格は小数第5位までで入力してください`,
});

/** W-01 の文言（design 14.1.8）。SL は「建値へ動かした」場合を添え、TP は確認を促す */
const W01_TEXT = {
  buy: {
    SL: '買いなのにSLがエントリー価格以上です。SLを建値以上に動かした場合はこのままで問題ありません。',
    TP: '買いなのにTPがエントリー価格以下です。入力内容を確認してください。',
  },
  sell: {
    SL: '売りなのにSLがエントリー価格以下です。SLを建値以下に動かした場合はこのままで問題ありません。',
    TP: '売りなのにTPがエントリー価格以上です。入力内容を確認してください。',
  },
};
const W03_TEXT = '損切り/利確ラインがエントリー価格から大きく離れています。入力内容を確認してください。';

/** リスクリワードの欄の2行目の案内（design 14.1.7 の表） */
export const RR_HINT = Object.freeze({
  needBoth: 'SLとTPの両方を入れると計算します',
  needEntry: 'エントリー価格と売買方向を入れると計算します',
  needPair: '通貨ペアを選ぶと計算します',
});

/**
 * 損切り・利確グループの内容を求める（1文字入力するたびに画面が呼ぶ）。
 * ・rr：リスクリワードの欄。value は「2.00」か「—」、sub は2行目（なければ null）。表の条件は design 14.1.7：
 *     SL・TP のどちらかが空 → 「—」＋「SLとTPの両方を入れると計算します」
 *     エントリー価格・売買方向が未入力 → 「—」＋「エントリー価格と売買方向を入れると計算します」
 *     方向と矛盾（W-01）→ 「—」（2行目なし。グループの下に警告文）
 *     正しい並び → 「2.00」＋「損切り 20.0 pips・利確 40.0 pips」
 *   RR は事実の表示のみ。値の良し悪しを色やコメントで評価しない（助言をしない方針：design 14.1.7）。
 * ・issues：エラー（E-01〜E-04）と警告（W-01・W-03・W-06）を、SL → TP の順に。画面は「欄から離れた・保存を押した」欄だけ出す（visibleIssues）。
 *   W-01 は calcRiskReward が返す（SL・TP の両方と通貨ペア・売買方向・エントリー価格がそろったときだけ：fx-rules 5.3）ので、
 *   SL だけ先に入れた入力途中や、エントリー価格を打ち直している途中には出ない。
 * ・slPrice / tpPrice：保存する数値（空・エラーなら null）
 * @param {object} f 入力欄の値（fields）
 */
export function evaluateLevels(f) {
  const pair = f.pair || '';
  // 通貨ペアが未選択のときは桁数を決められないので、桁の上限が大きい非JPYペアの規則で読む（E-01・E-02 だけを使う。entry.js の価格と同じ）
  const readPair = pair || 'EUR/USD';
  const entry = parsePrice(f.entryPrice, readPair);
  const sl = parsePrice(f.slPrice, readPair);
  const tp = parsePrice(f.tpPrice, readPair);
  const entryPrice = levelValue(entry);
  const slPrice = levelValue(sl);
  const tpPrice = levelValue(tp);
  const side = f.side === 'buy' || f.side === 'sell' ? f.side : null;

  const input = { pair: pair || null, side, entryPrice, slPrice, tpPrice };
  const { rr, warn } = calcRiskReward(input);
  const { riskPips, rewardPips } = calcSlTpPips(input);

  const rrView = { value: '—', sub: null };
  if (slPrice == null || tpPrice == null) rrView.sub = RR_HINT.needBoth;
  else if (!pair) rrView.sub = RR_HINT.needPair;
  else if (entryPrice == null || side == null) rrView.sub = RR_HINT.needEntry;
  else if (rr != null) {
    rrView.value = rr.toFixed(2);
    rrView.sub = `損切り ${formatPipsDistance(riskPips)}・利確 ${formatPipsDistance(rewardPips)}`;
  }

  const issues = [];
  for (const [field, label, kind, r, value] of [
    ['slPrice', SL_LABEL, 'SL', sl, slPrice], ['tpPrice', TP_LABEL, 'TP', tp, tpPrice],
  ]) {
    // 桁数の上限は通貨ペアを選んでからでないと決められない（選んだ時点でその場で再チェックする：design 14.1.8）
    if (!r.ok && (pair || r.error === 'E-01' || r.error === 'E-02')) issues.push({ field, type: 'error', text: LEVEL_ERRORS(label)[r.error] });
    if (warn.includes(kind)) issues.push({ field, type: 'warning', text: W01_TEXT[side][kind] });
    // W-03・W-06 は通貨ペアごとの桁・価格帯で見るので、通貨ペアを選んでから
    if (pair && value != null && entryPrice != null && isFarFromEntry(entryPrice, value, pair)) {
      issues.push({ field, type: 'warning', text: W03_TEXT });
    }
    if (pair && value != null && isOutOfPriceRange(value, pair)) {
      issues.push({ field, type: 'warning', text: `${label}：${pair} の価格としては大きく外れています。通貨ペアと桁を確認してください。` });
    }
  }

  return { rr: rrView, rrValue: rr, riskPips, rewardPips, slPrice, tpPrice, issues };
}

/**
 * 出してよい欄の分だけ、エラー・警告を取り出す。同じ文は1つにまとめる
 * （W-03 は「SL または TP」の警告なので、両方が離れていても1行にするため）。
 * @param {{field:string, type:string, text:string}[]} issues
 * @param {Set<string>} shown 欄から離れた・保存を押した欄
 */
export function visibleIssues(issues, shown) {
  const seen = new Set();
  return issues.filter((i) => {
    if (!shown.has(i.field) || seen.has(i.text)) return false;
    seen.add(i.text);
    return true;
  });
}

/* ---------------------------------------------------------
   保存する任意項目の組み立て
   --------------------------------------------------------- */

/**
 * 保存する任意項目（trades.js の saveNewTrade に渡す形・requirements 6.1 のキー名）を作る。入力チェックを通ったあとに呼ぶ。
 * riskReward・session の最終的な値は保存側（trades.js の recompute）が決める。ここでは riskReward は渡さない。
 * 空の欄は null（根拠・タグは空の配列）。メモは空白だけなら null で、それ以外は入力のまま（改行も残す）。
 * @param {object} f 入力欄の値（fields）
 */
export function buildOptionalInput(f) {
  const lv = evaluateLevels(f);
  return {
    slPrice: lv.slPrice,
    tpPrice: lv.tpPrice,
    entryReasons: [...f.entryReasons],
    timeframe: f.timeframe === '' ? null : f.timeframe,
    session: f.session === '' ? null : f.session,
    emotion: f.emotion === '' ? null : f.emotion,
    tags: [...f.tags],
    memo: f.memo.trim() === '' ? null : f.memo,
  };
}
