/* =========================================================
   js/csv.js
   CSV の作成（BOM付きUTF-8）と保存（iPhone は共有シート、PC はダウンロード）。T-25 で作成。
   列の構成・区切り方・CSVインジェクション対策の取り決めは architecture 14.2 に書いてある（T-44 のインポートと T-37 のシートの前提）。

   【なぜ「作る」関数を DOM や IndexedDB から切り離したか】
   ・CSV の作り方（エスケープ・BOM・列の順）は、間違えると「Excel で開くとずれる」「バックアップから戻せない」に直結する。
     画面や DB に触れない純粋な関数にしておけば、Node.js のテスト（tests/csv.test.js）で 1000 件でも確かめられる。
   ・記録を DB から読むのは画面側（screens/settings-data.js が trades.js を呼ぶ）。ここは「渡された記録を CSV にする」だけ。
   ・保存の関数（共有シート・ダウンロード）は navigator / document を「呼ばれたときに」触る。読み込んだだけでは触らないので
     Node.js からも import できる。テストでは env 引数ににせものを渡して確かめる。

   依存（architecture 4.2）：db（項目名 TRADE_KEYS だけ）, datetime, format
   ========================================================= */
import { TRADE_KEYS } from './db.js';
import { jstParts } from './datetime.js';
import { formatDateTime } from './format.js';

/** Excel に「これは UTF-8 です」と伝える印（バイト列 EF BB BF）。付けないと日本語が文字化けする */
export const BOM = '﻿';

/** 行の区切り。RFC 4180 の CRLF（Excel でいちばん安定して開ける） */
const EOL = '\r\n';

/** 配列の項目を1つのセルに入れるときの区切り（architecture 14.2）。選択肢の名前に使われにくい記号 */
const LIST_SEPARATOR = '|';

/**
 * CSV の列（見出し）。requirements 6.1 のキー名・順番のまま、`imageIds` だけ `imageCount`（画像の枚数）に置き換える。
 * なぜ imageIds をそのまま出さないか：画像の ID は画像本体（CSV に含められない Blob）とセットでしか意味がなく、
 * 復元（T-44）で ID だけ戻すと「記録が画像を指しているのに画像が無い」状態になるため。枚数なら、画像が付いていた記録だと分かる。
 */
export const CSV_COLUMNS = Object.freeze(TRADE_KEYS.map((k) => (k === 'imageIds' ? 'imageCount' : k)));

/** 区切りで1つのセルにまとめる配列の項目 */
const LIST_COLUMNS = Object.freeze(['entryReasons', 'tags']);

/* ---------------------------------------------------------
   セルの文字づくり
   --------------------------------------------------------- */

/**
 * CSV インジェクション対策が必要か（architecture 14.2）。
 * Excel は、セルの先頭が = + - @（と、タブ・改行）の文字を数式として実行することがある。
 * 先頭が「'」のあとに危険な文字が続くものも対象にするのは、取り込み（T-44）で先頭の「'」を1つ外したときに、
 * もともと「'=…」と入力されていたメモを壊さないため（外す側は unguardFormula）。
 */
const NEEDS_GUARD = /^'*[=+\-@\t\r]/;

/**
 * 文字の項目の先頭に「'」を付けて、Excel が数式として実行しないようにする。数値には使わない（pips のマイナスなどを壊さないため）。
 * @param {string} s
 * @returns {string}
 */
export function guardFormula(s) {
  return NEEDS_GUARD.test(s) ? `'${s}` : s;
}

/**
 * guardFormula の逆（T-44 の取り込みが使う約束。ここでは「元に戻せる形で出している」ことをテストで確かめるために置く）。
 * @param {string} s
 * @returns {string}
 */
export function unguardFormula(s) {
  return /^'+[=+\-@\t\r]/.test(s) ? s.slice(1) : s;
}

/** 配列の1つ分の要素に含まれる「\」と「|」を、区切りと見分けられるよう「\\」「\|」にする */
const escapeListItem = (s) => s.replace(/[\\|]/g, (c) => `\\${c}`);

/**
 * 配列（根拠・タグ）を1つのセルの文字にする。例：['ルール違反', '指標前'] → 'ルール違反|指標前'。
 * 選択肢の名前に「|」が入っていても読み戻せるよう、要素の中の「|」「\」は「\|」「\\」にする。
 * @param {string[]} list
 * @returns {string}
 */
export function joinList(list) {
  return list.map((x) => escapeListItem(String(x))).join(LIST_SEPARATOR);
}

/**
 * joinList の逆（T-44 の取り込みが使う約束。テストで往復できることを確かめるために置く）。空の文字は空の配列。
 * @param {string} text
 * @returns {string[]}
 */
