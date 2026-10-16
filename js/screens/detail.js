/* =========================================================
   js/screens/detail.js
   S-04 トレード詳細。型C（詳細画面）。URL：#/trades/{id}

   【T-10】ナビゲーションバー（‹ 一覧／編集）と下部ボタンの入れ物。
   【T-20】記録 1 件の表示（design 14.4）：
     ・見出し（バッジ・通貨ペア・売買方向・損益と pips／保有中は「151.234 で保有中・2時間15分」）
     ・「エントリー」「決済」（決済済みのみ）「タグ・メモ」のグループ。未入力の項目も行を残して「—」
     ・作成・更新日時、最下部の「決済を取り消す」（決済済みのみ）「この記録を削除」
     ・下部操作バー：保有中＝「決済する」、決済済み＝「編集」（design 14.7.9 ①）
     ・記録が見つからない（ID 不正・削除済み）ときは「この記録は見つかりません」＋［一覧へ］（14.4.7）
   表示する内容の組み立ては js/detail-view.js（画面に依存しない関数。テストあり）。ここは並べて描くだけ。
   メモ・タグなど利用者が入力した文字は h() を通す（必ずテキストとして入る：XSS 対策）。

   【T-21】「決済を取り消す」を実処理にした（確認シート → trades.js の reopenTrade → トースト「決済を取り消しました」。
   詳細画面に留まり、見出しが「保有中」に変わる：design 14.4.5）。

   【T-22】「この記録を削除」を実処理にした（確認シート → trades.js の deleteTrade（論理削除）→ 一覧へ戻る →
   一覧の表示が終わってからトースト「削除しました［取り消す］」を6秒出す：design 14.4.5・14.7.5）。
   「取り消す」付きのトーストは画面を移ると消えるので、ここでは出さず、js/deleted-toast.js に預けて一覧に出してもらう。
   「編集」（右上・決済済みの下部）は T-20 から実画面（#/trades/{id}/edit）へのリンク。
   画像のサムネイル・拡大表示（design 14.4.6）は T-24 で作る。画像のグループは、画像を表示できるようになる T-24 で足す。
   ========================================================= */
import { h } from '../ui/dom.js';
import { navbar, backButton, actionBar } from '../ui/bars.js';
import { badge, button, listGroup, dangerRow, emptyState, showLoadingAfter } from '../ui/parts.js';
import { renderNotices } from '../ui/notice.js';
import { confirmAction, showAlert } from '../ui/dialog.js';
import { showToast } from '../ui/toast.js';
import { getTrade, reopenTrade, deleteTrade, TRADES_CHANGED } from '../trades.js';
import { requestDeletedToast } from '../deleted-toast.js';
import { isAppError } from '../util.js';
import { on } from '../events.js';
import { buildDetailView, describeTrade } from '../detail-view.js';

/** 今表示している詳細画面の状態（unmount で後片付けするために 1 つだけ持つ） */
let current = null;

/* ---------------------------------------------------------
   部品
   --------------------------------------------------------- */

/** 見出し（グループにせず、ページ背景の上に左揃え：design 14.4.1）。主役の数字を上に置く */
function headNode(head) {
  const profitLine = head.profit
    ? [
      h('div', { class: `detail-head__profit num tone-${head.profit.tone}` }, head.profit.text),
      h('div', { class: 'detail-head__pips-line' },
        h('span', { class: `detail-head__pips num tone-${head.pips.tone}` }, head.pips.text),
        head.manual ? badge('manual') : null),
    ]
    : h('p', { class: 'detail-head__open-line num' }, head.openLine);

  return h('header', { class: 'detail-head' },
    // 見た目の文字は読み上げから外し、記号（▲・＋）を読ませない文章を代わりに置く
    h('span', { class: 'visually-hidden' }, head.speech),
    h('div', { class: 'detail-head__badges', 'aria-hidden': 'true' },
      head.account ? badge(head.account) : null, badge(head.status)),
    h('div', { class: 'detail-head__title', 'aria-hidden': 'true' },
      h('span', { class: 'detail-head__pair' }, head.pair),
      head.side ? badge(head.side) : null),
    h('div', { 'aria-hidden': 'true' }, profitLine),
  );
}

