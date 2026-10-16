/* =========================================================
   js/close-form.js
   S-03 決済記録の「画面に依存しない部分」（design.md 14.2、docs/fx-rules.md 4.4・8章、T-21）。

   【なぜ画面ファイル（screens/close.js）と分けたのか】
   「入力欄の文字をどう読むか」「どの入力にどのエラー・警告を出すか」「損益の欄に何を出すか」「符号付きの値を貼り付けたとき
   ＋/− 切替をどうするか」は、画面を開かなくても Node.js のテストで確かめられる形にしておきたいため。
   ここは document も IndexedDB も触らない純粋な関数だけ（画面はこの結果を並べて描くだけ）。
   pips・損益（円）の計算は trades.js の computeClose（→ calc.js）を呼ぶだけで、ここに式は書かない
   （画面の即時表示と保存で同じ結果になるようにするため）。

   【入力欄の値（fields）の形】下書き（drafts）にもそのまま保存する。入力した文字のまま持つ（architecture 6.5）：
     exitPrice / quoteToJpyRate … 入力欄の文字
     exitAt                    … 日時欄の値（'YYYY-MM-DDTHH:mm'）
     profitMode                … 'auto'（自動計算）／'manual'（確定損益を手入力）
     manualSign / manualAmount … 手入力の符号（'+'／'-'）と金額の数字（符号・カンマなし）
     exitReason / exitEmotion  … チップの選択（空文字＝未選択）
     tags / memo               … タグの配列・メモ（エントリー時の内容が入った状態で始まる：design 14.2.6）
   ========================================================= */
import {
  parsePrice, parseQuoteToJpyRate, parseManualProfitJpy, normalizeNumberText,
  isOutOfPriceRange, isLargePriceGap, isSignMismatch, checkExitAfterEntry, checkCloseInputs,
} from './validate.js';
import { fromInputValue } from './datetime.js';
import { getPairSpec, EXIT_REASON_LABELS } from './master.js';
import { formatYen, formatPips, formatShortDateTime, toneOf, toTenths, speakYen, speakPips } from './format.js';
import { computeClose } from './trades.js';

/** 決済理由の保存値の並び（design 14.2.3：TP到達・SL到達・裁量決済・建値決済・その他） */
export const EXIT_REASONS = Object.freeze(Object.keys(EXIT_REASON_LABELS));

/* ---------------------------------------------------------
   入力欄の初期値・下書きの読み込み・「変更あり」の判定
   --------------------------------------------------------- */

const isString = (v) => typeof v === 'string';

/** 文字の配列から、文字でないものと重複を取り除く（壊れた下書きで画面が止まらないように） */
function cleanStrings(v) {
  return Array.isArray(v) ? [...new Set(v.filter(isString))] : [];
}

/**
 * 決済画面を開いたときの初期値（design 14.2.6）。
 * ・決済日時は開いた時刻、決済価格・円換算レートは空（円換算レートに前回値は入れない：design 14.2.4）
 * ・タグ・メモはエントリー時の内容が入った状態で始まる（続けて書ける）。
 * ・決済理由・決済時の感情は、記録に残っているものがあれば入れておく（決済を取り消した記録をもう一度決済するとき、
 *   取り消しで残した値を空で上書きして消してしまわないため：fx-rules 4.5）。ふつうは空。
 * @param {object} trade 保有中の記録
 * @param {string} nowInput 今の日時（日時欄の値。datetime.js の nowInputValue）
 */
export function defaultCloseFields(trade, nowInput) {
  return {
    exitPrice: '',
    quoteToJpyRate: '',
    exitAt: nowInput,
    profitMode: 'auto',
    manualSign: '+',
    manualAmount: '',
    exitReason: EXIT_REASONS.includes(trade.exitReason) ? trade.exitReason : '',
    exitEmotion: isString(trade.exitEmotion) ? trade.exitEmotion : '',
    tags: cleanStrings(trade.tags),
    memo: isString(trade.memo) ? trade.memo : '',
  };
}

/** 下書きの fields を、知っている項目だけ取り出す（形が違う項目は初期値のまま） */
export function fieldsFromCloseDraft(draft, defaults) {
  const out = { ...defaults, tags: [...defaults.tags] };
  const src = (draft && draft.fields) || {};
  for (const k of ['exitPrice', 'quoteToJpyRate', 'exitAt', 'manualAmount', 'exitEmotion', 'memo']) {
    if (isString(src[k])) out[k] = src[k];
  }
  if (src.profitMode === 'auto' || src.profitMode === 'manual') out.profitMode = src.profitMode;
  if (src.manualSign === '+' || src.manualSign === '-') out.manualSign = src.manualSign;
  if (isString(src.exitReason) && (src.exitReason === '' || EXIT_REASONS.includes(src.exitReason))) out.exitReason = src.exitReason;
  if (Array.isArray(src.tags)) out.tags = cleanStrings(src.tags);
  return out;
}

