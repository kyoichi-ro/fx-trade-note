/* =========================================================
   tests/datetime.test.js
   日時（js/datetime.js）のテスト（T-17。architecture.md 6.6・13.2「日時」・13.3 #4）。
   ・保存形式（YYYY-MM-DDTHH:mm:ss+09:00・25文字）の生成と読み取り
   ・datetime-local 入力欄との変換（入力欄に見えている時刻＝保存される日本時間）
   ・端末のタイムゾーンが日本以外でも日本時間になること
     → 期待値はすべて「UTC の瞬間」から書いているので、どのタイムゾーンの端末で実行しても同じ結果になるはず。
       さらに DT-12 で、ブラウザ内蔵の Intl（Asia/Tokyo）で求めた日本時間とも見比べる。
       Node.js では  TZ=America/New_York node tests/run-node.mjs  のように端末のタイムゾーンを変えて確かめられる。
   IndexedDB・localStorage を使わないので、Node.js でもブラウザでも実行する。

   ID：DT-xx（日時）
   ========================================================= */
import {
  toJstString, nowJst, parseJst, toInputValue, fromInputValue, nowInputValue, diffMinutes, isWithinMinutes, jstParts,
} from '../js/datetime.js';
import { show } from './helpers.js';

const CATEGORY = '日時';

/** 保存形式（architecture 6.6） */
const JST_FORMAT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+09:00$/;

/** UTC の瞬間を Date で（月は 1〜12 で書く） */
const utc = (y, mo, d, hh = 0, mi = 0, ss = 0, ms = 0) => new Date(Date.UTC(y, mo - 1, d, hh, mi, ss, ms));

/** 確認項目 [説明, 合否, 実際の値] の一覧から合否を作る（db.test.js と同じ形） */
function verdict(checks) {
  const failed = checks.filter(([, ok]) => !ok);
  if (failed.length === 0) return { actual: `確認${checks.length}項目すべて一致`, pass: true };
  return { actual: failed.map(([label, , detail]) => `×${label}（実際：${show(detail)}）`).join('／'), pass: false };
}

const t = (id, title, input, expected, run) => ({ category: CATEGORY, id, title, input, expected, run });

/** Intl で求めた日本時間（'YYYY-MM-DDTHH:mm:ss'）。datetime.js とは別の方法で作り、照合に使う */
function jstByIntl(date) {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  const p = {};
  for (const { type, value } of f.formatToParts(date)) p[type] = value;
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
}