export function splitList(text) {
  if (text === '') return [];
  const out = [];
  let cur = '';
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c === '\\' && i + 1 < text.length) {
      i += 1;
      cur += text[i];
    } else if (c === LIST_SEPARATOR) {
      out.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

/**
 * 記録の1項目を、セルに入れる前の文字にする（エスケープ前）。
 * ・null / undefined … 空欄（未入力。「0」ではなく空にして区別する）
 * ・数値 … そのまま文字に。有限でない値（NaN など）は空欄。数値には CSV インジェクション対策をしない（マイナスを壊さないため）
 * ・配列（根拠・タグ）… 区切りでまとめる。imageIds は枚数
 * ・文字 … 先頭が数式になりうるときだけ「'」を付ける
 * @param {string} column CSV の列名
 * @param {object} trade
 * @returns {string}
 */
export function cellText(column, trade) {
  if (column === 'imageCount') return String(Array.isArray(trade.imageIds) ? trade.imageIds.length : 0);
  const v = trade[column];
  if (v == null) return '';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  if (Array.isArray(v)) return guardFormula(joinList(v));
  return guardFormula(String(v));
}

/**
 * セルを CSV の形にする。カンマ・ダブルクォート・改行を含むときは「"」で囲み、中の「"」は「""」にする。
 * @param {string} text
 * @returns {string}
 */
export function escapeCell(text) {
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/* ---------------------------------------------------------
   書き出す記録の選び方・全体の組み立て
   --------------------------------------------------------- */

/**
 * 書き出す記録を選び、エントリー日時の古い順に並べる（元の配列は書き換えない）。
 * ・includeDeleted が false（既定）なら、論理削除（deletedAt あり）は除く
 * ・並びは entryAt → createdAt → id の順。日時は固定形式の文字なので、文字の比較がそのまま時刻の順（architecture 6.6）。
 *   同じ記録の集まりなら、いつ書き出しても同じ並びになる（バックアップの差分が見やすい）
 * @param {object[]} trades
 * @param {{ includeDeleted?: boolean }} [opts]
 * @returns {object[]}
 */
export function selectForExport(trades, { includeDeleted = false } = {}) {
  const key = (t) => [String(t.entryAt ?? ''), String(t.createdAt ?? ''), String(t.id ?? '')];
  return trades
    .filter((t) => includeDeleted || t.deletedAt == null)
    .sort((a, b) => {
      const ka = key(a);
      const kb = key(b);
      for (let i = 0; i < ka.length; i += 1) {
        if (ka[i] !== kb[i]) return ka[i] < kb[i] ? -1 : 1;
      }
      return 0;
    });
}

/**
 * 記録の件数（削除済みを分けて数える）。設定画面の「記録の件数」と確認シートの表示に使う。
 * @param {object[]} trades
 * @returns {{ live: number, deleted: number }}
 */
export function countTrades(trades) {
  let deleted = 0;
  for (const t of trades) if (t.deletedAt != null) deleted += 1;
  return { live: trades.length - deleted, deleted };
}

/**
 * CSV の中身（BOM なしの文字）。見出しの行＋記録の行。行の終わりは CRLF で、最後の行にも付ける。
 * 1000 件でも一瞬（文字を配列に貯めて最後に1回つなぐ）。
 * @param {object[]} trades 記録（selectForExport 済みでも、全件でもよい。ここでは選び直さない）
 * @returns {string}
 */
export function buildCsvBody(trades) {
  const lines = [CSV_COLUMNS.join(',')];
  for (const t of trades) {
    lines.push(CSV_COLUMNS.map((c) => escapeCell(cellText(c, t))).join(','));
  }
  return lines.join(EOL) + EOL;
}

/** 2桁にそろえる */
const pad2 = (n) => String(n).padStart(2, '0');

/**
 * ファイル名 fx-trade-note_YYYYMMDD_HHmm.csv（日本時間の作成時刻。端末のタイムゾーンに左右されない）。
 * @param {Date} [date]
 * @returns {string}
 */
export function csvFileName(date = new Date()) {
  const p = jstParts(date);
  return `fx-trade-note_${p.year}${pad2(p.month)}${pad2(p.day)}_${pad2(p.hour)}${pad2(p.minute)}.csv`;
}

/**
 * 書き出しの準備：選ぶ → CSV にする → ファイル名を決める。
 * @param {object[]} allTrades DB から読んだ全件（削除済みを含む）
 * @param {{ includeDeleted?: boolean, now?: Date }} [opts]
 * @returns {{ text: string, fileName: string, rowCount: number, live: number, deleted: number, includeDeleted: boolean }}
 *   text は BOM 付き。rowCount は実際に書き出す記録の数、live / deleted は全件の内訳
 */
export function prepareCsv(allTrades, { includeDeleted = false, now = new Date() } = {}) {
  const rows = selectForExport(allTrades, { includeDeleted });
  const { live, deleted } = countTrades(allTrades);
  return {
    text: BOM + buildCsvBody(rows),
    fileName: csvFileName(now),
    rowCount: rows.length,
    live,
    deleted,
    includeDeleted,
  };
}

/* ---------------------------------------------------------
   画面に出す文（件数・最終書き出し）
   --------------------------------------------------------- */

const withCommas = (n) => n.toLocaleString('ja-JP');

/**
 * 設定画面の「記録の件数」の値。削除済みがあれば「128件（ほかに削除済み3件）」（design 14.6.1）。
 * @param {{ live: number, deleted: number }} counts
 */
export function recordCountLabel({ live, deleted }) {
  return deleted > 0 ? `${withCommas(live)}件（ほかに削除済み${withCommas(deleted)}件）` : `${withCommas(live)}件`;
}

/**
 * 確認シートの「記録」の値。削除済みを含めるときは「131件（削除済み3件を含む）」（design 14.6.5）。
 * @param {{ live: number, deleted: number }} counts
 * @param {boolean} includeDeleted
 */
export function exportCountLabel({ live, deleted }, includeDeleted) {
  if (includeDeleted && deleted > 0) return `${withCommas(live + deleted)}件（削除済み${withCommas(deleted)}件を含む）`;
  return `${withCommas(live)}件`;
}

/**
 * 「データ」グループの下の説明文（design 14.6.1・14.6.5）。
 * 書き出せる記録が0件なら案内、そうでなければ最終書き出し日時（まだなら「まだ書き出していません。」）に「画像は含まれません。」を添える。
 * @param {{ exportable: (number|null), lastExportAt: (string|null), now?: Date }} opts
 *   exportable … 書き出せる記録の数。まだ読み込めていない（null）ときは案内を出さない
 */
export function exportNote({ exportable, lastExportAt, now = new Date() }) {
  if (exportable === 0) return '記録がないため書き出せません。';
  const last = lastExportAt ? `最終書き出し：${formatDateTime(lastExportAt, now)}。` : 'まだ書き出していません。';
  return `${last}画像は含まれません。`;
}

/* ---------------------------------------------------------
   ファイルにして保存する
   --------------------------------------------------------- */

/**
 * CSV の文字から File を作る。text に BOM を含めておくと、Blob が UTF-8 に直すときに EF BB BF の3バイトになる。
 * @param {string} text BOM 付きの CSV
 * @param {string} fileName
 * @returns {File}
 */
export function createCsvFile(text, fileName) {
  return new File([text], fileName, { type: 'text/csv' });
}

/**
 * 共有シートで保存する方式にするか（design 14.6.5）。
 * navigator.canShare でファイルを共有できて、かつタッチ操作の端末（pointer: coarse）のときだけ true。
 * PC の Chrome / Edge もファイルの共有ができるが、PC では共有シートよりダウンロードの方が自然なので、タッチの端末に限る。
 * @param {File} file
 * @param {{ navigator?: object, matchMedia?: Function }} [env] テストでにせものを渡す。既定はブラウザ本物
 * @returns {boolean}
 */
export function canUseShareSheet(file, env = globalThis) {
  try {
    const nav = env.navigator;
    if (!nav || typeof nav.share !== 'function' || typeof nav.canShare !== 'function') return false;
    if (!nav.canShare({ files: [file] })) return false;
    return typeof env.matchMedia === 'function' && env.matchMedia('(pointer: coarse)').matches === true;
  } catch (e) {
    return false;
  }
}

/**
 * 共有シートを開いて CSV を渡す。「保存する」ボタンを押した直後に呼ぶこと（ブラウザは、ボタン操作の直後でないと共有シートを開かせないため）。
 * @param {File} file
 * @param {{ navigator?: object }} [env]
 * @returns {Promise<'shared'|'cancelled'>} 共有が終わったら 'shared'、共有シートを閉じた（キャンセル）なら 'cancelled'
 * @throws キャンセル以外の失敗（共有シートを開けなかったなど）はそのまま投げる
 */
export async function shareCsvFile(file, env = globalThis) {
  try {
    await env.navigator.share({ files: [file] });
    return 'shared';
  } catch (e) {
    // 共有シートを閉じたときは AbortError。失敗ではなく「やめた」として扱う（lastExportAt も記録しない）
    if (e && e.name === 'AbortError') return 'cancelled';
    throw e;
  }
}

/**
 * ダウンロードで保存する（PC や共有シートが使えない環境）。見えないリンクを作ってクリックし、すぐ片付ける。
 * 作った一時的なアドレス（blob:）は、ダウンロードが始まるまで残す必要があるので、少し待ってから解放する。
 * @param {File} file
 * @param {{ document?: Document, URL?: typeof URL, setTimeout?: Function }} [env]
 */
export function downloadCsvFile(file, env = globalThis) {
  const url = env.URL.createObjectURL(file);
  const a = env.document.createElement('a');
  a.href = url;
  a.download = file.name;
  a.rel = 'noopener';
  a.hidden = true;
  env.document.body.append(a);
  a.click();
  a.remove();
  env.setTimeout(() => env.URL.revokeObjectURL(url), 60 * 1000);
}
