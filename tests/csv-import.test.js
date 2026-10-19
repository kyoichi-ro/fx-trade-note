/* =========================================================
   tests/csv-import.test.js
   CSV の読み込み（js/csv-import.js と trades.js の buildImportedTrade）のテスト（T-44。design 14.6.9・14.6.11、
   sheets-setup 7.2、architecture 14.2）。
   ・書き出し（csv.js）→ 読み込みで元の記録に戻ること（往復）。1000件でも
   ・BOM の有無・CRLF／LF・最後の改行なし、列の順番の入れ替え・余分な列、シートの見え方（末尾0・synced）
   ・ファイルとして読めない（文字コード・形式・見出しだけ）と、読めなかった行の理由・行番号
   ・境界値（日時 2000〜2099 年・価格・ロットの上限・小数の桁）
   ・自動で決まる値（status・pips・損益）の確かめ方、riskReward・session の計算し直し
   ・確認シートの件数（新しい／すでにある／端末の方が新しい／削除済み／画像）と文言、選択肢の補い
   ・上書きのときに端末の画像・syncedAt を残し、updatedAt は CSV の値のまま（下書きの照合との関係）
   IndexedDB・localStorage・DOM を使わないので、Node.js でもブラウザでも実行する。
   DB への書き込み（1つのトランザクション・スキップ／上書き・確認中の変更）は tests/csv-import-db.test.js（ブラウザのみ）。

   ID：CI-xx（CSV 読み込み）
   ========================================================= */
import { CSV_COLUMNS, BOM, cellText, escapeCell, prepareCsv, buildCsvBody } from '../js/csv.js';
import {
  IMPORT_MAX_BYTES, decodeCsvBytes, parseCsvRecords, findColumns, parseImportText as parseTextAt, parseImportBytes as parseBytesAt, summarizeImport,
  importCount, importButtonLabel, periodLabel, confirmNote, modeNote, newerWarning, resultNotes, planChoiceAdditions, choiceAddedNote,
  ALL_EXISTING_NOTE, LIST_ITEMS_MAX, CHOICE_AUTO_ADD_MAX, FUTURE_TOLERANCE_MINUTES,
} from '../js/csv-import.js';
import { parseQuoteToJpyRate, QUOTE_RATE_MAX_EXCLUSIVE } from '../js/validate.js';
import { joinList } from '../js/csv.js';
import { toJstString } from '../js/datetime.js';
import { buildImportedTrade, computeClose, recompute, normalizeTrade } from '../js/trades.js';
import { judgeDraftTarget } from '../js/draft-notice.js';
import { show } from './helpers.js';

const CATEGORY = 'CSV読み込み';

/**
 * テストの「今」（未来の更新日時の判定：CI-R03）。端末の時計に左右されないよう決まった時刻にする。
 * テスト用の記録の日時（2026-10-15〜18 ごろ）より後
 */
export const TEST_NOW = new Date('2026-10-20T00:00:00+09:00');
const parseImportText = (text, opts = {}) => parseTextAt(text, { now: TEST_NOW, ...opts });
const parseImportBytes = (bytes, opts = {}) => parseBytesAt(bytes, { now: TEST_NOW, ...opts });
const t = (id, title, input, expected, run) => ({ category: CATEGORY, id, title, input, expected, run });

/* ---------------------------------------------------------
   テスト用の記録（アプリが保存するのと同じ形：pips・損益は computeClose、RR・status・session は recompute）
   --------------------------------------------------------- */

/** n 番目の ID（UUID の形） */
export const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/**
 * 32項目の記録を作る。exitPrice があれば決済済みとして pips・損益を計算する（manualProfitJpy を渡すと手入力）。
 * @param {object} [over]
 * @param {{ manualProfitJpy?: number }} [opts]
 */
export function sampleTrade(over = {}, { manualProfitJpy = null } = {}) {
  const base = {
    id: uuid(1), accountType: 'real', pair: 'USD/JPY', side: 'buy', entryPrice: 150.123, entryAt: '2026-10-15T21:30:00+09:00',
    lots: 0.5, lotUnitSize: 10000, slPrice: 149.9, tpPrice: 150.6, riskReward: null,
    exitPrice: 150.4, exitAt: '2026-10-15T23:00:00+09:00', pips: null, profitJpy: null, profitSource: null,
    quoteToJpyRate: null, status: null, entryReasons: ['トレンドフォロー'], timeframe: 'H1', session: null,
    emotion: '冷静', exitReason: 'tp', exitEmotion: '自信', tags: ['指標前'], memo: '順張り', imageIds: [],
    syncStatus: 'pending', syncedAt: null, deletedAt: null,
    createdAt: '2026-10-15T21:30:05+09:00', updatedAt: '2026-10-15T23:00:10+09:00',
    ...over,
  };
  if (base.exitPrice != null) {
    const c = computeClose(base, { exitPrice: base.exitPrice, quoteToJpyRate: base.quoteToJpyRate, manualProfitJpy });
    Object.assign(base, { pips: c.pips, profitJpy: c.profitJpy, profitSource: c.profitSource });
  }
  return normalizeTrade(recompute(base));
}

/** 保有中の記録 */
export function sampleOpen(over = {}) {
  return sampleTrade({ exitPrice: null, exitAt: null, exitReason: null, exitEmotion: null, ...over });
}

/** いろいろな形の記録（往復の確認用） */
export function variedTrades() {
  return [
    sampleTrade({ id: uuid(1) }),
    sampleOpen({ id: uuid(2), entryAt: '2026-09-01T09:15:00+09:00', slPrice: null, tpPrice: null, tags: [], entryReasons: [], memo: null, emotion: null, timeframe: null }),
    // 非JPYペア・円換算レートで自動計算・売り
    sampleTrade({ id: uuid(3), pair: 'EUR/USD', side: 'sell', entryPrice: 1.08512, exitPrice: 1.08101, slPrice: 1.089, tpPrice: 1.079, quoteToJpyRate: 150.123, lots: 1.25 }),
    // 手入力の損益（業者の確定値）・マイナス
    sampleTrade({ id: uuid(4), exitPrice: 149.8, exitReason: 'sl' }, { manualProfitJpy: -16330 }),
    // 非JPYペア・円換算レートなし・手入力
    sampleTrade({ id: uuid(5), pair: 'GBP/USD', entryPrice: 1.25, exitPrice: 1.2512, quoteToJpyRate: null, slPrice: null, tpPrice: null }, { manualProfitJpy: 1800 }),
    // 削除済み・デモ・区切り記号や数式に見える文字・改行・カンマ・引用符を含む
    sampleTrade({
      id: uuid(6), accountType: 'demo', lotUnitSize: 1000, deletedAt: '2026-10-16T10:00:00+09:00', updatedAt: '2026-10-16T10:00:00+09:00',
      tags: ['=SUM(A1)', 'a|b', 'c\\d'], entryReasons: ['-逆張り', '@メモ'], memo: "'=1+1\n2行目, \"引用\"\r\n3行目",
      emotion: '+焦り', exitEmotion: '\t空白',
    }),
    // 画像が付いていた記録（CSV には枚数だけ）・決済日時＝エントリー日時・引き分け
    sampleTrade({ id: uuid(7), exitPrice: 150.123, exitAt: '2026-10-15T21:30:00+09:00', imageIds: ['img-a', 'img-b'], exitReason: 'breakeven' }),
    // 境界：年 2000・2099、価格の上限の手前、ロットの上限
    sampleTrade({
      id: uuid(8), pair: 'EUR/JPY', entryPrice: 999999.999, exitPrice: 999999.998, lots: 10000000, lotUnitSize: 1,
      entryAt: '2000-01-01T00:00:00+09:00', exitAt: '2099-12-31T23:59:59+09:00', createdAt: '2000-01-01T00:00:00+09:00', updatedAt: '2026-10-18T00:00:00+09:00',
      slPrice: null, tpPrice: null,
    }),
  ];
}