export function collectDatetimeTests() {
  return [
    t('DT-01', '保存形式の生成（UTC→日本時間）', 'toJstString(2026-10-15 12:30:00 UTC)',
      "'2026-10-15T21:30:00+09:00'（25文字）",
      () => {
        const s = toJstString(utc(2026, 10, 15, 12, 30));
        return verdict([['値', s === '2026-10-15T21:30:00+09:00', s], ['25文字', s.length === 25, s.length]]);
      }),

    t('DT-02', '日本時間で日付・年が変わる', 'toJstString(2026-12-31 15:00:00 UTC)',
      "'2027-01-01T00:00:00+09:00'",
      () => {
        const s = toJstString(utc(2026, 12, 31, 15));
        return verdict([['値', s === '2027-01-01T00:00:00+09:00', s]]);
      }),

    t('DT-03', 'ミリ秒は切り捨て・読めない日時は例外', 'toJstString(…12:30:59.999 UTC)／toJstString(Invalid Date)',
      "':59'（繰り上げない）／RangeError",
      () => {
        const s = toJstString(utc(2026, 10, 15, 12, 30, 59, 999));
        let err = null;
        try { toJstString(new Date('x')); } catch (e) { err = e; }
        return verdict([
          ['切り捨て', s === '2026-10-15T21:30:59+09:00', s],
          ['RangeError', err instanceof RangeError, err && err.name],
        ]);
      }),

    t('DT-04', '今の日時の形式', 'nowJst()・nowInputValue()',
      '25文字の固定形式／16文字の入力欄の値で、nowJst の先頭16文字と同じ（同じ分の中で実行）',
      () => {
        const now = new Date();
        const a = toJstString(now);
        const b = nowInputValue(now);
        const n = nowJst();
        return verdict([
          ['nowJst の形式', JST_FORMAT.test(n) && n.length === 25, n],
          ['入力欄の値は16文字', b.length === 16, b],
          ['先頭16文字が同じ', a.slice(0, 16) === b, `${a} / ${b}`],
        ]);
      }),

    t('DT-05', '入力欄の値 → 保存形式', "fromInputValue('2026-10-15T21:30')／秒付き '2026-10-15T21:30:15'／'2026-10-15T21:30:15.250'",
      "'2026-10-15T21:30:00+09:00'／'…21:30:15+09:00'／'…21:30:15+09:00'（入力欄の時刻を日本時間として扱う）",
      () => {
        const a = fromInputValue('2026-10-15T21:30');
        const b = fromInputValue('2026-10-15T21:30:15');
        const c = fromInputValue('2026-10-15T21:30:15.250');
        return verdict([
          ['分まで', a === '2026-10-15T21:30:00+09:00', a],
          ['秒付き', b === '2026-10-15T21:30:15+09:00', b],
          ['小数の秒は切り捨て', c === '2026-10-15T21:30:15+09:00', c],
        ]);
      }),

    t('DT-06', '入力欄の値として読めないもの', "''／'2026-02-30T10:00'／'2026-10-15 21:30'（空白区切り）／'2026-10-15T24:00'／'2026-13-01T00:00'／null",
      'すべて null（画面は「日時を入力してください」）',
      () => {
        const list = ['', '2026-02-30T10:00', '2026-10-15 21:30', '2026-10-15T24:00', '2026-13-01T00:00', null];
        const got = list.map((x) => fromInputValue(x));
        return verdict(list.map((x, i) => [show(x), got[i] === null, got[i]]));
      }),

    t('DT-07', 'うるう日', "fromInputValue('2028-02-29T10:00')／'2027-02-29T10:00'",
      "'2028-02-29T10:00:00+09:00'／null（2027年は平年）",
      () => {
        const a = fromInputValue('2028-02-29T10:00');
        const b = fromInputValue('2027-02-29T10:00');
        return verdict([['2028年', a === '2028-02-29T10:00:00+09:00', a], ['2027年', b === null, b]]);
      }),

    t('DT-08', '保存形式 → 入力欄の値', "toInputValue('2026-10-15T21:30:45+09:00')／toInputValue(2026-10-15 15:10 UTC の Date)",
      "'2026-10-15T21:30'（秒は切り捨て）／'2026-10-16T00:10'（日本時間で日付が変わる）",
      () => {
        const a = toInputValue('2026-10-15T21:30:45+09:00');
        const b = toInputValue(utc(2026, 10, 15, 15, 10));
        return verdict([['文字から', a === '2026-10-15T21:30', a], ['Date から', b === '2026-10-16T00:10', b]]);
      }),

    t('DT-09', '入力欄の値に戻せないもの', "toInputValue('2026-10-15T21:30:00Z')／toInputValue('')／toInputValue(null)／toInputValue(Invalid Date)",
      "すべて ''（空欄）",
      () => {
        const list = ['2026-10-15T21:30:00Z', '', null, new Date('x')];
        const got = list.map((x) => toInputValue(x));
        return verdict(list.map((x, i) => [show(x instanceof Date ? 'Invalid Date' : x), got[i] === '', got[i]]));
      }),

    t('DT-10', '入力欄 ⇔ 保存形式の往復', "'2026-01-01T00:00'・'2026-03-08T02:30'・'2026-10-25T01:30'・'2026-12-31T23:59' を fromInputValue → toInputValue",
      '元の値に戻る（米国・英国の夏時間の切り替え日でもずれない）',
      () => {
        const list = ['2026-01-01T00:00', '2026-03-08T02:30', '2026-10-25T01:30', '2026-12-31T23:59'];
        return verdict(list.map((x) => {
          const back = toInputValue(fromInputValue(x));
          return [x, back === x, back];
        }));
      }),

    t('DT-11', '保存形式の読み取り', "parseJst('2026-10-15T21:30:00+09:00')／'…Z'／'…+0900'／'2026-02-30T00:00:00+09:00'／123",
      '1つ目は 2026-10-15 12:30 UTC の瞬間。ほかは null（固定形式以外は受け付けない）',
      () => {
        const d = parseJst('2026-10-15T21:30:00+09:00');
        const bad = ['2026-10-15T21:30:00Z', '2026-10-15T21:30:00+0900', '2026-02-30T00:00:00+09:00', 123].map((x) => parseJst(x));
        return verdict([
          ['瞬間', d && d.getTime() === Date.UTC(2026, 9, 15, 12, 30), d && d.toISOString()],
          ['固定形式以外は null', bad.every((x) => x === null), bad.map((x) => (x ? x.toISOString() : null)).join(',')],
        ]);
      }),

    t('DT-12', '端末のタイムゾーンに関係なく日本時間', '1年分（2026年）を約13日おき・夏時間の切り替え日を含む32の瞬間を toJstString',
      'Intl（Asia/Tokyo）で求めた日本時間とすべて一致',
      () => {
        const instants = [];
        for (let i = 0; i < 28; i += 1) instants.push(new Date(Date.UTC(2026, 0, 1, 7, 41, 13) + i * 13 * 86400000));
        // 米国（3/8・11/1）・欧州（3/29・10/25）の夏時間の切り替え前後
        instants.push(utc(2026, 3, 8, 6, 59, 59), utc(2026, 3, 8, 7, 0, 0), utc(2026, 10, 25, 0, 59, 59), utc(2026, 10, 25, 1, 0, 0));
        const bad = instants.filter((d) => toJstString(d).slice(0, 19) !== jstByIntl(d));
        return verdict([['不一致の数', bad.length === 0, bad.map((d) => d.toISOString()).join(',') || 0]]);
      }),

    t('DT-13', '経過時間（分）', "diffMinutes('…21:30:00+09:00', '…22:00:00+09:00')／日付をまたぐ／逆順／読めない値",
      '30／150／−30／null',
      () => {
        const a = diffMinutes('2026-10-15T21:30:00+09:00', '2026-10-15T22:00:00+09:00');
        const b = diffMinutes('2026-10-15T23:00:00+09:00', '2026-10-16T01:30:00+09:00');
        const c = diffMinutes('2026-10-15T22:00:00+09:00', '2026-10-15T21:30:00+09:00');
        const d = diffMinutes('x', '2026-10-15T22:00:00+09:00');
        return verdict([['30分', a === 30, a], ['日付をまたぐ', b === 150, b], ['逆順', c === -30, c], ['読めない', d === null, d]]);
      }),

    t('DT-14', '「30分以内」の境目（起動時に入力画面を自動で開くか）', "最終更新 '2026-10-15T21:00:00+09:00' に対して now＝21:29:59／21:30:00／21:30:01／20:59（未来の下書き）／読めない値",
      'true／true（ちょうど30分は以内）／false／true／false',
      () => {
        const base = '2026-10-15T21:00:00+09:00';
        const at = (hh, mi, ss) => utc(2026, 10, 15, hh - 9, mi, ss);
        const r = [
          isWithinMinutes(base, 30, at(21, 29, 59)),
          isWithinMinutes(base, 30, at(21, 30, 0)),
          isWithinMinutes(base, 30, at(21, 30, 1)),
          isWithinMinutes(base, 30, at(20, 59, 0)),
          isWithinMinutes('x', 30, at(21, 0, 0)),
        ];
        const exp = [true, true, false, true, false];
        return verdict(r.map((v, i) => [`${i + 1}つ目`, v === exp[i], v]));
      }),

    t('DT-15', '日本時間の部品（曜日を含む）', "jstParts('2026-10-15T21:30:05+09:00')／jstParts(2026-10-17 15:00 UTC)",
      '2026年10月15日 21:30:05・木曜（4）／10月18日 0:00・日曜（0）',
      () => {
        const a = jstParts('2026-10-15T21:30:05+09:00');
        const b = jstParts(utc(2026, 10, 17, 15));
        return verdict([
          ['1つ目', a && a.year === 2026 && a.month === 10 && a.day === 15 && a.hour === 21 && a.minute === 30 && a.second === 5 && a.weekday === 4, JSON.stringify(a)],
          ['2つ目', b && b.month === 10 && b.day === 18 && b.hour === 0 && b.minute === 0 && b.weekday === 0, JSON.stringify(b)],
          ['読めない値', jstParts('') === null, jstParts('')],
        ]);
      }),
  ];
}
