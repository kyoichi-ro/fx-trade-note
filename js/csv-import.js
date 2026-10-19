/* =========================================================
   js/csv-import.js
   CSV の読み込み（復元）の「読む・確かめる・数える」部分（T-44。design.md 14.6.9・14.6.11・14.6.12、
   docs/sheets-setup.md 7.2、architecture.md 14.2）。書き出し側は js/csv.js。

   【なぜ DOM や IndexedDB から切り離したか】
   ・読み込みの規則（列名で読む・BOM・改行・数値の形・日時の範囲・矛盾の見つけ方）は、間違えると
     「戻したはずの記録が壊れている」に直結する。画面・DB に触れない純粋な関数にしておけば、
     Node.js のテスト（tests/csv-import.test.js）で書き出し → 読み込みの往復や壊れた CSV を確かめられる。
   ・DB への書き込み（1つのトランザクションで全部か何もなし）は trades.js の importTrades、
     画面（ファイルの選択・確認シート・結果）は screens/settings-import.js が受け持つ。

   【読み方の約束（sheets-setup 7.2 の11項目・design 14.6.11 ⑥）】
   ・文字コードは UTF-8 として厳密に読む（TextDecoder の fatal。Excel の「CSV（コンマ区切り）」＝Shift_JIS は I-3）。
   ・先頭の BOM はあってもなくてもよい。行の区切りは CRLF・LF のどちらでもよく、最後の改行はなくてもよい。
   ・列は見出しの名前で探す（何列目かで読まない）。32 の名前（csv.js の CSV_COLUMNS）がすべて1回ずつあればよく、
     知らない名前の列は読み飛ばす（シートから書き出した CSV・オーナーが足した列も戻せる）。
   ・全部空の行は飛ばす。並び順には頼らない。
   ・数値は「半角の数字・小数点1つ・先頭のマイナス」だけ（3桁区切り・全角・指数表記・前後の空白は受け付けない）。
     末尾の0（150.100・1.00）は受け付ける（桁数は末尾の0を数えない：fx-rules 8.1）。
   ・日時は保存形式（25文字固定：architecture 6.6）だけ。年は 2000〜2099（fx-rules 8.1・roadmap 7.18 #26）。
   ・文字のセルは unguardFormula（CSV インジェクション対策の「'」を外す）、根拠・タグは splitList で戻す。
   ・画像は戻らない（imageCount は確認シート・結果の件数にだけ使う）。syncStatus・syncedAt の列は使わない
     （取り込んだ記録は pending：trades.js の buildImportedTrade）。

   【自動で決まる値の扱い（T-44 で決めたこと）】
   ・status（保有中／決済済み）は決済価格・決済日時の有無と一致していなければ読めない行にする（「決済済みなのに決済価格がありません」）。
   ・pips・損益（円）・損益の算出方法は、決済画面・編集画面の保存と同じ computeClose（trades.js → calc.js）で計算し直し、
     CSV の値と一致しなければ読めない行にする（「pipsが価格と合いません」）。手入力（manual）の損益は CSV の値を正とする（fx-rules 4.4）。
     このアプリが書き出した CSV なら必ず一致するので、一致しないのは手で直された・壊れたファイル。どちらが正しいか分からない値で
     DB を汚さないため、取り込まずに知らせる。
   ・riskReward は保存のたび（saveTrade）と同じく recompute() で計算し直す（CSV の値は使わない）。
     session は CSV の値（選択肢のどれか）を使い、空なら recompute() が entryAt から判定する（保存値を正とする：fx-rules 11.7）。
   ・価格・ロットには入力画面と同じ上限（E-17・E-18）と桁数（E-03・E-04・E-06）、1lot の通貨数には E-07、円換算レートには E-08 を当てる。

   依存（architecture 4.2）：csv（列名と区切りの規則）, trades（computeClose・judgeStatus）, validate, datetime, master, choice-list, util
   ========================================================= */
import { CSV_COLUMNS, unguardFormula, splitList } from './csv.js';
import { computeClose, judgeStatus } from './trades.js';
import { parsePrice, parseLots, parseLotUnitSize, parseQuoteToJpyRate, normalizePairInput, checkExitAfterEntry, countDecimals } from './validate.js';
import { parseJst, jstParts, INPUT_YEAR_MIN, INPUT_YEAR_MAX } from './datetime.js';
import { getPairSpec, SESSION_LABELS, TIMEFRAME_LABELS, EXIT_REASON_LABELS } from './master.js';
import { checkChoiceName } from './choice-list.js';

