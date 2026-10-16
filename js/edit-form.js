/* =========================================================
   js/edit-form.js
   S-05 編集の「画面に依存しない部分」（design.md 14.5、docs/fx-rules.md 4.4・4.5・5・8・11章、T-22）。

   【なぜ画面ファイル（screens/edit.js）と分けたのか】
   「記録を入力欄の値にどう直すか」「口座区分を変えたとき 1lot の通貨数をどうするか」「入力欄から保存する記録をどう組み立てるか」
   「変更があったか」「別の画面に先に変更されたときどう重ねるか」は、データ消失・計算ミスに直結する判断なので、
   画面を開かなくても Node.js のテストで確かめられる形にしておきたいため（entry-form.js・close-form.js と同じ考え方）。
   ここは document も IndexedDB も localStorage も触らない純粋な関数だけ。

   【再利用しているもの（独自の式・独自の文言を作らない）】
   ・必須項目のチェック・SL/TP と RR の表示と警告・セッションの手動優先 → entry-form.js
   ・決済価格・円換算レート・日時・手入力損益のチェックと損益の表示 → close-form.js の evaluateClose / describeProfit
   ・pips・損益・RR の計算 → trades.js の computeClose / buildClosedTrade・calc.js（保存側の recompute() が最終的に決め直す）

   【入力欄の値（fields）の形】下書き（drafts）にもそのまま保存する。入力した文字のまま持つ（architecture 6.5）。
     entry-form.js の欄：accountType / pair / side / entryPrice / lots / entryAt / slPrice / tpPrice / entryReasons / timeframe / session /
                         emotion / tags / memo
     close-form.js の欄：exitPrice / quoteToJpyRate / exitAt / profitMode / manualSign / manualAmount / exitReason / exitEmotion
   決済の欄は保有中の記録では使わない（空のまま持つだけ）。タグ・メモはエントリー・決済で共通の1つ（design 14.5.2）。
   ========================================================= */
import {
  parsePrice, parseLots, parseQuoteToJpyRate,
} from './validate.js';
import { fromInputValue, toInputValue } from './datetime.js';
import { getPairSpec } from './master.js';
import { judgeStatus, recompute, buildClosedTrade } from './trades.js';
import {
  SESSIONS, TIMEFRAMES, autoSession, evaluateLevels, checkRequiredFields, buildOptionalInput,
} from './entry-form.js';
import { EXIT_REASONS, evaluateClose, resolveManualProfit } from './close-form.js';
import { formatLotUnit } from './format.js';

/** 編集で持つ入力欄の名前（下書きの読み書き・「別の画面で変更されたとき」の重ね合わせで使う） */
export const EDIT_FIELD_KEYS = Object.freeze([
  'accountType', 'pair', 'side', 'entryPrice', 'lots', 'entryAt', 'slPrice', 'tpPrice', 'entryReasons', 'timeframe', 'session',
  'emotion', 'tags', 'memo',
  'exitPrice', 'quoteToJpyRate', 'exitAt', 'profitMode', 'manualSign', 'manualAmount', 'exitReason', 'exitEmotion',
]);

/** 「キャンセル」の確認シートの見出し（design 14.7.4：編集の破棄。router.js の back() が使う） */
export const EDIT_DISCARD_TITLE = '変更を破棄しますか？';

/** 保存後のトースト（design 14.5.1。1lot の変更はトーストで繰り返さない：14.5.3） */
export const EDIT_SAVED_TOAST = '変更を保存しました';

const isString = (v) => typeof v === 'string';

/** 文字の配列から、文字でないものと重複を取り除く（壊れた記録・下書きで画面が止まらないように） */
function cleanStrings(v) {
  return Array.isArray(v) ? [...new Set(v.filter(isString))] : [];
}

/**
 * 数値を入力欄の文字にする。1e-7 のような指数表記にならないようにする（欄に「1e-7」と出るとエラーになるため）。
 * 空・数値でない値は ''。
 */
function numberToText(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '';
  const s = String(n);
  return /e/i.test(s) ? n.toFixed(10).replace(/\.?0+$/, '') : s;
}

/** 欄の値のコピー（配列を共有しない：初期値と入力中の値が同じ配列を指して、比べられなくなるのを防ぐ） */
export function cloneEditFields(f) {
  return { ...f, entryReasons: [...f.entryReasons], tags: [...f.tags] };
}

/* ---------------------------------------------------------
   記録 → 入力欄の値、下書き → 入力欄の値
   --------------------------------------------------------- */

