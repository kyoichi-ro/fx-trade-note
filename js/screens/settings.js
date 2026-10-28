/* =========================================================
   js/screens/settings.js
   S-06 設定。型A（タブ画面）。URL：#/settings（design.md 3.2 S-06・14.6.1・14.6.2）
   ※ 設定の「保存」を受け持つ js/settings-store.js とは役割が違う別ファイル。

   【T-15 で作った範囲】
   ・取引：1lotの通貨数（デモ／本番）。欄から離れたときに E-07 をチェックし、正しければ保存してトースト
   ・テーマ：端末に合わせる／ライト／ダーク（チェックの行）。タップした瞬間に切り替えて保存（トーストなし）。
     ブラウザのバーの色（theme-color）も一緒に切り替える（ui/theme.js）
   ・このアプリについて：バージョン
   【T-16 で足した範囲】
   ・選択肢（よく使う通貨ペア・エントリー根拠・感情・タグ）の各行の右に登録数を表示（編集画面の中身は screens/choices.js）
   【T-25 で足した範囲】
   ・データ：CSVを書き出す・削除済みの記録も含める・記録の件数・最終書き出し（中身は screens/settings-data.js）
   【T-29 で足した範囲】
   ・このアプリについて：データの保護（有効／ブラウザ任せ）・使用量と、説明文「記録はこの端末の中だけに保存されています。…」
     （判定と文言は js/data-protection.js。ホーム画面への追加方法の画面の中身は screens/install-guide.js）
   【T-28 で足した範囲】
   ・このアプリについて：新しい版が待機中のとき、「バージョン」の行の下に「新しいバージョンに更新」（アクセント色の文字）。
     押すと一覧のお知らせ行の［更新］と同じ（js/sw-update.js の applyUpdate：切り替えて再読み込み）。design 14.6.1
     2026-10-26（オーナー要望）：待機中でないときも「最新のバージョンを確認」として同じ行をいつも出し、押すと今すぐ確かめる
     （checkForUpdateNow。見つかれば「新しいバージョンに更新」に変わる。最新ならトースト「最新のバージョンです」）
   【T-44 で足した範囲】
   ・データの続き（見出しのないまとまり）：CSVを読み込む（中身は screens/settings-import.js）。取り込んだあとは、
     「記録の件数」（settings-data.js が記録の変更通知で読み直す）と選択肢の登録数（足した選択肢の分）を新しくする
   【T-40 で足した範囲】
   ・スプレッドシート同期（テーマとデータの間）：Apps Script URL・合言葉・接続テスト（中身は screens/settings-sync.js）
   【まだ作らないもの（担当タスク）】
   ・スプレッドシート同期の「同期状態 ›」の行 … T-43（#/settings/sync と一緒に足す：design 14.6.8）
   ========================================================= */
import { h } from '../ui/dom.js';
import { largeTitle } from '../ui/bars.js';
import { listGroup, listRow } from '../ui/parts.js';
import { numberRow, checkRows, setGroupMessages } from '../ui/fields.js';
import { showToast } from '../ui/toast.js';
import { alertSettingsWriteFailed } from '../ui/dialog.js';
import { applyTheme } from '../ui/theme.js';
import { APP_VERSION } from '../config.js';
import { CHOICE_KINDS, CHOICE_KIND_LABELS } from '../master.js';
import { parseLotUnitSize } from '../validate.js';
import { getSetting, setSetting } from '../settings-store.js';
import { isAppError } from '../util.js';
import { dataGroup } from './settings-data.js';
import { importGroup } from './settings-import.js';
import { syncGroup } from './settings-sync.js';
import { readPersisted, readUsage, protectionLabel, protectionNote, formatUsage } from '../data-protection.js';
import { isUpdateWaiting, applyUpdate, checkForUpdateNow, UPDATE_READY } from '../sw-update.js';
import { on } from '../events.js';

/**
 * E-07 の画面の文言（design 14.6.2。2026-10-16 オーナー決定）。
 * fx-rules 8.2 の文言（「1以上の整数で入力してください」）に、貼り付けた「10,000」も E-07 になるため
 * 直し方が分かるよう「カンマなしで」と例を添えた形。
 */
const E07_TEXT = '1以上の整数をカンマなしで入力してください（例：10000）';

/** 1lotの通貨数の欄の下の説明文（design 14.6.1） */
const LOT_UNIT_NOTE = '業者の取引画面で1lotが何通貨か確認して入力します。変えても、保存済みの記録の損益は変わりません。';

