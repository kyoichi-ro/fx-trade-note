/* =========================================================
   tests/csv.test.js
   CSVエクスポート（js/csv.js）のテスト（T-25。architecture 14.2、design 14.6.5、requirements F-09・6.1）。
   ・BOM付きUTF-8、列の見出し・順番、行の区切り（CRLF）
   ・エスケープ（カンマ・ダブルクォート・改行）、日本語・絵文字、空欄
   ・配列（根拠・タグ）の区切りと、区切り文字を含む名前の往復
   ・CSV インジェクション対策（先頭が = + - @ タブ 改行 のとき「'」を付ける。数値の列は対象外）
   ・論理削除の含める／除く、並び順、ファイル名（日本時間）、件数の文言
   ・1000 件でも動くこと、書き出した CSV を読み戻して元の値と一致すること（読み戻しはテスト側の小さなパーサーで行う。
     アプリ本体のインポートは Phase 2 の T-44 で、ここでは作らない）
   ・共有シートの使い分け（canUseShareSheet）と共有の結果（shareCsvFile）をにせものの navigator で確かめる
   ・スプレッドシートへ送る値（sheetRowValues：T-41）が CSV のセルと同じ作り方であること（CS-30・CS-31）
   IndexedDB・localStorage・DOM を使わないので、Node.js でもブラウザでも実行する。

   ID：CS-xx（CSV）
   ========================================================= */
import {
  BOM, CSV_COLUMNS, guardFormula, unguardFormula, joinList, splitList, cellText, escapeCell,
  selectForExport, countTrades, buildCsvBody, csvFileName, prepareCsv,
  recordCountLabel, exportCountLabel, exportNote, createCsvFile, canUseShareSheet, shareCsvFile,
  sheetRowValues, CSV_NUMBER_COLUMNS,
} from '../js/csv.js';
import { TRADE_KEYS } from '../js/db.js';
import { show } from './helpers.js';

const CATEGORY = 'CSV';

/** requirements 6.1 のキー名の順番（テスト側で独立に書き写したもの。imageIds だけ imageCount に置き換わる） */
const REQ_6_1_COLUMNS = [
  'id', 'accountType', 'pair', 'side', 'entryPrice', 'entryAt', 'lots', 'lotUnitSize',
  'slPrice', 'tpPrice', 'riskReward', 'exitPrice', 'exitAt', 'pips', 'profitJpy', 'profitSource',
  'quoteToJpyRate', 'status', 'entryReasons', 'timeframe', 'session', 'emotion', 'exitReason', 'exitEmotion',
  'tags', 'memo', 'imageCount', 'syncStatus', 'syncedAt', 'deletedAt', 'createdAt', 'updatedAt',
];

/** 32項目すべてを持つ決済済みの記録（上書きしたい項目だけ渡す） */
function trade(over = {}) {
  return {
    id: 'id-0001', accountType: 'real', pair: 'USD/JPY', side: 'buy', entryPrice: 150.123, entryAt: '2026-10-15T21:30:00+09:00',
    lots: 0.5, lotUnitSize: 10000, slPrice: 149.9, tpPrice: 150.6, riskReward: 2.1,
    exitPrice: 150.4, exitAt: '2026-10-15T23:00:00+09:00', pips: 27.7, profitJpy: 1385, profitSource: 'auto',
    quoteToJpyRate: null, status: 'closed', entryReasons: ['トレンドフォロー', 'ブレイクアウト'], timeframe: 'H1', session: 'newyork',
    emotion: '冷静', exitReason: 'tp', exitEmotion: '自信', tags: ['指標前'], memo: '順張りで入った', imageIds: [],
    syncStatus: 'pending', syncedAt: null, deletedAt: null,
    createdAt: '2026-10-15T21:30:05+09:00', updatedAt: '2026-10-15T23:00:10+09:00',
    ...over,
  };
}

/** 保有中の記録（決済の項目はすべて null） */
function openTrade(over = {}) {
  return trade({
    id: 'id-open', exitPrice: null, exitAt: null, pips: null, profitJpy: null, profitSource: null, status: 'open',
    exitReason: null, exitEmotion: null, riskReward: null, slPrice: null, tpPrice: null, memo: null, tags: [], entryReasons: [],
    timeframe: null, session: null, emotion: null, ...over,
  });
}

/* ---------------------------------------------------------
   テスト側の小さな CSV パーサー（RFC 4180 の範囲）
   書き出した CSV を読み戻して、元の値と一致するかを確かめるためだけに使う。
   --------------------------------------------------------- */

/** BOM を除いた CSV の文字を、行×セルの二次元配列にする（クォート内のカンマ・改行・"" を扱う） */
function parseCsv(text) {
  const src = text.startsWith(BOM) ? text.slice(1) : text;
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') { cell += '"'; i += 1; } else quoted = false;
      } else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\r' && src[i + 1] === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; i += 1; }
    else cell += c;
  }
  if (cell !== '' || row.length > 0) { row.push(cell); rows.push(row); }
  return rows;
}

/** 1件だけ書き出して、その行をセルの配列として返す（BOM・見出しは除く） */
function oneRow(t) {
  const rows = parseCsv(buildCsvBody([t]));
  return rows[1];
}

