/* =========================================================
   js/screens/settings-sync.js
   設定画面の「スプレッドシート同期」グループ（design.md 14.6.8・14.6.12。T-40）。
   settings.js が長くなりすぎないよう、このグループだけ別ファイルにした（画面そのものではなく settings.js の一部品。
   settings-data.js と同じ作り）。置き場所は「テーマ」と「データ」の間（design 14.6.8）。

   【行】
   ・Apps Script URL：縦積みの行（ラベルの下に等幅の欄。長い URL を折り返して全体を見せる。最大4行）
   ・合言葉：伏せ字の欄＋「表示／隠す」（画面を開くたびに伏せ字に戻る）
   ・接続テスト：アクセント色の文字の行。保存済みの URL・合言葉で Apps Script に ping を送る（シートには何も書かない）
   ・同期状態の行は作らない（送信〔T-41〕と同期状態の画面〔T-43〕がまだ無いため。T-43 で足す：design 14.6.8）

   【保存のタイミング（design 14.6.8。1lotの通貨数〔settings.js〕と同じ考え方）】
   ・欄から離れたときにチェック（js/sync.js の checkGasUrl・checkSyncToken）
     ・誤り … 行を赤にしてグループの下にエラー文。保存しない（誤ったまま画面を離れると、次に開いたときは保存済みの値に戻る）
     ・正しく、保存済みの値と違う … 保存してトースト「設定を保存しました」。空欄は「未設定」として保存（エラーにしない）
     ・正しく、保存済みの値と同じ … 何もしない（欄を出入りしただけで毎回トーストが出ないように）
   ・欄に入ったまま画面を離れたとき（タブを押したなど）は commitFocused で、正しい値だけ保存する

   【接続テストの結果（design 14.6.8）】
   ・グループの下に文で残す（アラートにしない：閉じると読み返せないため）。自動では消さない。
   ・URL か合言葉を変えたら消す（古い結果を新しい設定の結果と誤解しないように）。実行中に変えたら、その結果は捨てる。
   ・画面を開き直すと消える（保存しない）。

   【秘密の情報】URL・合言葉は入力欄の中にだけ出す。トースト・エラー文・console には出さない（js/sync.js の冒頭）。
   ========================================================= */
import { h } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { listGroup } from '../ui/parts.js';
import { secretRow, stackedLineRow, setGroupMessages } from '../ui/fields.js';
import { showToast } from '../ui/toast.js';
import { alertSettingsWriteFailed } from '../ui/dialog.js';
import { getSetting, setSetting } from '../settings-store.js';
import { isAppError } from '../util.js';
import { nowJst } from '../datetime.js';
import { checkGasUrl, checkSyncToken, normalizeSyncText, pingAppsScript, pingResultText } from '../sync.js';

/** グループの下の説明文（design 14.6.8）。未設定＝URL・合言葉のどちらかの保存済みの値が空 */
export const SYNC_NOTE_UNSET = 'URLと合言葉を入れると、接続テストができます。記録の控えをGoogleスプレッドシートに送ります（画像は送りません）。';
export const SYNC_NOTE_SET = '記録の控えをGoogleスプレッドシートに送ります（画像は送りません）。URLと合言葉はこの端末の中にだけ保存されます。';

/** 本物の設定の窓口（localStorage・接頭辞 fxnote:） */
const realStore = { get: getSetting, set: setSetting };

/**
 * 「スプレッドシート同期」のグループを作る。
 * @param {{ ping?: typeof pingAppsScript, now?: () => string, store?: { get: Function, set: Function }, toast?: Function }} [deps]
 *   テストで差し替えるためのもの（接続テストの送信・時刻・設定の保存場所・トースト）。テストは本物の設定（fxnote:）に触れない
 * @returns {{ group: HTMLElement, commitFocused: () => void, dispose: () => void }}
 */