/** 表示の行 1 つ。値が「—」（未入力）のときは灰色。2 行目（RR の損切り・利確の幅など）は右揃えで下に */
function rowNode(r) {
  if (r.kind === 'memo') return memoNode(r);
  return h('div', { class: `list-row detail-row${r.sub ? ' detail-row--sub' : ''}` },
    h('span', { class: 'list-row__label' }, r.label),
    h('span', { class: `list-row__value${r.numeric ? ' num' : ''}${r.empty ? ' is-empty' : ''}` },
      // 根拠・タグは 1 つずつのまとまりにして、「、」の位置で折り返す（言葉の途中で切れないように）
      r.items ? r.items.map((item, i) => h('span', { class: 'detail-item' }, i < r.items.length - 1 ? `${item}、` : item)) : r.value),
    r.sub ? h('span', { class: 'detail-row__sub' }, r.sub) : null,
  );
}

/** メモは全文を左揃えで、改行もそのまま見せる（CSS の white-space: pre-wrap）。空なら灰色の「メモなし」 */
function memoNode(r) {
  return h('div', { class: 'list-row detail-memo' },
    r.empty ? null : h('span', { class: 'visually-hidden' }, 'メモ'),
    h('p', { class: `detail-memo__text${r.empty ? ' is-empty' : ''}` }, r.value),
  );
}

/** 「エントリー」「決済」「タグ・メモ」のグループ */
function sectionNode(s) {
  return listGroup({ header: s.header, footer: s.footer, rows: s.rows.map(rowNode), className: `detail-group detail-group--${s.key}` });
}

/* ---------------------------------------------------------
   危険な操作（確認シート → 実処理。決済の取り消しは T-21、削除は T-22）
   --------------------------------------------------------- */

/**
 * 「決済を取り消す」：確認シート（design 14.7.4）→ 保有中に戻す（trades.js の reopenTrade）。
 * 戻したあとは詳細画面に留まる。保存の通知（TRADES_CHANGED）でこの画面が描き直され、見出しが「保有中」・下部ボタンが「決済する」に変わる。
 * トーストに「取り消す」は付けない（消した値を別に覚えておく仕組みが要るため。確認シートで何が消えるかを伝えている：design 14.4.5）。
 */
async function onCancelClose(ctx) {
  const ok = await confirmAction({
    title: '決済を取り消しますか？',
    message: '決済を取り消すと、決済価格と損益が消えて保有中に戻ります。決済理由・感情・メモ・画像は残ります。',
    confirmLabel: '決済を取り消す',
  });
  if (!ok || !ctx.alive) return;
  try {
    await reopenTrade(ctx.id);
  } catch (e) {
    if (!ctx.alive) return;
    if (isAppError(e, 'NOT_FOUND')) {
      load(ctx); // 別の画面で削除されていた：「この記録は見つかりません」の表示に変わる
      return;
    }
    console.error('決済を取り消せませんでした', e);
    await showAlert({ title: '決済を取り消せませんでした', message: '記録はそのまま残っています。もう一度試してください。' });
    return;
  }
  if (!ctx.alive) return;
  // すでに保有中だった（別の画面で先に取り消された）ときは何も保存されず通知も出ないので、ここでも描き直して表示を合わせる
  // （読み込み中に呼ばれたら終わってからやり直すだけなので、通知による描き直しと重なっても害はない）
  load(ctx);
  showToast('決済を取り消しました');
}