/** 取り込んだ記録が、元の記録と（画像・同期の項目を除いて）同じになるはずの形 */
const expectedAfterImport = (orig) => ({ ...orig, imageIds: [], syncStatus: 'pending', syncedAt: null });

/** 項目の並びに関係なく中身が同じか */
function deepEqual(a, b) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => Object.hasOwn(b, k) && deepEqual(a[k], b[k]));
}

/** 違う項目の名前を並べる（不合格のときの表示） */
function diffKeys(a, b) {
  return Object.keys({ ...a, ...b }).filter((k) => !deepEqual(a[k], b[k]));
}

function verdict(checks) {
  const failed = checks.filter(([, ok]) => !ok);
  if (failed.length === 0) return { actual: `確認${checks.length}項目すべて一致`, pass: true };
  return { actual: failed.map(([label, , detail]) => `×${label}（実際：${show(detail)}）`).join('／'), pass: false };
}

/* ---------------------------------------------------------
   CSV の文字を組み立てる道具
   --------------------------------------------------------- */

/** 記録の各列のセルの文字（書き出しと同じ cellText） */
const cellsOf = (trade) => Object.fromEntries(CSV_COLUMNS.map((c) => [c, cellText(c, trade)]));

/**
 * 見出し＋行の CSV の文字を作る。rows は「列名 → セルの文字（エスケープ前）」。
 * @param {object[]} rows
 * @param {{ columns?: string[], eol?: string, bom?: boolean, finalEol?: boolean }} [opts]
 */
function csvText(rows, { columns = CSV_COLUMNS, eol = '\r\n', bom = false, finalEol = true } = {}) {
  const lines = [columns.join(','), ...rows.map((r) => columns.map((c) => escapeCell(r[c] ?? '')).join(','))];
  return (bom ? BOM : '') + lines.join(eol) + (finalEol ? eol : '');
}

/** 良い記録1件のセルの一部だけを差し替えた CSV を読んで、最初の「読めなかった理由」を返す（読めたら null） */
function reasonWith(over, trade = sampleTrade()) {
  const r = parseImportText(csvText([{ ...cellsOf(trade), ...over }]));
  if (!r.ok) return `ファイル全体：${r.error}`;
  return r.issues.length ? r.issues[0].reason : null;
}

const encode = (s) => new TextEncoder().encode(s);

/* ---------------------------------------------------------
   テストの定義
   --------------------------------------------------------- */

