/* =========================================================
   tests/components.js
   共通部品の確認用ページ（tests/components.html）。design.md 9章の部品を、js/ui/ の本物の部品で並べる。
   ・ライト/ダークは上の切り替えで変えられる（保存はしない。アプリのテーマ設定には触れない）。
   ・トーストの位置は「画面の型」の切り替えで、タブ画面（新規エントリーボタンあり／なし）・入力画面を再現できる。
   ・文字は ui/dom.js の h() でだけ入れる（innerHTML は使わない：architecture 14.1）。
   ========================================================= */
import { h, clear } from '../js/ui/dom.js';
import { icon, ICON_NAMES } from '../js/ui/icons.js';
import {
  button, iconButton, setBusy, badge, listGroup, listRow, dangerRow, emptyState, spinner, showLoadingAfter,
} from '../js/ui/parts.js';
import {
  numberRow, textRow, textareaRow, dateTimeRow, switchRow, segment, sideSegment, accountSegment, chips, setGroupMessages,
} from '../js/ui/fields.js';
import { showToast, hideToast } from '../js/ui/toast.js';
import { actionSheet, confirmAction, showAlert } from '../js/ui/dialog.js';
import { createNotice, renderNotices, showAppNotice, hideAppNotice } from '../js/ui/notice.js';
import { largeTitle, navbar, backButton, textButton, actionBar, newEntryButton } from '../js/ui/bars.js';
import { startKeyboardWatch, startInputModalityWatch } from '../js/ui/keyboard.js';

const root = document.getElementById('app');

/** 部品の種類ごとの大見出し */
const heading = (text) => h('h2', { class: 'c-heading' }, text);
/** グループの外に部品を並べる台 */
const stage = (...children) => h('div', { class: 'c-stage' }, children);
/** 操作の結果を出す欄 */
const resultLine = () => h('p', { class: 'c-result', 'aria-live': 'polite' }, '結果：—');

/* ---------------------------------------------------------
   表示の切り替え（テーマ・画面の型）
   --------------------------------------------------------- */
function controls() {
  // URL の ?theme=light / ?theme=dark でも最初のテーマを選べる（画面写真を自動で撮って見比べるときに使う）
  const q = new URLSearchParams(location.search).get('theme');
  if (q === 'light' || q === 'dark') document.documentElement.dataset.theme = q;
  // テーマ：<html data-theme> を付け外しするだけ（design 12章の仕組み）。localStorage には保存しない
  const theme = segment({
    name: 'theme', label: 'テーマ', value: document.documentElement.dataset.theme || 'auto',
    options: [{ value: 'auto', label: '端末' }, { value: 'light', label: 'ライト' }, { value: 'dark', label: 'ダーク' }],
    onChange: (v) => {
      if (v === 'auto') delete document.documentElement.dataset.theme;
      else document.documentElement.dataset.theme = v;
    },
  });

  // 画面の型：トーストの位置（design 9.6・14.7.5）を確かめるため、新規エントリーボタン・下部操作バーを出し入れする
  let fixedParts = [];
  const applyLayout = (v) => {
    for (const el of fixedParts) el.remove();
    fixedParts = [];
    document.body.dataset.layout = v === 'form' ? 'form' : 'tab';
    if (v === 'fab') fixedParts = [newEntryButton('#')];
    if (v === 'form') fixedParts = [actionBar(button('本番で保存', { variant: 'primary', onClick: () => showToast('保存しました') }))];
    root.append(...fixedParts);
  };
  const layout = segment({
    name: 'layout', label: '画面の型', value: 'tab',
    options: [{ value: 'tab', label: 'タブ画面' }, { value: 'fab', label: '一覧' }, { value: 'form', label: '入力画面' }],
    onChange: applyLayout,
  });

  return listGroup({
    header: '表示の切り替え（この確認用ページだけの操作）',
    rows: [h('div', { class: 'field-row' }, theme.el), h('div', { class: 'field-row' }, layout.el)],
    footer: '画面の型を変えると、トーストの出る位置（タブバーの上／新規エントリーボタンの上／下部操作バーの上）が変わります。「一覧」は右下に新規エントリーボタン、「入力画面」は下部の保存ボタンが出ます。'
      + 'タブバーそのものは出していないため、タブ画面ではタブバーの高さぶん空いた位置に出ます。',
  });
}

/* ---------------------------------------------------------
   ボタン（design 9.1）
   --------------------------------------------------------- */