/**
 * 保存されている記録を、入力欄の値にする（design 14.5.1「初期値は記録の値」）。
 * ・価格・ロットは数値を文字にしただけ（末尾の 0 は元から保存されていない）。日時は日本時間の欄の値
 * ・損益が手入力（profitSource＝manual）の記録は、最初から「確定損益」の形（符号＋金額）で開く（design 14.5.2）
 * ・セッションは、保存されている正しい値を使い、空・知らない値のときだけ日時から自動判定した値にする（fx-rules 11.7：保存値が正）
 * ・時間足・決済理由・感情は、知らない文字でも消さずにそのまま持つ（保存でうっかり消さないため。画面はその値のチップも出す）
 * @param {object} trade 保存されている記録
 */
export function editFieldsFromTrade(trade) {
  const entryAt = toInputValue(trade.entryAt);
  const manual = trade.profitSource === 'manual' && typeof trade.profitJpy === 'number';
  return {
    accountType: trade.accountType === 'demo' || trade.accountType === 'real' ? trade.accountType : '',
    pair: isString(trade.pair) ? trade.pair : '',
    side: trade.side === 'buy' || trade.side === 'sell' ? trade.side : '',
    entryPrice: numberToText(trade.entryPrice),
    lots: numberToText(trade.lots),
    entryAt,
    slPrice: numberToText(trade.slPrice),
    tpPrice: numberToText(trade.tpPrice),
    entryReasons: cleanStrings(trade.entryReasons),
    timeframe: isString(trade.timeframe) ? trade.timeframe : '',
    session: SESSIONS.includes(trade.session) ? trade.session : autoSession(entryAt),
    emotion: isString(trade.emotion) ? trade.emotion : '',
    tags: cleanStrings(trade.tags),
    memo: isString(trade.memo) ? trade.memo : '',
    exitPrice: numberToText(trade.exitPrice),
    quoteToJpyRate: numberToText(trade.quoteToJpyRate),
    exitAt: toInputValue(trade.exitAt),
    profitMode: manual ? 'manual' : 'auto',
    manualSign: manual && trade.profitJpy < 0 ? '-' : '+',
    manualAmount: manual ? String(Math.abs(trade.profitJpy)) : '',
    exitReason: isString(trade.exitReason) ? trade.exitReason : '',
    exitEmotion: isString(trade.exitEmotion) ? trade.exitEmotion : '',
  };
}

/**
 * 下書きの fields を、知っている項目だけ取り出す（形が違う項目は記録の値のまま。壊れた下書きで画面が止まらないように）。
 * @param {object|null} draft
 * @param {object} base editFieldsFromTrade の結果（記録の値）
 */
export function fieldsFromEditDraft(draft, base) {
  const out = cloneEditFields(base);
  const src = (draft && draft.fields) || {};
  for (const k of ['entryPrice', 'lots', 'entryAt', 'slPrice', 'tpPrice', 'emotion', 'memo', 'exitPrice', 'quoteToJpyRate', 'exitAt',
    'manualAmount', 'exitEmotion']) {
    if (isString(src[k])) out[k] = src[k];
  }
  if (isString(src.pair) && src.pair !== '') out.pair = src.pair;
  if (src.accountType === 'demo' || src.accountType === 'real') out.accountType = src.accountType;
  if (src.side === 'buy' || src.side === 'sell') out.side = src.side;
  if (isString(src.timeframe) && (src.timeframe === '' || TIMEFRAMES.includes(src.timeframe))) out.timeframe = src.timeframe;
  if (isString(src.session) && (src.session === '' || SESSIONS.includes(src.session))) out.session = src.session;
  if (isString(src.exitReason) && (src.exitReason === '' || EXIT_REASONS.includes(src.exitReason))) out.exitReason = src.exitReason;
  if (Array.isArray(src.entryReasons)) out.entryReasons = cleanStrings(src.entryReasons);
  if (Array.isArray(src.tags)) out.tags = cleanStrings(src.tags);
  if (src.profitMode === 'auto' || src.profitMode === 'manual') out.profitMode = src.profitMode;
  if (src.manualSign === '+' || src.manualSign === '-') out.manualSign = src.manualSign;
  return out;
}

/* ---------------------------------------------------------
   変更の検出
   --------------------------------------------------------- */

/** 手入力が「入っている」ときだけ符号付きの文字にする（金額が空なら上書きしない扱い：close-form.js と同じ） */
function manualKey(f) {
  return f.profitMode === 'manual' && f.manualAmount !== '' ? `${f.manualSign}${f.manualAmount}` : '';
}

