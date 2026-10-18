/* =========================================================
   js/datetime.js
   日本時間（JST）の日時文字列の生成・読み取りと、入力欄（datetime-local）との変換（architecture.md 4.2・6.6）。

   【T-12】保存処理で createdAt・updatedAt・deletedAt を付けるのに必要な toJstString() と nowJst() を作成。
   【T-17】エントリー記録画面で使う次の関数を追加し、日時のテスト（tests/datetime.test.js：architecture 13.2「日時」・13.3 #4）を作成：
     ・parseJst()       保存形式の文字 → Date（読めなければ null）
     ・toInputValue()   日時 → 入力欄の値 'YYYY-MM-DDTHH:mm'（日本時間）
     ・fromInputValue() 入力欄の値 → 保存形式（日本時間として解釈：6.6）
     ・nowInputValue()  今の日時を入力欄の値で（「今にする」・画面を開いた時刻）
     ・diffMinutes()    2つの日時の差（分）。保有時間・下書きの「30分以内」の判定に使う
     ・isWithinMinutes() 「今から○分以内か」（起動時に入力画面を自動で開くかの判定：architecture 9.3）
     ・jstParts()       日本時間の年・月・日・時・分・曜日（画面の表示用の部品。表示の文字にするのは画面側）

   保存形式（architecture 6.6 の固定形式）：
     YYYY-MM-DDTHH:mm:ss+09:00   例 2026-10-15T21:30:00+09:00（常に25文字）
   ・常に日本時間で、秒まで・ミリ秒なし・桁数固定。文字列のまま比べても時刻の順になるようにするため。
   ・日本時間は夏時間がないので「UTC＋9時間」で作る。端末のタイムゾーン設定（海外旅行中など）に左右されない。
     そのため、このファイルでは getHours() などの「端末の時刻」を読む関数を一切使わず、getUTC〜 と Date.UTC だけを使う。
   ・new Date('2026-10-15 21:30')（空白区切り）は iOS Safari で読めないため使わない（6.6）。文字は自分で分解して読む。

   ・ここは「基礎」の層（architecture 4.3）。window や document を使わない（Node.js でも動く）。
   ========================================================= */

/** 日本時間と UTC の差（9時間）をミリ秒で */
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** 2桁にそろえる（5 → '05'） */
const pad2 = (n) => String(n).padStart(2, '0');

/**
 * 入力欄から受け付ける年の範囲（T-33：T-30 の R-09）。トレードの記録に使う日時なので 2000〜2099 年に限る。
 * 以前は「0500年」のような打ち間違いがそのまま保存され、保存形式（25文字固定）が崩れて、並び順や日時の読み取りが壊れたため。
 * 範囲外は fromInputValue が null。画面は「日時は2000〜2099年で入力してください」と出し分ける（isInputYearOutOfRange：T-33 再確認 RC-05）。
 * 保存済みの日時を読む parseJst には当てない（読めなくなるのを避ける）。
 */
export const INPUT_YEAR_MIN = 2000;
export const INPUT_YEAR_MAX = 2099;

/** 保存形式（25文字固定）。ほかの書き方（Z・+0900・ミリ秒付き）は受け付けない（並び順の約束を守るため） */
const JST_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\+09:00$/;

/**
 * datetime-local 入力欄の値の形。ふつうは 'YYYY-MM-DDTHH:mm'（分まで）だが、
 * ブラウザによっては秒（:ss）や小数の秒（.sss）を付けて返すことがあるので、それも受け付ける（小数の秒は切り捨て）。
 */
const INPUT_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?$/;

/**
 * 年月日時分秒（日本時間）から Date を作る。存在しない日時（2月30日・25時など）は null。
 * Date.UTC は「2月30日」を3月2日に繰り上げてしまうので、作った後に同じ値に戻るかで確かめる。
 */
function dateFromJstFields(y, mo, d, hh, mi, ss) {
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || hh > 23 || mi > 59 || ss > 59) return null;
  const t = Date.UTC(y, mo - 1, d, hh, mi, ss) - JST_OFFSET_MS;
  const j = new Date(t + JST_OFFSET_MS);
  if (j.getUTCFullYear() !== y || j.getUTCMonth() !== mo - 1 || j.getUTCDate() !== d) return null;
  return new Date(t);
}

/**
 * Date を日本時間の固定形式の文字列にする。
 * getUTC〜 を使うのは、端末のタイムゾーンの影響を受けないようにするため
 * （「UTC の時刻＋9時間」をずらした Date から UTC の値を読むと、日本時間の値になる）。
 * ミリ秒は切り捨てる（秒まで：architecture 6.6）。
 * @param {Date} date
 * @returns {string} 例 '2026-10-15T21:30:00+09:00'
 */
export function toJstString(date) {
  const t = date.getTime();
  if (!Number.isFinite(t)) throw new RangeError('toJstString(): 正しくない日時です');
  const j = new Date(t + JST_OFFSET_MS);
  // 年も4桁にそろえる（999年以前で桁が減り、25文字固定の約束が崩れないように：R-09）
  return `${String(j.getUTCFullYear()).padStart(4, '0')}-${pad2(j.getUTCMonth() + 1)}-${pad2(j.getUTCDate())}`
    + `T${pad2(j.getUTCHours())}:${pad2(j.getUTCMinutes())}:${pad2(j.getUTCSeconds())}+09:00`;
}

