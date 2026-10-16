/* =========================================================
   js/screens/settings.js
   S-06 設定。型A（タブ画面）。URL：#/settings（design.md 3.2 S-06・14.6.1・14.6.2）
   ※ 設定の「保存」を受け持つ js/settings-store.js とは役割が違う別ファイル。

   【T-15 で作った範囲】
   ・取引：1lotの通貨数（デモ／本番）。欄から離れたときに E-07 をチェックし、正しければ保存してトースト
   ・テーマ：端末に合わせる／ライト／ダーク（チェックの行）。タップした瞬間に切り替えて保存（トーストなし）。
     ブラウザのバーの色（theme-color）も一緒に切り替える（ui/theme.js）
   ・このアプリについて：バージョン
   【まだ作らないもの（担当タスク）】
   ・選択肢の各行の登録数の表示と、選択肢の編集画面の中身 … T-16（行と移動先は T-10 で作成済み）
   ・データ（CSVを書き出す・削除済みの記録も含める・記録の件数・最終書き出し）… T-25
   ・このアプリについての「データの保護」「使用量」と説明文、ホーム画面への追加方法の画面の中身 … T-29
   ・スプレッドシート同期 … Phase 2（T-40）
   ========================================================= */
import { h } from '../ui/dom.js';
import { largeTitle } from '../ui/bars.js';
import { listGroup, listRow } from '../ui/parts.js';
import { numberRow, checkRows, setGroupMessages } from '../ui/fields.js';
import { showToast } from '../ui/toast.js';
import { showAlert } from '../ui/dialog.js';
import { applyTheme } from '../ui/theme.js';
import { APP_VERSION } from '../config.js';
import { parseLotUnitSize } from '../validate.js';
import { getSetting, setSetting } from '../settings-store.js';
import { isAppError } from '../util.js';

/**
 * E-07 の画面の文言（design 14.6.2。2026-10-16 オーナー決定）。
 * fx-rules 8.2 の文言（「1以上の整数で入力してください」）に、貼り付けた「10,000」も E-07 になるため
 * 直し方が分かるよう「カンマなしで」と例を添えた形。
 */
const E07_TEXT = '1以上の整数をカンマなしで入力してください（例：10000）';

/** 1lotの通貨数の欄の下の説明文（design 14.6.1） */
const LOT_UNIT_NOTE = '業者の取引画面で1lotが何通貨か確認して入力します。変えても、保存済みの記録の損益は変わりません。';

/** 設定を保存できなかったときのアラート（design 14.7.3「設定の保存」。自動で消えない） */
function alertSettingsWriteFailed() {
  return showAlert({ title: '設定を保存できませんでした', message: '端末の空き容量が不足している可能性があります。' });
}

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
   画面
   --------------------------------------------------------- */

let lotUnit = null;

export default {
  layout: 'tab',
  tab: 'settings',
  title: '設定',

  mount(root) {
    lotUnit = lotUnitGroup();
    root.append(
      largeTitle('設定'),
      h('div', { class: 'screen__body' },
        // ① 取引
        lotUnit.group,

        // ② 選択肢（design 3.2 S-06）。URL の kind は architecture 5.1 の4種類。
        //    右側の登録数の表示と、編集画面の中身は T-16 で作る
        listGroup({
          header: '選択肢',
          rows: [
            listRow({ label: 'よく使う通貨ペア', href: '#/settings/choices/pairs' }),
            listRow({ label: 'エントリー根拠', href: '#/settings/choices/entryReasons' }),
            listRow({ label: '感情', href: '#/settings/choices/emotions' }),
            listRow({ label: 'タグ', href: '#/settings/choices/tags' }),
          ],
        }),

        // ③ テーマ
        themeGroup(),

        // ④ データ（CSV の書き出しなど）は T-25 で、この位置に足す

        // ⑥ このアプリについて（「データの保護」「使用量」と説明文は T-29 で足す）
        listGroup({
          header: 'このアプリについて',
          rows: [
            listRow({ label: 'バージョン', value: APP_VERSION, numeric: true }),
            listRow({ label: 'ホーム画面への追加方法', href: '#/settings/install' }),
          ],
        }),
      ),
    );
  },

  unmount() {
    if (lotUnit) lotUnit.commitFocused();
    lotUnit = null;
  },

  // 設定はその場で保存するので「保存していない変更」はない（誤った値は保存済みの値に戻す：design 14.6.2）
  hasUnsavedChanges() {
    return false;
  },
};