/** 読み込めるファイルの大きさの上限（design 14.6.9 I-5。1000件で約0.5MB なので、20MB は数万件分の余裕がある） */
export const IMPORT_MAX_BYTES = 20 * 1024 * 1024;

/** 確認シートに1行ずつ出す「読めなかった行」の最大数（design 14.6.9。それ以上は「ほか n行」） */
export const ISSUE_LIST_MAX = 20;

/** メモの上限（requirements 6.1「最大2,000文字程度」。入力欄の maxlength と同じ：ui/fields.js textareaRow） */
const MEMO_MAX_LENGTH = 2000;

/** ID の形（UUID）。このアプリの ID は util.js の newId（UUID v4）。Apps Script も UUID の形かを確かめる（sheets-setup 10.2 #3） */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** CSV の数値の形（半角数字・小数点1つ・先頭のマイナスだけ）。空白・全角・カンマ・指数表記・「.5」「150.」は読めない */
const CSV_NUMBER = /^-?\d+(?:\.\d+)?$/;

/** Excel で保存し直したときの日時の形（2026/10/15 21:30 など）。読めない理由に添えるためだけに見分ける（sheets-setup 7.2 #10） */
const EXCEL_DATE_LIKE = /^\d{4}\/\d{1,2}\/\d{1,2}/;

/** 項目の日本語名（requirements 6.1。読めなかった行の理由の文に使う：design 14.6.9） */
const LABELS = Object.freeze({
  id: 'ID', accountType: 'デモ/本番', pair: '通貨ペア', side: '売買方向', entryPrice: 'エントリー価格', entryAt: 'エントリー日時',
  lots: 'ロット', lotUnitSize: '1lotの通貨数', slPrice: '損切りライン（SL）', tpPrice: '利確ライン（TP）',
  exitPrice: '決済価格', exitAt: '決済日時', pips: 'pips', profitJpy: '損益（円）', profitSource: '損益の算出方法',
  quoteToJpyRate: '円換算レート', status: 'ステータス', entryReasons: 'エントリー根拠', timeframe: '時間足', session: 'セッション',
  emotion: 'エントリー時の感情', exitReason: '決済理由', exitEmotion: '決済時の感情', tags: 'タグ', memo: 'メモ',
  imageCount: '画像の枚数', createdAt: '作成日時', updatedAt: '更新日時', deletedAt: '削除日時',
});

/* ---------------------------------------------------------
   ファイル（バイト列）→ 文字
   --------------------------------------------------------- */

/**
 * CSV ではないと分かるファイルか（design 14.6.9 I-2：Numbers・Excel のファイルを選んだとき）。
 * Numbers（.numbers）・Excel（.xlsx）は ZIP（先頭 PK\x03\x04）、古い Excel（.xls）は OLE（D0 CF 11 E0）。
 * NUL 文字を含むものも文字のファイルではない。UTF-8 として読む前に見分けないと、I-3（文字コード）と出てしまい直し方を誤るため。
 * @param {Uint8Array} bytes
 */
function looksBinary(bytes) {
  const startsWith = (...sig) => sig.every((b, i) => bytes[i] === b);
  if (startsWith(0x50, 0x4b, 0x03, 0x04) || startsWith(0xd0, 0xcf, 0x11, 0xe0)) return true;
  // UTF-16 の印（FF FE / FE FF）は「文字コードが違う」の方なので、ここでは binary としない
  if (startsWith(0xff, 0xfe) || startsWith(0xfe, 0xff)) return false;
  const end = Math.min(bytes.length, 4096);
  for (let i = 0; i < end; i += 1) if (bytes[i] === 0) return true;
  return false;
}

/**
 * ファイルの中身（バイト列）を UTF-8 の文字にする。先頭の BOM は取り除く。
 * @param {Uint8Array} bytes
 * @returns {{ ok: true, text: string } | { ok: false, error: 'format'|'encoding' }}
 *   format … CSV でない（I-2）／encoding … UTF-8 として読めない（I-3）
 */
