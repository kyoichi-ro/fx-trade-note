/* =========================================================
   js/screens/settings-import.js
   設定画面の「CSVを読み込む」（design.md 14.6.9〜14.6.12。T-44）。
   「データ」グループの続き（見出しのない2つ目のまとまり）として settings.js が並べる。画面そのものではなく settings.js の一部品。

   【流れ（design 14.6.9）】
   ① 行を押す → すぐに見えないファイル選択（<input type="file">）を開く（iPhone の「ファイル」は、押した直後にしか開けないため
      間に await を挟まない）。キャンセルしたときは何もしない
   ② 選んだら読み込み・チェック（js/csv-import.js）。0.3秒以上かかるときだけ行の文字を「読み込み中」にする。
      ファイルとして読めない（大きすぎる・読めない・形式・文字コード・記録0行）ときはアラート I-1〜I-5 で設定に戻る
   ③ 確認シート「CSVの読み込み」（件数・すでにある記録の扱い〔初期値スキップ〕・読めなかった行）→［n件を取り込む］
   ④ 取り込み中は閉じられない（「キャンセル」無効・背景タップ・Esc も効かない）。取り込みは trades.js の importTrades が
      1つのトランザクションで行うので、途中でアプリが閉じられても何も入っていない
   ⑤ 結果を同じシートの中に出す（「キャンセル」は隠す）→［完了］で閉じる。選択肢に無いタグ・根拠・感情は末尾に足して結果で知らせる
   失敗：書き込みの失敗（容量不足の可能性）はアラートの後で確認シートを開き直す（選んだ「スキップ／上書き」はそのまま）。
         確認中に記録が変わった（CONFLICT）はアラートの後で設定に戻す（件数が古くなっているため）。
   ========================================================= */
import { h } from '../ui/dom.js';
import { listGroup, listRow, button, setBusy } from '../ui/parts.js';
import { segment, messageLine } from '../ui/fields.js';
import { icon } from '../ui/icons.js';
import { openSheet } from '../ui/sheet.js';
import { alertImportFile, alertImportFailed, focusQuietly } from '../ui/dialog.js';
import { getAllTrades, importTrades } from '../trades.js';
import { getSetting, setSetting } from '../settings-store.js';
import { isAppError } from '../util.js';
import {
  IMPORT_MAX_BYTES, ISSUE_LIST_MAX, parseImportBytes, summarizeImport, importCount, importButtonLabel,
  countLabel, lineCountLabel, periodLabel, confirmNote, modeNote, newerWarning, ALL_EXISTING_NOTE, ISSUES_NOTE,
  resultNotes, planChoiceAdditions, choiceAddedNote,
} from '../csv-import.js';

/** 「読み込み中」「途中で閉じると…」を出すまでの待ち時間（ミリ秒）。すぐ終わるときに文字がちらつかないように（design 14.6.9） */
const BUSY_DELAY_MS = 300;

/**
 * この大きさ以上のファイルは、読む前に「読み込み中」を出す（バイト）。CSV のチェックは画面を止めて一気に行うので、
 * 0.3秒の待ち時間の仕掛けが途中で動けず、表示が出ないまま待たせてしまうため。2MB はおよそ4000件で、チェックに0.3秒ほどかかる大きさ
 */
const SHOW_BUSY_FIRST_BYTES = 2 * 1024 * 1024;

/** 画面の描き直しを1回待つ（「読み込み中」を描いてから重い処理を始めるため） */
const nextPaint = () => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));

/** 行の下の説明文（design 14.6.9「画像・設定が戻らないことの伝え方」） */
const ROW_NOTE = '書き出したCSVから記録を戻します。画像と設定は戻りません。';

/** 取り込み中、ボタンの上に出す文（design 14.6.9） */
const IMPORTING_NOTE = '途中でアプリを閉じると、何も取り込まれません（もう一度読み込めます）。';

/* ---------------------------------------------------------
   確認シートの中身
   --------------------------------------------------------- */