/**
 * 記録を開いたときの値から変わっているか（キャンセル時の破棄確認・下書きを作るかの判定：design 14.5.5・14.1.10）。
 * ・根拠・タグは選んだ順ではなく中身で比べる（外して付け直しただけで「変更あり」にしない）
 * ・「確定損益を入力」を開いただけ（金額が空）は変更とみなさない
 * ・セッションは手で選び直したときと、日時を変えて自動で変わったときに差になる
 * 決済の欄は保有中の記録では空のままなので、比べても差は出ない。
 */
export function isEditChanged(initial, fields) {
  const key = (f) => JSON.stringify([
    f.accountType, f.pair, f.side, f.entryPrice, f.lots, f.entryAt, f.slPrice, f.tpPrice, [...f.entryReasons].sort(), f.timeframe,
    f.session, f.emotion, [...f.tags].sort(), f.memo,
    f.exitPrice, f.quoteToJpyRate, f.exitAt, manualKey(f), f.exitReason, f.exitEmotion,
  ]);
  return key(initial) !== key(fields);
}

/**
 * 保存する記録が、保存されている記録と中身まで同じか（updatedAt・syncStatus など保存で必ず変わる項目は見ない）。
 * 「150」を「150.0」と打ち直しただけ、などの「文字は変わったが値は同じ」ときに、保存せず updatedAt を変えないために使う
 * （design 14.5.1「変更がないまま保存：保存処理をせずに S-04 へ戻る」）。
 * 比べる前に recompute() を通すのは、保存側（saveTrade）が status・RR・セッションを同じ関数で決め直すため。
 * 根拠・タグは中身で比べる（順番だけの違いでは保存しない）。
 * @param {object} stored 保存されている記録
 * @param {object} built buildEditedTrade() の結果
 */
export function isSameTradeContent(stored, built) {
  const next = recompute(built);
  const norm = (t) => {
    const o = { ...t };
    delete o.updatedAt;
    delete o.syncStatus;
    o.entryReasons = [...(t.entryReasons || [])].sort();
    o.tags = [...(t.tags || [])].sort();
    return JSON.stringify(Object.keys(o).sort().map((k) => [k, o[k] ?? null]));
  };
  return norm(stored) === norm(next);
}

/* ---------------------------------------------------------
   口座区分と 1lot の通貨数（fx-rules 4.5・design 14.5.3）
   --------------------------------------------------------- */

/**
 * 保存する 1lot の通貨数。口座区分が記録のままなら記録時の値、変えたなら変更先の口座の今の設定値。
 * 「元の口座に戻したら記録時の値に戻す」（押し間違いを元どおりにできるように）は、この1つの関数で自然に満たされる
 * （画面の途中の状態を持たず、そのときの口座だけで決まるため）。
 * 記録に値がない（壊れた記録）ときは今の設定値で補う。口座が未選択（'' ）のときは null。
 * @param {object} stored 保存されている記録
 * @param {string} accountType 今選んでいる口座
 * @param {(accountType: 'demo'|'real') => number} getLotUnitSize 口座ごとの今の設定値
 * @returns {number|null}
 */
export function lotUnitSizeFor(stored, accountType, getLotUnitSize) {
  if (accountType !== 'demo' && accountType !== 'real') return null;
  if (accountType === stored.accountType && typeof stored.lotUnitSize === 'number') return stored.lotUnitSize;
  return getLotUnitSize(accountType);
}

/** 口座の名前（画面の文言用） */
const ACCOUNT_NAMES = { demo: 'デモ', real: '本番' };

/**
 * 下部の保存ボタンの文字（design 14.5.1・14.5.3）。口座を記録から変えたときだけ「デモに変更して保存」「本番に変更して保存」。
 * 元の口座に戻したら「変更を保存」に戻る。
 */
export function editSaveLabel(storedAccountType, accountType) {
  if (accountType !== storedAccountType && ACCOUNT_NAMES[accountType]) return `${ACCOUNT_NAMES[accountType]}に変更して保存`;
  return '変更を保存';
}

/** エントリーグループの下の説明文のふだんの文（口座を変えていない・変えても 1lot が同じとき：design 14.5.2） */
export const LOT_UNIT_NOTE = '1lotの通貨数は記録したときの設定値です。';