export function decodeCsvBytes(bytes) {
  if (looksBinary(bytes)) return { ok: false, error: 'format' };
  // UTF-16 の BOM は TextDecoder('utf-8') が読み違えずに失敗するとは限らないので、先に見分ける
  if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)) return { ok: false, error: 'encoding' };
  let text;
  try {
    // fatal：UTF-8 として正しくないバイト（Shift_JIS など）があれば例外にする（黙って「�」に置き換えさせない）
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (e) {
    return { ok: false, error: 'encoding' };
  }
  // TextDecoder は先頭の BOM を1つ取り除くが、念のため残っていれば外す（BOM が2つ付いたファイル）
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return { ok: true, text };
}

/* ---------------------------------------------------------
   文字 → 行×セル（RFC 4180 の形。改行は CRLF・LF・CR のどれでも）
   --------------------------------------------------------- */

/**
 * CSV の文字を、レコード（行）ごとのセルの配列にする。
 * ・「"」で囲んだセルの中のカンマ・改行・「""」（＝「"」1つ）を扱う。メモの中の改行はそのまま残る
 * ・最後の改行はあってもなくてもよい（最後の空の行は作らない）
 * ・囲みの「"」が閉じないままファイルが終わったら unterminated: true（最後のレコードが途中で切れている）
 * 囲んでいないセルの途中の「"」はそのまま文字として扱う（このアプリもシートも書き出さない形なので、厳しくしない）。
 * @param {string} text BOM を除いた文字
 * @returns {{ records: string[][], unterminated: boolean }}
 */
export function parseCsvRecords(text) {
  const records = [];
  let row = [];
  let cell = '';
  let quoted = false;
  let started = false; // 今のレコードに何か（文字・区切り）があったか。最後の改行のあとに空のレコードを作らないため
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += c;
      }
      continue;
    }
    if (c === '"' && cell === '') {
      quoted = true;
      started = true;
    } else if (c === ',') {
      row.push(cell);
      cell = '';
      started = true;
    } else if (c === '\r' || c === '\n') {
      if (c === '\r' && text[i + 1] === '\n') i += 1;
      row.push(cell);
      records.push(row);
      row = [];
      cell = '';
      started = false;
    } else {
      cell += c;
      started = true;
    }
  }
  if (started || quoted) {
    row.push(cell);
    records.push(row);
  }
  return { records, unterminated: quoted };
}

/**
 * 見出しの行から、32列それぞれが何列目にあるかを求める（design 14.6.11 ⑥）。
 * 32 の名前がすべて1回ずつあれば、順番は問わず、ほかの名前の列は読み飛ばす。足りない・同じ名前が2つあれば null（I-2）。
 * 見出しの前後の空白は取り除いて比べる（シートで見出しを打ち直したときの空白で読めなくならないように）。
 * @param {string[]} header
 * @returns {Map<string, number>|null}
 */
export function findColumns(header) {
  const map = new Map();
  header.forEach((name, i) => {
    const key = name.trim();
    if (!CSV_COLUMNS.includes(key)) return;
    map.set(key, map.has(key) ? -1 : i); // -1 ＝ 同じ名前が2つ
  });
  if (map.size !== CSV_COLUMNS.length || [...map.values()].includes(-1)) return null;
  return map;
}

/* ---------------------------------------------------------
   1行 → 記録（チェックしながら組み立てる）
   --------------------------------------------------------- */

/** 読めなかった理由を持って処理を抜けるための印（例外にするのは、チェックの途中で深く入れ子にしないため） */
class RowError extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}
const fail = (reason) => { throw new RowError(reason); };

/**
 * セルの読み方をまとめた道具（1行ぶん）。どれも「最初の問題」で RowError を投げる。
 * @param {string[]} cells
 * @param {Map<string, number>} columns
 */