/** ファイル名の行（書き出しの確認シートと同じ形：design 14.6.5） */
function fileRow(name) {
  return h('div', { class: 'list-row export-file' },
    h('span', { class: 'export-file__label' }, 'ファイル名'),
    h('span', { class: 'export-file__name' }, name));
}

/** 読めなかった行の一覧（最大20行。それ以上は「ほか n行」） */
function issueRows(issues) {
  const rows = issues.slice(0, ISSUE_LIST_MAX).map((x) => h('div', { class: 'list-row import-issue' },
    h('span', { class: 'import-issue__line' }, `${x.line}行目`),
    h('span', { class: 'import-issue__reason' }, x.reason)));
  if (issues.length > ISSUE_LIST_MAX) {
    rows.push(h('div', { class: 'list-row import-issue' },
      h('span', { class: 'import-issue__reason' }, `ほか ${lineCountLabel(issues.length - ISSUE_LIST_MAX)}`)));
  }
  return rows;
}

/**
 * 確認シート（と結果）の中身を作る。
 * @param {{ fileName: string, parsed: object, summary: object, overwrite: boolean }} state
 *   overwrite は開き直しても残す（容量不足で開き直したとき、選んだ「スキップ／上書き」をそのままにする）
 * @param {(value: any) => void} finish
 * @param {{ setDismissible: Function, setCancelHidden: Function }} control
 * @param {() => void} onImported 取り込みが終わったとき（設定画面の件数・選択肢の数を新しくする）
 */