function buttons() {
  const save = button('保存', { variant: 'primary' });
  save.addEventListener('click', () => {
    // 処理中の表示：2秒だけ「保存中」＋回転アイコン、押せない状態（連打で2件保存されない）
    setBusy(save, true, '保存中');
    setTimeout(() => { setBusy(save, false); showToast('保存しました'); }, 2000);
  });
  const result = resultLine();
  return [
    heading('ボタン（9.1）'),
    h('div', { class: 'c-stage c-stage--column' },
      save,
      button('決済を保存（無効）', { variant: 'primary', disabled: true }),
      button('編集', { variant: 'secondary', block: true }),
    ),
    stage(
      button('条件を解除', { variant: 'secondary' }),
      button('キャンセル', { variant: 'text' }),
      button('保存', { variant: 'text', strong: true }),
      button('今にする', { variant: 'text' }),
      iconButton('filter', '絞り込み', { onClick: () => { result.textContent = '結果：絞り込みを押しました'; } }),
      iconButton('close', '閉じる', { onClick: () => { result.textContent = '結果：閉じるを押しました'; } }),
    ),
    result,
    listGroup({
      header: '危険な操作（詳細画面の最下部の独立したグループ）',
      rows: [
        dangerRow('決済を取り消す', async () => {
          const ok = await confirmAction({
            title: '決済を取り消すと、決済価格と損益が消えて保有中に戻ります。決済理由・感情・メモ・画像は残ります。',
            confirmLabel: '決済を取り消す',
          });
          result.textContent = `結果：${ok ? '決済を取り消す を選びました' : 'キャンセルしました'}`;
        }),
        dangerRow('この記録を削除', async () => {
          const ok = await confirmAction({ title: 'この記録を削除しますか？', message: '本番 USD/JPY ▲買い 10/15 21:30 の記録', confirmLabel: '削除' });
          result.textContent = `結果：${ok ? '削除 を選びました' : 'キャンセルしました'}`;
          if (ok) showToast('削除しました', { action: { label: '取り消す', onClick: () => showToast('削除を取り消しました') } });
        }),
      ],
      footer: '押すとアクションシートで確認します。「削除」を選ぶと、取り消すボタン付きのトースト（6秒）が出ます。',
    }),
  ];
}

/* ---------------------------------------------------------
   ナビゲーションバー（9.11）・新規エントリーボタン（9.10）の線画アイコン
   --------------------------------------------------------- */
function bars() {
  return [
    heading('ナビゲーションバー（9.11）'),
    h('div', { class: 'c-stage c-stage--column c-navbar-sample' },
      navbar({ left: backButton('一覧', () => {}), title: '詳細', right: textButton('編集') }),
      navbar({ left: textButton('キャンセル'), title: '新規エントリー', right: textButton('保存', { strong: true }) }),
    ),
    h('p', { class: 'c-result' }, '「‹」は線画アイコンです。新規エントリーボタン（＋）は上の「画面の型」で「一覧」を選ぶと右下に出ます。'),
  ];
}

/* ---------------------------------------------------------
   グループ化されたリスト（9.13）
   --------------------------------------------------------- */
function lists() {
  return [
    heading('グループ化されたリスト（9.13）'),
    listGroup({
      header: '取引',
      rows: [
        listRow({ label: '1lotの通貨数（本番）', value: '10,000', numeric: true }),
        listRow({ label: 'エントリー根拠', href: '#' }),
        listRow({ label: 'バージョン', value: '0.1.0', numeric: true }),
      ],
      footer: 'グループの下の説明文（13px・灰）。',
    }),
  ];
}

/* ---------------------------------------------------------
   入力欄（9.2）とエラー①・注意②（9.15・14.1.8）
   --------------------------------------------------------- */