function rowReader(cells, columns) {
  const raw = (key) => cells[columns.get(key)];
  /** 文字のセル（CSV インジェクション対策の「'」を戻す） */
  const text = (key) => unguardFormula(raw(key));
  /** 数値のセル。空なら null。形が違えば「〜が数値ではありません」。数値の列は「'」を付けて書き出さないので戻さない */
  const numberText = (key) => {
    const s = raw(key);
    if (s === '') return null;
    if (!CSV_NUMBER.test(s)) fail(`${LABELS[key]}が数値ではありません`);
    return s;
  };
  /** 選択肢（決まった値のどれか）。空なら null（required なら「〜がありません」） */
  const choice = (key, allowed, { required = false } = {}) => {
    const v = text(key);
    if (v === '') {
      if (required) fail(`${LABELS[key]}がありません`);
      return null;
    }
    if (!allowed.includes(v)) fail(`${LABELS[key]}の値が違います`);
    return v;
  };
  /** 日時（保存形式・2000〜2099年）。空なら null */
  const dateTime = (key, { required = false } = {}) => {
    const v = text(key);
    if (v === '') {
      if (required) fail(`${LABELS[key]}がありません`);
      return null;
    }
    const d = parseJst(v);
    const year = Number(v.slice(0, 4));
    if (!d || year < INPUT_YEAR_MIN || year > INPUT_YEAR_MAX) {
      // Excel で保存し直すと日時の形が変わる。原因が分かるよう添える（sheets-setup 7.2 #10。直し方は付けない：design 14.6.9）
      fail(EXCEL_DATE_LIKE.test(v) ? `${LABELS[key]}が読めません（Excelで保存し直した形です）` : `${LABELS[key]}が読めません`);
    }
    return v;
  };
  /** 価格（E-01〜E-04・E-17。入力画面と同じ parsePrice） */
  const price = (key, pair, { required = false } = {}) => {
    const s = numberText(key);
    if (s === null) {
      if (required) fail(`${LABELS[key]}がありません`);
      return null;
    }
    const r = parsePrice(s, pair);
    if (r.ok) return r.value;
    if (r.error === 'E-02') fail(`${LABELS[key]}が0以下です`);
    if (r.error === 'E-17') fail(`${LABELS[key]}が大きすぎます`);
    return fail(`${LABELS[key]}の小数の桁が多すぎます`); // E-03・E-04（E-01 は CSV_NUMBER で先に止まる）
  };
  /** 根拠・タグ（「|」でつないだ1つのセル）。空の要素（「a||b」）は読めない */
  const list = (key) => {
    const items = splitList(text(key));
    if (items.some((x) => x === '')) fail(`${LABELS[key]}の値が違います`);
    return items;
  };
  /** 任意の文字（感情）。空なら null */
  const optionalText = (key) => {
    const v = text(key);
    return v === '' ? null : v;
  };
  return { raw, text, numberText, choice, dateTime, price, list, optionalText };
}

/**
 * 1行のセルから記録を組み立てる（チェックを通ったものだけ）。
 * 返す記録は requirements 6.1 の32項目（imageIds は空・syncStatus は pending・syncedAt は null の仮の値。
 * 実際に保存する形は trades.js の buildImportedTrade が端末の記録と合わせて決める）。riskReward は null の仮の値
 * （保存のときに recompute() で求める）。
 * @param {string[]} cells
 * @param {Map<string, number>} columns findColumns の結果
 * @returns {{ ok: true, trade: object, imageCount: number } | { ok: false, reason: string }}
 */
export function rowToTrade(cells, columns) {
  try {
    return { ok: true, ...readRow(rowReader(cells, columns)) };
  } catch (e) {
    if (e instanceof RowError) return { ok: false, reason: e.reason };
    throw e;
  }
}