function sheetContent(state, finish, control, onImported) {
  const { parsed, summary } = state;
  const body = h('div', { class: 'import-sheet' });
  const footer = h('div', { class: 'import-sheet__footer' });

  /* ---------- 件数 ---------- */
  const countsGroup = listGroup({
    rows: [
      fileRow(state.fileName),
      summary.period ? listRow({ label: '記録の期間', value: periodLabel(summary.period), numeric: true }) : null,
      listRow({ label: '新しい記録', value: countLabel(summary.newCount), numeric: true }),
      summary.existingCount > 0 ? listRow({ label: 'すでにある記録', value: countLabel(summary.existingCount), numeric: true }) : null,
      summary.issueCount > 0 ? listRow({ label: '読めなかった行', value: lineCountLabel(summary.issueCount), numeric: true }) : null,
    ].filter(Boolean),
    footer: h('p', {}, confirmNote(summary)),
  });

  /* ---------- すでにある記録の扱い（すでにある記録が0件ならグループごと出さない） ---------- */
  let seg = null;
  let modeGroup = null;
  const modeFooter = h('div', {});
  if (summary.existingCount > 0) {
    seg = segment({
      name: 'import-mode',
      label: 'すでにある記録の扱い',
      value: state.overwrite ? 'overwrite' : 'skip',
      options: [{ value: 'skip', label: 'スキップ' }, { value: 'overwrite', label: '上書き' }],
      onChange: (v) => {
        state.overwrite = v === 'overwrite';
        renderMode();
      },
    });
    modeGroup = listGroup({
      header: `すでにある記録（${countLabel(summary.existingCount)}）の扱い`,
      rows: [h('div', { class: 'filter-row' }, seg.el)],
      footer: modeFooter,
    });
  }

  /* ---------- 読めなかった行 ---------- */
  const issuesGroup = parsed.issues.length > 0
    ? listGroup({ header: '読めなかった行', rows: issueRows(parsed.issues), footer: h('p', {}, ISSUES_NOTE) })
    : null;

  /* ---------- 下部：取り込み中の文・主要ボタン ---------- */
  const busyNote = h('p', { class: 'import-sheet__note', hidden: true }, IMPORTING_NOTE);
  const importBtn = button('', { variant: 'primary', block: true, onClick: () => runImport() });

  /** 選んだ扱い（スキップ／上書き）に合わせて、説明・注意・ボタンの文字を変える */
  function renderMode() {
    const label = importButtonLabel(summary, state.overwrite);
    importBtn.querySelector('.btn__label').textContent = label;
    importBtn.disabled = importCount(summary, state.overwrite) === 0;
    if (!modeGroup) return;
    const parts = [h('p', {}, modeNote(state.overwrite))];
    if (state.overwrite && summary.newerOnDevice > 0) parts.push(messageLine('warning', newerWarning(summary.newerOnDevice)));
    if (!state.overwrite && summary.newCount === 0) parts.push(h('p', {}, ALL_EXISTING_NOTE));
    modeFooter.replaceChildren(...parts);
  }

  /** 取り込む（③〜⑤） */
  async function runImport() {
    if (importBtn.disabled) return;
    control.setDismissible(false);
    if (seg) {
      // 取り込み中は「スキップ／上書き」も変えられない（design 14.6.9「件数・セグメントも無効表示」）
      for (const input of seg.el.querySelectorAll('input')) input.disabled = true;
      seg.el.classList.add('is-disabled');
    }
    setBusy(importBtn, true, '取り込み中');
    const noteTimer = setTimeout(() => { busyNote.hidden = false; }, BUSY_DELAY_MS);
    let result;
    try {
      result = await importTrades(parsed.rows.map((r) => r.trade), { overwrite: state.overwrite, snapshot: summary.snapshot });
    } catch (e) {
      clearTimeout(noteTimer);
      console.error('CSVを取り込めませんでした', e);
      // シートを閉じてからアラートを出す（アラートを重ねるとシートが閉じてしまうため：設定の書き出しと同じ作り）
      finish({ failed: isAppError(e, 'CONFLICT') ? 'conflict' : 'write' });
      return;
    }
    clearTimeout(noteTimer);
    const choiceNote = addMissingChoices(result.trades);
    // 画像が付いていた記録のうち、新しく追加したもの（上書きした記録はこの端末の画像が残っている）
    const addedWithImages = parsed.rows.filter((r) => r.imageCount > 0 && summary.snapshot.get(r.trade.id) === null).length;
    renderResult(result, resultNotes({ addedWithImages, choiceNote }));
    control.setCancelHidden(true);
    control.setDismissible(true);
    onImported();
  }

  /** 結果（同じシートの中身を入れ替える：design 14.6.9） */
  function renderResult(result, notes) {
    const rows = [
      h('div', { class: 'list-row import-done', role: 'status' },
        icon('check', { size: 'sm', className: 'import-done__icon' }),
        h('span', { class: 'import-done__label' }, '取り込みました')),
      listRow({ label: '追加した記録', value: countLabel(result.added), numeric: true }),
      listRow({ label: '上書きした記録', value: countLabel(result.overwritten), numeric: true }),
      listRow({ label: 'スキップした記録', value: countLabel(result.skipped), numeric: true }),
      summary.issueCount > 0 ? listRow({ label: '読めなかった行', value: lineCountLabel(summary.issueCount), numeric: true }) : null,
    ].filter(Boolean);
    body.replaceChildren(listGroup({ rows, footer: notes.map((text) => h('p', {}, text)) }));
    body.scrollTop = 0;
    const doneBtn = button('完了', { variant: 'primary', block: true, onClick: () => finish('done') });
    footer.replaceChildren(doneBtn);
    focusQuietly(doneBtn);
  }

  body.append(...[countsGroup, modeGroup, issuesGroup].filter(Boolean));
  footer.append(busyNote, importBtn);
  renderMode();
  return { body, footer };
}

/**
 * 取り込んだ記録のタグ・根拠・感情のうち、選択肢に無いものを末尾に足す（design 14.6.11 ⑤）。
 * 記録はもう保存できているので、設定を保存できなかったときは結果の文を出さないだけにする（「加えました」と嘘をつかない）。
 * @returns {string} 結果に出す文（足さなかったら空）
 */
function addMissingChoices(trades) {
  try {
    const plan = planChoiceAdditions(getSetting('choices'), trades);
    if (plan.total === 0) return '';
    setSetting('choices', plan.choices);
    return choiceAddedNote(plan.added);
  } catch (e) {
    console.warn('取り込んだ記録の選択肢を足せませんでした', e);
    return '';
  }
}

/**
 * 確認シートを出して取り込む。容量不足などの書き込みの失敗は、アラートの後で確認シートを開き直す（design 14.6.9）。
 * @param {object} state sheetContent の state
 * @param {() => void} onImported
 */