/** 手入力が「入っている」ときだけ符号付きの文字にする（金額が空なら上書きしない扱い：design 14.2.5） */
function manualKey(f) {
  return f.profitMode === 'manual' && f.manualAmount !== '' ? `${f.manualSign}${f.manualAmount}` : '';
}

/**
 * 初期値から変わっているか（キャンセル時の破棄確認・下書きを作るかの判定：design 14.2.8・14.1.10）。
 * 自動でフォーカスしただけ・「確定損益を入力」を開いただけ（金額が空）は変更とみなさない。
 */
export function isCloseFormChanged(initial, fields) {
  // タグは選んだ順ではなく中身で比べる（外して付け直しただけで「変更あり」にしないため）
  const key = (f) => JSON.stringify([f.exitPrice, f.quoteToJpyRate, f.exitAt, manualKey(f), f.exitReason, f.exitEmotion, [...f.tags].sort(), f.memo]);
  return key(initial) !== key(fields);
}

/** 「詳細（任意）」を閉じているときの 2 行目。値が入っている項目名を出す（design 14.1.4）。例「タグ、メモ 入力済み」 */
export function detailsSummary(f) {
  const filled = [];
  if (f.exitReason) filled.push('決済理由');
  if (f.exitEmotion) filled.push('感情');
  if (f.tags.length > 0) filled.push('タグ');
  if (f.memo !== '') filled.push('メモ');
  return filled.length > 0 ? `${filled.join('、')} 入力済み` : '決済理由、感情、タグ、メモ';
}

/** 下部の保存ボタンの文字（口座を必ず添える：design 14.2.8）。口座が分からないとき（壊れた記録）は雛形の「決済を保存」 */
export function closeSaveLabel(accountType) {
  if (accountType === 'real') return '本番の決済を保存';
  if (accountType === 'demo') return 'デモの決済を保存';
  return '決済を保存';
}

/** 保存後のトースト（design 14.2.8：「決済を保存しました ＋1,265円」。損益が空なら文だけ） */
export function closeToastText(profitJpy) {
  return profitJpy == null ? '決済を保存しました' : `決済を保存しました ${formatYen(profitJpy)}`;
}

/* ---------------------------------------------------------
   確定損益（手入力）の読み方
   --------------------------------------------------------- */

/** 「確定損益を入力」を開いたときの符号の初期値：pips がマイナスなら「−」、それ以外は「＋」（design 14.2.5） */
export function initialManualSign(pips) {
  return pips != null && pips < 0 ? '-' : '+';
}

/**
 * 金額欄に入力・貼り付けされた文字から、符号と数字を取り分ける（2026-10-16 宿題の推奨案：roadmap 6.1・design 14.2.9）。
 *
 * なぜ必要か：業者アプリの表示 `−5,700`・`+2,480`・`－５，７００`（全角）をそのまま貼り付けられるのに、
 * ＋/− 切替が「−」のままだと、`−5,700` を貼っても「切替＝−」と「−」が二重になって意図が曖昧になる。
 * 逆に切替が「＋」のとき `−5,700` を貼ると、金額欄が `−5,700`・切替が「＋」のちぐはぐな状態になる。
 * そこで、貼り付けた値に符号があればその符号に切替を合わせ、金額欄には符号を除いた数字だけを残す。
 *   ・先頭が「-」「−」「－」→ 切替を「−」に。金額は符号を除いた数字
 *   ・先頭が「+」「＋」（直後が数字）→ 切替を「＋」に
 *   ・符号がない → 切替はそのまま（切替が「−」のまま「5,700」を打てば −5,700）
 * カンマ（全角「，」も）と全角数字は正規化して取り除く／半角にする（validate.js の normalizeNumberText と同じ規則）。
 * 「--5」「+-5」のように符号が重なっているものは、先頭の符号だけ取り分けて残りを金額欄に残す
 * （金額欄に「-5」が残る＝整数ではないので E-09 のエラーになる。黙って直さない）。
 * @param {string} text 金額欄の今の文字
 * @param {'+'|'-'} currentSign 今の切替
 * @returns {{ sign: '+'|'-', amount: string }}
 */
export function splitSignedAmount(text, currentSign) {
  const raw = String(text ?? '').trim();
  const s = normalizeNumberText(raw, { profit: true });
  if (s.startsWith('-')) return { sign: '-', amount: s.slice(1) };
  // 先頭の「+」は normalizeNumberText が取り除いてしまうので、元の文字で見分ける（直後が数字のときだけ符号とみなす：fx-rules 8.1）
  if (/^[+＋][0-9０-９]/.test(raw)) return { sign: '+', amount: s };
  return { sign: currentSign === '-' ? '-' : '+', amount: s };
}