/** rowToTrade の中身（チェックの順番＝読めなかった理由に出す「最初の問題」の順番） */
function readRow(r) {
  // ① ID
  const id = r.text('id');
  if (id === '') fail('IDがありません');
  if (!UUID_PATTERN.test(id)) fail('IDの形が違います');

  // ② エントリーの必須項目（通貨ペアを先に読む：価格の桁数は通貨ペアで決まるため）
  const accountType = r.choice('accountType', ['demo', 'real'], { required: true });
  const pair = r.text('pair');
  if (pair === '') fail('通貨ペアがありません');
  // 保存形式（USD/JPY）そのままで、通貨ペアの追加と同じ規則（FX 以外・同じ通貨・円が左側でない）に合うものだけ
  const pairCheck = normalizePairInput(pair, []);
  if (!/^[A-Z]{3}\/[A-Z]{3}$/.test(pair) || !pairCheck.ok || pairCheck.pair !== pair) fail('通貨ペアの値が違います');
  const side = r.choice('side', ['buy', 'sell'], { required: true });
  const entryPrice = r.price('entryPrice', pair, { required: true });
  const entryAt = r.dateTime('entryAt', { required: true });

  const lotsText = r.numberText('lots');
  if (lotsText === null) fail('ロットがありません');
  const lots = parseLots(lotsText);
  if (!lots.ok) {
    if (lots.error === 'E-18') fail('ロットが大きすぎます');
    if (lots.error === 'E-06') fail('ロットの小数の桁が多すぎます');
    fail('ロットが0以下です'); // E-05（数値でないものは CSV_NUMBER で先に止まる）
  }
  const unitText = r.numberText('lotUnitSize');
  if (unitText === null) fail('1lotの通貨数がありません');
  const lotUnitSize = parseLotUnitSize(unitText);
  if (!lotUnitSize.ok) fail('1lotの通貨数が1以上の整数ではありません');

  // ③ SL・TP（任意）
  const slPrice = r.price('slPrice', pair);
  const tpPrice = r.price('tpPrice', pair);

  // ④ 選択肢・文字の項目
  const status = r.choice('status', ['open', 'closed'], { required: true });
  const entryReasons = r.list('entryReasons');
  const timeframe = r.choice('timeframe', Object.keys(TIMEFRAME_LABELS));
  const session = r.choice('session', Object.keys(SESSION_LABELS));
  const emotion = r.optionalText('emotion');
  const exitReason = r.choice('exitReason', Object.keys(EXIT_REASON_LABELS));
  const exitEmotion = r.optionalText('exitEmotion');
  const tags = r.list('tags');
  const memoText = r.text('memo');
  if (memoText.length > MEMO_MAX_LENGTH) fail('メモが長すぎます');
  const memo = memoText === '' ? null : memoText;

  // ⑤ 画像の枚数（画像そのものは戻らない。確認シートと結果の件数にだけ使う）
  const imageText = r.numberText('imageCount');
  const imageCount = imageText === null ? 0 : Number(imageText);
  // 0以上の整数（シートの見え方の「2.00」も受け付ける）
  if (imageText !== null && (countDecimals(imageText) > 0 || imageCount < 0)) fail('画像の枚数の値が違います');

  // ⑥ 記録の日時
  const createdAt = r.dateTime('createdAt', { required: true });
  const updatedAt = r.dateTime('updatedAt', { required: true });
  const deletedAt = r.dateTime('deletedAt');

  // ⑦ 決済（ステータスと決済の値が合っているか、pips・損益を計算し直して一致するか）
  const exitPrice = r.price('exitPrice', pair);
  const exitAt = r.dateTime('exitAt');
  const rateText = r.numberText('quoteToJpyRate');
  let quoteToJpyRate = null;
  if (rateText !== null) {
    const rate = parseQuoteToJpyRate(rateText);
    // JPY ペアは円換算レートを使わない（保存値はいつも null：fx-rules 4.3）
    if (!rate.ok || getPairSpec(pair).isJpyPair) fail('円換算レートの値が違います');
    quoteToJpyRate = rate.value;
  }
  const close = readClose(r, { status, pair, side, entryPrice, entryAt, lots: lots.value, lotUnitSize: lotUnitSize.value, exitPrice, exitAt, quoteToJpyRate });

  const trade = {
    id, accountType, pair, side, entryPrice, entryAt, lots: lots.value, lotUnitSize: lotUnitSize.value,
    slPrice, tpPrice, riskReward: null, exitPrice, exitAt,
    pips: close.pips, profitJpy: close.profitJpy, profitSource: close.profitSource,
    quoteToJpyRate, status: judgeStatus({ exitPrice, exitAt }), entryReasons, timeframe, session, emotion, exitReason, exitEmotion,
    tags, memo, imageIds: [], syncStatus: 'pending', syncedAt: null, deletedAt, createdAt, updatedAt,
  };
  return { trade, imageCount };
}

/**
 * 決済の項目を確かめ、保存する pips・損益・算出方法を返す（上の【自動で決まる値の扱い】）。
 * @returns {{ pips: (number|null), profitJpy: (number|null), profitSource: ('auto'|'manual'|null) }}
 */
