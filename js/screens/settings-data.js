/* =========================================================
   js/screens/settings-data.js
   設定画面の「データ」グループ：CSVの書き出し（design.md 14.6.1・14.6.2・14.6.5。T-25）。
   settings.js が長くなりすぎないよう、このグループだけ別ファイルにした（画面そのものではなく settings.js の一部品）。

   【流れ（design 14.6.5）】
   ① 「CSVを書き出す」… 記録を読んで CSV を作る（通常は一瞬。0.3秒以上かかるときだけ行の文字を「作成中」にする）
   ② 方式の振り分け（csv.js の canUseShareSheet）
      ・iPhone など（共有シートを使える・タッチ端末）… 確認シート（ファイル名・件数）→［保存する］で共有シートを開く
        2段階にする理由：共有シートは「ボタンを押した直後」にしか開けないため、CSV を先に作っておいてボタンで即座に開く。
        共有シートを閉じた（キャンセル）ときは確認シートに戻り、何も記録しない
      ・PC など … 1タップでダウンロード
   ③ 保存・送信が終わったら（共有の成功、またはダウンロードの開始）lastExportAt を記録してトースト。
      CSV を作っただけでは記録しない（「最後のバックアップから○日」の案内を正しく出すため）
   失敗はアラート（design 14.7.3）。キャンセルは失敗として扱わない。
   【T-29】①〜③を exportCsv() に切り出した（ホーム画面への追加の画面の「CSVを書き出す」でも同じ動きにするため：design 14.6.6）。
   【T-44】「CSVを読み込む」は見出しのない次のまとまり（screens/settings-import.js）。取り込みの後に「記録の件数」を新しくするため、
   記録の変更通知（trades-changed）で件数を読み直す。

   【「削除済みの記録も含める」を保存しない理由】
   requirements 6.3 に対応する設定キーがなく、docs を変えずに足すとキー名の取り決め（settings-store.js）から外れるため、
   この画面を開いている間だけ覚える（開き直すとオフ＝既定の「含めない」に戻る）。うっかりオンのまま次回も含めてしまうのを避ける意味もある。
   ========================================================= */
import { h } from '../ui/dom.js';
import { listGroup, listRow, button, setBusy } from '../ui/parts.js';
import { switchRow } from '../ui/fields.js';
import { openSheet } from '../ui/sheet.js';
import { showToast } from '../ui/toast.js';
import { alertCsvCreateFailed, alertCsvSaveFailed } from '../ui/dialog.js';
import { getAllTrades, TRADES_CHANGED } from '../trades.js';
import { on } from '../events.js';
import { getSetting, setSetting } from '../settings-store.js';
import { nowJst } from '../datetime.js';
import {
  prepareCsv, createCsvFile, canUseShareSheet, shareCsvFile, downloadCsvFile,
  recordCountLabel, exportCountLabel, exportNote, countTrades,
} from '../csv.js';

/** 「作成中」を出すまでの待ち時間（ミリ秒）。すぐ終わるときに文字がちらつかないように（design 14.6.5） */
const BUSY_DELAY_MS = 300;

/** 確認シートの説明文（design 14.6.5）。共有シートには「保存」という言葉がなく、初めての人が探せないため */
const SHARE_NOTE = '次の画面で「"ファイル"に保存」を選ぶと、iPhoneの「ファイル」アプリに保存できます。';

/**
 * 確認シートの中身（ファイル名・件数・削除済みの扱い・［保存する］）。
 * @param {ReturnType<typeof prepareCsv>} prepared
 * @param {File} file
 * @param {(value: any) => void} finish シートを閉じる。'saved'（共有できた）／'failed'（共有を開けなかった）
 */