export function syncGroup({ ping = pingAppsScript, now = nowJst, store = realStore, toast = showToast } = {}) {
  let alive = true;
  /** 実行中の接続テストを、画面を離れたときに打ち切るため */
  let controller = null;
  let running = false;
  /** 設定が変わるたびに1つ進める。接続テストを始めたときの値と違えば、その結果は捨てる */
  let generation = 0;
  /** 表示中の接続テストの結果（{ result, time }）。null なら出さない */
  let shown = null;

  // ---- 入力欄 ----
  const fields = [
    { key: 'gasUrl', check: checkGasUrl, error: null },
    { key: 'syncToken', check: checkSyncToken, error: null },
  ].map((f) => ({ ...f, saved: store.get(f.key) }));
  const [urlField, tokenField] = fields;

  const url = stackedLineRow({
    label: 'Apps Script URL',
    value: urlField.saved ?? '',
    placeholder: 'ここに貼り付け',
    maxRows: 4,
    inputmode: 'url',
    enterkeyhint: 'next',
    onInput: () => onFieldInput(urlField),
    onBlur: () => commit(urlField),
    // 改行キーは入れずに次の欄（合言葉）へ進む。合言葉の欄に移ると URL の欄から離れるので、チェック・保存も走る
    onEnter: () => token.input.focus(),
  });
  urlField.el = url.textarea;
  urlField.refresh = url.resize;

  const token = secretRow({
    label: '合言葉',
    value: tokenField.saved ?? '',
    placeholder: '未設定',
    enterkeyhint: 'done',
    onInput: () => onFieldInput(tokenField),
    onBlur: () => commit(tokenField),
  });
  tokenField.el = token.input;
  tokenField.refresh = token.update;
  // PC の Enter キー・iOS の「完了」で欄から離れる（1lotの通貨数と同じ）
  token.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); token.input.blur(); }
  });

  // ---- 接続テストの行（実行中は「確認中」＋回転アイコン 16px：design 14.6.8） ----
  const testLabel = h('span', { class: 'list-row__label' }, '接続テスト');
  // 回転アイコンは SVG（hidden が効かない）なので、実行中だけ行に入れる
  const testSpinner = icon('spinner', { size: 'xs', className: 'spinner__icon' });
  const testRow = h('button', { type: 'button', class: 'list-row action-row sync-test', onClick: () => runTest() }, testLabel);

  // ---- グループの下：成功の文（✓）・説明文・読み上げ用の知らせ ----
  const okLine = h('p', { class: 'sync-result' },
    icon('check', { size: 'xs', className: 'sync-result__icon' }),
    h('span', { class: 'sync-result__text num' }, ''));
  const note = h('p', { class: 'sync-note' }, '');
  // 結果の文は作り直すので、読み上げは変わらない場所（role="status"）で知らせる
  const live = h('p', { class: 'visually-hidden', role: 'status' }, '');

  const group = listGroup({ header: 'スプレッドシート同期', rows: [url.row, token.row, testRow], footer: [note, live] });

  /** 保存済みの URL・合言葉がそろっているか */
  const configured = () => Boolean(urlField.saved && tokenField.saved);

  /** グループの下の文・行の赤・接続テストを押せるかを、今の状態に合わせて描き直す */
  function render() {
    const messages = fields.filter((f) => f.error).map((f) => ({ type: 'error', text: f.error, target: f.el }));
    if (shown && shown.result !== 'ok') {
      // 失敗の結果は赤の ⚠＋文。合言葉が違う（T-2）ときは合言葉の行も赤にする（design 14.6.8）
      messages.push({ type: 'error', text: pingResultText(shown.result), target: shown.result === 'badToken' ? token.input : undefined });
    }
    okLine.remove();
    setGroupMessages(group, messages); // 入力のエラー文 → 失敗の結果 の順で、説明文の上に入る
    if (shown && shown.result === 'ok') {
      okLine.querySelector('.sync-result__text').textContent = pingResultText('ok', shown.time);
      note.before(okLine);
    }
    note.textContent = configured() ? SYNC_NOTE_SET : SYNC_NOTE_UNSET;
    // 押せないとき：保存済みの値が空・どちらかの欄がエラー・実行中（design 14.6.8）
    testRow.disabled = !configured() || fields.some((f) => f.error) || running;
  }

  /** 表示中の結果を消し、実行中のテストの結果も捨てる（URL・合言葉が変わったとき） */
  function discardResult() {
    generation += 1;
    if (shown) {
      shown = null;
      live.textContent = '';
    }
  }

  /**
   * 入力中：保存済みの値と違う文字になったら、表示中の結果を消し、実行中のテストの結果も捨てる
   * （欄の文字と違う設定の結果を見せないため）。エラー文は欄から離れるまでそのまま（入力中は責めない）
   */
  function onFieldInput(f) {
    if (normalizeSyncText(f.el.value) === (f.saved ?? '')) return;
    const had = Boolean(shown);
    discardResult();
    if (had) render();
  }

  /** 欄から離れたときのチェックと保存（同じ値で2回呼ばれても、2回目は何もしない） */
  function commit(f) {
    const r = f.check(f.el.value);
    f.error = r.ok ? null : r.message;
    if (!r.ok) {
      render();
      return;
    }
    if (r.value !== f.saved) {
      try {
        f.saved = store.set(f.key, r.value);
      } catch (e) {
        if (!isAppError(e, 'SETTINGS_WRITE')) throw e;
        // 保存できなかったので、画面も保存済みの値に戻す。e には値が入らない（settings-store.js が中身を出さない）
        console.error('スプレッドシート同期の設定を保存できませんでした', e);
        f.el.value = f.saved ?? '';
        f.refresh();
        render();
        alertSettingsWriteFailed();
        return;
      }
      discardResult();
      toast('設定を保存しました');
    }
    // 前後の空白を取り除いた、保存した形に見た目をそろえる
    if (f.el.value !== (f.saved ?? '')) {
      f.el.value = f.saved ?? '';
      f.refresh();
    }
    render();
  }

  /** 接続テストの行の「確認中」の表示を付け外しする */
  function setTesting(on) {
    if (on) testRow.prepend(testSpinner);
    else testSpinner.remove();
    testLabel.textContent = on ? '確認中' : '接続テスト';
    testRow.classList.toggle('is-busy', on);
    if (on) testRow.setAttribute('aria-busy', 'true');
    else testRow.removeAttribute('aria-busy');
  }

  /** 接続テスト：保存済みの URL・合言葉で ping を送り、結果をグループの下に出す */
  async function runTest() {
    if (running || !configured() || fields.some((f) => f.error)) return;
    running = true;
    discardResult();
    const started = generation;
    setTesting(true);
    render();
    controller = new AbortController();
    const out = await ping({ url: urlField.saved, token: tokenField.saved, signal: controller.signal });
    controller = null;
    running = false;
    if (!alive) return;
    setTesting(false);
    // 実行中に URL・合言葉が変わっていたら、この結果は古い設定のものなので捨てる
    if (started === generation && out.result !== 'aborted') {
      shown = { result: out.result, time: now().slice(11, 16) }; // 確かめた時刻（時:分）
      live.textContent = pingResultText(shown.result, shown.time);
    }
    render();
  }

  render();

  return {
    group,
    /**
     * 欄に入ったまま画面を離れたとき用（タブを押したときなど、端末によっては blur が届く前に画面が消えるため）。
     * 正しい値なら保存し、誤った値なら何もしない（＝保存済みの値に戻る）。
     */
    commitFocused() {
      const f = fields.find((x) => x.el === document.activeElement);
      if (f && f.check(f.el.value).ok) commit(f);
    },
    /** 画面を離れたとき：実行中の接続テストを打ち切る */
    dispose() {
      alive = false;
      if (controller) controller.abort();
    },
  };
}