export function collectCsvImportTests() {
  return [
    t('CI-01', '書き出し → 読み込みで元に戻る（往復）：保有中・決済済み・非JPY・手入力・削除済み・記号や改行を含む記録',
      'variedTrades() 8件を prepareCsv（削除済みも含める）→ バイト列 → parseImportBytes → buildImportedTrade（新しい記録）',
      '8件すべて読める（読めない行0）。画像（imageIds は []）・syncStatus（pending）・syncedAt（null）以外の32項目が元の記録と同じ',
      () => {
        const origs = variedTrades();
        const p = prepareCsv(origs, { includeDeleted: true });
        const r = parseImportBytes(encode(p.text));
        const checks = [['読めた', r.ok, r.error], ['読めない行0', r.ok && r.issues.length === 0, r.ok && r.issues]];
        if (r.ok) {
          checks.push(['件数', r.rows.length === origs.length, r.rows.length]);
          for (const o of origs) {
            const row = r.rows.find((x) => x.trade.id === o.id);
            const got = row ? buildImportedTrade(row.trade, null) : null;
            checks.push([`ID ${o.id.slice(-2)}`, got && deepEqual(got, expectedAfterImport(o)), got && diffKeys(got, expectedAfterImport(o))]);
          }
          const img = r.rows.find((x) => x.trade.id === uuid(7));
          checks.push(['画像の枚数は数として読む', img && img.imageCount === 2, img && img.imageCount]);
        }
        return verdict(checks);
      }),

    t('CI-02', '1000件の往復（書き出し → 読み込み）',
      '1000件（決済済み・保有中・削除済みを混ぜる）を書き出して読み込む',
      '1000件すべて読めて、元の記録と同じ（画像・同期の項目を除く）',
      () => {
        const origs = [];
        for (let i = 0; i < 1000; i += 1) {
          const day = String((i % 28) + 1).padStart(2, '0');
          const at = `2026-09-${day}T${String(i % 24).padStart(2, '0')}:00:00+09:00`;
          const over = { id: uuid(1000 + i), entryAt: at, createdAt: at, updatedAt: at, exitAt: i % 3 === 0 ? null : `2026-09-${day}T23:59:00+09:00`,
            memo: `メモ${i}`, deletedAt: i % 50 === 0 ? at : null };
          origs.push(i % 3 === 0 ? sampleOpen(over) : sampleTrade({ ...over, exitPrice: 150 + (i % 7) / 100 }));
        }
        const r = parseImportText(buildCsvBody(origs));
        const bad = r.ok ? origs.filter((o) => {
          const row = r.rows.find((x) => x.trade.id === o.id);
          return !row || !deepEqual(buildImportedTrade(row.trade, null), expectedAfterImport(o));
        }) : origs;
        return verdict([['読めた', r.ok, r.error], ['1000件', r.ok && r.rows.length === 1000, r.ok && r.rows.length], ['すべて一致', bad.length === 0, bad.length]]);
      }),

    t('CI-03', 'BOM の有無・改行（CRLF／LF）・最後の改行なしを問わない',
      '同じ2件を ①BOM＋CRLF＋最後に改行 ②BOMなし＋LF ③BOMなし＋CRLF＋最後の改行なし ④LF＋最後の改行なし',
      'どれも2件読めて、中身が同じ',
      () => {
        const rows = [cellsOf(sampleTrade({ id: uuid(1) })), cellsOf(sampleOpen({ id: uuid(2) }))];
        const variants = [
          csvText(rows, { bom: true }), csvText(rows, { eol: '\n' }), csvText(rows, { finalEol: false }), csvText(rows, { eol: '\n', finalEol: false }),
        ];
        const results = variants.map((s) => parseImportBytes(encode(s)));
        const ref = JSON.stringify(results[0].ok && results[0].rows);
        return verdict(results.map((r, i) => [`形${i + 1}`, r.ok && r.rows.length === 2 && r.issues.length === 0 && JSON.stringify(r.rows) === ref, r.ok ? r.issues : r.error]));
      }),

    t('CI-04', '列は名前で読む：順番の入れ替え・知らない列（シート固有・オーナーが足した列）・見出しの前後の空白',
      '32列を逆順に並べ、先頭と途中に知らない列「note」「」を足し、見出しの1つに前後の空白',
      '1件読めて、元の記録と同じ',
      () => {
        const orig = sampleTrade();
        const columns = ['note', ...[...CSV_COLUMNS].reverse()];
        columns.splice(10, 0, '');
        const head = columns.map((c) => (c === 'memo' ? ' memo ' : c));
        const cells = { ...cellsOf(orig), note: '手で足した列', '': 'x' };
        const text = [head.join(','), columns.map((c) => escapeCell(cells[c] ?? '')).join(',')].join('\n');
        const r = parseImportText(text);
        const got = r.ok && r.rows[0] ? buildImportedTrade(r.rows[0].trade, null) : null;
        return verdict([['読めた', r.ok && r.issues.length === 0, r.ok ? r.issues : r.error], ['元と同じ', got && deepEqual(got, expectedAfterImport(orig)), got && diffKeys(got, expectedAfterImport(orig))]]);
      }),

    t('CI-05', '見出しが合わない CSV はファイルごと読めない（I-2）',
      '①列が1つ足りない ②同じ名前の列が2つ ③空のファイル ④見出しが日本語 ⑤ほかのアプリの CSV',
      'どれも error: format',
      () => {
        const missing = CSV_COLUMNS.filter((c) => c !== 'tags').join(',');
        const dup = [...CSV_COLUMNS, 'memo'].join(',');
        const cases = [missing, dup, '', 'ID,デモ/本番,通貨ペア\n1,2,3', 'date,amount\n2026-10-15,100'];
        return verdict(cases.map((s, i) => {
          const r = parseImportText(s);
          return [`ケース${i + 1}`, !r.ok && r.error === 'format', r.ok ? 'ok' : r.error];
        }));
      }),

    t('CI-06', '文字コード・ファイルの種類の見分け（I-2・I-3）',
      '①Shift_JIS（Excel の「CSV（コンマ区切り）」）②UTF-16（BOM FF FE）③ZIP（Numbers・xlsx）④古い Excel（D0 CF 11 E0）⑤NUL を含む ⑥正しい UTF-8',
      '①② encoding ③④⑤ format ⑥ 読める',
      () => {
        const head = encode(`${CSV_COLUMNS.join(',')}\r\n`);
        // 「ドル円」の Shift_JIS（83 68 83 8B 89 7E）を見出しのあとに足す
        const sjis = new Uint8Array([...head, 0x83, 0x68, 0x83, 0x8b, 0x89, 0x7e, 0x0d, 0x0a]);
        const utf16 = new Uint8Array([0xff, 0xfe, 0x69, 0x00, 0x64, 0x00]);
        const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]);
        const ole = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1]);
        const nul = new Uint8Array([...head, 0x00, 0x41]);
        const good = encode(csvText([cellsOf(sampleTrade())], { bom: true }));
        const e = (b) => { const r = decodeCsvBytes(b); return r.ok ? 'ok' : r.error; };
        return verdict([
          ['Shift_JIS', e(sjis) === 'encoding', e(sjis)], ['UTF-16', e(utf16) === 'encoding', e(utf16)],
          ['ZIP', e(zip) === 'format', e(zip)], ['OLE', e(ole) === 'format', e(ole)], ['NUL', e(nul) === 'format', e(nul)],
          ['UTF-8', e(good) === 'ok' && parseImportBytes(good).ok, e(good)],
          ['BOM は取り除く', decodeCsvBytes(good).ok && !decodeCsvBytes(good).text.startsWith(BOM), decodeCsvBytes(good).text?.charCodeAt(0)],
          ['上限は20MB', IMPORT_MAX_BYTES === 20 * 1024 * 1024, IMPORT_MAX_BYTES],
        ]);
      }),

    t('CI-07', '見出しの行しかない・全部空の行しかないときは「記録がありません」（I-4）。全部空の行は飛ばす',
      '①見出しだけ ②見出し＋空の行（「,,,」と空行）③記録1件の間に空の行',
      '①② error: empty ③ 1件読めて、読めない行0',
      () => {
        const head = CSV_COLUMNS.join(',');
        const blankCells = CSV_COLUMNS.map(() => '').join(',');
        const r1 = parseImportText(`${head}\r\n`);
        const r2 = parseImportText(`${head}\r\n${blankCells}\r\n\r\n`);
        const one = csvText([cellsOf(sampleTrade())]).trimEnd();
        const r3 = parseImportText(`${one}\r\n\r\n${blankCells}\r\n`);
        return verdict([
          ['見出しだけ', !r1.ok && r1.error === 'empty', r1.ok ? 'ok' : r1.error],
          ['空の行だけ', !r2.ok && r2.error === 'empty', r2.ok ? 'ok' : r2.error],
          ['空の行は飛ばす', r3.ok && r3.rows.length === 1 && r3.issues.length === 0, r3.ok ? r3.issues : r3.error],
        ]);
      }),

    t('CI-08', 'シートから書き出した CSV の見え方を受け付ける（sheets-setup 7.1・7.2）',
      '価格 150.100・ロット 0.50・1lot 10000.0・損益 2500（2500.00 は手入力の損益）・画像の枚数 2.00・syncStatus synced・syncedAt あり・BOM なし・LF',
      '読めて、値は元と同じ数値。syncStatus は pending、syncedAt は null（列の値は使わない）',
      () => {
        const auto = sampleTrade({ id: uuid(1), entryPrice: 150.1, exitPrice: 150.35, lots: 0.5 });
        const manual = sampleTrade({ id: uuid(2) }, { manualProfitJpy: 2500 });
        const rows = [
          { ...cellsOf(auto), entryPrice: '150.100', exitPrice: '150.350', lots: '0.50', lotUnitSize: '10000.0', pips: '25.0', imageCount: '2.00', syncStatus: 'synced', syncedAt: '2026-10-16T08:00:00+09:00' },
          { ...cellsOf(manual), profitJpy: '2500.00', syncStatus: 'synced', syncedAt: '2026-10-16T08:00:00+09:00' },
        ];
        const r = parseImportText(csvText(rows, { eol: '\n' }));
        const a = r.ok && r.rows.find((x) => x.trade.id === uuid(1));
        const m = r.ok && r.rows.find((x) => x.trade.id === uuid(2));
        const built = a ? buildImportedTrade(a.trade, null) : null;
        return verdict([
          ['読めた', r.ok && r.issues.length === 0, r.ok ? r.issues : r.error],
          ['自動の記録が元と同じ', built && deepEqual(built, expectedAfterImport(auto)), built && diffKeys(built, expectedAfterImport(auto))],
          ['画像の枚数', a && a.imageCount === 2, a && a.imageCount],
          ['手入力の損益 2500', m && m.trade.profitJpy === 2500 && m.trade.profitSource === 'manual', m && m.trade.profitJpy],
          ['syncedAt は使わない', built && built.syncedAt === null && built.syncStatus === 'pending', built && built.syncedAt],
        ]);
      }),

    t('CI-09', '読めなかった行の理由：列の数・ID・同じ ID（何行目と同じか）',
      '①列が1つ多い行 ②ID が空 ③ID が UUID の形でない ④同じ ID が2行目と4行目',
      '「列の数が見出しと合いません」「IDがありません」「IDの形が違います」「同じIDの行がほかにあります（2行目）」',
      () => {
        const good = cellsOf(sampleTrade());
        const head = CSV_COLUMNS.join(',');
        const line = (c) => CSV_COLUMNS.map((k) => escapeCell(c[k] ?? '')).join(',');
        const extra = parseImportText(`${head}\r\n${line(good)},余分\r\n`);
        const dup = parseImportText(`${head}\r\n${line(good)}\r\n${line({ ...good, id: uuid(9) })}\r\n${line(good)}\r\n`);
        return verdict([
          ['列の数', extra.ok && extra.issues[0]?.reason === '列の数が見出しと合いません', extra.ok && extra.issues[0]],
          ['ID が空', reasonWith({ id: '' }) === 'IDがありません', reasonWith({ id: '' })],
          ['ID の形', reasonWith({ id: 'abc' }) === 'IDの形が違います', reasonWith({ id: 'abc' })],
          ['同じ ID', dup.ok && dup.rows.length === 2 && dup.issues.length === 1 && dup.issues[0].line === 4
            && dup.issues[0].reason === '同じIDの行がほかにあります（2行目）', dup.ok && dup.issues],
        ]);
      }),

    t('CI-10', '読めなかった行の理由：必須・数値・選択肢・上限・桁数（入力画面と同じ E-01〜E-08・E-17・E-18）',
      '空の価格・「1,000」・全角「１５０」・指数「1e2」・前後の空白・0・1,000,000・JPY で小数4桁・ロット 0.001・ロット 10,000,000.01・1lot 0.5・口座 live・時間足 H2・レート 0',
      'それぞれ design 14.6.9 の形の理由（「エントリー価格がありません」「ロットが数値ではありません」など）',
      () => {
        const nonJpy = sampleTrade({ pair: 'EUR/USD', entryPrice: 1.085, exitPrice: 1.086, slPrice: null, tpPrice: null, quoteToJpyRate: 150 });
        const cases = [
          [{ entryPrice: '' }, 'エントリー価格がありません'],
          [{ lots: '1,000' }, 'ロットが数値ではありません'],
          [{ entryPrice: '１５０' }, 'エントリー価格が数値ではありません'],
          [{ entryPrice: '1e2' }, 'エントリー価格が数値ではありません'],
          [{ entryPrice: ' 150.123' }, 'エントリー価格が数値ではありません'],
          [{ entryPrice: '0' }, 'エントリー価格が0以下です'],
          [{ slPrice: '1000000' }, '損切りライン（SL）が大きすぎます'],
          [{ entryPrice: '150.1234' }, 'エントリー価格の小数の桁が多すぎます'],
          [{ lots: '0.001' }, 'ロットの小数の桁が多すぎます'],
          [{ lots: '10000000.01' }, 'ロットが大きすぎます'],
          [{ lots: '0' }, 'ロットが0以下です'],
          [{ lotUnitSize: '0.5' }, '1lotの通貨数が1以上の整数ではありません'],
          [{ accountType: 'live' }, 'デモ/本番の値が違います'],
          [{ accountType: '' }, 'デモ/本番がありません'],
          [{ timeframe: 'H2' }, '時間足の値が違います'],
          [{ pair: 'usd/jpy' }, '通貨ペアの値が違います'],
          [{ pair: 'XAU/USD' }, '通貨ペアの値が違います'],
          [{ pair: 'JPY/USD' }, '通貨ペアの値が違います'],
          [{ quoteToJpyRate: '150' }, '円換算レートの値が違います'], // JPY ペアにレート
        ];
        const checks = cases.map(([over, want]) => [JSON.stringify(over), reasonWith(over) === want, reasonWith(over)]);
        checks.push(['非JPY：レート 0', reasonWith({ quoteToJpyRate: '0' }, nonJpy) === '円換算レートの値が違います', reasonWith({ quoteToJpyRate: '0' }, nonJpy)]);
        checks.push(['非JPY：小数6桁', reasonWith({ entryPrice: '1.085001' }, nonJpy) === 'エントリー価格の小数の桁が多すぎます', reasonWith({ entryPrice: '1.085001' }, nonJpy)]);
        return verdict(checks);
      }),

    t('CI-11', '日時：保存形式（25文字）だけ・年は 2000〜2099（fx-rules 8.1・roadmap 7.18 #26）。Excel の形は理由に添える',
      '1999-12-31・2100-01-01・2月30日・Z 付き・空の作成日時・「2026/10/15 21:30」／境界 2000-01-01T00:00:00・2099-12-31T23:59:59',
      '範囲外・形違いは「〜が読めません」（Excel の形は「（Excelで保存し直した形です）」付き）。境界は読める',
      () => {
        const cases = [
          [{ entryAt: '1999-12-31T23:59:59+09:00' }, 'エントリー日時が読めません'],
          [{ updatedAt: '2100-01-01T00:00:00+09:00' }, '更新日時が読めません'],
          [{ entryAt: '2026-02-30T10:00:00+09:00' }, 'エントリー日時が読めません'],
          [{ entryAt: '2026-10-15T12:30:00Z' }, 'エントリー日時が読めません'],
          [{ createdAt: '' }, '作成日時がありません'],
          [{ entryAt: '2026/10/15 21:30' }, 'エントリー日時が読めません（Excelで保存し直した形です）'],
          [{ deletedAt: '0500-01-01T00:00:00+09:00' }, '削除日時が読めません'],
        ];
        const checks = cases.map(([over, want]) => [JSON.stringify(over), reasonWith(over) === want, reasonWith(over)]);
        // 更新日時は「今」より先にできない（CI-R03）ので、2099年の境界は決済日時で確かめる
        const edge = sampleTrade({ entryAt: '2000-01-01T00:00:00+09:00', createdAt: '2000-01-01T00:00:00+09:00', exitAt: '2099-12-31T23:59:59+09:00', updatedAt: '2026-10-18T00:00:00+09:00' });
        checks.push(['境界は読める', reasonWith({}, edge) === null, reasonWith({}, edge)]);
        return verdict(checks);
      }),

    t('CI-12', '矛盾：ステータスと決済の値・決済日時の前後・保有中の pips',
      '決済済みなのに決済価格が空／決済日時が空、保有中なのに決済価格・pips・損益の算出方法がある、決済日時がエントリー日時より前、ステータス空',
      'それぞれ「決済済みなのに決済価格がありません」などの理由',
      () => {
        const open = sampleOpen();
        const cases = [
          [{ exitPrice: '' }, '決済済みなのに決済価格がありません', undefined],
          [{ exitAt: '' }, '決済済みなのに決済日時がありません', undefined],
          [{ exitAt: '2026-10-15T21:00:00+09:00' }, '決済日時がエントリー日時より前です', undefined],
          [{ status: '' }, 'ステータスがありません', undefined],
          [{ status: 'done' }, 'ステータスの値が違います', undefined],
          [{ exitPrice: '150.4' }, '保有中なのに決済価格があります', open],
          [{ pips: '0.0' }, '保有中なのにpipsがあります', open],
          [{ profitSource: 'auto' }, '保有中なのに損益の算出方法があります', open],
          [{ status: 'open' }, '保有中なのに決済価格があります', undefined],
        ];
        return verdict(cases.map(([over, want, base]) => [JSON.stringify(over), reasonWith(over, base) === want, reasonWith(over, base)]));
      }),

    t('CI-13', 'pips・損益は計算し直して CSV の値と比べる（合わない行は取り込まない）。手入力の損益は CSV の値を正とする',
      'pips を 27.6 に／損益を 1384 に／算出方法を manual に（損益は自動計算のまま）／手入力の損益を空・小数に／非JPY の自動なのにレートが空',
      '「pipsが価格と合いません」「損益（円）が価格と合いません」など。手入力の 999 円（自動計算と違う値）は読める',
      () => {
        const nonJpy = sampleTrade({ pair: 'EUR/USD', entryPrice: 1.085, exitPrice: 1.086, slPrice: null, tpPrice: null, quoteToJpyRate: 150 });
        const manual = sampleTrade({}, { manualProfitJpy: 999 });
        const cases = [
          [{ pips: '27.6' }, 'pipsが価格と合いません', undefined],
          [{ pips: '' }, 'pipsが価格と合いません', undefined],
          [{ profitJpy: '1384' }, '損益（円）が価格と合いません', undefined],
          [{ profitSource: 'manual', profitJpy: '' }, '損益（円）がありません', undefined],
          [{ profitJpy: '999.5' }, '損益（円）が整数ではありません', manual],
          [{ profitSource: '' }, '損益の算出方法の値が違います', undefined],
          [{ quoteToJpyRate: '' }, '損益（円）が価格と合いません', nonJpy],
          [{}, null, manual],
        ];
        const checks = cases.map(([over, want, base]) => [JSON.stringify(over), reasonWith(over, base) === want, reasonWith(over, base)]);
        const r = parseImportText(csvText([cellsOf(manual)]));
        checks.push(['手入力の値のまま', r.ok && r.rows[0]?.trade.profitJpy === 999 && r.rows[0]?.trade.profitSource === 'manual', r.ok && r.rows[0]?.trade.profitJpy]);
        return verdict(checks);
      }),

    t('CI-14', 'riskReward は CSV の値を使わず計算し直す。session は CSV の値（選択肢）を使い、空なら日時から判定',
      'riskReward を 9.99 や「abc」に／session を london（日時では newyork）に／session を空に／session を「NY」に',
      'RR は SL・TP から計算した値。session は london のまま・空なら newyork・「NY」は「セッションの値が違います」',
      () => {
        const base = sampleTrade();
        const read = (over) => {
          const r = parseImportText(csvText([{ ...cellsOf(base), ...over }]));
          return r.ok && r.rows[0] ? buildImportedTrade(r.rows[0].trade, null) : null;
        };
        const a = read({ riskReward: '9.99' });
        const b = read({ riskReward: 'abc' });
        const c = read({ session: 'london' });
        const d = read({ session: '' });
        return verdict([
          ['RR は計算し直す', a && a.riskReward === base.riskReward && base.riskReward !== null, a && a.riskReward],
          ['RR の文字は無視', b && b.riskReward === base.riskReward, b && b.riskReward],
          ['session は CSV の値', c && c.session === 'london', c && c.session],
          ['session が空なら判定', d && d.session === base.session && base.session === 'newyork', d && d.session],
          ['session の値違い', reasonWith({ session: 'NY' }) === 'セッションの値が違います', reasonWith({ session: 'NY' })],
        ]);
      }),

    t('CI-15', '文字のセル：数式の印「\'」を戻す・根拠とタグの空の要素・メモの長さ・引用符の閉じ忘れ',
      'メモ「\'=1」・「\'普通」、タグ「a||b」、2001文字のメモ、最後の行の引用符が閉じていない',
      '「=1」に戻す・「\'普通」はそのまま、「タグの値が違います」「メモが長すぎます」「引用符（"）が閉じていません」',
      () => {
        const read = (over) => {
          const r = parseImportText(csvText([{ ...cellsOf(sampleTrade()), ...over }]));
          return r.ok && r.rows[0] ? r.rows[0].trade : null;
        };
        const good = csvText([cellsOf(sampleTrade())]);
        const cut = `${good}${CSV_COLUMNS.map((c) => (c === 'memo' ? '"途中で切れた' : escapeCell(cellText(c, sampleTrade({ id: uuid(2) }))))).join(',')}`;
        const r = parseImportText(cut);
        return verdict([
          ['\'= を戻す', read({ memo: "'=1" })?.memo === '=1', read({ memo: "'=1" })?.memo],
          ['\'普通 はそのまま', read({ memo: "'普通" })?.memo === "'普通", read({ memo: "'普通" })?.memo],
          ['タグの空の要素', reasonWith({ tags: 'a||b' }) === 'タグの値が違います', reasonWith({ tags: 'a||b' })],
          ['メモ2000文字は読める', reasonWith({ memo: 'あ'.repeat(2000) }) === null, reasonWith({ memo: 'あ'.repeat(2000) })],
          ['メモ2001文字', reasonWith({ memo: 'あ'.repeat(2001) }) === 'メモが長すぎます', reasonWith({ memo: 'あ'.repeat(2001) })],
          ['引用符の閉じ忘れ', r.ok && r.rows.length === 1 && r.issues[0]?.line === 3 && r.issues[0]?.reason === '引用符（"）が閉じていません', r.ok && r.issues],
        ]);
      }),

    t('CI-16', '行番号は見出しを1行目として数える（メモの中の改行は数えない・空の行は数える）',
      '2行目：改行を2つ含むメモ／3行目：空の行／4行目：ロットが空',
      '読めなかった行は「4行目」',
      () => {
        const head = CSV_COLUMNS.join(',');
        const line = (c) => CSV_COLUMNS.map((k) => escapeCell(c[k] ?? '')).join(',');
        const a = cellsOf(sampleTrade({ id: uuid(1), memo: '1\n2\n3' }));
        const b = { ...cellsOf(sampleTrade({ id: uuid(2) })), lots: '' };
        const r = parseImportText(`${head}\r\n${line(a)}\r\n\r\n${line(b)}\r\n`);
        return verdict([['1件読める', r.ok && r.rows.length === 1, r.ok && r.rows.length], ['4行目', r.ok && r.issues[0]?.line === 4 && r.issues[0]?.reason === 'ロットがありません', r.ok && r.issues]]);
      }),

    t('CI-17', 'parseCsvRecords：引用符の中のカンマ・改行・「""」、CR だけの改行、最後の改行なし',
      '「a,"b,c","d""e","f\\r\\ng"\\rx,y」',
      '[[a, b,c, d"e, f\\r\\ng], [x, y]]・閉じ忘れなし',
      () => {
        const r = parseCsvRecords('a,"b,c","d""e","f\r\ng"\rx,y');
        const want = [['a', 'b,c', 'd"e', 'f\r\ng'], ['x', 'y']];
        return verdict([['セル', JSON.stringify(r.records) === JSON.stringify(want), r.records], ['閉じ忘れなし', r.unterminated === false, r.unterminated]]);
      }),

    t('CI-18', 'findColumns：32の名前がそろえば位置を返す。足りない・重なると null',
      '①CSV_COLUMNS ②逆順＋知らない列 ③1つ欠ける ④1つ重なる',
      '①② 32個の位置（逆順なら id が最後）③④ null',
      () => {
        const a = findColumns([...CSV_COLUMNS]);
        const b = findColumns(['x', ...[...CSV_COLUMNS].reverse()]);
        return verdict([
          ['そのまま', a && a.size === 32 && a.get('id') === 0, a && a.size],
          ['逆順', b && b.get('id') === 32 && b.get('updatedAt') === 1, b && b.get('id')],
          ['欠ける', findColumns(CSV_COLUMNS.slice(1)) === null],
          ['重なる', findColumns([...CSV_COLUMNS, 'id']) === null],
        ]);
      }),

    t('CI-19', '確認シートの件数：新しい／すでにある（削除済みも）／端末の方が新しい／削除済み／画像／期間・snapshot',
      'CSV 4件（うち削除済み1・画像あり2）。端末には2件（1件は端末の方が新しい・1件は端末で削除済み）',
      '新しい2・すでにある2・端末の方が新しい1・削除済み1・画像2・期間 2026/09/01〜2026/10/15・snapshot は端末の updatedAt（ない ID は null）',
      () => {
        const csv = [
          sampleTrade({ id: uuid(1), imageIds: ['x'] }),
          sampleTrade({ id: uuid(2), entryAt: '2026-09-01T09:00:00+09:00', exitAt: '2026-09-01T10:00:00+09:00' }),
          sampleTrade({ id: uuid(3), deletedAt: '2026-10-16T00:00:00+09:00', updatedAt: '2026-10-16T00:00:00+09:00', imageIds: ['y', 'z'] }),
          sampleOpen({ id: uuid(4) }),
        ];
        const parsed = parseImportText(buildCsvBody(csv));
        const device = [
          { ...csv[0], updatedAt: '2026-10-20T00:00:00+09:00' }, // 端末の方が新しい
          { ...csv[1], deletedAt: '2026-09-02T00:00:00+09:00', updatedAt: csv[1].updatedAt }, // 端末で削除済み（同じ版）
        ];
        const s = summarizeImport(parsed, device);
        return verdict([
          ['新しい', s.newCount === 2, s.newCount], ['すでにある', s.existingCount === 2, s.existingCount],
          ['端末の方が新しい', s.newerOnDevice === 1, s.newerOnDevice], ['削除済み', s.deletedCount === 1, s.deletedCount],
          ['画像', s.imageRecords === 2, s.imageRecords], ['読めない行', s.issueCount === 0, s.issueCount],
          ['期間', periodLabel(s.period) === '2026/09/01〜2026/10/15', periodLabel(s.period)],
          ['snapshot（ある）', s.snapshot.get(uuid(1)) === '2026-10-20T00:00:00+09:00', s.snapshot.get(uuid(1))],
          ['snapshot（ない）', s.snapshot.get(uuid(4)) === null && s.snapshot.size === 4, s.snapshot.get(uuid(4))],
          ['取り込む数（スキップ）', importCount(s, false) === 2], ['取り込む数（上書き）', importCount(s, true) === 4],
        ]);
      }),

    t('CI-20', '確認シートの文言（design 14.6.9）',
      'ボタン・説明文・扱いの説明・注意・期間（1日だけ）・結果の説明',
      'design 14.6.9 の文のとおり',
      () => {
        const s = (o) => ({ readable: 10, newCount: 0, existingCount: 0, deletedCount: 0, imageRecords: 0, ...o });
        return verdict([
          ['ボタン', importButtonLabel(s({ newCount: 1220, existingCount: 8 }), false) === '1,220件を取り込む', importButtonLabel(s({ newCount: 1220, existingCount: 8 }), false)],
          ['ボタン（上書き）', importButtonLabel(s({ newCount: 122, existingCount: 8 }), true) === '130件を取り込む'],
          ['ボタン（0件）', importButtonLabel(s({ existingCount: 10 }), false) === '取り込む記録はありません'],
          ['ボタン（読めない）', importButtonLabel(s({ readable: 0 }), false) === '取り込める記録はありません'],
          ['説明（削除済み・画像）', confirmNote(s({ deletedCount: 3, imageRecords: 14 })) === '削除済みの記録3件を含みます（一覧には出ません）。画像は戻りません（画像が付いていた記録 14件）。', confirmNote(s({ deletedCount: 3, imageRecords: 14 }))],
          ['説明（画像なし）', confirmNote(s({})) === '画像は戻りません。', confirmNote(s({}))],
          ['スキップ', modeNote(false) === 'この端末の記録をそのまま残します。'],
          ['上書き', modeNote(true) === 'CSVの内容で置き換えます。この端末にある画像はそのまま残ります。'],
          ['注意', newerWarning(2) === 'うち2件は、この端末の記録の方があとで更新されています。上書きすると、その変更は失われます。'],
          ['全部ある', ALL_EXISTING_NOTE === 'すべての記録がこの端末にあります。CSVの内容で置き換えるときは「上書き」を選びます。'],
          ['期間（1日）', periodLabel({ from: '2026-10-15T09:00:00+09:00', to: '2026-10-15T23:00:00+09:00' }) === '2026/10/15'],
          ['結果（画像・選択肢）', JSON.stringify(resultNotes({ addedWithImages: 1, choiceNote: 'タグ2件を選択肢に加えました。' })) === JSON.stringify([
            '画像は戻っていません。必要な画像は、各記録の編集画面から追加し直せます。', 'タグ2件を選択肢に加えました。', '1lotの通貨数などの設定は戻りません。'])],
          ['結果（なし）', JSON.stringify(resultNotes({ addedWithImages: 0, choiceNote: '' })) === JSON.stringify(['1lotの通貨数などの設定は戻りません。'])],
        ]);
      }),

    t('CI-21', '選択肢に無いタグ・根拠・感情を末尾に足す（design 14.6.11 ⑤）',
      '選択肢：根拠［A］・感情［冷静］・タグ［］。記録：根拠 A,B／感情 不安・決済時 焦り／タグ x,y,x。削除済みの記録のタグ z、21文字のタグ、前後に空白のタグ',
      '根拠 [A,B]・感情 [冷静,不安,焦り]・タグ [x,y]（z・21文字・空白付きは足さない）。文「根拠1件・感情2件・タグ2件を選択肢に加えました。」',
      () => {
        const choices = { entryReasons: ['A'], emotions: ['冷静'], tags: [] };
        const trades = [
          sampleTrade({ entryReasons: ['A', 'B'], emotion: '不安', exitEmotion: '焦り', tags: ['x', 'y', 'x'] }),
          sampleTrade({ id: uuid(2), tags: ['z'], deletedAt: '2026-10-16T00:00:00+09:00' }),
          sampleTrade({ id: uuid(3), tags: ['あ'.repeat(21), ' 空白 '], emotion: null, exitEmotion: null, entryReasons: [] }),
        ];
        const plan = planChoiceAdditions(choices, trades);
        return verdict([
          ['根拠', JSON.stringify(plan.choices.entryReasons) === JSON.stringify(['A', 'B']), plan.choices.entryReasons],
          ['感情', JSON.stringify(plan.choices.emotions) === JSON.stringify(['冷静', '不安', '焦り']), plan.choices.emotions],
          ['タグ', JSON.stringify(plan.choices.tags) === JSON.stringify(['x', 'y']), plan.choices.tags],
          ['数', plan.total === 5, plan.total],
          ['文', choiceAddedNote(plan.added) === '根拠1件・感情2件・タグ2件を選択肢に加えました。', choiceAddedNote(plan.added)],
          ['足さないときは空', choiceAddedNote({ entryReasons: 0, emotions: 0, tags: 0 }) === ''],
          ['元の選択肢は変えない', choices.tags.length === 0 && choices.emotions.length === 1],
        ]);
      }),

    t('CI-22', '上書きの組み立て：端末の画像・syncedAt を残し、ほかは CSV の値（updatedAt・deletedAt も）。syncStatus は pending',
      '端末：画像2枚・syncedAt あり・削除済み・updatedAt 新しい。CSV：削除されていない・updatedAt 古い',
      'imageIds・syncedAt は端末の値、deletedAt は null（CSV）、updatedAt は CSV の値、syncStatus pending',
      () => {
        const csv = sampleTrade({ memo: 'CSV の内容' });
        const stored = { ...csv, memo: '端末の内容', imageIds: ['img-1', 'img-2'], syncStatus: 'synced', syncedAt: '2026-10-16T00:00:00+09:00',
          deletedAt: '2026-10-17T00:00:00+09:00', updatedAt: '2026-10-17T00:00:00+09:00' };
        const r = parseImportText(buildCsvBody([csv]));
        const got = buildImportedTrade(r.rows[0].trade, stored);
        return verdict([
          ['画像は端末', JSON.stringify(got.imageIds) === JSON.stringify(['img-1', 'img-2']), got.imageIds],
          ['syncedAt は端末', got.syncedAt === '2026-10-16T00:00:00+09:00', got.syncedAt],
          ['syncStatus', got.syncStatus === 'pending', got.syncStatus],
          ['メモは CSV', got.memo === 'CSV の内容', got.memo],
          ['deletedAt は CSV', got.deletedAt === null, got.deletedAt],
          ['updatedAt は CSV', got.updatedAt === csv.updatedAt, got.updatedAt],
          ['32項目', Object.keys(got).length === 32, Object.keys(got).length],
        ]);
      }),

    t('CI-23', '上書きと下書きの照合（architecture 9.3）：同じ版なら下書きはそのまま、違う版なら「元の記録が変更された」',
      '端末の記録（updatedAt＝T1）の編集の下書き（baseUpdatedAt＝T1）。①CSV の updatedAt も T1 で上書き ②CSV の updatedAt が T0（古い）で上書き ③CSV が削除済み',
      '① ok ② stale ③ gone',
      () => {
        const T1 = '2026-10-17T00:00:00+09:00';
        const stored = sampleTrade({ updatedAt: T1 });
        const draft = { kind: 'edit', baseUpdatedAt: T1 };
        const csvSame = parseImportText(buildCsvBody([sampleTrade({ updatedAt: T1 })])).rows[0].trade;
        const csvOld = parseImportText(buildCsvBody([sampleTrade()])).rows[0].trade;
        const csvDel = parseImportText(buildCsvBody([sampleTrade({ deletedAt: T1, updatedAt: T1 })])).rows[0].trade;
        const j = (row) => judgeDraftTarget(draft, buildImportedTrade(row, stored));
        return verdict([['同じ版', j(csvSame) === 'ok', j(csvSame)], ['古い版', j(csvOld) === 'stale', j(csvOld)], ['削除済み', j(csvDel) === 'gone', j(csvDel)]]);
      }),

    /* ===== T-44 レビューの修正（docs/reviews/T-44.md の CI-R01〜R04） ===== */

    t('CI-24', 'CI-R01：根拠・タグ・感情の長さと個数の上限（1つの名前は選択肢と同じ20文字・根拠とタグは50個まで）',
      '根拠・タグの名前 20文字／21文字、絵文字20文字、タグ 50個／51個、感情・決済時の感情 21文字、10万文字の感情',
      '20文字・50個は読める。超えると「タグが長すぎます」「タグが多すぎます」「エントリー時の感情が長すぎます」など',
      () => {
        const names = (n) => Array.from({ length: n }, (_, i) => `t${i}`);
        const cases = [
          [{ tags: 'あ'.repeat(20) }, null],
          [{ tags: '🙂'.repeat(20) }, null],
          [{ tags: `a|${'あ'.repeat(21)}` }, 'タグが長すぎます'],
          [{ entryReasons: 'い'.repeat(21) }, 'エントリー根拠が長すぎます'],
          [{ tags: joinList(names(50)) }, null],
          [{ tags: joinList(names(51)) }, 'タグが多すぎます'],
          [{ entryReasons: joinList(names(51)) }, 'エントリー根拠が多すぎます'],
          [{ emotion: 'う'.repeat(20) }, null],
          [{ emotion: 'う'.repeat(21) }, 'エントリー時の感情が長すぎます'],
          [{ exitEmotion: 'え'.repeat(21) }, '決済時の感情が長すぎます'],
          [{ emotion: 'x'.repeat(100000) }, 'エントリー時の感情が長すぎます'],
        ];
        const checks = cases.map(([over, want]) => [Object.keys(over)[0] + String(Object.values(over)[0].length), reasonWith(over) === want, reasonWith(over)]);
        // 上限いっぱいでも1つのセルは Apps Script の 50,000 文字（sheets-setup 11章）に届かない
        const widest = cellText('tags', sampleTrade({ tags: Array.from({ length: LIST_ITEMS_MAX }, (_, i) => `${'|'.repeat(19)}${i % 10}`) }));
        checks.push(['50,000文字に届かない', widest.length < 50000, widest.length]);
        checks.push(['上限の値', LIST_ITEMS_MAX === 50, LIST_ITEMS_MAX]);
        return verdict(checks);
      }),

    t('CI-25', 'CI-R01：選択肢に自動で足すのは種類ごとに100件まで。超えると exceeded（画面はアラート）',
      '選択肢にないタグ 100種類／101種類、感情 101種類（エントリー時と決済時に分けて）',
      '100種類は全部足す（exceeded false）。101種類は100件で止めて exceeded true',
      () => {
        const empty = { entryReasons: [], emotions: [], tags: [] };
        const withTags = (n) => Array.from({ length: Math.ceil(n / 50) }, (_, k) => sampleTrade({
          id: uuid(k + 1), tags: Array.from({ length: Math.min(50, n - k * 50) }, (_, i) => `tag${k * 50 + i}`), emotion: null, exitEmotion: null, entryReasons: [],
        }));
        const a = planChoiceAdditions(empty, withTags(100));
        const b = planChoiceAdditions(empty, withTags(101));
        const emos = Array.from({ length: 101 }, (_, i) => sampleTrade({ id: uuid(i + 1), emotion: `e${i}`, exitEmotion: i === 100 ? 'last' : null, tags: [], entryReasons: [] }));
        const c = planChoiceAdditions(empty, emos);
        return verdict([
          ['上限の値', CHOICE_AUTO_ADD_MAX === 100, CHOICE_AUTO_ADD_MAX],
          ['100種類', a.added.tags === 100 && !a.exceeded, [a.added.tags, a.exceeded]],
          ['101種類', b.added.tags === 100 && b.choices.tags.length === 100 && b.exceeded, [b.added.tags, b.exceeded]],
          ['感情も', c.added.emotions === 100 && c.exceeded, [c.added.emotions, c.exceeded]],
          ['既にある名前は数えない', !planChoiceAdditions({ ...empty, tags: Array.from({ length: 101 }, (_, i) => `tag${i}`) }, withTags(101)).exceeded],
        ]);
      }),

    t('CI-26', 'CI-R02：ID は英小文字の UUID だけ（大文字は小文字に直さず読めない行に）',
      '①大文字の ID ②同じ ID の小文字の行と大文字の行',
      '①「IDの形が違います」②小文字の行は読め、大文字の行は「同じIDの行」ではなく「IDの形が違います」',
      () => {
        const id = uuid(1).replace(/0/g, 'a');
        const upper = id.toUpperCase();
        const head = CSV_COLUMNS.join(',');
        const line = (c) => CSV_COLUMNS.map((k) => escapeCell(c[k] ?? '')).join(',');
        const r = parseImportText(`${head}\r\n${line({ ...cellsOf(sampleTrade()), id })}\r\n${line({ ...cellsOf(sampleTrade()), id: upper })}\r\n`);
        return verdict([
          ['大文字', reasonWith({ id: upper }) === 'IDの形が違います', reasonWith({ id: upper })],
          ['小文字は読める', reasonWith({ id }) === null, reasonWith({ id })],
          ['同一視しない', r.ok && r.rows.length === 1 && r.rows[0].trade.id === id && r.issues[0]?.reason === 'IDの形が違います', r.ok && r.issues],
        ]);
      }),

    t('CI-27', 'CI-R03：未来の更新日時（10分を超えて先）・作成日時が更新日時より後・削除日時が更新日時より後は読めない行',
      '「今」＝2026-10-20 00:00。更新日時 ＋9分59秒／＋10分／＋10分1秒／1日後、作成日時＞更新日時、削除日時＞更新日時、作成日時＝更新日時＝削除日時',
      '10分までは読める。超えると「更新日時が未来です」。「作成日時が更新日時より後です」「削除日時が更新日時より後です」。同じ時刻は読める',
      () => {
        const at = (ms) => toJstString(new Date(TEST_NOW.getTime() + ms));
        const T = '2026-10-16T00:00:00+09:00';
        const min = 60 * 1000;
        const cases = [
          [{ updatedAt: at(10 * min - 1000) }, null],
          [{ updatedAt: at(10 * min) }, null],
          [{ updatedAt: at(10 * min + 1000) }, '更新日時が未来です'],
          [{ updatedAt: at(24 * 60 * min) }, '更新日時が未来です'],
          [{ createdAt: '2026-10-15T23:00:11+09:00' }, '作成日時が更新日時より後です'],
          [{ deletedAt: '2026-10-15T23:00:11+09:00' }, '削除日時が更新日時より後です'],
          [{ createdAt: T, updatedAt: T, deletedAt: T }, null],
        ];
        const checks = cases.map(([over, want]) => [JSON.stringify(over), reasonWith(over) === want, reasonWith(over)]);
        checks.push(['許すずれは10分', FUTURE_TOLERANCE_MINUTES === 10, FUTURE_TOLERANCE_MINUTES]);
        return verdict(checks);
      }),

    t('CI-28', 'CI-R04：円換算レートは 1,000,000 未満（入力画面と同じ parseQuoteToJpyRate・E-08）。保有中なのに円換算レートがある行は読めない',
      'parseQuoteToJpyRate：999999.999／1000000／1e21 の22桁。CSV：非JPY の決済済みでレート 1000000、非JPY の保有中でレート 150',
      '999999.999 は読める、1,000,000 以上は E-08。CSV は「円換算レートの値が違います」「保有中なのに円換算レートがあります」',
      () => {
        const nonJpyOpen = sampleOpen({ pair: 'EUR/USD', entryPrice: 1.085, slPrice: null, tpPrice: null });
        const nonJpy = sampleTrade({ pair: 'EUR/USD', entryPrice: 1.085, exitPrice: 1.086, slPrice: null, tpPrice: null, quoteToJpyRate: 150 });
        const p = (x) => { const r = parseQuoteToJpyRate(x); return r.ok ? r.value : r.error; };
        return verdict([
          ['上限の値', QUOTE_RATE_MAX_EXCLUSIVE === 1000000, QUOTE_RATE_MAX_EXCLUSIVE],
          ['999999.999', p('999999.999') === 999999.999, p('999999.999')],
          ['1000000', p('1000000') === 'E-08', p('1000000')],
          ['22桁', p('1000000000000000000000') === 'E-08', p('1000000000000000000000')],
          ['CSV のレートが大きい', reasonWith({ quoteToJpyRate: '1000000' }, nonJpy) === '円換算レートの値が違います', reasonWith({ quoteToJpyRate: '1000000' }, nonJpy)],
          ['保有中なのにレート', reasonWith({ quoteToJpyRate: '150' }, nonJpyOpen) === '保有中なのに円換算レートがあります', reasonWith({ quoteToJpyRate: '150' }, nonJpyOpen)],
          ['保有中でレートなしは読める', reasonWith({}, nonJpyOpen) === null, reasonWith({}, nonJpyOpen)],
        ]);
      }),
  ];
}