function forms() {
  const side = sideSegment();
  const price = numberRow({ label: 'エントリー価格', placeholder: '0.000' });
  const lots = numberRow({ label: 'ロット', value: '0.5', unit: 'lot' });
  const unit = numberRow({ label: '1lotの通貨数', value: '10,000', unit: '通貨', inputmode: 'numeric', enterkeyhint: 'done' });
  const dt = dateTimeRow({
    label: '日時',
    value: '2026-10-15T21:30',
    onNow: () => {
      // 「今にする」の見本：端末の時刻を datetime-local の形にする（本番の変換は datetime.js：T-17）
      const d = new Date();
      const p = (n) => String(n).padStart(2, '0');
      dt.input.value = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
    },
  });

  const required = listGroup({
    header: '必須',
    rows: [h('div', { class: 'field-row' }, side.el), price.row, lots.row, dt.row],
  });
  const settings = listGroup({ header: '設定（E-07 の例）', rows: [unit.row] });
  const others = listGroup({
    header: '詳細（任意）',
    rows: [
      textRow({ label: '合言葉', type: 'password', placeholder: '未設定' }).row,
      switchRow({ label: '削除済みも含める' }).row,
      textareaRow({ label: 'メモ', warnAt: 1990 }).row,
    ],
    footer: 'メモは残り10文字を切ると残り文字数を表示します（本番は design 9.2 の「2,000文字に近づいたら」の値を画面ごとに決める）。',
  });

  let shown = false;
  const toggle = button('エラーと注意を出す', { variant: 'secondary' });
  toggle.addEventListener('click', () => {
    shown = !shown;
    toggle.querySelector('.btn__label').textContent = shown ? 'エラーと注意を消す' : 'エラーと注意を出す';
    if (shown) {
      // 文言は design 14.1.8・14.6.2（v1.7）のとおり
      setGroupMessages(required, [
        { type: 'error', text: '買いか売りを選んでください', target: side.el },
        { type: 'error', text: 'エントリー価格：価格は小数第3位までで入力してください', target: price.input },
        { type: 'warning', text: '数量が非常に大きくなっています。ロットと1lotの通貨数を確認してください。' },
      ]);
      setGroupMessages(settings, [{ type: 'error', text: '1以上の整数をカンマなしで入力してください（例：10000）', target: unit.input }]);
    } else {
      setGroupMessages(required, []);
      setGroupMessages(settings, []);
    }
  });

  return [
    heading('入力欄（9.2）・セグメント（9.3）'),
    h('p', { class: 'c-lead' }, '数値の欄は小数点付きの数字キーボード（inputmode="decimal"）。行のどこを押しても入力欄にフォーカスします。'
      + '「エラーと注意を出す」で、① 入力の問題（赤・行の文字も赤／セグメントは赤い枠）と ② 注意（琥珀）を確認できます。'),
    stage(toggle),
    required,
    settings,
    others,
    listGroup({
      header: 'デモ / 本番・汎用',
      rows: [
        h('div', { class: 'field-row' }, accountSegment({ value: 'real' }).el),
        h('div', { class: 'field-row' }, accountSegment({ value: 'demo' }).el),
        h('div', { class: 'field-row' }, sideSegment({ value: 'sell' }).el),
      ],
    }),
  ];
}

/* ---------------------------------------------------------
   チップ（9.4）
   --------------------------------------------------------- */
function chipSection() {
  const result = resultLine();
  const show = (name) => (sel) => { result.textContent = `結果：${name} ${sel.length ? sel.join('・') : '（未選択）'}`; };
  // エントリー画面と同じ3列×2段の格子（design 9.4 の注記・14.1.2。T-15 で余白 4px・中央寄せに）
  const pairs = chips({
    label: '通貨ペア', required: true, selected: ['USD/JPY'], onChange: show('通貨ペア'), className: 'chips--pair-grid',
    options: ['USD/JPY', 'EUR/USD', 'GBP/JPY', 'EUR/JPY', 'AUD/JPY', 'GBP/USD'].map((v) => ({ value: v, label: v })),
  });
  const reasons = chips({
    label: 'エントリー根拠', multiple: true, selected: ['トレンドフォロー'], onChange: show('根拠'),
    options: ['トレンドフォロー', '押し目買い', 'レジサポ', 'ブレイク', '指標'].map((v) => ({ value: v, label: v })),
  });
  const emotion = chips({
    label: '感情', onChange: show('感情'),
    options: ['冷静', '焦り', '自信あり', '不安'].map((v) => ({ value: v, label: v })),
  });
  const tags = chips({
    label: 'タグ', multiple: true, onChange: show('タグ'), addLabel: '追加',
    onAdd: () => { result.textContent = '結果：「＋追加」を押しました（タグの追加欄は T-17 で作る）'; },
    options: ['ルール通り', 'ルール違反'].map((v) => ({ value: v, label: v })),
  });
  return [
    heading('チップ選択（9.4）'),
    listGroup({
      header: '通貨ペア（1つだけ・解除できない・3列の格子）', rows: [h('div', { class: 'field-row' }, pairs.el)],
      footer: '格子のチップに限り左右の余白を4pxにし、文字と ✓ を中央に置く（375px・320px 幅で選択中の「USD/JPY」が収まるか確認する）。',
    }),
    listGroup({ header: 'エントリー根拠（複数選べる）', rows: [h('div', { class: 'field-row' }, reasons.el)] }),
    listGroup({ header: '感情（1つだけ・もう一度押すと解除）', rows: [h('div', { class: 'field-row' }, emotion.el)] }),
    listGroup({ header: 'タグ（複数・＋追加）', rows: [h('div', { class: 'field-row' }, tags.el)] }),
    result,
  ];
}