/**
 * 1lot の通貨数の行と、その下の説明文を決める（design 14.5.3 の表）。
 * ・口座を変え、1lot の値が変わる → 「口座をデモに変えたため、1lotの通貨数を 10,000 → 100,000 に変更しました。…」
 *     後半は 決済済み・自動計算：「損益を計算し直しています。」／決済済み・手入力：「損益（円）は手入力の値のまま変わりません。」／
 *     保有中：「決済したときの損益に使います。」
 * ・口座を変えたが両方の設定値が同じ → 説明文は出さない（何も変わらないため）。ふだんの文のまま
 * ・元の口座に戻した → ふだんの文（1lot は記録時の値）
 * @param {object} stored 保存されている記録
 * @param {object} fields 入力欄の値
 * @param {{ getLotUnitSize: Function, closed: boolean, manualProfit: boolean }} ctx
 *   manualProfit：保存される損益が手入力の値か（説明文の後半の出し分け）
 * @returns {{ size: (number|null), text: string, changed: boolean }}
 */
export function describeLotUnit(stored, fields, { getLotUnitSize, closed, manualProfit }) {
  const size = lotUnitSizeFor(stored, fields.accountType, getLotUnitSize);
  const before = typeof stored.lotUnitSize === 'number' ? stored.lotUnitSize : null;
  const accountChanged = fields.accountType !== stored.accountType;
  const valueChanged = accountChanged && size != null && before != null && size !== before;
  if (!valueChanged) return { size, text: LOT_UNIT_NOTE, changed: false };
  const tail = !closed ? '決済したときの損益に使います。'
    : manualProfit ? '損益（円）は手入力の値のまま変わりません。' : '損益を計算し直しています。';
  return {
    size,
    text: `口座を${ACCOUNT_NAMES[fields.accountType]}に変えたため、1lotの通貨数を ${formatLotUnit(before)} → ${formatLotUnit(size)} に変更しました。${tail}`,
    changed: true,
  };
}

/* ---------------------------------------------------------
   入力チェックと計算（design 14.5.4）
   --------------------------------------------------------- */

/**
 * 日時欄の値を保存形式にする。ただし欄の値が「記録の日時を欄の値にしたもの」のままなら、記録の値をそのまま使う。
 * 欄は分までなので、秒まで持つ日時（21:30:12）を直さずに保存すると秒が黙って 00 になってしまうため（直した日時だけ書き換える）。
 */
function atValue(text, original) {
  return text !== '' && text === toInputValue(original) ? original : fromInputValue(text);
}

/** 入力欄の文字を数値に（読めない・空なら null） */
function priceValue(text, pair) {
  const r = parsePrice(text, pair);
  return r.ok && !r.empty ? r.value : null;
}

/**
 * 入力欄の値から、チェックの結果・計算結果・口座変更の表示をまとめて求める（1文字入力するたびに画面が呼ぶ）。
 * issues は画面の上から順（必須 → 決済 → 損益 → 損切り・利確）。画面は「欄から離れた」などで出してよいものだけを出す。
 *   field：必須は entry-form.js の ENTRY_REQUIRED_KEYS、損切り・利確は slPrice / tpPrice、
 *          決済は 'exitPrice' | 'quoteToJpyRate' | 'exitAt' | 'manualProfit' | 'profitNeed'（E-11：保存を押したときだけ出す）
 * 決済済みの記録では、エントリー側（価格・ロット・日時・口座）を直した結果をそのまま決済の計算（pips・損益・E-10・W-02）に使う
 * （design 14.5.4）。エントリー価格が読めないうちは pips・損益は「—」になる（close-form.js の計算は空の値で止まらない：fx-rules 4.5）。
 * @param {object} stored 保存されている記録
 * @param {object} fields 入力欄の値
 * @param {{ getLotUnitSize: Function, now?: Date }} ctx
 */
