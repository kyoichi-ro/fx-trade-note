/* =========================================================
   tests/format.test.js
   表示用の整形（js/format.js）のテスト（T-19。design.md 6.3・14.3.4・14.3.8）。
   ・円：＋2,500円 / −1,885円 / ±0円（プラスは全角の＋、マイナスは U+2212、ゼロは ±）
   ・pips：＋25.0 pips / −37.7 pips / ±0.0 pips。-0.0 と出さない
   ・ロット：余計な0を付けない
   ・日時：10/15(木) 21:30、今年以外は 2025/12/30(火) 09:00、見出し 10月15日（木）、下書きの時刻
   IndexedDB・localStorage を使わないので、Node.js でもブラウザでも実行する。

   ID：FM-xx（表示の整形）
   ========================================================= */
import {
  formatYen, formatPips, formatPipsTenths, formatLots, formatTime, formatDateTime, formatDateHeading, formatDraftTime,
  toneOf, toTenths, speakYen, speakPips, speakDateTime,
} from '../js/format.js';
import { show } from './helpers.js';

const CATEGORY = '表示の整形';

/** 「今」＝ 2026-10-15（木）12:00（日本時間） */
const NOW = new Date('2026-10-15T12:00:00+09:00');

function verdict(checks) {
  const failed = checks.filter(([, ok]) => !ok);
  if (failed.length === 0) return { actual: `確認${checks.length}項目すべて一致`, pass: true };
  return { actual: failed.map(([label, , detail]) => `×${label}（実際：${show(detail)}）`).join('／'), pass: false };
}

/** [入力, 期待] の並びを関数で変換して比べる */
function table(fn, rows) {
  return verdict(rows.map(([input, want]) => {
    const got = fn(input);
    return [`${show(input)} → ${show(want)}`, got === want, got];
  }));
}

const t = (id, title, input, expected, run) => ({ category: CATEGORY, id, title, input, expected, run });