/** 3桁区切りの表示（例 10000 → '10,000'）。欄から離れているときだけこの形で見せる（design 14.6.2） */
function withCommas(n) {
  return n.toLocaleString('ja-JP');
}

/* ---------------------------------------------------------
   取引：1lotの通貨数（デモ／本番）
   --------------------------------------------------------- */

/**
 * 1lotの通貨数のグループを作る。
 * 流れ（design 14.6.2）：
 *  ① 欄に入ったら（focus）カンマを外した数字にする（そのまま書き換えられるように）
 *  ② 欄から離れたら（blur）validate.js の parseLotUnitSize で E-07 をチェック
 *     ・誤り（空欄を含む）… 行を赤にし、グループの下にエラー文。保存はしない
 *     ・正しく、保存済みの値と違う … 保存してトースト「設定を保存しました」
 *     ・正しく、保存済みの値と同じ … 保存もトーストもしない（欄を出入りしただけで毎回トーストが出ないように）
 *  ③ 誤ったまま画面を離れたら、保存済みの値に戻す（保存していないので、次に開くと保存済みの値が出る）
 * @returns {{ group: HTMLElement, commitFocused: () => void }}
 */
function lotUnitGroup() {
  const fields = [
    { key: 'lotUnitSize.demo', label: '1lotの通貨数（デモ）' },
    { key: 'lotUnitSize.real', label: '1lotの通貨数（本番）' },
  ].map((f) => ({ ...f, saved: getSetting(f.key), hasError: false, input: null }));

  let group = null;

  /** エラーの欄があれば、同じ文を1行だけ出して、誤っている行すべてを赤にする（デモ・本番が両方誤りでも文は重ねない） */
  const renderMessages = () => {
    const targets = fields.filter((f) => f.hasError).map((f) => f.input);
    setGroupMessages(group, targets.length ? [{ type: 'error', text: E07_TEXT, targets }] : []);
  };

  /** 欄から離れたときのチェックと保存（同じ値で2回呼ばれても、2回目は何もしない） */
  const commit = (f) => {
    const r = parseLotUnitSize(f.input.value);
    // 空欄も誤りとして扱う（1lotの通貨数は損益の計算に必ず要るため、空のまま保存はしない）
    f.hasError = !r.ok || r.empty === true;
    renderMessages();
    if (f.hasError) return;

    if (r.value !== f.saved) {
      try {
        f.saved = setSetting(f.key, r.value);
      } catch (e) {
        if (!isAppError(e, 'SETTINGS_WRITE')) throw e;
        // 保存できなかったので、画面も保存済みの値に戻す（保存されていない値を、保存されたように見せない）
        console.error('1lotの通貨数を保存できませんでした', e);
        f.input.value = withCommas(f.saved);
        alertSettingsWriteFailed();
        return;
      }
      // 過去の記録が変わらないことは、グループの下の説明文で常に示しているのでトーストでは繰り返さない（design 14.6.2）
      showToast('設定を保存しました');
    }
    f.input.value = withCommas(f.saved);
  };

  for (const f of fields) {
    const { row, input } = numberRow({
      label: f.label,
      name: f.key,
      value: withCommas(f.saved),
      unit: '通貨',
      // 整数だけなので小数点のない数字キーボード。数字キーボードには「完了」キーがないため、
      // iOS ではキーボードの上のバーの「完了」で閉じる（design 8.4・14.6.2）
      inputmode: 'numeric',
      enterkeyhint: 'done',
      onBlur: () => commit(f),
    });
    // ① 欄に入ったらカンマを外す。エラー中の文字（例「10,000」）は直しやすいよう、そのまま残す
    input.addEventListener('focus', () => {
      if (!f.hasError) input.value = String(f.saved);
    });
    // PC の Enter キーでも「欄から離れた」ことにする（iOS の「完了」と同じ動きにそろえる）
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    });
    f.input = input;
    f.row = row;
  }

  group = listGroup({ header: '取引', rows: fields.map((f) => f.row), footer: h('p', {}, LOT_UNIT_NOTE) });

  return {
    group,
    /**
     * 欄に入ったまま画面を離れたとき用（タブを押したときなど、端末によっては blur が届く前に画面が消えるため）。
     * 正しい値なら保存し、誤った値なら何もしない（＝保存済みの値に戻る）。
     */
    commitFocused() {
      const f = fields.find((x) => x.input === document.activeElement);
      if (f && parseLotUnitSize(f.input.value).ok) commit(f);
    },
  };
}