/**
 * 「この記録を削除」：確認シート（design 14.7.4）→ 論理削除（trades.js の deleteTrade。画像は消さない）→ 一覧へ戻る。
 * 「削除しました［取り消す］」のトーストは、ここでは出さず deleted-toast.js に預ける
 * （ui/toast.js は「取り消す」付きのトーストを画面を移ったときに消すので、先に出すと一覧に戻った時点で消える。
 *  一覧が表示を終えたところで出す：list.js。取り消せるのはそこから6秒間）。
 * 削除の通知（TRADES_CHANGED）でこの画面が「見つかりません」に描き直されて一瞬見えないよう、削除中は描き直さない（ctx.leaving）。
 * 失敗したときは記録をそのまま残してアラート（design 14.7.3「記録の削除」。やり直しは確認シートからもう一度）。
 */
async function onDelete(ctx) {
  const ok = await confirmAction({
    title: 'この記録を削除しますか？',
    message: describeTrade(ctx.trade, new Date()),
    confirmLabel: '削除',
  });
  if (!ok || !ctx.alive) return;
  ctx.leaving = true;
  let deleted;
  try {
    deleted = await deleteTrade(ctx.id);
  } catch (e) {
    ctx.leaving = false;
    if (!ctx.alive) return;
    if (isAppError(e, 'NOT_FOUND')) {
      load(ctx); // 別の画面で記録が消えていた：「この記録は見つかりません」の表示に変わる
      return;
    }
    console.error('記録を削除できませんでした', e);
    await showAlert({ title: '削除できませんでした', message: '記録はそのまま残っています。もう一度試してください。' });
    return;
  }
  if (!ctx.alive) return;
  requestDeletedToast({ id: ctx.id, deletedAt: deleted.deletedAt });
  // 削除済みの詳細画面を履歴に残さない（history.back。履歴がなければ一覧へ置き換え：architecture 5.3）
  ctx.nav.back('#/');
}

/** 最下部の独立したグループ。決済済みは「決済を取り消す」「この記録を削除」、保有中は削除だけ（design 14.4.5） */
function dangerNode(ctx, view) {
  const rows = [];
  if (view.canCancelClose) rows.push(dangerRow('決済を取り消す', () => onCancelClose(ctx)));
  rows.push(dangerRow('この記録を削除', () => onDelete(ctx)));
  return listGroup({ rows, className: 'detail-danger' });
}

/* ---------------------------------------------------------
   描画（読み込み中 → 見つかった／見つからない／読み込めない）
   --------------------------------------------------------- */

/** ナビゲーションバー。「編集」は記録が見つかったときだけ（design 14.4.7） */
function navNode(ctx, withEdit) {
  return navbar({
    left: backButton('一覧', () => ctx.nav.back('#/')),
    title: '詳細',
    // 編集は「進む」移動なので普通のリンクにする（履歴が 1 つ増える）
    right: withEdit ? h('a', { class: 'btn btn--text', href: `${ctx.base}/edit` }, '編集') : null,
  });
}

function renderFound(ctx, trade) {
  const view = buildDetailView(trade, new Date());
  ctx.trade = trade;
  // 下部：保有中は主要ボタン「決済する」、決済済みは副ボタン「編集」（design 14.4.5・14.7.9 ①）
  const bottom = view.closed
    ? button('編集', { variant: 'secondary', block: true, href: `${ctx.base}/edit` })
    : button('決済する', { variant: 'primary', block: true, href: `${ctx.base}/close` });
  ctx.root.replaceChildren(
    navNode(ctx, true),
    h('div', { class: 'screen__body detail' },
      headNode(view.head),
      view.sections.map(sectionNode),
      h('p', { class: 'detail-timestamps' }, view.timestamps),
      dangerNode(ctx, view),
    ),
    actionBar(bottom),
  );
}

/** 記録が見つからない（ID が不正・削除済み）：design 14.4.7 */
function renderMissing(ctx) {
  ctx.trade = null;
  ctx.root.replaceChildren(
    navNode(ctx, false),
    h('div', { class: 'screen__body' },
      emptyState({
        iconName: 'notebook',
        title: 'この記録は見つかりません',
        text: '削除された可能性があります。',
        // 「‹ 一覧」と同じ戻り方（一覧から来たなら履歴を戻る。履歴がなければ一覧へ置き換え）
        action: button('一覧へ', { variant: 'secondary', onClick: () => ctx.nav.back('#/') }),
      })),
  );
}