/* ---------------------------------------------------------
   バッジ（9.5）
   --------------------------------------------------------- */
function badges() {
  return [
    heading('バッジ（9.5）'),
    listGroup({
      rows: [
        h('div', { class: 'list-row' }, h('div', { class: 'c-badges' },
          ['demo', 'real', 'buy', 'sell', 'open', 'closed', 'manual', 'unsynced'].map((k) => badge(k)))),
        h('div', { class: 'list-row' }, h('div', { class: 'c-trade-line' },
          badge('real'), h('span', {}, 'USD/JPY'), badge('sell'), h('span', { class: 'c-trade-line__profit num' }, '＋12,345円'))),
        h('div', { class: 'list-row' }, h('div', { class: 'c-trade-line' },
          badge('demo'), h('span', {}, 'EUR/USD'), badge('buy'))),
      ],
      footer: '一覧の行での並び順は［デモ/本番］通貨ペア ▲買い/▼売り（design 9.5）。押せないので影や立体感は付けません。',
    }),
  ];
}

/* ---------------------------------------------------------
   トースト（9.6・14.7.5）
   --------------------------------------------------------- */
function toasts() {
  return [
    heading('トースト（9.6）'),
    stage(
      button('保存しました', { variant: 'secondary', onClick: () => showToast('保存しました') }),
      button('決済の保存', { variant: 'secondary', onClick: () => showToast('決済を保存しました ＋1,234円') }),
      button('取り消す付き', {
        variant: 'secondary',
        onClick: () => showToast('削除しました', { action: { label: '取り消す', onClick: () => showToast('削除を取り消しました') } }),
      }),
      button('消す', { variant: 'text', onClick: () => hideToast() }),
    ),
    h('p', { class: 'c-result' }, '成功は3秒、取り消す付きは6秒で消えます。タップで即閉じます。押している間・「取り消す」にフォーカスがある間は6秒のカウントが止まります。'),
  ];
}

/* ---------------------------------------------------------
   確認（アクションシート 9.7・14.7.4）とアラート（14.7.3）
   --------------------------------------------------------- */
function dialogs() {
  const result = resultLine();
  return [
    heading('確認・アラート（9.7・14.7.3）'),
    stage(
      button('入力の破棄', {
        variant: 'secondary',
        onClick: async () => {
          const v = await actionSheet({
            title: '入力内容を破棄しますか？', message: '追加した画像も削除されます。',
            actions: [{ label: '入力内容を破棄', value: 'discard', danger: true }], cancelLabel: '編集を続ける',
          });
          result.textContent = `結果：${v === 'discard' ? '入力内容を破棄 を選びました' : '編集を続ける（何もしない）'}`;
        },
      }),
      button('保存の失敗', {
        variant: 'secondary',
        onClick: async () => {
          const v = await showAlert({
            title: '保存できませんでした',
            message: '端末の空き容量が不足している可能性があります。入力内容はこの画面に残っています。',
            buttons: [{ label: '閉じる', value: 'close' }, { label: 'もう一度保存', value: 'retry', primary: true }],
          });
          result.textContent = `結果：${v === 'retry' ? 'もう一度保存' : '閉じる'} を選びました`;
        },
      }),
      button('削除の失敗', {
        variant: 'secondary',
        onClick: async () => {
          await showAlert({ title: '削除できませんでした', message: '記録はそのまま残っています。もう一度試してください。' });
          result.textContent = '結果：閉じる を選びました';
        },
      }),
    ),
    result,
    h('p', { class: 'c-result' }, 'アクションシートは背景のタップ・Esc キーでも「何もしない」で閉じます。アラートはボタンでだけ閉じます（見落とし防止）。'),
  ];
}

/* ---------------------------------------------------------
   お知らせ行（9.16）：画面の中と #notice-area
   --------------------------------------------------------- */