function readClose(r, t) {
  const pipsText = r.numberText('pips');
  const profitText = r.numberText('profitJpy');
  const source = r.choice('profitSource', ['auto', 'manual']);

  if (t.status === 'open') {
    // 保有中は決済の値がすべて空（決済の取り消しも空に戻す：fx-rules 4.5）
    if (t.exitPrice !== null) fail('保有中なのに決済価格があります');
    if (t.exitAt !== null) fail('保有中なのに決済日時があります');
    if (pipsText !== null) fail('保有中なのにpipsがあります');
    if (profitText !== null) fail('保有中なのに損益（円）があります');
    if (source !== null) fail('保有中なのに損益の算出方法があります');
    return { pips: null, profitJpy: null, profitSource: null };
  }

  if (t.exitPrice === null) fail('決済済みなのに決済価格がありません');
  if (t.exitAt === null) fail('決済済みなのに決済日時がありません');
  if (!checkExitAfterEntry(t.entryAt, t.exitAt).ok) fail('決済日時がエントリー日時より前です'); // E-10

  // 手入力の損益は CSV の値を正とする（整数の円：fx-rules 4.4。末尾の0だけの小数「2500.00」はシートの見え方なので受け付ける）
  let manual = null;
  if (source === 'manual') {
    if (profitText === null) fail('損益（円）がありません');
    const n = Number(profitText);
    if (countDecimals(profitText) > 0 || !Number.isSafeInteger(n)) fail('損益（円）が整数ではありません');
    manual = n === 0 ? 0 : n;
  }
  // 決済画面・編集画面の保存と同じ計算（独自の式は書かない）
  const c = computeClose(t, { exitPrice: t.exitPrice, quoteToJpyRate: t.quoteToJpyRate, manualProfitJpy: manual });
  const csvPips = pipsText === null ? null : Number(pipsText);
  if (csvPips !== c.pips) fail('pipsが価格と合いません');
  const csvProfit = profitText === null ? null : Number(profitText);
  if (csvProfit !== c.profitJpy) fail('損益（円）が価格と合いません');
  if (source !== c.profitSource) fail('損益の算出方法の値が違います');
  return { pips: c.pips, profitJpy: c.profitJpy, profitSource: c.profitSource };
}

/* ---------------------------------------------------------
   ファイル全体
   --------------------------------------------------------- */

/**
 * CSV の文字を読み、取り込める記録と読めなかった行に分ける。
 * 行番号は「見出しを1行目として数えた番号」（design 14.6.9。メモの中の改行は数えない＝Numbers・Googleスプレッドシートの行番号と同じ）。
 * 全部空の行は飛ばす（行番号は進める）。同じ ID の2回目以降の行は「同じIDの行がほかにあります（n行目）」。
 * @param {string} text BOM を除いた文字
 * @returns {{ ok: false, error: 'format'|'empty' } |
 *   { ok: true, rows: {line: number, trade: object, imageCount: number}[], issues: {line: number, reason: string}[] }}
 *   format … 見出しが合わない（I-2）／empty … 見出しの行しかない（I-4）
 */
export function parseImportText(text) {
  const { records, unterminated } = parseCsvRecords(text);
  if (records.length === 0) return { ok: false, error: 'format' };
  const columns = findColumns(records[0]);
  if (!columns) return { ok: false, error: 'format' };

  const rows = [];
  const issues = [];
  const firstLineOfId = new Map();
  let dataRows = 0;
  records.slice(1).forEach((cells, i) => {
    const line = i + 2;
    if (cells.every((c) => c === '')) return; // 全部空の行（シートで行を消した跡など）
    dataRows += 1;
    const isLast = i === records.length - 2;
    if (isLast && unterminated) {
      issues.push({ line, reason: '引用符（"）が閉じていません' });
      return;
    }
    if (cells.length !== records[0].length) {
      issues.push({ line, reason: '列の数が見出しと合いません' });
      return;
    }
    // 同じ ID の2回目以降は、1回目が読めた行かどうかに関係なく取り込まない（design 14.6.9）
    const id = unguardFormula(cells[columns.get('id')]);
    if (id !== '' && firstLineOfId.has(id)) {
      issues.push({ line, reason: `同じIDの行がほかにあります（${firstLineOfId.get(id)}行目）` });
      return;
    }
    if (id !== '') firstLineOfId.set(id, line);
    const r = rowToTrade(cells, columns);
    if (r.ok) rows.push({ line, trade: r.trade, imageCount: r.imageCount });
    else issues.push({ line, reason: r.reason });
  });
  if (dataRows === 0) return { ok: false, error: 'empty' };
  return { ok: true, rows, issues };
}