/** 今の日時を日本時間の固定形式で返す（例 '2026-10-15T21:30:12+09:00'） */
export function nowJst() {
  return toJstString(new Date());
}

/**
 * 保存形式の文字（'2026-10-15T21:30:00+09:00'）を Date にする。
 * 形が違う・存在しない日時なら null（呼び出し側が「読めない日時」として扱う。例外にはしない）。
 * @param {string} text
 * @returns {Date|null}
 */
export function parseJst(text) {
  if (typeof text !== 'string') return null;
  const m = JST_PATTERN.exec(text);
  if (!m) return null;
  const [, y, mo, d, hh, mi, ss] = m.map(Number);
  return dateFromJstFields(y, mo, d, hh, mi, ss);
}

/** Date または保存形式の文字を Date にそろえる（どちらでもなければ null） */
function toDate(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : null;
  return parseJst(value);
}

/**
 * 日時を datetime-local 入力欄の値（日本時間の 'YYYY-MM-DDTHH:mm'）にする。
 * 入力欄は分までなので秒は切り捨てる（21:30:59 → 21:30）。読めない値なら ''（空欄）。
 * @param {Date|string} value Date または保存形式の文字
 * @returns {string} 例 '2026-10-15T21:30'
 */
export function toInputValue(value) {
  const d = toDate(value);
  if (!d) return '';
  return toJstString(d).slice(0, 16);
}

/**
 * 入力欄の値が「形は日時として正しいが、年が 2000〜2099 年の外」か（RC-05）。
 * 画面が「日時を入力してください」（空欄・読めない）と「日時は2000〜2099年で入力してください」を出し分けるために使う。
 * 空欄・形が違うときは false。
 * @param {string} text 例 '1999-12-31T23:59'
 * @returns {boolean}
 */
export function isInputYearOutOfRange(text) {
  if (typeof text !== 'string') return false;
  const m = INPUT_PATTERN.exec(text.trim());
  if (!m) return false;
  const y = Number(m[1]);
  return y < INPUT_YEAR_MIN || y > INPUT_YEAR_MAX;
}

/**
 * datetime-local 入力欄の値を、日本時間として保存形式にする（architecture 6.6：入力欄に見えている時刻＝保存される日本時間）。
 * 秒がなければ ':00' を付ける。空欄・形が違う・存在しない日時（2月30日など）・2000〜2099 年の外（R-09）は null
 * （画面は「日時を入力してください」）。
 * @param {string} text 例 '2026-10-15T21:30'
 * @returns {string|null} 例 '2026-10-15T21:30:00+09:00'
 */
export function fromInputValue(text) {
  if (typeof text !== 'string') return null;
  const m = INPUT_PATTERN.exec(text.trim());
  if (!m) return null;
  const [y, mo, d, hh, mi] = m.slice(1, 6).map(Number);
  if (y < INPUT_YEAR_MIN || y > INPUT_YEAR_MAX) return null;
  const ss = m[6] === undefined ? 0 : Number(m[6]);
  const date = dateFromJstFields(y, mo, d, hh, mi, ss);
  return date ? toJstString(date) : null;
}

/**
 * 今の日時を入力欄の値（日本時間・分まで）で返す。「今にする」と、エントリー画面を開いた時刻の自動入力に使う。
 * @param {Date} [now] テスト用に時刻を渡せる
 */
export function nowInputValue(now = new Date()) {
  return toInputValue(now);
}

/**
 * 2つの日時の差を分で返す（to − from。秒の差も小数で含む）。どちらかが読めなければ null。
 * 保有時間（決済日時 − エントリー日時：requirements 6.1 の補足）と、下書きの経過時間に使う。
 * @param {Date|string} from
 * @param {Date|string} to
 * @returns {number|null}
 */
export function diffMinutes(from, to) {
  const a = toDate(from);
  const b = toDate(to);
  if (!a || !b) return null;
  return (b.getTime() - a.getTime()) / 60000;
}

/**
 * 日時 value が「now から数えて minutes 分以内」か（ちょうど minutes 分は以内に含める）。
 * 起動時に、下書きの最終更新から30分以内なら入力画面を自動で開く判定に使う（architecture 9.3・design 14.1.10）。
 * 未来の日時（端末の時計を戻した場合など）も「最近」とみなして true にする（入力の続きを開けなくなるよりよいため）。
 * 読めない日時は false。
 * @param {Date|string} value
 * @param {number} minutes
 * @param {Date} [now]
 */
export function isWithinMinutes(value, minutes, now = new Date()) {
  const diff = diffMinutes(value, now);
  return diff !== null && diff <= minutes;
}

/**
 * 日本時間の年・月・日・時・分・秒・曜日（0＝日〜6＝土）を返す。読めなければ null。
 * 「21:32 の下書き」「10/14 21:32」のような表示の文字は画面側で組み立てる（表示の整形は format.js・各画面の担当）。
 * @param {Date|string} value
 * @returns {{year:number, month:number, day:number, hour:number, minute:number, second:number, weekday:number}|null}
 */
export function jstParts(value) {
  const d = toDate(value);
  if (!d) return null;
  const j = new Date(d.getTime() + JST_OFFSET_MS);
  return {
    year: j.getUTCFullYear(),
    month: j.getUTCMonth() + 1,
    day: j.getUTCDate(),
    hour: j.getUTCHours(),
    minute: j.getUTCMinutes(),
    second: j.getUTCSeconds(),
    weekday: j.getUTCDay(),
  };
}