function notices() {
  const inScreen = h('div');
  const items = [
    { iconName: 'warning', tone: 'error', text: 'データを読み込めませんでした', action: { label: '再読み込み', onClick: () => {} } },
    {
      iconName: 'pencil', text: '入力途中のエントリーがあります', subtext: 'USD/JPY ▲買い・21:32',
      action: { label: '続ける', onClick: () => showToast('（見本）入力画面を開きます') },
      onClose: () => { items.splice(1, 1); renderNotices(inScreen, items); },
    },
    {
      iconName: 'sync', text: '新しいバージョンがあります', action: { label: '更新', onClick: () => {} },
      onClose: () => { items.splice(items.findIndex((x) => x.text.startsWith('新しい')), 1); renderNotices(inScreen, items); },
    },
  ];
  renderNotices(inScreen, items);

  const appArea = button('画面の一番上に出す', {
    variant: 'secondary',
    onClick: () => showAppNotice('demo-unexpected', {
      iconName: 'warning', tone: 'error', text: '予期しない問題が起きました。アプリを再読み込みしてください。',
      action: { label: '再読み込み', onClick: () => hideAppNotice('demo-unexpected') },
    }),
  });

  return [
    heading('お知らせ行（9.16）'),
    h('p', { class: 'c-lead' }, '画面の中のお知らせは優先順に最大2行。上の「×」で閉じると3つ目（新しいバージョン）が出ます。読み込みエラーは × がなく消えません。'),
    inScreen,
    h('div', { class: 'notice-list' },
      createNotice({ iconName: 'warning', tone: 'warning', text: '下書きを保存できません', subtext: 'アプリを閉じると入力内容が消えます。' }),
      createNotice({
        text: '入力途中の内容を復元しました', subtext: '21:32 の下書き',
        action: { label: '破棄', onClick: () => confirmAction({ title: '入力途中の内容を破棄しますか？', confirmLabel: '入力内容を破棄' }) },
      }),
    ),
    stage(appArea, button('一番上のお知らせを消す', { variant: 'text', onClick: () => hideAppNotice('demo-unexpected') })),
    h('p', { class: 'c-result' }, 'アプリ全体の問題（予期しない問題・DB を開けない等）は、画面の一番上の共通の置き場（#notice-area）に出します。'),
  ];
}

/* ---------------------------------------------------------
   空状態（9.14）・読み込み中（9.15）
   --------------------------------------------------------- */
function emptyAndLoading() {
  const loadingBox = h('div');
  const startLoading = () => {
    clear(loadingBox);
    const l = showLoadingAfter(loadingBox);
    setTimeout(() => { l.stop(); loadingBox.append(h('p', { class: 'c-result' }, '読み込みが終わりました（0.3秒未満なら回転アイコンは出ません）')); }, 1500);
  };
  return [
    heading('空状態（9.14）'),
    emptyState({ iconName: 'notebook', title: '記録はまだありません', text: 'エントリーしたら右下の「新規エントリー」から記録します。' }),
    emptyState({
      iconName: 'search', title: '条件に合う記録はありません', text: '条件を変えるか、解除してください。',
      action: button('条件を解除', { variant: 'secondary' }),
    }),
    heading('読み込み中（9.15）'),
    stage(spinner(), button('1.5秒かかる読み込み', { variant: 'secondary', onClick: startLoading })),
    loadingBox,
    h('p', { class: 'c-result' }, '「視差効果を減らす」設定がオンの端末では、回転を止めて「読み込み中」の文字を出します。'),
  ];
}

/* ---------------------------------------------------------
   アイコン一覧（9.17）
   --------------------------------------------------------- */
function icons() {
  return [
    heading('線画アイコン（9.17）'),
    h('div', { class: 'c-icons' },
      ICON_NAMES.map((n) => h('div', { class: 'c-icon' }, icon(n), h('span', { class: 'c-icon__name' }, n)))),
  ];
}

function main() {
  startInputModalityWatch();
  startKeyboardWatch();
  clear(root);
  root.append(
    largeTitle('共通部品'),
    h('p', { class: 'c-lead' }, 'design.md 9章の共通部品を、アプリと同じ CSS・部品で並べた確認用ページです（アプリの画面には入りません）。'
      + 'ここで押しても記録は保存されません。'),
    controls(),
    ...buttons(),
    ...bars(),
    ...lists(),
    ...forms(),
    ...chipSection(),
    ...badges(),
    ...toasts(),
    ...dialogs(),
    ...notices(),
    ...emptyAndLoading(),
    ...icons(),
  );
}

main();