/** 記録を読み込めなかった（DB のエラー）：画面全体の問題なのでお知らせ行（design 14.7.1） */
function renderLoadError(ctx) {
  ctx.trade = null;
  const notices = h('div', { class: 'detail-notices' });
  renderNotices(notices, [{
    iconName: 'warning',
    tone: 'error',
    text: 'データを読み込めませんでした',
    action: { label: '再読み込み', onClick: () => load(ctx) },
  }]);
  ctx.root.replaceChildren(navNode(ctx, false), h('div', { class: 'screen__body' }, notices));
}

/** 最初の表示（読み込み中）。0.3 秒以上かかるときだけ回転アイコンを出す（すぐ終わるときにちらつかせない：design 9.15） */
function renderLoading(ctx) {
  const body = h('div', { class: 'screen__body' });
  ctx.root.replaceChildren(navNode(ctx, false), body);
  ctx.loading = showLoadingAfter(body);
}

/**
 * 記録を読み込んで描く。読み込み中にもう一度呼ばれたら、終わってからやり直す（古い結果で上書きしないため）。
 * 描き直したときはスクロール位置を保つ（他の画面で記録が変わった通知で、読んでいる途中の位置が飛ばないように）。
 */
async function load(ctx) {
  if (ctx.busy) {
    ctx.dirty = true;
    return;
  }
  ctx.busy = true;
  const scrollY = ctx.rendered ? window.scrollY : 0;
  let state;
  try {
    const trade = await getTrade(ctx.id);
    // 論理削除済み（deletedAt あり）は「見つからない」と同じ扱い（architecture 5.1）
    state = trade && trade.deletedAt == null ? { kind: 'found', trade } : { kind: 'missing' };
  } catch (e) {
    console.error('記録を読み込めませんでした', e);
    state = { kind: 'error' };
  }
  ctx.busy = false;
  if (!ctx.alive) return;

  if (ctx.loading) {
    ctx.loading.stop();
    ctx.loading = null;
  }
  if (state.kind === 'found') renderFound(ctx, state.trade);
  else if (state.kind === 'missing') renderMissing(ctx);
  else renderLoadError(ctx);
  ctx.rendered = true;
  if (scrollY > 0) window.scrollTo(0, scrollY);

  if (ctx.dirty) {
    ctx.dirty = false;
    load(ctx);
  }
}

export default {
  layout: 'detail',
  tab: null,
  title: '詳細',

  mount(root, { params, nav }) {
    const ctx = {
      alive: true, root, nav, id: params.id,
      // URL に戻すときは encodeURIComponent で符号化する（ID に / や # などが混ざっていても URL が壊れないように）
      base: `#/trades/${encodeURIComponent(params.id)}`,
      trade: null, busy: false, dirty: false, rendered: false, loading: null, stopWatching: null, leaving: false,
    };
    current = ctx;
    renderLoading(ctx);
    // この記録が他の画面・操作で変わったら描き直す（T-21 の決済の取り消しなど）
    ctx.stopWatching = on(TRADES_CHANGED, (detail) => {
      if (detail && detail.id === ctx.id && !ctx.leaving) load(ctx);
    });
    // 読み込みは待たずに画面を出す（DB が開くのを待っている間も画面が真っ白にならないように）
    load(ctx);
  },

  unmount() {
    const ctx = current;
    if (!ctx) return;
    current = null;
    ctx.alive = false;
    if (ctx.loading) ctx.loading.stop();
    if (ctx.stopWatching) ctx.stopWatching();
    // T-24 で画像の表示用URLの解放（architecture.md 11.3）をここに足す
  },

  hasUnsavedChanges() {
    return false;
  },
};