export function evaluateEdit(stored, fields, { getLotUnitSize, now = new Date() }) {
  const closed = judgeStatus(stored) === 'closed';
  const pair = fields.pair;
  const lotsRead = parseLots(fields.lots);
  const lotUnitSize = lotUnitSizeFor(stored, fields.accountType, getLotUnitSize);

  // 決済済みなら、エントリー側の入力から作った「仮の記録」で決済の欄を評価する（読めない値は null）
  let close = null;
  if (closed && pair) {
    close = evaluateClose({
      pair,
      side: fields.side || null,
      entryPrice: priceValue(fields.entryPrice, pair),
      entryAt: fromInputValue(fields.entryAt),
      lots: lotsRead.ok && !lotsRead.empty ? lotsRead.value : null,
      lotUnitSize,
    }, fields, { now });
  }
  const manualProfit = Boolean(close && close.profitSource === 'manual');
  const lotUnit = describeLotUnit(stored, fields, { getLotUnitSize, closed, manualProfit });
  const levels = evaluateLevels(fields);
  const issues = [
    ...checkRequiredFields(fields, { lotUnitSize }),
    ...(close ? close.issues : []),
    ...levels.issues,
  ];
  return {
    closed, close, levels, lotUnit, issues,
    hasError: issues.some((i) => i.type === 'error'),
    saveLabel: editSaveLabel(stored.accountType, fields.accountType),
  };
}

/* ---------------------------------------------------------
   保存する記録の組み立て
   --------------------------------------------------------- */

/**
 * 入力欄の値から、saveTrade に渡す記録を組み立てる（入力チェックを通ったあとに呼ぶ。DB に触れない）。
 *
 * 【データを落とさないための約束】
 * ・保存されている記録（stored）を土台にして、編集できる項目だけを置き換える。画像（imageIds）・createdAt・syncStatus などの
 *   編集しない項目は stored のまま残る（saveTrade も createdAt・deletedAt・syncedAt は保存済みの値を使う）。
 * ・status・riskReward・session の最終決定は saveTrade の recompute()（渡された値を信用しない）。
 * 【計算】
 * ・lotUnitSize は lotUnitSizeFor（口座を変えたら変更先の今の設定値、変えていなければ記録時の値）
 * ・決済済みなら buildClosedTrade で pips・損益を求め直す。手入力（manual）の損益は入力欄の値のまま（口座区分を変えても書き換えない：
 *   fx-rules 4.5）。自動計算の損益は新しい 1lot で計算し直す。
 * ・保有中の記録の決済の欄は触らない（pips・損益などは空のまま）
 * ・タグ・メモは空白だけなら null（entry-form.js の buildOptionalInput と同じ）
 * @param {object} stored 保存されている記録
 * @param {object} fields 入力欄の値（検査済み）
 * @param {{ getLotUnitSize: Function }} ctx
 * @returns {object} 32項目の記録（status などは未決定）
 */
export function buildEditedTrade(stored, fields, { getLotUnitSize }) {
  const pair = fields.pair;
  const entryPrice = priceValue(fields.entryPrice, pair);
  const lotsRead = parseLots(fields.lots);
  const entryAt = atValue(fields.entryAt, stored.entryAt);
  if (entryPrice == null || !lotsRead.ok || lotsRead.empty || entryAt == null || !pair
    || (fields.side !== 'buy' && fields.side !== 'sell') || lotUnitSizeFor(stored, fields.accountType, getLotUnitSize) == null) {
    // 入力画面が必ず検査してから渡す。ここに来るのはプログラムの誤り
    throw new TypeError('edit-form：必須項目が足りない入力から記録を組み立てようとしました');
  }
  const optional = buildOptionalInput(fields);
  const entryPart = {
    ...stored,
    accountType: fields.accountType,
    pair,
    side: fields.side,
    entryPrice,
    entryAt,
    lots: lotsRead.value,
    lotUnitSize: lotUnitSizeFor(stored, fields.accountType, getLotUnitSize),
    ...optional,
  };
  if (judgeStatus(stored) !== 'closed') return entryPart;

  const exit = parsePrice(fields.exitPrice, pair);
  const exitAt = atValue(fields.exitAt, stored.exitAt);
  const rate = getPairSpec(pair).isJpyPair ? { ok: true, value: null } : parseQuoteToJpyRate(fields.quoteToJpyRate);
  const manual = resolveManualProfit(fields);
  if (!exit.ok || exit.empty || exitAt == null || !rate.ok || manual.ok === false) {
    throw new TypeError('edit-form：決済の入力が足りない・正しくないまま記録を組み立てようとしました');
  }
  return buildClosedTrade(entryPart, {
    exitPrice: exit.value,
    exitAt,
    quoteToJpyRate: rate.value,
    manualProfitJpy: manual.ok ? manual.value : null,
    exitReason: fields.exitReason === '' ? null : fields.exitReason,
    exitEmotion: fields.exitEmotion === '' ? null : fields.exitEmotion,
    tags: optional.tags,
    memo: optional.memo,
  });
}