/**
 * 手入力の損益（円）を読み取る。
 * @returns {{ empty: true } | { ok: true, value: number } | { ok: false, error: 'E-09' }}
 *   empty … 手入力ではない（自動計算モード）、または金額が空（＝上書きしない）
 */
export function resolveManualProfit(fields) {
  if (fields.profitMode !== 'manual') return { empty: true };
  const amount = normalizeNumberText(fields.manualAmount, { profit: true });
  if (amount === '') return { empty: true };
  // 金額欄に符号が残っている（「--5」など）ものは、切替と食い違うので整数とはみなさない（E-09）
  if (amount.startsWith('-')) return { ok: false, error: 'E-09' };
  const r = parseManualProfitJpy((fields.manualSign === '-' ? '-' : '') + amount);
  return r.ok ? { ok: true, value: r.value } : { ok: false, error: 'E-09' };
}

/** 金額欄から離れたときの表示：数字だけなら 3桁区切り（1,240）。それ以外（エラーになる文字）はそのまま見せる */
export function formatAmountText(amount) {
  if (!/^\d{1,15}$/.test(amount)) return amount;
  return String(Number(amount)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** 金額欄から離れたときに保存しておく文字：数字だけなら先頭の0を除く（007 → 7）。それ以外はそのまま */
export function tidyAmount(amount) {
  return /^\d{1,15}$/.test(amount) ? String(Number(amount)) : amount;
}

/* ---------------------------------------------------------
   入力チェックと計算（design 14.2.7・14.2.9、fx-rules 8章）
   --------------------------------------------------------- */

const EXIT_PRICE_LABEL = '決済価格';

const EXIT_PRICE_ERRORS = {
  'E-01': `${EXIT_PRICE_LABEL}：数値で入力してください`,
  'E-02': `${EXIT_PRICE_LABEL}：0より大きい値を入力してください`,
  'E-03': `${EXIT_PRICE_LABEL}：価格は小数第3位までで入力してください`,
  'E-04': `${EXIT_PRICE_LABEL}：価格は小数第5位までで入力してください`,
};

/** 文言の置き場（design 14.2.9。画面は issues の text をそのまま出す） */
const TEXT = {
  required: { exitPrice: '決済価格を入力してください', exitAt: '日時を入力してください' },
  'E-08': '円換算レートは0より大きい値（小数第3位まで）で入力してください',
  'E-09': '損益（円）は整数で入力してください',
  'E-11': '円換算レートか確定損益のどちらかを入力してください',
  'W-02': '価格の差が大きすぎます。桁や通貨ペアの間違いがないか確認してください。',
  'W-05': 'pips と損益（円）のプラス・マイナスが逆です。スワップや手数料の影響であればこのままで問題ありません。',
};

/**
 * 入力欄の文字から、計算結果とエラー・警告を求める（1文字入力するたびに画面が呼ぶ）。
 * issues は画面の上から順（決済価格 → 円換算レート → 日時 → 損益）。画面は「欄から離れた」などで出してよいものだけを出す。
 *   field：'exitPrice' | 'quoteToJpyRate' | 'exitAt' | 'manualProfit' | 'profitNeed'（E-11：保存を押したときだけ出す）
 * @param {object} trade 保有中の記録
 * @param {object} fields 入力欄の値
 * @param {{ now?: Date }} [opts] now は E-10 の文の日付の「今年」判定用（テストで固定できる）
 */
export function evaluateClose(trade, fields, { now = new Date() } = {}) {
  const spec = getPairSpec(trade.pair);
  const exit = parsePrice(fields.exitPrice, trade.pair);
  // JPYペアには円換算レートの欄がない。非JPYペアだけ読む
  const rate = spec.isJpyPair ? { ok: true, value: null, empty: true } : parseQuoteToJpyRate(fields.quoteToJpyRate);
  const exitAt = fromInputValue(fields.exitAt);
  const manual = resolveManualProfit(fields);
  const manualValue = manual.ok && !manual.empty ? manual.value : null;
  const exitReady = exit.ok && !exit.empty;

  const issues = [];
  const add = (field, type, text) => issues.push({ field, type, text });

  if (exit.empty) add('exitPrice', 'error', TEXT.required.exitPrice);
  else if (!exit.ok) add('exitPrice', 'error', EXIT_PRICE_ERRORS[exit.error]);
  else {
    // エントリー価格が空（編集画面でエントリー価格を入れ直している途中）のときは、差を比べられないので警告しない
    if (trade.entryPrice != null && isLargePriceGap(trade.entryPrice, exit.value, trade.pair)) add('exitPrice', 'warning', TEXT['W-02']);
    if (isOutOfPriceRange(exit.value, trade.pair)) {
      add('exitPrice', 'warning', `${EXIT_PRICE_LABEL}：${trade.pair} の価格としては大きく外れています。通貨ペアと桁を確認してください。`);
    }
  }
  if (!rate.ok) add('quoteToJpyRate', 'error', TEXT['E-08']);
  if (!exitAt) add('exitAt', 'error', TEXT.required.exitAt);
  else if (!checkExitAfterEntry(trade.entryAt, exitAt).ok) {
    add('exitAt', 'error', `決済日時がエントリー日時（${formatShortDateTime(trade.entryAt, now)}）より前になっています`);
  }
  if (manual.ok === false) add('manualProfit', 'error', TEXT['E-09']);

  // pips・損益は trades.js の computeClose（calc.js）。決済価格が読めないうちは計算しない
  const calc = exitReady
    ? computeClose(trade, { exitPrice: exit.value, quoteToJpyRate: rate.ok ? rate.value : null, manualProfitJpy: manualValue })
    : { pips: null, autoProfitJpy: null, profitJpy: null, profitSource: null };

  if (calc.profitSource === 'manual' && isSignMismatch(calc.pips, manualValue)) add('manualProfit', 'warning', TEXT['W-05']);
  // E-11：円換算レートも確定損益も空。レートが読めない（E-08）・損益が読めない（E-09）ときは、そちらのエラーだけにする
  if (rate.ok && manual.ok !== false
    && !checkCloseInputs({ pair: trade.pair, quoteToJpyRate: rate.value, manualProfitJpy: manualValue }).ok) {
    add('profitNeed', 'error', TEXT['E-11']);
  }

  return {
    spec, exit, rate, exitAt, manual, manualValue, exitReady,
    pips: calc.pips,
    autoProfitJpy: calc.autoProfitJpy,
    profitJpy: calc.profitJpy,
    profitSource: calc.profitSource,
    // 「自動計算に戻す」が使えるか。非JPYペアで円換算レートが空のままでは戻しても計算できない（design 14.2.5）
    canReturnToAuto: spec.isJpyPair || (rate.ok && !rate.empty),
    issues,
    hasError: issues.some((i) => i.type === 'error'),
  };
}

/**
 * 損益の欄に出す内容（design 14.2.7）。画面はこの結果を並べるだけ。
 * 色は必ず記号（＋/−/±）と併用する（tone は色の種類。'none' は灰色）。
 * @returns {{ mode: 'auto'|'manual', main: {text:string, tone:string}, hint: (string|null), pips: (null|{text:string, tone:string}),
 *   ref: string, back: ('button'|'note') }}
 */
export function describeProfit(ev, fields) {
  const pips = ev.pips == null ? null : { text: formatPips(ev.pips), tone: toneOf(toTenths(ev.pips)) };
  if (fields.profitMode === 'manual') {
    return {
      mode: 'manual',
      main: { text: '—', tone: 'none' },
      hint: null,
      pips: pips || { text: '—', tone: 'none' },
      ref: ev.autoProfitJpy == null ? '—' : formatYen(ev.autoProfitJpy),
      back: ev.canReturnToAuto ? 'button' : 'note',
    };
  }
  if (!ev.exitReady) {
    return { mode: 'auto', main: { text: '—', tone: 'none' }, hint: '決済価格を入れると計算します', pips: null, ref: '—', back: 'button' };
  }
  if (ev.profitJpy == null) {
    return { mode: 'auto', main: { text: '—', tone: 'none' }, hint: '円換算レートか確定損益を入力', pips, ref: '—', back: 'button' };
  }
  return { mode: 'auto', main: { text: formatYen(ev.profitJpy), tone: toneOf(ev.profitJpy) }, hint: null, pips, ref: '—', back: 'button' };
}

/** 読み上げ用の損益の文（欄から離れたときに 1 回だけ読ませる：design 14.1.7 と同じ方針）。計算できないときは空 */
export function speakProfit(ev) {
  if (!ev.exitReady) return '';
  const parts = [];
  if (ev.profitJpy != null) parts.push(`損益 ${speakYen(ev.profitJpy)}`);
  if (ev.pips != null) parts.push(speakPips(ev.pips));
  return parts.join('、');
}

/**
 * 保存する決済の入力（trades.js の closeTrade / buildClosedTrade に渡す形）を作る。入力チェックを通ったあとに呼ぶ。
 * pips・損益はここでは渡さない（保存側が computeClose で求める）。
 */
export function closeInputFromEvaluation(ev, fields) {
  return {
    exitPrice: ev.exit.value,
    exitAt: ev.exitAt,
    quoteToJpyRate: ev.rate.value,
    manualProfitJpy: ev.manualValue,
    exitReason: fields.exitReason === '' ? null : fields.exitReason,
    exitEmotion: fields.exitEmotion === '' ? null : fields.exitEmotion,
    tags: [...fields.tags],
    memo: fields.memo.trim() === '' ? null : fields.memo,
  };
}