/* ---------------------------------------------------------
   テーマ（端末に合わせる／ライト／ダーク）
   --------------------------------------------------------- */

function themeGroup() {
  let saved = getSetting('theme');
  const rows = checkRows({
    name: 'theme',
    value: saved,
    options: [
      { value: 'auto', label: '端末に合わせる' },
      { value: 'light', label: 'ライト' },
      { value: 'dark', label: 'ダーク' },
    ],
    // タップした瞬間に切り替えて保存（トーストなし：画面の色が変わるので分かる。design 14.6.2）
    onChange: (value) => {
      applyTheme(value);
      try {
        saved = setSetting('theme', value);
      } catch (e) {
        if (!isAppError(e, 'SETTINGS_WRITE')) throw e;
        // 保存できなければ、見た目も選択も保存済みのテーマに戻す（次に開いたときと食い違わないように）
        console.error('テーマを保存できませんでした', e);
        applyTheme(saved);
        rows.setValue(saved);
        alertSettingsWriteFailed();
      }
    },
  });
  return listGroup({ header: 'テーマ', rows: rows.rows });
}

/* ---------------------------------------------------------
   選択肢の登録数（design 14.6.1：「よく使う通貨ペア 6 ›」）
   --------------------------------------------------------- */

/** その種類の登録数。通貨ペアは favoritePairs、根拠・感情・タグは choices の各配列 */
function choiceCount(kind) {
  return kind === 'pairs' ? getSetting('favoritePairs').length : getSetting('choices')[kind].length;
}

/* ---------------------------------------------------------
   このアプリについて（design 14.6.1・14.6.2。T-29 で「データの保護」「使用量」と説明文を足した）
   --------------------------------------------------------- */

/**
 * 「このアプリについて」のグループを作る。
 * ・データの保護：navigator.storage.persisted() が true なら「有効」、false なら「ブラウザ任せ」。機能がない環境では行を出さない
 * ・使用量：navigator.storage.estimate() の使用量。取得できない環境では行を出さない
 * ・下の説明文：「記録はこの端末の中だけに保存されています。…」。「ブラウザ任せ」のときは先頭に注意を足す
 * どちらもブラウザに問い合わせる（待ちが入る）ので、行は隠した状態で作り、答えが届いたら値を入れて見せる
 * （画面を出すのを待たせないため。答えは一瞬で返るので、行が後から現れてもほとんど目立たない）。
 * ここでは persist()（保護を頼む）は呼ばない。頼むのは起動時と記録の保存直後だけ（architecture 12.5「繰り返し求めない」）。
 * @returns {{ group: HTMLElement, dispose: () => void }}
 */
function aboutGroup() {
  let alive = true;
  const protectionRow = listRow({ label: 'データの保護', value: '' });
  const usageRow = listRow({ label: '使用量', value: '', numeric: true });
  protectionRow.hidden = true;
  usageRow.hidden = true;
  const note = h('p', {}, protectionNote(null));

  // バージョンの行の下の1行（いつも出す）。
  // ・新しい版が待機中なら「新しいバージョンに更新」：押すと切り替えて再読み込み。設定を開いている間に見つかったときも切り替わる（UPDATE_READY）。
  //   設定の画面には入力途中の内容がない（値はその場で保存済み）ので、押したらすぐ再読み込みしてよい
  // ・それ以外は「最新のバージョンを確認」：押すと今すぐ確かめる（2026-10-26 オーナー要望。自動の確認は前面に戻ったとき1時間おき）
  const updateLabel = h('span', { class: 'list-row__label' }, '');
  const updateRow = h('button', { type: 'button', class: 'list-row action-row', onClick: () => onUpdateRow() }, updateLabel);
  let checking = false;
  const showWaiting = (waiting) => {
    updateLabel.textContent = waiting ? '新しいバージョンに更新' : '最新のバージョンを確認';
    updateRow.dataset.waiting = waiting ? '1' : '';
  };
  const onUpdateRow = async () => {
    if (updateRow.dataset.waiting) {
      applyUpdate();
      return;
    }
    if (checking) return;
    checking = true;
    updateRow.disabled = true;
    updateLabel.textContent = '確認しています…';
    const result = await checkForUpdateNow();
    checking = false;
    if (!alive) return;
    updateRow.disabled = false;
    showWaiting(result === 'waiting');
    if (result === 'latest') showToast('最新のバージョンです');
    else if (result === 'offline') showToast('確認できませんでした。電波のある場所でもう一度試してください', { iconName: 'warning' });
    else if (result === 'unavailable') showToast('このブラウザでは確認できません', { iconName: 'warning' });
  };
  showWaiting(isUpdateWaiting());
  const stopUpdateWatch = on(UPDATE_READY, () => { if (!checking) showWaiting(true); });

  const group = listGroup({
    header: 'このアプリについて',
    rows: [
      listRow({ label: 'バージョン', value: APP_VERSION, numeric: true }),
      updateRow,
      protectionRow,
      usageRow,
      listRow({ label: 'ホーム画面への追加方法', href: '#/settings/install' }),
    ],
    footer: note,
  });

  /** 行に値を入れて見せる。値が null（機能がない・読めない）なら隠したまま */
  const fill = (row, text) => {
    if (!alive || text === null) return;
    row.querySelector('.list-row__value').textContent = text;
    row.hidden = false;
  };

  readPersisted().then((persisted) => {
    fill(protectionRow, protectionLabel(persisted));
    if (alive) note.textContent = protectionNote(persisted);
  });
  readUsage().then((bytes) => fill(usageRow, formatUsage(bytes)));

  return {
    group,
    dispose() {
      alive = false;
      stopUpdateWatch();
    },
  };
}