async function confirmAndImport(state, onImported) {
  for (;;) {
    const result = await openSheet({
      title: 'CSVの読み込み',
      content: (finish, control) => sheetContent(state, finish, control, onImported),
    });
    if (!result || !result.failed) return; // キャンセル・完了
    await alertImportFailed(result.failed);
    if (result.failed === 'conflict') return; // 件数が古くなっているので開き直さない
  }
}

/* ---------------------------------------------------------
   入口の行
   --------------------------------------------------------- */

/**
 * 「CSVを読み込む」のまとまりを作る（「データ」の続き。見出しなし）。
 * @param {{ onImported?: () => void }} [opts] onImported … 取り込みが終わったとき（設定画面の選択肢の数を新しくする）
 * @returns {{ group: HTMLElement, dispose: () => void }}
 */
export function importGroup({ onImported = () => {} } = {}) {
  let busy = false; // 読み込み〜確認シートの間（二重に始めない）
  let alive = true;

  // 見えないファイル選択。CSV だけを選べるようにする（画像のときの「写真ライブラリ」「写真を撮る」を出さない）
  const input = h('input', { type: 'file', accept: '.csv,text/csv', hidden: true, 'aria-hidden': 'true', tabindex: '-1' });
  const row = h('button', { type: 'button', class: 'list-row export-row', onClick: () => pick() },
    h('span', { class: 'list-row__label' }, 'CSVを読み込む'));
  const group = listGroup({ rows: [row], footer: h('p', {}, ROW_NOTE) });
  group.append(input);

  /** ① 押した直後にファイル選択を開く（ここで await しない） */
  function pick() {
    if (busy) return;
    input.value = '';
    input.click();
  }

  input.addEventListener('change', () => {
    const file = input.files && input.files[0];
    input.value = ''; // 同じファイルをもう一度選べるように
    if (file && !busy) start(file);
  });

  /** ②〜⑤ */
  async function start(file) {
    busy = true;
    const timer = setTimeout(() => setBusy(row, true, '読み込み中'), BUSY_DELAY_MS);
    try {
      if (file.size >= SHOW_BUSY_FIRST_BYTES && file.size <= IMPORT_MAX_BYTES) {
        clearTimeout(timer);
        setBusy(row, true, '読み込み中');
        await nextPaint();
      }
      const prepared = await readFile(file);
      clearTimeout(timer);
      setBusy(row, false);
      if (!alive) return;
      if (prepared.error) {
        await alertImportFile(prepared.error);
        return;
      }
      await confirmAndImport({ fileName: file.name, parsed: prepared.parsed, summary: prepared.summary, overwrite: false }, onImported);
    } finally {
      clearTimeout(timer);
      setBusy(row, false);
      busy = false;
    }
  }

  return {
    group,
    dispose() {
      alive = false;
    },
  };
}

/**
 * ファイルを読み、確認シートに出す数を求める（確認シートを出す前に全部済ませる：design 14.6.12）。
 * @param {File} file
 * @returns {Promise<{ error: string } | { error: null, parsed: object, summary: object }>}
 *   error：'too-large'（I-5）／'read'（I-1）／'format'（I-2）／'encoding'（I-3）／'empty'（I-4）
 */
async function readFile(file) {
  // 大きなファイルは中身を読まずに断る（20MB を超えるものを読むと、古い iPhone ではメモリが足りなくなるおそれ）
  if (file.size > IMPORT_MAX_BYTES) return { error: 'too-large' };
  let bytes;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch (e) {
    console.error('CSVのファイルを読み込めませんでした', e);
    return { error: 'read' };
  }
  const parsed = parseImportBytes(bytes);
  if (!parsed.ok) return { error: parsed.error };
  let deviceTrades;
  try {
    deviceTrades = await getAllTrades(); // 削除済みを含む（同じ ID の記録は、削除済みでも「すでにある記録」）
  } catch (e) {
    console.error('この端末の記録を読み込めませんでした', e);
    return { error: 'read' };
  }
  return { error: null, parsed, summary: summarizeImport(parsed, deviceTrades) };
}