export function collectFormatTests() {
  return [
    t('FM-01', '円：符号と3桁区切り（design 6.3）', '2500・-1885・0・1234567',
      "'＋2,500円'・'−1,885円'・'±0円'・'＋1,234,567円'",
      () => table(formatYen, [[2500, '＋2,500円'], [-1885, '−1,885円'], [0, '±0円'], [1234567, '＋1,234,567円'], [-50000, '−50,000円']])),

    t('FM-02', '円：値がなければ「—」（保有中・計算できなかった）。-0 は「±0円」', 'null・undefined・NaN・-0',
      "'—'・'—'・'—'・'±0円'",
      () => table(formatYen, [[null, '—'], [undefined, '—'], [NaN, '—'], [-0, '±0円']])),

    t('FM-03', '円：マイナスは U+2212、プラスは全角の＋（ハイフン・半角+ ではない）', '-30・30',
      '先頭の文字が U+2212 と U+FF0B',
      () => verdict([
        ['マイナス', formatYen(-30).codePointAt(0) === 0x2212, formatYen(-30).codePointAt(0)],
        ['プラス', formatYen(30).codePointAt(0) === 0xff0b, formatYen(30).codePointAt(0)],
        ['ゼロ', formatYen(0).codePointAt(0) === 0xb1, formatYen(0).codePointAt(0)],
      ])),

    t('FM-04', 'pips：小数第1位・符号付き', '25・-37.7・0.5・-377.00000000000006÷10',
      "'＋25.0 pips'・'−37.7 pips'・'＋0.5 pips'・'−37.7 pips'",
      () => table(formatPips, [[25, '＋25.0 pips'], [-37.7, '−37.7 pips'], [0.5, '＋0.5 pips'], [-377.00000000000006 / 10, '−37.7 pips']])),

    t('FM-05', 'pips：0.05未満は「±0.0 pips」（「−0.0」と出さない）。値がなければ「—」', '0・-0・0.04・-0.04・null',
      "'±0.0 pips'・'±0.0 pips'・'±0.0 pips'・'±0.0 pips'・'—'",
      () => table(formatPips, [[0, '±0.0 pips'], [-0, '±0.0 pips'], [0.04, '±0.0 pips'], [-0.04, '±0.0 pips'], [null, '—']])),

    t('FM-06', 'pips：0.1pips 単位の整数（合計）から表示', '128・-197・0・-5・1234',
      "'＋12.8 pips'・'−19.7 pips'・'±0.0 pips'・'−0.5 pips'・'＋123.4 pips'",
      () => table(formatPipsTenths, [[128, '＋12.8 pips'], [-197, '−19.7 pips'], [0, '±0.0 pips'], [-5, '−0.5 pips'], [1234, '＋123.4 pips']])),

    t('FM-07', 'pips の整数化：0から遠い方へ四捨五入', '0.05・-0.05・37.7・0.04',
      '1・-1・377・0',
      () => verdict([
        ['0.05', toTenths(0.05) === 1, toTenths(0.05)],
        ['-0.05', toTenths(-0.05) === -1, toTenths(-0.05)],
        ['37.7', toTenths(37.7) === 377, toTenths(37.7)],
        ['0.04', toTenths(0.04) === 0 && !Object.is(toTenths(0.04), -0), toTenths(0.04)],
        ['-0.04（-0 にならない）', Object.is(toTenths(-0.04), 0), toTenths(-0.04)],
      ])),

    t('FM-08', 'ロット：余計な0を付けない', '0.5・1・0.01・0.07・10・100・0.1+0.2',
      "'0.5lot'・'1lot'・'0.01lot'・'0.07lot'・'10lot'・'100lot'・'0.3lot'",
      () => table(formatLots, [[0.5, '0.5lot'], [1, '1lot'], [0.01, '0.01lot'], [0.07, '0.07lot'], [10, '10lot'], [100, '100lot'], [0.1 + 0.2, '0.3lot'], [null, '—']])),

    t('FM-09', '色の向き：プラス＝profit・マイナス＝loss・ゼロ＝even', '5・-5・0・-0',
      'profit・loss・even・even',
      () => table(toneOf, [[5, 'profit'], [-5, 'loss'], [0, 'even'], [-0, 'even']])),

    t('FM-10', '日時：今年は「10/15(木) 11:30」、今年以外は年付き（design 6.3）', '2026-10-15T11:30・2025-12-30T09:00・2026-01-01T00:05',
      "'10/15(木) 11:30'・'2025/12/30(火) 09:00'・'1/1(木) 00:05'",
      () => table((v) => formatDateTime(v, NOW), [
        ['2026-10-15T11:30:00+09:00', '10/15(木) 11:30'],
        ['2025-12-30T09:00:00+09:00', '2025/12/30(火) 09:00'],
        ['2026-01-01T00:05:00+09:00', '1/1(木) 00:05'],
        ['壊れた日時', '—'],
      ])),

    t('FM-11', '日時の見出し：「10月15日（木）」、今年以外は「2025年12月30日（火）」', '2026-10-15・2025-12-30',
      "'10月15日（木）'・'2025年12月30日（火）'",
      () => table((v) => formatDateHeading(v, NOW), [
        ['2026-10-15T10:30:00+09:00', '10月15日（木）'],
        ['2025-12-30T09:00:00+09:00', '2025年12月30日（火）'],
        ['2026-10-09T22:30:00+09:00', '10月9日（金）'],
      ])),

    t('FM-12', '時刻だけ：2桁にそろえる', '2026-10-15T10:30・2026-10-15T09:05',
      "'10:30'・'09:05'",
      () => table(formatTime, [['2026-10-15T10:30:00+09:00', '10:30'], ['2026-10-15T09:05:00+09:00', '09:05'], ['x', '—']])),

    t('FM-13', '下書きの時刻：今日は時刻だけ、今日でなければ「10/14 21:32」（design 14.3.8）', '今日 21:32・昨日 21:32・昨年 12/31 09:05',
      "'21:32'・'10/14 21:32'・'12/31 09:05'",
      () => table((v) => formatDraftTime(v, NOW), [
        ['2026-10-15T21:32:00+09:00', '21:32'],
        ['2026-10-14T21:32:00+09:00', '10/14 21:32'],
        ['2025-12-31T09:05:00+09:00', '12/31 09:05'],
        ['x', ''],
      ])),

    t('FM-14', '日付の境目は日本時間（UTC の前日 15:00 以降は日本の翌日）', '2026-10-15T15:00:00Z（＝10/16 0:00 JST）を「今」として 10/15 22:00 JST',
      "下書き '10/15 22:00'（今日ではない）・日時 '10/15(木) 22:00'",
      () => {
        const now = new Date('2026-10-15T15:00:00Z');
        return verdict([
          ['下書き', formatDraftTime('2026-10-15T22:00:00+09:00', now) === '10/15 22:00', formatDraftTime('2026-10-15T22:00:00+09:00', now)],
          ['日時', formatDateTime('2026-10-15T22:00:00+09:00', now) === '10/15(木) 22:00', formatDateTime('2026-10-15T22:00:00+09:00', now)],
        ]);
      }),

    t('FM-15', '読み上げ用：プラス/マイナスと言葉で読ませる（記号を読ませない）', '2500・-1885・0・null／25・-37.7',
      "'プラス2,500円'・'マイナス1,885円'・'0円'・'未確定'／'プラス25.0 pips'・'マイナス37.7 pips'",
      () => verdict([
        ['円', [speakYen(2500), speakYen(-1885), speakYen(0), speakYen(null)].join('・') === 'プラス2,500円・マイナス1,885円・0円・未確定', speakYen(-1885)],
        ['pips', [speakPips(25), speakPips(-37.7), speakPips(0)].join('・') === 'プラス25.0 pips・マイナス37.7 pips・0.0 pips', speakPips(-37.7)],
        ['日時', speakDateTime('2026-10-15T10:30:00+09:00', NOW) === '10月15日 10時30分', speakDateTime('2026-10-15T10:30:00+09:00', NOW)],
      ])),
  ];
}