/* ---------------------------------------------------------
   通貨ペアを変えたときの円換算レート（fx-rules 4.5「編集で通貨ペアを変え、決済通貨が変わるとき」の推奨案）
   --------------------------------------------------------- */

/** 円換算ペア（決済通貨/JPY）。JPYペアは null（円換算レートを使わない）。通貨ペアが空・書式違いでも例外にしない */
function quoteToJpyPairOf(pair) {
  return pair ? getPairSpec(pair).quoteToJpyPair : null;
}

/**
 * 通貨ペアを変えたあとの、円換算レート欄の値を決める。
 * 円換算レートは「決済通貨/JPY」のレートなので、決済通貨が変わる（EUR/USD の USD/JPY → EUR/GBP の GBP/JPY など）と、
 * 古い値は別の通貨のレートになり、そのまま自動計算に使うと損益（円）が誤る。そこで次のように決める：
 *   ・円換算ペアが変わらない（EUR/USD → GBP/USD など、決済通貨が同じ）→ 今の値を残す
 *   ・変わるが、記録を開いたときのペアの円換算ペアに戻った → 記録の値に戻す（押し間違いを元どおりにする。口座区分の 1lot と同じ考え方）
 *   ・それ以外（決済通貨が変わる・JPYペアにした）→ 空にする。自動計算の記録は保存時に E-11 で入力を促す。
 *     手入力（manual）の損益は円換算レートに関係なく変わらない
 * JPYペア→非JPYペアも、前のペアが円換算ペアを持たないので「変わる」側（記録が JPY のときは元々空）。
 * @param {{ pair: string, quoteToJpyRate: string }} initial 記録を開いたときの入力欄の値
 * @param {{ pair: string, quoteToJpyRate: string }} prev 変える前の入力欄の値
 * @param {string} nextPair 変えたあとの通貨ペア
 * @returns {string}
 */
export function rateAfterPairChange(initial, prev, nextPair) {
  const next = quoteToJpyPairOf(nextPair);
  if (next === quoteToJpyPairOf(prev.pair)) return prev.quoteToJpyRate;
  if (next !== null && next === quoteToJpyPairOf(initial.pair)) return initial.quoteToJpyRate;
  return '';
}

/* ---------------------------------------------------------
   別の画面で先に記録が変更されたとき（architecture 6.12・15.1、trades.js の CONFLICT）
   --------------------------------------------------------- */

/** 配列は選んだ順ではなく中身で比べる（isEditChanged と同じ。順番だけの違いは「変更」とみなさない） */
function sameValue(a, b) {
  const norm = (v) => (Array.isArray(v) ? JSON.stringify([...v].sort()) : JSON.stringify(v));
  return norm(a) === norm(b);
}

/**
 * 「最新の記録に、自分が変えた項目だけを重ねる」ための入力欄の値を作る。
 * 編集を始めたときの値（initial）と今の値（mine）で違う項目だけを、最新の記録の値（latest）に上書きする。
 * 自分が触っていない項目は最新の記録の値のまま＝別の画面での変更を失わない。
 * 通貨ペアを自分が変えていて円換算レートは触っていないときは、最新の記録のレートが別の通貨のものになるので、
 * rateAfterPairChange で決め直す（最新のペアを「変える前」として扱う）。
 * @param {object} initial 編集を始めたときの入力欄の値
 * @param {object} mine 今の入力欄の値
 * @param {object} latest editFieldsFromTrade(最新の記録)
 */
export function rebaseEditFields(initial, mine, latest) {
  const out = cloneEditFields(latest);
  for (const k of EDIT_FIELD_KEYS) {
    if (!sameValue(initial[k], mine[k])) out[k] = Array.isArray(mine[k]) ? [...mine[k]] : mine[k];
  }
  if (sameValue(initial.quoteToJpyRate, mine.quoteToJpyRate) && out.pair !== latest.pair) {
    out.quoteToJpyRate = rateAfterPairChange(latest, latest, out.pair);
  }
  return out;
}

/**
 * 自分が決済の項目（決済価格・円換算レート・決済日時・損益の手入力・決済理由・決済時の感情）を変えているか。
 * 別の画面で決済が取り消された（最新が保有中）とき、これらは重ねる先がなく黙って落ちるので、保存せず知らせるために使う。
 */
export function hasCloseChanges(initial, mine) {
  return ['exitPrice', 'quoteToJpyRate', 'exitAt', 'exitReason', 'exitEmotion'].some((k) => initial[k] !== mine[k])
    || manualKey(initial) !== manualKey(mine);
}