/* ---------------------------------------------------------
   画面
   --------------------------------------------------------- */

/**
 * 「選択肢」のグループ。CSV の読み込みで選択肢が足されたとき（T-44）に登録数を書き直せるよう、値の場所を覚えておく。
 * @returns {{ group: HTMLElement, refresh: () => void }}
 */
function choicesGroup() {
  const rows = CHOICE_KINDS.map((kind) => ({
    kind,
    row: listRow({
      label: CHOICE_KIND_LABELS[kind],
      value: String(choiceCount(kind)),
      numeric: true,
      href: `#/settings/choices/${kind}`,
    }),
  }));
  return {
    group: listGroup({ header: '選択肢', rows: rows.map((r) => r.row) }),
    refresh() {
      for (const { kind, row } of rows) row.querySelector('.list-row__value').textContent = String(choiceCount(kind));
    },
  };
}

let lotUnit = null;
let sync = null;
let data = null;
let importer = null;
let about = null;

export default {
  layout: 'tab',
  tab: 'settings',
  title: '設定',

  mount(root) {
    lotUnit = lotUnitGroup();
    const choices = choicesGroup();
    sync = syncGroup();
    data = dataGroup();
    importer = importGroup({ onImported: () => choices.refresh() });
    about = aboutGroup();
    root.append(
      largeTitle('設定'),
      h('div', { class: 'screen__body' },
        // ① 取引
        lotUnit.group,

        // ② 選択肢（design 3.2 S-06）。URL の kind は architecture 5.1 の4種類。右に登録数（灰）と ›（design 14.6.1）。
        //    画面を開くたびに作り直す（mount）ので、編集画面から戻ると最新の数になる
        choices.group,

        // ③ テーマ
        themeGroup(),

        // ④ スプレッドシート同期（T-40。design 14.6.8：テーマとデータの間。自動で控えを送る仕組みを、手動の CSV より上に置く）
        sync.group,

        // ⑤ データ（CSV の書き出し：T-25。design 14.6.1 の並び＝スプレッドシート同期の次、「このアプリについて」の前）
        data.group,
        // ⑥ データの続き：CSVを読み込む（T-44。design 14.6.9：見出しのない2つ目のまとまり）
        importer.group,

        // ⑦ このアプリについて（バージョン・データの保護・使用量・ホーム画面への追加方法と、データ保護の説明文）
        about.group,
      ),
    );
  },

  unmount() {
    if (lotUnit) lotUnit.commitFocused();
    lotUnit = null;
    if (sync) {
      sync.commitFocused();
      sync.dispose();
    }
    sync = null;
    if (data) data.dispose();
    data = null;
    if (importer) importer.dispose();
    importer = null;
    if (about) about.dispose();
    about = null;
  },

  // 設定はその場で保存するので「保存していない変更」はない（誤った値は保存済みの値に戻す：design 14.6.2）
  hasUnsavedChanges() {
    return false;
  },
};