/**
 * 選んだファイルの中身（バイト列）を読む。大きさの確認（I-5）は読む前に画面側で File.size で行う（大きなファイルを読み込まないため）。
 * @param {Uint8Array} bytes
 * @returns {ReturnType<typeof parseImportText> | { ok: false, error: 'encoding' }}
 */
export function parseImportBytes(bytes) {
  const decoded = decodeCsvBytes(bytes);
  if (!decoded.ok) return decoded;
  return parseImportText(decoded.text);
}

/* ---------------------------------------------------------
   この端末の記録と比べて数える（確認シート：design 14.6.9）
   --------------------------------------------------------- */

/**
 * 取り込める記録を、この端末の記録と比べて数える。
 * ・新しい記録＝この端末に同じ ID がない／すでにある記録＝ある（この端末で削除済みのものも含む）
 * ・端末の方が新しい＝すでにある記録のうち、端末の更新日時（updatedAt）が CSV より後（上書きの注意：design 14.6.9）
 * ・snapshot：CSV の ID ごとの「確認した時点の端末の updatedAt（なければ null）」。取り込むときに、確認中に記録が
 *   変わっていないかを確かめるために trades.js の importTrades に渡す
 * @param {{ rows: {trade: object, imageCount: number}[], issues: object[] }} parsed parseImportText の結果（ok のとき）
 * @param {object[]} deviceTrades この端末の全記録（削除済みを含む）
 */
export function summarizeImport(parsed, deviceTrades) {
  const device = new Map(deviceTrades.map((t) => [t.id, t]));
  const snapshot = new Map();
  let newCount = 0;
  let existingCount = 0;
  let newerOnDevice = 0;
  let deletedCount = 0;
  let imageRecords = 0;
  let from = null;
  let to = null;
  for (const { trade, imageCount } of parsed.rows) {
    const stored = device.get(trade.id) || null;
    snapshot.set(trade.id, stored ? stored.updatedAt : null);
    if (stored) {
      existingCount += 1;
      if (typeof stored.updatedAt === 'string' && stored.updatedAt > trade.updatedAt) newerOnDevice += 1;
    } else {
      newCount += 1;
    }
    if (trade.deletedAt != null) deletedCount += 1;
    if (imageCount > 0) imageRecords += 1;
    // 日時は固定形式なので、文字の比較がそのまま時刻の順（architecture 6.6）
    if (from === null || trade.entryAt < from) from = trade.entryAt;
    if (to === null || trade.entryAt > to) to = trade.entryAt;
  }
  return {
    readable: parsed.rows.length,
    newCount, existingCount, newerOnDevice, deletedCount, imageRecords,
    issueCount: parsed.issues.length,
    period: from === null ? null : { from, to },
    snapshot,
  };
}

/** 取り込む件数（スキップ＝新しい記録の数、上書き＝新しい記録＋すでにある記録の数：design 14.6.9） */
export function importCount(summary, overwrite) {
  return summary.newCount + (overwrite ? summary.existingCount : 0);
}

/* ---------------------------------------------------------
   画面に出す文（design 14.6.9。文言は design が正）
   --------------------------------------------------------- */

const withCommas = (n) => n.toLocaleString('ja-JP');

/** 件数（「122件」）と行数（「2行」） */
export const countLabel = (n) => `${withCommas(n)}件`;
export const lineCountLabel = (n) => `${withCommas(n)}行`;

/** 日付だけ（2026/09/01）。日時は日本時間の固定形式 */
function dayLabel(at) {
  const p = jstParts(at);
  return `${p.year}/${String(p.month).padStart(2, '0')}/${String(p.day).padStart(2, '0')}`;
}

/** 記録の期間（「2026/09/01〜2026/10/15」。1日だけなら「2026/10/15」） */
export function periodLabel(period) {
  const a = dayLabel(period.from);
  const b = dayLabel(period.to);
  return a === b ? a : `${a}〜${b}`;
}

/** 主要ボタンの文字（0件のときは押せない形の文字） */
export function importButtonLabel(summary, overwrite) {
  if (summary.readable === 0) return '取り込める記録はありません';
  const n = importCount(summary, overwrite);
  return n === 0 ? '取り込む記録はありません' : `${withCommas(n)}件を取り込む`;
}