function sheetContent(prepared, file, finish) {
  const counts = { live: prepared.live, deleted: prepared.deleted };
  const body = listGroup({
    rows: [
      // ファイル名は等幅・長ければ折り返す（design 14.6.5）
      h('div', { class: 'list-row export-file' },
        h('span', { class: 'export-file__label' }, 'ファイル名'),
        h('span', { class: 'export-file__name' }, file.name)),
      listRow({ label: '記録', value: exportCountLabel(counts, prepared.includeDeleted), numeric: true }),
      // 設定のスイッチの状態を見せるだけ（ここでは変えない）
      listRow({ label: '削除済みの記録', value: prepared.includeDeleted ? '含める' : '含めない' }),
    ],
    footer: h('p', {}, SHARE_NOTE),
  });

  const saveBtn = button('保存する', {
    variant: 'primary',
    block: true,
    onClick: async () => {
      // 連打で共有シートを二重に開かない（二重に開くと InvalidStateError になる）
      saveBtn.disabled = true;
      let outcome;
      try {
        // ボタンを押した直後にここで共有シートを開く（await より前に navigator.share が呼ばれる）
        outcome = await shareCsvFile(file);
      } catch (e) {
        console.error('CSVを共有できませんでした', e);
        finish('failed');
        return;
      }
      if (outcome === 'shared') finish('saved');
      else saveBtn.disabled = false; // 共有シートを閉じただけ：このシートに戻り、もう一度押せる
    },
  });

  return { body, footer: saveBtn };
}

/**
 * 確認シートを出して、共有シートで保存してもらう。
 * 共有を開けなかったとき（失敗）はアラートを出し、閉じたあと確認シートを開き直す
 * （アラートを重ねるとシートが閉じてしまうため。文言は design のとおり「もう一度『保存する』を押してください」）。
 * @returns {Promise<boolean>} 共有が終わったら true、やめた（キャンセル）なら false
 */
async function saveWithShareSheet(prepared, file) {
  for (;;) {
    const result = await openSheet({
      title: 'CSVの書き出し',
      content: (finish) => sheetContent(prepared, file, finish),
    });
    if (result === 'saved') return true;
    if (result !== 'failed') return false;
    await alertCsvSaveFailed();
  }
}

/**
 * CSV を作って保存・送信するまでの一連の流れ（上の【流れ】①〜③）。
 * 設定画面の「CSVを書き出す」と、ホーム画面への追加の画面（install-guide.js）の「CSVを書き出す」の両方から使う
 * （design 14.6.6「設定の『CSVを書き出す』と同じ動き」。同じ処理を2か所に書くと、片方だけ直し忘れるため）。
 * 二重に始めないための見張り（busy）は呼び出し側が持つ。
 * @param {{ includeDeleted: boolean, button: HTMLButtonElement, onCounts?: (counts: {live: number, deleted: number}) => void }} opts
 *   button   … 0.3秒以上かかるときに「作成中」にするボタン
 *   onCounts … 記録を読み直したときの件数（画面の件数表示を最新にするため）
 * @returns {Promise<boolean>} 保存・送信まで終わったら true（やめた・失敗・0件は false）
 */
export async function exportCsv({ includeDeleted, button: btn, onCounts = () => {} }) {
  const timer = setTimeout(() => setBusy(btn, true, '作成中'), BUSY_DELAY_MS);
  const stopBusy = () => {
    clearTimeout(timer);
    setBusy(btn, false);
  };

  let prepared;
  let file;
  try {
    // 開いている間に記録が増減していても、書き出すときに読み直した最新の記録を使う
    const trades = await getAllTrades();
    onCounts(countTrades(trades));
    prepared = prepareCsv(trades, { includeDeleted });
    file = createCsvFile(prepared.text, prepared.fileName);
  } catch (e) {
    console.error('CSVを作成できませんでした', e);
    stopBusy();
    await alertCsvCreateFailed();
    return false;
  }
  stopBusy();
  if (prepared.rowCount === 0) return false; // 直前に記録が消えていた：呼び出し側が件数から案内文に切り替える

  let saved;
  if (canUseShareSheet(file)) {
    saved = await saveWithShareSheet(prepared, file);
  } else {
    try {
      downloadCsvFile(file);
      saved = true;
    } catch (e) {
      console.error('CSVをダウンロードできませんでした', e);
      await alertCsvSaveFailed('ファイルを保存できませんでした。もう一度試してください。');
      saved = false;
    }
  }
  if (saved) afterSaved();
  return saved;
}