/** 列名からセルの値を取る */
const cellOf = (row, column) => row[CSV_COLUMNS.indexOf(column)];

function verdict(checks) {
  const failed = checks.filter(([, ok]) => !ok);
  if (failed.length === 0) return { actual: `確認${checks.length}項目すべて一致`, pass: true };
  return { actual: failed.map(([label, , detail]) => `×${label}（実際：${show(detail)}）`).join('／'), pass: false };
}

const t = (id, title, input, expected, run) => ({ category: CATEGORY, id, title, input, expected, run });

/* ---------------------------------------------------------
   にせものの navigator（共有シートの使い分けの確認用）
   --------------------------------------------------------- */

function fakeEnv({ canShare = true, coarse = true, hasShare = true, shareImpl = async () => {}, throwOnCanShare = false } = {}) {
  const calls = [];
  const navigator = {};
  if (hasShare) navigator.share = async (data) => { calls.push(data); return shareImpl(data); };
  navigator.canShare = () => {
    if (throwOnCanShare) throw new Error('canShare が使えません');
    return canShare;
  };
  return { env: { navigator, matchMedia: () => ({ matches: coarse }) }, calls };
}

const errorNamed = (name) => Object.assign(new Error(name), { name });

export function collectCsvTests() {
  return [
    t('CS-01', 'BOM付きUTF-8：先頭に印が1つだけ付き、ファイルにすると先頭の3バイトが EF BB BF',
      '1件を prepareCsv → createCsvFile → バイト列',
      '文字の先頭が \\uFEFF（2つ目はない）／ファイルの先頭3バイトが EF BB BF／日本語がUTF-8として読み戻せる',
      async () => {
        const p = prepareCsv([trade({ memo: 'ドル円' })]);
        const bytes = new Uint8Array(await createCsvFile(p.text, p.fileName).arrayBuffer());
        const decoded = new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);
        return verdict([
          ['先頭がBOM', p.text.startsWith(BOM), p.text.charCodeAt(0)],
          ['BOMは1つだけ', !p.text.slice(1).startsWith(BOM), p.text.charCodeAt(1)],
          ['先頭3バイト', bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf, [...bytes.slice(0, 3)]],
          ['日本語が読み戻せる', decoded.includes('ドル円'), decoded.slice(0, 20)],
          ['種類が text/csv', createCsvFile(p.text, p.fileName).type === 'text/csv', createCsvFile(p.text, p.fileName).type],
        ]);
      }),

    t('CS-02', '見出し：requirements 6.1 のキー名と順番（32列）。imageIds だけ imageCount',
      'CSV_COLUMNS と 1行目',
      '32列。6.1 の順。TRADE_KEYS（db.js）と同じ並びで imageIds が imageCount に置き換わる',
      () => {
        const head = parseCsv(buildCsvBody([]))[0];
        const sameAsKeys = TRADE_KEYS.every((k, i) => CSV_COLUMNS[i] === (k === 'imageIds' ? 'imageCount' : k));
        return verdict([
          ['32列', head.length === 32, head.length],
          ['6.1の順番', head.join(',') === REQ_6_1_COLUMNS.join(','), head.join(',')],
          ['db.js の項目名と対応', sameAsKeys && CSV_COLUMNS.length === TRADE_KEYS.length, CSV_COLUMNS.length],
          ['imageIds の列はない', !head.includes('imageIds'), head.includes('imageIds')],
        ]);
      }),

    t('CS-03', '行の区切りは CRLF。最後の行の終わりにも付く。1件なら見出し＋1行',
      '1件・2件',
      '「\\r\\n」で区切られ、末尾も「\\r\\n」。行数は件数＋1',
      () => {
        const one = buildCsvBody([trade()]);
        const two = buildCsvBody([trade(), trade({ id: 'id-0002' })]);
        return verdict([
          ['末尾が CRLF', one.endsWith('\r\n'), one.slice(-4)],
          ['LFだけの改行がない', !/[^\r]\n/.test(one), 'LF単独あり'],
          ['1件＝2行', one.split('\r\n').length - 1 === 2, one.split('\r\n').length - 1],
          ['2件＝3行', two.split('\r\n').length - 1 === 3, two.split('\r\n').length - 1],
        ]);
      }),

    t('CS-04', '値の書き方：数値はそのまま、日時は固定形式の文字、列挙は英語の値、null は空欄',
      'closed の記録と open の記録',
      'entryPrice=150.123・lots=0.5・pips=27.7・profitJpy=1385・side=buy・entryAt=…+09:00。open の決済の列は空欄',
      () => {
        const c = oneRow(trade());
        const o = oneRow(openTrade());
        return verdict([
          ['entryPrice', cellOf(c, 'entryPrice') === '150.123', cellOf(c, 'entryPrice')],
          ['lots', cellOf(c, 'lots') === '0.5', cellOf(c, 'lots')],
          ['pips', cellOf(c, 'pips') === '27.7', cellOf(c, 'pips')],
          ['profitJpy', cellOf(c, 'profitJpy') === '1385', cellOf(c, 'profitJpy')],
          ['side', cellOf(c, 'side') === 'buy', cellOf(c, 'side')],
          ['entryAt', cellOf(c, 'entryAt') === '2026-10-15T21:30:00+09:00', cellOf(c, 'entryAt')],
          ['open の exitPrice が空欄', cellOf(o, 'exitPrice') === '', cellOf(o, 'exitPrice')],
          ['open の exitAt が空欄', cellOf(o, 'exitAt') === '', cellOf(o, 'exitAt')],
          ['open の status', cellOf(o, 'status') === 'open', cellOf(o, 'status')],
          ['deletedAt が空欄', cellOf(c, 'deletedAt') === '', cellOf(c, 'deletedAt')],
        ]);
      }),

    t('CS-05', '数値の 0 は「0」、未入力（null）は空欄。両者は区別できる',
      'profitJpy=0・pips=0 と、null',
      '0 → "0"、null → ""',
      () => {
        const z = oneRow(trade({ profitJpy: 0, pips: 0, slPrice: null }));
        return verdict([
          ['profitJpy 0', cellOf(z, 'profitJpy') === '0', cellOf(z, 'profitJpy')],
          ['pips 0', cellOf(z, 'pips') === '0', cellOf(z, 'pips')],
          ['slPrice null', cellOf(z, 'slPrice') === '', cellOf(z, 'slPrice')],
          ['-0 は 0', cellText('pips', { pips: -0 }) === '0', cellText('pips', { pips: -0 })],
        ]);
      }),

    t('CS-06', 'エスケープ：カンマを含む文字は "…" で囲む', 'メモ「買い,売り,待ち」',
      '"買い,売り,待ち" になり、読み戻すと元のメモ（1セル）',
      () => {
        const body = buildCsvBody([trade({ memo: '買い,売り,待ち' })]);
        const row = parseCsv(body)[1];
        return verdict([
          ['囲まれている', body.includes('"買い,売り,待ち"'), body.split('\r\n')[1].slice(-40)],
          ['列数がずれない', row.length === 32, row.length],
          ['読み戻し', cellOf(row, 'memo') === '買い,売り,待ち', cellOf(row, 'memo')],
        ]);
      }),

    t('CS-07', 'エスケープ：ダブルクォートは "" にして囲む', 'メモ  「"損切り"を入れた」',
      '"""損切り""を入れた"。読み戻すと元のメモ',
      () => {
        const memo = '"損切り"を入れた';
        const body = buildCsvBody([trade({ memo })]);
        return verdict([
          ['二重になっている', body.includes('"""損切り""を入れた"'), body.split('\r\n')[1].slice(-40)],
          ['読み戻し', cellOf(parseCsv(body)[1], 'memo') === memo, cellOf(parseCsv(body)[1], 'memo')],
        ]);
      }),

    t('CS-08', 'エスケープ：メモの中の改行（LF・CRLF・CR）は囲んで残る。行数がずれない',
      'メモ「1行目\\n2行目\\r\\n3行目\\r4行目」',
      '読み戻すと同じメモ（改行もそのまま）。全体の記録の行は2行（見出し＋1件）',
      () => {
        const memo = '1行目\n2行目\r\n3行目\r4行目';
        const body = buildCsvBody([trade({ memo }), trade({ id: 'id-0002' })]);
        const rows = parseCsv(body);
        return verdict([
          ['記録の行は見出し＋2件', rows.length === 3, rows.length],
          ['どの行も32列', rows.every((r) => r.length === 32), rows.map((r) => r.length)],
          ['メモが同じ', cellOf(rows[1], 'memo') === memo, cellOf(rows[1], 'memo')],
        ]);
      }),

    t('CS-09', '日本語・絵文字・全角記号は、そのまま書き出して読み戻せる', 'メモ「ドル円・ユーロ／円　🙂 ＋10pips」など',
      '読み戻すと同じ文字。UTF-8 のバイト列に直して戻しても同じ',
      () => {
        const memo = 'ドル円・ユーロ／円　🙂 ＋10pips 「引用」';
        const p = prepareCsv([trade({ memo, tags: ['様子見すべきだった'] })]);
        const back = new TextDecoder().decode(new TextEncoder().encode(p.text));
        const row = parseCsv(back)[1];
        return verdict([
          ['メモ', cellOf(row, 'memo') === memo, cellOf(row, 'memo')],
          ['タグ', cellOf(row, 'tags') === '様子見すべきだった', cellOf(row, 'tags')],
          ['全角の＋は対象外（数式にならない）', !cellOf(row, 'memo').startsWith("'"), cellOf(row, 'memo')],
        ]);
      }),

    t('CS-10', '配列（根拠・タグ）は「|」でつなぐ。空の配列は空欄、1つならそのまま',
      "entryReasons=['トレンドフォロー','ブレイクアウト']・tags=['ルール違反','指標前','その他']・tags=[]",
      "'トレンドフォロー|ブレイクアウト'・'ルール違反|指標前|その他'・''",
      () => {
        const a = oneRow(trade({ tags: ['ルール違反', '指標前', 'その他'] }));
        const b = oneRow(trade({ tags: [], entryReasons: ['その他'] }));
        return verdict([
          ['根拠2つ', cellOf(a, 'entryReasons') === 'トレンドフォロー|ブレイクアウト', cellOf(a, 'entryReasons')],
          ['タグ3つ', cellOf(a, 'tags') === 'ルール違反|指標前|その他', cellOf(a, 'tags')],
          ['空の配列は空欄', cellOf(b, 'tags') === '', cellOf(b, 'tags')],
          ['1つはそのまま', cellOf(b, 'entryReasons') === 'その他', cellOf(b, 'entryReasons')],
        ]);
      }),

    t('CS-11', '配列の名前に「|」「\\」を含んでいても、書き出し→分割で元の配列に戻る', "['A|B','C\\\\D','普通','\\\\|']",
      "joinList → splitList で同じ配列。名前の中の「|」は「\\|」、「\\」は「\\\\」",
      () => {
        const list = ['A|B', 'C\\D', '普通', '\\|'];
        const joined = joinList(list);
        const back = splitList(joined);
        return verdict([
          ['エスケープされる', joined === 'A\\|B|C\\\\D|普通|\\\\\\|', joined],
          ['往復で同じ', back.length === list.length && back.every((x, i) => x === list[i]), back],
          ['空は空の配列', splitList('').length === 0, splitList('')],
          ['CSV全体を通しても戻る', splitList(cellOf(oneRow(trade({ tags: list })), 'tags')).join('/') === list.join('/'), 'x'],
        ]);
      }),

    t('CS-12', 'CSVインジェクション：先頭が = + - @ のメモには先頭に「\'」を付ける', "'=1+1'・'+1'・'-2'・'@SUM(A1)'",
      "\"'=1+1\"・\"'+1\"・\"'-2\"・\"'@SUM(A1)\"",
      () => {
        const cases = ['=1+1', '+1', '-2', '@SUM(A1)', '=HYPERLINK("http://example.com","x")'];
        return verdict(cases.map((memo) => {
          const got = cellOf(oneRow(trade({ memo })), 'memo');
          return [`${memo} → '${memo}`, got === `'${memo}`, got];
        }));
      }),

    t('CS-13', 'CSVインジェクション：タブ・改行で始まる文字も対象。先頭が空白だけ・途中の記号は対象外',
      "'\\t=1'・'\\r=1'・' =1'・'a=1'・'1-2'・'メモ-ラベル'",
      "最初の2つだけ「'」が付く（\\r は囲まれる）。残りはそのまま",
      () => {
        const got = (memo) => cellOf(oneRow(trade({ memo })), 'memo');
        return verdict([
          ['タブ始まり', got('\t=1') === "'\t=1", got('\t=1')],
          ['CR始まり', got('\r=1') === "'\r=1", got('\r=1')],
          ['空白始まりは対象外', got(' =1') === ' =1', got(' =1')],
          ['途中の=は対象外', got('a=1') === 'a=1', got('a=1')],
          ['数字始まりは対象外', got('1-2') === '1-2', got('1-2')],
          ['途中の-は対象外', got('メモ-ラベル') === 'メモ-ラベル', got('メモ-ラベル')],
        ]);
      }),

    t('CS-14', 'CSVインジェクション：数値の列は対象外（pips・損益のマイナスをそのまま出す）',
      'pips=-37.7・profitJpy=-1885・riskReward=0',
      "'-37.7'・'-1885'（「'」は付かない）",
      () => {
        const row = oneRow(trade({ pips: -37.7, profitJpy: -1885 }));
        return verdict([
          ['pips', cellOf(row, 'pips') === '-37.7', cellOf(row, 'pips')],
          ['profitJpy', cellOf(row, 'profitJpy') === '-1885', cellOf(row, 'profitJpy')],
        ]);
      }),

    t('CS-15', 'CSVインジェクション：タグ・根拠・感情も対象。配列は「つないだ文字の先頭」だけを見る',
      "tags=['=cmd','-x']・entryReasons=['普通','=後ろ']・emotion='+焦り'",
      "tags は \"'=cmd|-x\"、根拠は '普通|=後ろ'（先頭ではないので付かない）、感情は \"'+焦り\"",
      () => {
        const row = oneRow(trade({ tags: ['=cmd', '-x'], entryReasons: ['普通', '=後ろ'], emotion: '+焦り', exitEmotion: '@x' }));
        return verdict([
          ['タグの先頭', cellOf(row, 'tags') === "'=cmd|-x", cellOf(row, 'tags')],
          ['根拠は後ろの=に付けない', cellOf(row, 'entryReasons') === '普通|=後ろ', cellOf(row, 'entryReasons')],
          ['感情', cellOf(row, 'emotion') === "'+焦り", cellOf(row, 'emotion')],
          ['決済時の感情', cellOf(row, 'exitEmotion') === "'@x", cellOf(row, 'exitEmotion')],
        ]);
      }),

    t('CS-16', 'CSVインジェクション：「\'」を付けた分は取り込み側で元に戻せる（元から「\'=」で始まるメモも壊れない）',
      "'=1'・\"'=1\"・\"''-1\"・\"'普通\"・'普通'",
      'guardFormula → unguardFormula で元の文字。元から「\'」で始まる普通の文字には何もしない',
      () => {
        const cases = ['=1', "'=1", "''-1", "'普通", '普通', '-5pips', '\t=1', ''];
        return verdict(cases.map((s) => {
          const back = unguardFormula(guardFormula(s));
          return [`往復 ${show(s)}`, back === s, back];
        }).concat([
          ['普通の文字は付けない', guardFormula("'普通") === "'普通", guardFormula("'普通")],
          ['付いていない文字は外さない', unguardFormula("'普通") === "'普通", unguardFormula("'普通")],
        ]));
      }),

    t('CS-17', '画像：imageIds は出さず、imageCount に枚数を入れる', 'imageIds が 0枚・2枚・4枚',
      '0・2・4。画像のIDは CSV の中のどこにも出ない',
      () => {
        const ids = ['img-aaa-111', 'img-bbb-222'];
        const body = buildCsvBody([
          trade({ id: 'a' }), trade({ id: 'b', imageIds: ids }), trade({ id: 'c', imageIds: [...ids, 'img-ccc-333', 'img-ddd-444'] }),
        ]);
        const rows = parseCsv(body);
        return verdict([
          ['0枚', cellOf(rows[1], 'imageCount') === '0', cellOf(rows[1], 'imageCount')],
          ['2枚', cellOf(rows[2], 'imageCount') === '2', cellOf(rows[2], 'imageCount')],
          ['4枚', cellOf(rows[3], 'imageCount') === '4', cellOf(rows[3], 'imageCount')],
          ['画像IDは出ない', !body.includes('img-aaa'), 'IDあり'],
        ]);
      }),

    t('CS-18', '論理削除：既定は含めない。含めるとき deletedAt の列で見分けられる', '3件のうち1件が deletedAt あり',
      '既定＝2件。includeDeleted:true＝3件で、削除済みの行の deletedAt が入っている',
      () => {
        const del = trade({ id: 'id-del', deletedAt: '2026-10-16T09:00:00+09:00', entryAt: '2026-10-15T22:00:00+09:00' });
        const all = [trade({ id: 'id-1' }), del, trade({ id: 'id-3', entryAt: '2026-10-15T23:30:00+09:00' })];
        const excl = prepareCsv(all);
        const incl = prepareCsv(all, { includeDeleted: true });
        const rowsIncl = parseCsv(incl.text);
        const delRow = rowsIncl.find((r) => cellOf(r, 'id') === 'id-del');
        return verdict([
          ['既定は2件', excl.rowCount === 2 && parseCsv(excl.text).length === 3, excl.rowCount],
          ['削除済みの行がない', !excl.text.includes('id-del'), 'あり'],
          ['含めると3件', incl.rowCount === 3 && rowsIncl.length === 4, incl.rowCount],
          ['deletedAt が入る', delRow && cellOf(delRow, 'deletedAt') === '2026-10-16T09:00:00+09:00', delRow && cellOf(delRow, 'deletedAt')],
          ['削除していない行は空欄', cellOf(rowsIncl.find((r) => cellOf(r, 'id') === 'id-1'), 'deletedAt') === '', 'x'],
          ['内訳は全件で数える', excl.live === 2 && excl.deleted === 1, `${excl.live}/${excl.deleted}`],
        ]);
      }),

    t('CS-19', '件数：countTrades と画面の文言（記録の件数・書き出しの件数）', '128件・削除済み3件',
      "'128件（ほかに削除済み3件）'・含めるとき '131件（削除済み3件を含む）'・含めないとき '128件'・削除済み0件なら括弧なし",
      () => {
        const n = (live, deleted) => ({ live, deleted });
        const mixed = [trade(), trade({ id: 'x', deletedAt: '2026-10-16T09:00:00+09:00' }), trade({ id: 'y', deletedAt: '2026-10-16T09:00:00+09:00' })];
        const c = countTrades(mixed);
        return verdict([
          ['countTrades', c.live === 1 && c.deleted === 2, `${c.live}/${c.deleted}`],
          ['設定画面（削除済みあり）', recordCountLabel(n(128, 3)) === '128件（ほかに削除済み3件）', recordCountLabel(n(128, 3))],
          ['設定画面（削除済みなし）', recordCountLabel(n(128, 0)) === '128件', recordCountLabel(n(128, 0))],
          ['シート（含める）', exportCountLabel(n(128, 3), true) === '131件（削除済み3件を含む）', exportCountLabel(n(128, 3), true)],
          ['シート（含めない）', exportCountLabel(n(128, 3), false) === '128件', exportCountLabel(n(128, 3), false)],
          ['シート（含めるが削除済み0）', exportCountLabel(n(128, 0), true) === '128件', exportCountLabel(n(128, 0), true)],
          ['3桁区切り', recordCountLabel(n(1000, 0)) === '1,000件', recordCountLabel(n(1000, 0))],
        ]);
      }),

    t('CS-20', '0件：見出しだけのCSVになる。画面の説明文は「記録がないため書き出せません。」', '記録なし・削除済みだけ',
      '見出し1行だけ（BOM付き）。削除済みだけで含めないなら rowCount=0',
      () => {
        const empty = prepareCsv([]);
        const onlyDeleted = prepareCsv([trade({ deletedAt: '2026-10-16T09:00:00+09:00' })]);
        return verdict([
          ['見出しだけ', parseCsv(empty.text).length === 1 && empty.rowCount === 0, parseCsv(empty.text).length],
          ['BOMは付く', empty.text.startsWith(BOM), 'なし'],
          ['削除済みだけ・含めない', onlyDeleted.rowCount === 0, onlyDeleted.rowCount],
          ['0件の説明文', exportNote({ exportable: 0, lastExportAt: null }) === '記録がないため書き出せません。', exportNote({ exportable: 0, lastExportAt: null })],
        ]);
      }),

    t('CS-21', '最終書き出しの説明文：まだなら「まだ書き出していません。」、あれば日時。画像は含まれない旨を添える',
      'lastExportAt=null・2026-10-12 22:40・読み込み前（exportable=null）',
      "'まだ書き出していません。画像は含まれません。'・'最終書き出し：10/12(月) 22:40。画像は含まれません。'",
      () => {
        const now = new Date('2026-10-15T12:00:00+09:00');
        const never = exportNote({ exportable: 3, lastExportAt: null, now });
        const done = exportNote({ exportable: 3, lastExportAt: '2026-10-12T22:40:05+09:00', now });
        const loading = exportNote({ exportable: null, lastExportAt: null, now });
        return verdict([
          ['未実施', never === 'まだ書き出していません。画像は含まれません。', never],
          ['実施済み', done === '最終書き出し：10/12(月) 22:40。画像は含まれません。', done],
          ['読み込み前は0件の案内を出さない', loading === 'まだ書き出していません。画像は含まれません。', loading],
        ]);
      }),

    t('CS-22', '並び順：エントリー日時の古い順（同時刻は作成日時、さらに id）。元の配列は書き換えない',
      '3件を新しい順に渡す',
      'id-a → id-b → id-c の順で出る。渡した配列の並びは変わらない',
      () => {
        const input = [
          trade({ id: 'id-c', entryAt: '2026-10-16T09:00:00+09:00' }),
          trade({ id: 'id-b', entryAt: '2026-10-15T21:30:00+09:00', createdAt: '2026-10-15T21:31:00+09:00' }),
          trade({ id: 'id-a', entryAt: '2026-10-15T21:30:00+09:00', createdAt: '2026-10-15T21:30:00+09:00' }),
        ];
        const before = input.map((x) => x.id).join();
        const ids = parseCsv(buildCsvBody(selectForExport(input))).slice(1).map((r) => cellOf(r, 'id'));
        return verdict([
          ['古い順', ids.join() === 'id-a,id-b,id-c', ids.join()],
          ['元の並びはそのまま', input.map((x) => x.id).join() === before, input.map((x) => x.id).join()],
        ]);
      }),

    t('CS-23', 'ファイル名：fx-trade-note_YYYYMMDD_HHmm.csv（日本時間）。日付をまたぐ時刻・年またぎも日本時間',
      '2026-10-15T21:40 JST・UTC 2026-12-31T15:05（日本は翌日 0:05）',
      "'fx-trade-note_20261015_2140.csv'・'fx-trade-note_20270101_0005.csv'",
      () => verdict([
        ['日本時間の夜', csvFileName(new Date('2026-10-15T21:40:00+09:00')) === 'fx-trade-note_20261015_2140.csv', csvFileName(new Date('2026-10-15T21:40:00+09:00'))],
        ['UTCでは前日', csvFileName(new Date('2026-12-31T15:05:00Z')) === 'fx-trade-note_20270101_0005.csv', csvFileName(new Date('2026-12-31T15:05:00Z'))],
        ['1桁の月日は0埋め', csvFileName(new Date('2026-01-02T03:04:00+09:00')) === 'fx-trade-note_20260102_0304.csv', csvFileName(new Date('2026-01-02T03:04:00+09:00'))],
        ['prepareCsv も同じ名前', prepareCsv([], { now: new Date('2026-10-15T21:40:00+09:00') }).fileName === 'fx-trade-note_20261015_2140.csv', 'x'],
      ])),

    t('CS-24', '壊れたデータでも止まらない：項目が無い・数値が有限でない・配列の中が文字でない', 'memo 無し・pips=NaN・tags=[1,null]',
      '例外を出さず、無い項目・NaN は空欄。列数は32のまま',
      () => {
        const broken = trade({ pips: NaN, profitJpy: Infinity, tags: [1, null] });
        delete broken.memo;
        const row = oneRow(broken);
        return verdict([
          ['列数32', row.length === 32, row.length],
          ['memo 無しは空欄', cellOf(row, 'memo') === '', cellOf(row, 'memo')],
          ['NaN は空欄', cellOf(row, 'pips') === '', cellOf(row, 'pips')],
          ['Infinity は空欄', cellOf(row, 'profitJpy') === '', cellOf(row, 'profitJpy')],
          ['配列の中は文字にする', cellOf(row, 'tags') === '1|null', cellOf(row, 'tags')],
        ]);
      }),

    t('CS-25', 'escapeCell：特別な文字がなければそのまま、あれば囲む', "'abc'・'a,b'・'a\"b'・'a\\nb'・''",
      "'abc'・'\"a,b\"'・'\"a\"\"b\"'・'\"a\\nb\"'・''",
      () => verdict([
        ['そのまま', escapeCell('abc') === 'abc', escapeCell('abc')],
        ['カンマ', escapeCell('a,b') === '"a,b"', escapeCell('a,b')],
        ['クォート', escapeCell('a"b') === '"a""b"', escapeCell('a"b')],
        ['改行', escapeCell('a\nb') === '"a\nb"', escapeCell('a\nb')],
        ['空', escapeCell('') === '', escapeCell('')],
        ['日本語', escapeCell('あ') === 'あ', escapeCell('あ')],
      ])),

    t('CS-26', '読み戻し：厄介な値をまとめて入れた記録を書き出し、テスト側のパーサーで読み戻すと全項目が元と一致する',
      'カンマ・クォート・改行・日本語・絵文字・「|」「\\」・先頭が「=」を含む記録',
      '32項目すべて一致（imageIds は枚数、配列は区切りを分割、先頭の「\'」は外す）',
      () => {
        const original = trade({
          memo: '=SUM(1,2)\n"引用",カンマ\r\n日本語🙂', tags: ['A|B', '-マイナス', 'C\\D'], entryReasons: ['普通'],
          emotion: '焦り', imageIds: ['i1', 'i2'], pips: -12.3, profitJpy: -1230, deletedAt: '2026-10-16T09:00:00+09:00',
        });
        const row = oneRow(original);
        const back = (col) => unguardFormula(cellOf(row, col));
        const checks = [];
        for (const col of CSV_COLUMNS) {
          const v = original[col === 'imageCount' ? 'imageIds' : col];
          let ok;
          if (col === 'imageCount') ok = cellOf(row, col) === String(v.length);
          else if (Array.isArray(v)) ok = JSON.stringify(splitList(back(col))) === JSON.stringify(v);
          else if (v == null) ok = cellOf(row, col) === '';
          else if (typeof v === 'number') ok = Number(cellOf(row, col)) === v;
          else ok = back(col) === v;
          checks.push([col, ok, cellOf(row, col)]);
        }
        return verdict(checks);
      }),

    t('CS-27', '1000件：書き出せる。行数・列数が正しく、一瞬（1秒未満）で作れる。メモは全部違う内容',
      '1000件（通貨ペア・価格・メモ・タグはばらばら。特殊な文字を一部に含む）',
      '1001行（見出し＋1000件）、どの行も32列、id が1000件ぶん一意、1秒未満',
      () => {
        const pairs = ['USD/JPY', 'EUR/USD', 'GBP/JPY', 'EUR/JPY', 'AUD/JPY'];
        const trades = [];
        for (let i = 0; i < 1000; i += 1) {
          const day = String((i % 28) + 1).padStart(2, '0');
          const hh = String(i % 24).padStart(2, '0');
          trades.push(trade({
            id: `id-${String(i).padStart(4, '0')}`, pair: pairs[i % 5], side: i % 2 ? 'buy' : 'sell',
            entryPrice: 100 + i / 1000, entryAt: `2026-0${(i % 9) + 1}-${day}T${hh}:00:00+09:00`,
            pips: i % 3 === 0 ? -i / 10 : i / 10, profitJpy: i % 3 === 0 ? -i : i,
            memo: i % 7 === 0 ? `=メモ${i},"引用"\n改行` : `メモ${i}`, tags: i % 5 === 0 ? ['A|B', '指標前'] : [],
            deletedAt: i % 100 === 0 ? '2026-10-16T09:00:00+09:00' : null,
          }));
        }
        const start = Date.now();
        const withDeleted = prepareCsv(trades, { includeDeleted: true });
        const without = prepareCsv(trades);
        const ms = Date.now() - start;
        const rows = parseCsv(withDeleted.text);
        const ids = new Set(rows.slice(1).map((r) => cellOf(r, 'id')));
        return verdict([
          ['1001行', rows.length === 1001, rows.length],
          ['どの行も32列', rows.every((r) => r.length === 32), rows.filter((r) => r.length !== 32).length],
          ['idが一意', ids.size === 1000, ids.size],
          ['削除済みを除くと990件', without.rowCount === 990 && parseCsv(without.text).length === 991, without.rowCount],
          [`速い（${ms}ms）`, ms < 1000, ms],
        ]);
      }),

    t('CS-28', '共有シートの使い分け：共有できる＋タッチ端末のときだけ共有シート。PC・共有不可・例外はダウンロード', '5通りの環境',
      '共有可・タッチ → true／マウス → false／canShare false → false／share が無い → false／canShare が例外 → false',
      () => {
        const file = createCsvFile(BOM + 'a', 'x.csv');
        const touch = fakeEnv();
        const pc = fakeEnv({ coarse: false });
        const noShare = fakeEnv({ canShare: false });
        const missing = fakeEnv({ hasShare: false });
        const boom = fakeEnv({ throwOnCanShare: true });
        return verdict([
          ['iPhone 想定', canUseShareSheet(file, touch.env) === true, canUseShareSheet(file, touch.env)],
          ['PC 想定', canUseShareSheet(file, pc.env) === false, canUseShareSheet(file, pc.env)],
          ['ファイルを共有できない', canUseShareSheet(file, noShare.env) === false, canUseShareSheet(file, noShare.env)],
          ['share が無い', canUseShareSheet(file, missing.env) === false, canUseShareSheet(file, missing.env)],
          ['canShare が例外', canUseShareSheet(file, boom.env) === false, canUseShareSheet(file, boom.env)],
          ['navigator が無い（Node など）', canUseShareSheet(file, {}) === false, canUseShareSheet(file, {})],
        ]);
      }),

    t('CS-29', '共有の結果：成功は shared、シートを閉じた（AbortError）は cancelled、それ以外の失敗は例外', '3通り',
      'shared／cancelled（例外にしない）／NotAllowedError は投げ直す。渡すのは files だけ',
      async () => {
        const file = createCsvFile(BOM + 'a', 'x.csv');
        const ok = fakeEnv();
        const abort = fakeEnv({ shareImpl: async () => { throw errorNamed('AbortError'); } });
        const ng = fakeEnv({ shareImpl: async () => { throw errorNamed('NotAllowedError'); } });
        const r1 = await shareCsvFile(file, ok.env);
        const r2 = await shareCsvFile(file, abort.env);
        let r3 = 'no-throw';
        try { await shareCsvFile(file, ng.env); } catch (e) { r3 = e.name; }
        return verdict([
          ['成功', r1 === 'shared', r1],
          ['files だけを渡す', ok.calls.length === 1 && Object.keys(ok.calls[0]).join() === 'files' && ok.calls[0].files[0] === file, Object.keys(ok.calls[0] || {}).join()],
          ['キャンセルは失敗にしない', r2 === 'cancelled', r2],
          ['それ以外は投げ直す', r3 === 'NotAllowedError', r3],
        ]);
      }),

    t('CS-30', 'シートへ送る値（sheetRowValues：T-41）は CSV のセルと同じ作り方。数値の列は JSON の数値、文字の列は cellText',
      '決済済み・保有中・数式になりうる文字・配列・画像2枚・NaN／文字の入った数値の列',
      'sheets-setup 4.3：文字の21列は cellText と同じ文字（null は空の文字・「\'」の印・| でつなぐ）、数値の11列は数値か null、'
        + 'imageCount は枚数、syncStatus は synced・syncedAt は送る時刻。列は CSV_COLUMNS の32列だけ',
      () => {
        const at = '2026-10-28T10:00:00+09:00';
        const samples = [
          trade({ imageIds: ['a', 'b'], memo: '=HYPERLINK("x")', tags: ['指|標', '-逆'], emotion: '@冷静' }),
          openTrade(),
          trade({ entryPrice: Number.NaN, lots: '1', pips: Infinity, profitJpy: -1885, quoteToJpyRate: 149.85 }),
        ];
        const checks = [];
        for (const [n, tr] of samples.entries()) {
          const v = sheetRowValues(tr, { syncedAt: at });
          checks.push([`#${n + 1} 列は32列・CSV と同じ並び`, Object.keys(v).join() === CSV_COLUMNS.join(), Object.keys(v).join()]);
          for (const c of CSV_COLUMNS) {
            if (c === 'syncStatus' || c === 'syncedAt') continue;
            if (CSV_NUMBER_COLUMNS.includes(c)) {
              const raw = c === 'imageCount' ? tr.imageIds.length : tr[c];
              const want = typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
              checks.push([`#${n + 1} ${c}（数値）`, v[c] === want, v[c]]);
              // 数値の列は、CSV のセルの文字を数に直したものと同じ（未入力・NaN は CSV でも空欄）
              const cell = cellText(c, tr);
              checks.push([`#${n + 1} ${c} と CSV のセル`, want === null ? (cell === '' || typeof raw !== 'number') : String(want) === cell, cell]);
            } else {
              checks.push([`#${n + 1} ${c}（文字）`, v[c] === cellText(c, tr) && typeof v[c] === 'string', v[c]]);
            }
          }
          checks.push([`#${n + 1} syncStatus・syncedAt`, v.syncStatus === 'synced' && v.syncedAt === at, `${v.syncStatus} ${v.syncedAt}`]);
        }
        const first = sheetRowValues(samples[0], { syncedAt: at });
        checks.push(['数式になりうる文字に印', first.memo === '\'=HYPERLINK("x")' && first.emotion === '\'@冷静', `${first.memo} ${first.emotion}`]);
        checks.push(['配列は | でつなぐ（中の | は \\|）', first.tags === '指\\|標|-逆', first.tags]);
        checks.push(['imageCount は枚数', first.imageCount === 2, first.imageCount]);
        checks.push(['記録は書き換えない', samples[0].syncStatus === 'pending' && samples[0].syncedAt === null, samples[0].syncStatus]);
        return verdict(checks);
      }),

    t('CS-31', '数値の列（CSV_NUMBER_COLUMNS）は sheets-setup 4.1 の11列', 'CSV_NUMBER_COLUMNS',
      "entryPrice・lots・lotUnitSize・slPrice・tpPrice・riskReward・exitPrice・pips・profitJpy・quoteToJpyRate・imageCount（どれも CSV_COLUMNS にある）",
      () => {
        const want = ['entryPrice', 'lots', 'lotUnitSize', 'slPrice', 'tpPrice', 'riskReward', 'exitPrice', 'pips', 'profitJpy', 'quoteToJpyRate', 'imageCount'];
        return verdict([
          ['11列', CSV_NUMBER_COLUMNS.length === 11 && want.every((c) => CSV_NUMBER_COLUMNS.includes(c)), CSV_NUMBER_COLUMNS.join()],
          ['どれも CSV の列', CSV_NUMBER_COLUMNS.every((c) => CSV_COLUMNS.includes(c)), ''],
        ]);
      }),
  ];
}