/** 件数のまとまりの下の説明文（削除済み → 画像の順。画像の文はいつも出す） */
export function confirmNote(summary) {
  const parts = [];
  if (summary.deletedCount > 0) parts.push(`削除済みの記録${withCommas(summary.deletedCount)}件を含みます（一覧には出ません）。`);
  parts.push(summary.imageRecords > 0 ? `画像は戻りません（画像が付いていた記録 ${withCommas(summary.imageRecords)}件）。` : '画像は戻りません。');
  return parts.join('');
}

/** 「すでにある記録」の扱いの説明（選んだ方） */
export function modeNote(overwrite) {
  return overwrite ? 'CSVの内容で置き換えます。この端末にある画像はそのまま残ります。' : 'この端末の記録をそのまま残します。';
}

/** 上書きで、端末の方が新しい記録があるときの注意 */
export function newerWarning(count) {
  return `うち${withCommas(count)}件は、この端末の記録の方があとで更新されています。上書きすると、その変更は失われます。`;
}

/** すべてがすでにある記録で、スキップを選んでいるときの案内 */
export const ALL_EXISTING_NOTE = 'すべての記録がこの端末にあります。CSVの内容で置き換えるときは「上書き」を選びます。';

/** 読めなかった行の説明 */
export const ISSUES_NOTE = '読めなかった行は取り込みません。行番号は、見出しを1行目として数えた番号です（NumbersやGoogleスプレッドシートで開いたときの行番号と同じ）。';

/** 結果の説明文（画像 → 選択肢 → 設定の順。design 14.6.9） */
export function resultNotes({ addedWithImages, choiceNote }) {
  const out = [];
  if (addedWithImages > 0) out.push('画像は戻っていません。必要な画像は、各記録の編集画面から追加し直せます。');
  if (choiceNote) out.push(choiceNote);
  out.push('1lotの通貨数などの設定は戻りません。');
  return out;
}

/* ---------------------------------------------------------
   選択肢の補い（design 14.6.11 ⑤）
   --------------------------------------------------------- */

/** 選択肢の種類と、記録の中でその選択肢を使う項目（感情は エントリー時・決済時 で共通：requirements 6.1） */
const CHOICE_SOURCES = Object.freeze([
  ['entryReasons', '根拠', (t) => t.entryReasons],
  ['emotions', '感情', (t) => [t.emotion, t.exitEmotion]],
  ['tags', 'タグ', (t) => t.tags],
]);

/**
 * 取り込んだ記録のタグ・根拠・感情のうち、この端末の選択肢に無いものを末尾に足す（機種変更後は選択肢が初期値に戻っているため）。
 * ・削除済みの記録の名前は足さない（一覧に出ない記録のために選択肢を増やさない）
 * ・選択肢に足せない名前（21文字以上・前後に空白がある）は足さない（記録の中の名前はそのまま残る）。名前のチェックは選択肢の編集と同じ checkChoiceName
 * ・通貨ペアは「よく使う通貨ペア」に足さない（並びが変わるため：design 14.6.11 ⑤）
 * @param {{ entryReasons: string[], emotions: string[], tags: string[] }} choices 今の選択肢（設定 choices）
 * @param {object[]} trades 取り込んだ記録
 * @returns {{ choices: object, added: { entryReasons: number, emotions: number, tags: number }, total: number }}
 */
export function planChoiceAdditions(choices, trades) {
  const next = { entryReasons: [...choices.entryReasons], emotions: [...choices.emotions], tags: [...choices.tags] };
  const added = { entryReasons: 0, emotions: 0, tags: 0 };
  for (const t of trades) {
    if (t.deletedAt != null) continue;
    for (const [kind, , pick] of CHOICE_SOURCES) {
      for (const name of pick(t)) {
        if (typeof name !== 'string') continue;
        const r = checkChoiceName(name, next[kind]);
        if (!r.ok || r.name !== name) continue;
        next[kind].push(name);
        added[kind] += 1;
      }
    }
  }
  return { choices: next, added, total: added.entryReasons + added.emotions + added.tags };
}

/** 結果の「タグ2件・感情1件を選択肢に加えました。」（足したものがなければ空の文字） */
export function choiceAddedNote(added) {
  const parts = CHOICE_SOURCES.filter(([kind]) => added[kind] > 0).map(([kind, label]) => `${label}${withCommas(added[kind])}件`);
  return parts.length ? `${parts.join('・')}を選択肢に加えました。` : '';
}