/** 保存・送信が終わったときの後始末：最終書き出しを記録し、トーストを出す（design 14.6.5） */
function afterSaved() {
  try {
    setSetting('lastExportAt', nowJst());
  } catch (e) {
    // ファイルはもう保存できている。日時が記録できなかっただけなので、利用者には知らせず記録だけ残す
    console.warn('最終書き出し日時を保存できませんでした', e);
  }
  showToast('CSVを書き出しました');
}

/**
 * 「データ」グループを作る。
 * @returns {{ group: HTMLElement, dispose: () => void }} dispose は画面を離れるとき（書き出しの途中でも画面の更新だけ止める）
 */
export function dataGroup() {
  let counts = null;          // { live, deleted }。読み込めるまで null
  let includeDeleted = false; // 削除済みの記録も含めるか（この画面を開いている間だけ覚える）
  let busy = false;           // 書き出しの途中（二重に始めない）
  let alive = true;

  const exportBtn = h('button', { type: 'button', class: 'list-row export-row', onClick: () => startExport() },
    h('span', { class: 'list-row__label' }, 'CSVを書き出す'));
  const countRow = listRow({ label: '記録の件数', value: '—', numeric: true });
  const countValue = countRow.querySelector('.list-row__value');
  const note = h('p', {}, '');

  const { row: switchEl } = switchRow({
    label: '削除済みの記録も含める',
    name: 'exportIncludeDeleted',
    checked: false,
    onChange: (e) => {
      includeDeleted = e.target.checked;
      render();
    },
  });

  const group = listGroup({ header: 'データ', rows: [exportBtn, switchEl, countRow], footer: note });

  /** 書き出せる記録の数（まだ読み込めていないときは null） */
  const exportableCount = () => (counts ? (includeDeleted ? counts.live + counts.deleted : counts.live) : null);

  /** 件数・説明文・ボタンの有効/無効を今の状態に合わせる */
  function render() {
    if (!alive) return;
    const exportable = exportableCount();
    countValue.textContent = counts ? recordCountLabel(counts) : '—';
    note.textContent = exportNote({ exportable, lastExportAt: getSetting('lastExportAt') });
    // 記録が0件のときは押せなくする（design 14.6.5）。作成中は setBusy が押せなくしている
    if (!busy) exportBtn.disabled = exportable === 0;
  }

  async function startExport() {
    if (busy) return;
    busy = true; // 保存が終わるまで二重に始めない（確認シートの間も）
    try {
      // 読み直した件数はすぐ画面に反映する（直前に記録が消えていたときは、ここで案内文に切り替わる）
      await exportCsv({ includeDeleted, button: exportBtn, onCounts: (c) => { counts = c; render(); } });
    } finally {
      busy = false;
      render(); // 最終書き出しの日時・ボタンの有効/無効を今の状態に
    }
  }

  // 件数は画面を開いた後に読む（読み込み中も設定画面は操作できる）。読めなくても「—」のまま。書き出しを押すと改めて読み、失敗ならアラート
  const loadCounts = () => getAllTrades().then((trades) => {
    counts = countTrades(trades);
    render();
  }).catch((e) => {
    console.error('記録の件数を読み込めませんでした', e);
  });
  loadCounts();
  render();
  // 設定画面を開いたまま記録が増えたとき（CSV の読み込み：T-44。design 14.6.9「閉じたら『記録の件数』を新しい件数に」）は読み直す
  const stopWatching = on(TRADES_CHANGED, () => { if (alive) loadCounts(); });

  return {
    group,
    dispose() {
      alive = false;
      stopWatching();
    },
  };
}
