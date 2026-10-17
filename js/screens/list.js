/* =========================================================
   js/screens/list.js
   S-01 一覧（ホーム）。型A（タブ画面）。URL：#/

   【T-10】画面の入れ物。
   【T-17】お知らせ行「入力途中のエントリーがあります［続ける］」（design 14.3.8）。
     × は「次に起動するまで出さない」だけで、下書きは消さない（一覧には破棄の操作を置かない）。
   【T-22】決済・編集の下書きも同じお知らせ行で案内する（「入力途中の決済／編集があります」。2件以上は「入力途中の記録がn件あります［選ぶ］」
     → アクションシートで選ぶ）。対象の記録が削除・決済済みになった下書きは黙って消し、編集（・決済）の下書きで元の記録が下書きのあとに
     変更されていたものは、消したうえで「元の記録が変更されたため、入力途中の編集を破棄しました」を1回だけ出す（× のみ）。
     判定と文言は js/draft-notice.js（画面に依存しない関数。テストあり）。
     詳細画面で削除して戻ってきたら、一覧の表示が終わってからトースト「削除しました［取り消す］」を6秒出す（受け渡しは js/deleted-toast.js）。
     「取り消す」→ undoDeleteTrade で元に戻し、行を1秒ハイライト（js/row-flash.js）。取り消しで null が返った（削除日時が変わっていた）ときは何もしない。
   【T-19】記録の一覧（design 14.3.1・14.3.4〜14.3.6・14.3.9）：
     ・サマリー（件数・合計損益。デモと本番が混在なら口座別2行）とその直下の pips の注記
     ・「保有中 n件」のグループ（エントリー日時の新しい順。行の右端に［決済］）
     ・決済済みを決済日ごとの見出しの下に新しい順で。見出しの日計はサマリーが1口座のときだけ
     ・最初の約50行を描き、下までスクロールしたら続きを足す（analytics 4.9 #5）
     ・0件のときは空状態の案内
     ・タブ切替・詳細から戻ったときのスクロール位置の復元（architecture 5.2・5.5）
     ・読み込みに失敗したときのお知らせ行［再読み込み］（design 14.3.8 の優先1）
   【T-21】決済・保存から戻った直後に、その行を約1秒だけ目立たせる（design 14.3.4。受け渡しは js/row-flash.js）。
   【T-23】絞り込み（design 14.3.1・14.3.7・14.3.9・14.3.10、analytics 4.2〜4.8）：
     ・大タイトル右の絞り込みボタン（条件の数つき）→ 絞り込みシート（js/ui/filter-sheet.js）。「n件を表示」で適用
     ・適用中の条件チップ（js/ui/filter-chips.js）。タップで確認なしにその条件だけ解除、2つ以上なら「すべて解除」
     ・条件を変えたら、読み込み済みの記録（ctx.trades）から選び直す（DB は読み直さない：analytics 4.1）。スクロールは先頭へ
     ・条件に合う記録が0件のときの空状態（「記録はまだありません」とは別。チップは出したまま［条件を解除］）
     ・条件は画面を離れても残し（モジュールの変数）、変えるたびに localStorage の listFilter へ保存する。
       アプリを開いたときに保存から30分以内なら復元、超えていれば初期値（analytics 4.8。判定は filter.js の restoreFilter）
     ・アプリが前面に戻ったとき、日付が変わっていれば「今日」「今月」などを計算し直す（analytics 4.4.2）
   【T-29】お知らせ行「ホーム画面に追加すると、データが消えにくくなります［方法］」（design 14.3.8 の優先4）。
     iPhone・iPad をホーム画面版でなくブラウザで開いているときだけ出す（判定は js/data-protection.js）。［方法］→ #/settings/install。
     × は「次に起動するまで出さない」。
   【T-28】お知らせ行「新しいバージョンがあります［更新］」（design 14.3.8 の優先3）。新しい版が待機中のときだけ出す
     （判定と切り替えは js/sw-update.js）。［更新］→ 新しい版に切り替えて再読み込み。× は「次に起動するまで出さない」。
     一覧には入力中の内容がないので、ここから再読み込みしても入力は消えない（入力画面では出さない）。
   詳細・決済画面は T-20・T-21。
   集計・並び順・日付のまとめは js/filter.js（画面に依存しない純粋な関数）、文字の整形は js/format.js。
   ========================================================= */
import { h } from '../ui/dom.js';
import { largeTitle, newEntryButton } from '../ui/bars.js';
import { listGroup, badge, emptyState, spinner, showLoadingAfter, button } from '../ui/parts.js';
import { renderNotices } from '../ui/notice.js';
import { actionSheet, showAlert, closeOpenDialog } from '../ui/dialog.js';
import { openFilterSheet } from '../ui/filter-sheet.js';
import { createFilterButton, renderFilterChips } from '../ui/filter-chips.js';
import { showToast } from '../ui/toast.js';
import { getAllTrades, getTrade, undoDeleteTrade, TRADES_CHANGED } from '../trades.js';
import { on } from '../events.js';
import { getAllDrafts, discardDraft, DRAFT_KIND } from '../drafts.js';
import { judgeDraftTarget, buildDraftNotice, DRAFT_STALE_TEXT } from '../draft-notice.js';
import { takeDeletedToast } from '../deleted-toast.js';
import { isAppError } from '../util.js';
import { buildListView, flattenView, nextChunkEnd, summaryRows, defaultFilter, describeFilter, clearCondition,
  packFilter, restoreFilter } from '../filter.js';
import { getSetting, setSetting } from '../settings-store.js';
import { jstParts } from '../datetime.js';
import { formatPrice, formatYen, formatPips, formatPipsTenths, formatLots, formatTime, formatDateTime,
  toneOf, toTenths, speakYen, speakPips, speakDateTime } from '../format.js';
import { LIST_PAGE_SIZE } from '../config.js';
import { takeRowFlash, requestRowFlash, FLASH_DURATION_MS } from '../row-flash.js';
import { isIos, isStandalone, shouldShowInstallNotice, INSTALL_NOTICE } from '../data-protection.js';
import { isUpdateWaiting, applyUpdate, UPDATE_READY } from '../sw-update.js';

/** お知らせ行を × で閉じたか（次に起動するまで出さない：design 14.3.8。アプリを開き直すと元に戻る） */
let draftNoticeClosed = false;

/** 「ホーム画面に追加すると、データが消えにくくなります」を × で閉じたか（同じく次に起動するまで出さない：design 14.3.8） */
let installNoticeClosed = false;

/** 「新しいバージョンがあります」を × で閉じたか（同じく次に起動するまで出さない：design 14.3.8） */
let updateNoticeClosed = false;

/**
 * 一覧を離れたときのスクロール位置と、そこまでに描いていた行数。
 * router.js は画面を切り替えるたびにページの先頭へスクロールするので、戻ってきたときはここから復元する
 * （architecture 5.5）。アプリを閉じて開き直したら変数ごと消えて先頭に戻る（design 14.3.11）。
 * 行数も覚えるのは、下の方までスクロールしていたとき、続きの行を描き足さないと位置まで届かないため。
 */
let savedPosition = { scrollY: 0, rows: 0 };

/**
 * 絞り込み条件。タブを切り替えても、詳細を見て戻っても残す（analytics 4.8）。null＝まだ決めていない。
 * アプリを閉じて開き直したときは、最初に一覧を開く時点で localStorage の listFilter から復元する（getCurrentFilter）。
 */
let currentFilter = null;

/**
 * アプリを開いた時刻（ページを読み込んだ時刻）。30分以内かどうかはここを基準にする。
 * 一覧を最初に開いた時刻にしないのは、起動時に入力途中の画面が自動で開いて、一覧に来るのが遅れた場合でも
 * 「アプリを開いたとき」の時刻で判定するため（analytics 4.8）。
 */
function appStartedAt() {
  const origin = typeof performance !== 'undefined' && performance.timeOrigin;
  return new Date(Number.isFinite(origin) && origin > 0 ? origin : Date.now());
}

/** 今の条件。最初の1回だけ保存値から復元（30分を過ぎていれば初期値）する */
function getCurrentFilter() {
  if (currentFilter === null) currentFilter = restoreFilter(getSetting('listFilter'), appStartedAt());
  return currentFilter;
}

/**
 * 条件を localStorage に保存する（保存時刻つき）。保存できなくても一覧の操作は続けられる（次に開いたときに復元されないだけ）ので、
 * アラートでは止めずコンソールに残す。
 */
function persistFilter(filter) {
  try {
    setSetting('listFilter', packFilter(filter));
  } catch (e) {
    console.warn('絞り込み条件を保存できませんでした', e);
  }
}

/** 今表示している一覧の状態（unmount で後片付けするために1つだけ持つ） */
let current = null;

/* ---------------------------------------------------------
   部品（サマリー・トレード行）
   --------------------------------------------------------- */

/** 口座・売買方向のバッジ。値が壊れていて知らない種類のときは出さない（badge() は知らない種類で例外を出すため） */
function safeBadge(kind, allowed) {
  return allowed.includes(kind) ? badge(kind) : null;
}

/** 右揃えの数値。利益/損失/ゼロの色は記号と併用する（色だけに頼らない：design 5.1） */
function numSpan(className, text, tone) {
  return h('span', { class: `${className} num tone-${tone}` }, text);
}

/** サマリー1行の読み上げ。例「本番、7件、うち保有中1件、合計損益 マイナス46,980円、pips合計 プラス12.8 pips」（design 14.3.6） */
function speakSummaryRow(r) {
  const parts = [r.account === 'real' ? '本番' : 'デモ', `${r.count}件`];
  if (r.openCount > 0) parts.push(`うち保有中${r.openCount}件`);
  if (r.profitJpy == null) parts.push('損益は未確定');
  else parts.push(`合計損益 ${speakYen(r.profitJpy)}`, `pips合計 ${speakPips(r.pipsTenths / 10)}`);
  return parts.join('、');
}

/**
 * サマリーの1行（design 14.3.6）。1行目：［本番/デモ］と合計損益、2行目：件数と合計 pips。
 * 決済済みが1件もない口座は金額と pips の位置に「—」（灰）。「±0円」とは出さない。
 * 見た目の文字は読み上げから外し、代わりに読み上げ用の文を置く（「＋」「▲」を記号のまま読ませないため）。
 */
function summaryRow(r, single) {
  const yenTone = r.profitJpy == null ? 'none' : toneOf(r.profitJpy);
  const pipsTone = r.pipsTenths == null ? 'none' : toneOf(r.pipsTenths);
  const countText = r.openCount > 0 ? `${r.count}件（保有中${r.openCount}）` : `${r.count}件`;
  return h('div', { class: `summary-row${single ? ' summary-row--single' : ''}` },
    h('span', { class: 'visually-hidden' }, speakSummaryRow(r)),
    h('div', { class: 'summary-row__line', 'aria-hidden': 'true' },
      badge(r.account),
      numSpan('summary-row__amount', formatYen(r.profitJpy), yenTone)),
    h('div', { class: 'summary-row__line summary-row__line--sub', 'aria-hidden': 'true' },
      h('span', { class: 'num' }, countText),
      numSpan('summary-row__pips', r.pipsTenths == null ? '—' : formatPipsTenths(r.pipsTenths), pipsTone)),
  );
}

/**
 * サマリー（件数・合計損益）と pips の注記（design 14.3.6）。
 * 混在のときはグループの上に全体の件数、1口座だけのときは全体の件数は出さず金額を大きく（22px）。
 * pips の注記は、サマリーに pips の合計が1つでも出ているときだけ、グループの直下に置く。
 * @returns {Node[]}
 */
function summaryNodes(view) {
  const rows = summaryRows(view.summary);
  if (rows.length === 0) return [];
  const single = rows.length === 1;
  const hasPips = rows.some((r) => r.pipsTenths != null);
  return [
    single ? null : h('p', { class: 'list-count num' }, `${view.summary.total}件`),
    listGroup({
      className: 'summary-group',
      rows: rows.map((r) => summaryRow(r, single)),
      footer: hasPips ? 'pips は通貨ペア・ロットを区別せず足した値です。' : null,
    }),
  ];
}

/** 行の読み上げ（design 14.3.4）。例「本番、USD/JPY、買い、10月15日 10時30分決済、1ロット、プラス2,500円、プラス25.0 pips」 */
function speakTradeRow(t, closed, now) {
  const parts = [t.accountType === 'real' ? '本番' : 'デモ', t.pair, t.side === 'buy' ? '買い' : '売り'];
  const lots = formatLots(t.lots).replace('lot', 'ロット');
  if (closed) {
    parts.push(`${speakDateTime(t.exitAt, now)}決済`, lots, speakYen(t.profitJpy), speakPips(t.pips));
  } else {
    parts.push(`${speakDateTime(t.entryAt, now)}エントリー`, lots, 'エントリー価格 ' + priceText(t), '保有中');
  }
  return parts.join('、');
}

/** エントリー価格を通貨ペアの表示桁数で（価格が空・壊れているときは「—」） */
function priceText(t) {
  return typeof t.pair === 'string' && typeof t.entryPrice === 'number' ? formatPrice(t.entryPrice, t.pair) : '—';
}

/** 1行目の左：［デモ/本番］通貨ペア ▲買い/▼売り（design 9.5「一覧の行での並び順」） */
function rowTitle(t) {
  return h('span', { class: 'trade-row__title' },
    safeBadge(t.accountType, ['demo', 'real']),
    h('span', { class: 'trade-row__pair' }, t.pair ?? '—'),
    safeBadge(t.side, ['buy', 'sell']),
  );
}

/**
 * トレード行（design 14.3.4）。
 * ・決済済み：1行目に損益（円）、2行目に決済時刻・ロット・（手入力なら［手入力］）と pips。pips は円とは別に自分の符号で色を付ける
 * ・保有中：2行目にエントリー日時・ロット・エントリー価格。右端に［決済］
 * ・行全体が詳細へのリンク。［決済］は別のリンクにして、押せる範囲を重ねない（design 8.1。<a> の中に <a> は入れられない）
 * ・幅が足りないとき、2行目の項目は省略せず次の行へ折り返す（左側の項目ごとに nowrap）
 */
function tradeRow(item, now) {
  const t = item.trade;
  const id = encodeURIComponent(t.id);
  const closed = item.closed;

  const meta = closed
    ? [
      h('span', { class: 'trade-row__meta-item' }, formatTime(t.exitAt)),
      h('span', { class: 'trade-row__meta-item' }, formatLots(t.lots)),
      t.profitSource === 'manual' ? badge('manual') : null,
    ]
    : [
      h('span', { class: 'trade-row__meta-item' }, formatDateTime(t.entryAt, now)),
      h('span', { class: 'trade-row__meta-item' }, formatLots(t.lots)),
      h('span', { class: 'trade-row__meta-item' }, priceText(t)),
    ];

  const link = h('a', { class: 'trade-row__link', href: `#/trades/${id}` },
    h('span', { class: 'visually-hidden' }, speakTradeRow(t, closed, now)),
    h('div', { class: 'trade-row__line', 'aria-hidden': 'true' },
      rowTitle(t),
      closed ? numSpan('trade-row__amount', formatYen(t.profitJpy), t.profitJpy == null ? 'none' : toneOf(t.profitJpy)) : null),
    h('div', { class: 'trade-row__line trade-row__line--sub', 'aria-hidden': 'true' },
      h('span', { class: 'trade-row__meta num' }, meta),
      closed && t.pips != null ? numSpan('trade-row__pips', formatPips(t.pips), toneOf(toTenths(t.pips))) : null),
  );

  const action = closed ? null : h('a', {
    class: 'trade-row__action', href: `#/trades/${id}/close`, 'aria-label': `${t.pair ?? ''} を決済する`,
  }, h('span', { class: 'trade-row__action-label' }, '決済'));

  // data-trade-id：戻った直後のハイライトで、どの行かを見つけるための目印（js/row-flash.js）
  return h('div', { class: `trade-row${closed ? '' : ' trade-row--open'}`, dataset: { tradeId: String(t.id) } }, link, action);
}

/**
 * 決済・保存から戻った直後に、その行を約1秒だけ `--color-accent-tint` の背景にする（design 14.3.4）。
 * 背景色の付け外しだけで、グラデーションや影は使わない。元に戻すときのゆっくりした消え方は CSS の transition が担当し、
 * 「視差効果を減らす」設定の人には base.css が動きを止めて色の切り替えだけにする。
 * 該当の行が見つからないとき（絞り込みで外れている、50件より後ろにあるなど）は何もしない。
 */
function flashRow(listEl, id) {
  const row = [...listEl.querySelectorAll('.trade-row')].find((el) => el.dataset.tradeId === id);
  if (!row) return;
  row.classList.add('is-flash');
  setTimeout(() => row.classList.remove('is-flash'), FLASH_DURATION_MS);
}

/* ---------------------------------------------------------
   描画（最初の約50行 → 下までスクロールで続きを足す）
   --------------------------------------------------------- */

/** グループ1つ（見出し＋角丸のまとまり）を作って一覧に足す。行は返り値の body に足していく */
function addGroup(ctx, header) {
  const group = listGroup({ header, className: 'trade-group' });
  ctx.listEl.append(group);
  return group.querySelector('.list-group__body');
}

/** 決済日の見出し。右端に日計（サマリーが1口座のときだけ：design 14.3.5） */
function dateHeader(ctx, entry) {
  const showTotal = ctx.view.showDailyTotals && entry.profitJpy != null;
  return [
    h('span', {}, entry.label),
    showTotal ? numSpan('trade-group__total', formatYen(entry.profitJpy), toneOf(entry.profitJpy)) : null,
  ];
}

/**
 * 行を rowLimit 行ぶん足す。見出しは行の直前に付いてくる。
 * 前回の続きが同じ日の途中なら、その日のまとまり（ctx.body）に足し続ける。
 */
function appendChunk(ctx, rowLimit) {
  const end = nextChunkEnd(ctx.entries, ctx.next, rowLimit);
  for (let i = ctx.next; i < end; i += 1) {
    const e = ctx.entries[i];
    if (e.type === 'open-header') {
      ctx.body = addGroup(ctx, `保有中 ${e.count}件`);
    } else if (e.type === 'date-header') {
      ctx.body = addGroup(ctx, dateHeader(ctx, e));
    } else {
      ctx.body.append(tradeRow(e.item, ctx.now));
      ctx.shownRows += 1;
    }
  }
  ctx.next = end;
  if (ctx.next >= ctx.entries.length) {
    ctx.sentinel.remove(); // 最後まで表示したら何も出さない
    if (ctx.observer) ctx.observer.disconnect();
  }
}

/** 下端が近づいたら続きを足す。足したあとも下端が近ければ、もう一度ここへ来る（observe し直して判定をやり直す） */
function loadMore(ctx) {
  if (!ctx.alive || ctx.next >= ctx.entries.length) return;
  appendChunk(ctx, LIST_PAGE_SIZE);
  if (ctx.observer && ctx.next < ctx.entries.length) {
    ctx.observer.unobserve(ctx.sentinel);
    ctx.observer.observe(ctx.sentinel);
  }
}

/** 空状態（記録0件：design 14.3.9）。右下の新規エントリーボタンがあるので、ここにボタンは置かない */
function emptyNode() {
  return emptyState({
    iconName: 'notebook',
    title: '記録はまだありません',
    text: 'エントリーしたら右下の「新規エントリー」から記録します。',
  });
}

/** 空状態（絞り込みの結果が0件：design 14.3.9）。条件のチップは出したまま、［条件を解除］ですべての条件を初期値に戻す */
function noMatchNode(ctx) {
  return emptyState({
    iconName: 'search',
    title: '条件に合う記録はありません',
    text: '条件を変えるか、解除してください。',
    action: button('条件を解除', { variant: 'secondary', onClick: () => setFilter(ctx, defaultFilter()) }),
  });
}

/* ---------------------------------------------------------
   絞り込み（条件の変更・チップ・シート）
   --------------------------------------------------------- */

/** 絞り込みボタンの数字と無効表示、条件チップを今の条件に合わせる */
function syncFilterUi(ctx) {
  const chips = describeFilter(ctx.filter, ctx.now.getTime());
  renderFilterChips(ctx.chipsEl, chips, {
    onClear: (key) => {
      setFilter(ctx, clearCondition(ctx.filter, key));
      ctx.filterButton.el.focus(); // 押したチップは消えるので、キーボード・読み上げの人の位置を絞り込みボタンに移す
    },
    onClearAll: () => {
      setFilter(ctx, defaultFilter());
      ctx.filterButton.el.focus();
    },
  });
  // 記録が1件もない（または読み込み前）あいだは押せない
  ctx.filterButton.update({ count: chips.length, disabled: !ctx.view || ctx.view.recordCount === 0 });
}

/**
 * 条件を変える。保存して、読み込み済みの記録から選び直し、スクロールは先頭に戻す（条件が変わったので、前の位置に意味がないため）。
 * 記録をまだ読み込んでいなければ、読み込み後の描画が新しい条件を使う。
 */
function setFilter(ctx, next) {
  currentFilter = next;
  ctx.filter = next;
  persistFilter(next);
  if (ctx.trades) renderList(ctx, ctx.trades, { scrollY: 0, rows: 0 });
  else syncFilterUi(ctx);
}

/** 絞り込みシートを開く。「n件を表示」で適用された条件だけ受け取る（キャンセルなら何も変えない） */
async function openFilter(ctx) {
  if (!ctx.trades || ctx.sheetOpen) return;
  ctx.sheetOpen = true;
  let next = null;
  try {
    next = await openFilterSheet({ trades: ctx.trades, filter: ctx.filter, nowMs: Date.now(), favorites: getSetting('favoritePairs') });
  } finally {
    ctx.sheetOpen = false;
  }
  if (next && ctx.alive) setFilter(ctx, next);
}

/** 日本時間の日付（'2026-10-15'）。日が変わったかの判定に使う */
function jstDayKey(ms) {
  const p = jstParts(new Date(ms));
  return `${p.year}-${p.month}-${p.day}`;
}

/**
 * アプリが前面に戻ったとき、日付が変わっていたら「今日」「今月」などの範囲を今の日付で計算し直す（analytics 4.4.2）。
 * 開きっぱなしのまま日をまたいでも、古い日付の範囲で絞り込んだままにならないようにするため。位置はそのまま。
 */
function onBecameVisible(ctx) {
  if (document.visibilityState !== 'visible' || !ctx.alive || !ctx.ready || !ctx.trades) return;
  if (jstDayKey(Date.now()) === jstDayKey(ctx.now.getTime())) return;
  renderList(ctx, ctx.trades, { scrollY: window.scrollY, rows: ctx.shownRows });
}

/**
 * 読み込んだ記録で一覧を描き直す。
 * @param {object} ctx
 * @param {object[]} trades
 * @param {{ scrollY: number, rows: number }} position 描き終えたあとに戻すスクロール位置と、最低限描いておく行数
 */
function renderList(ctx, trades, position) {
  if (ctx.observer) ctx.observer.disconnect();
  ctx.trades = trades;
  ctx.now = new Date(); // 「今年」の判定と、「今日」「今月」の範囲に使う（日時の整形は Date を受け取る）
  ctx.view = buildListView(trades, ctx.filter, ctx.now.getTime());
  ctx.entries = flattenView(ctx.view);
  ctx.next = 0;
  ctx.shownRows = 0;
  ctx.body = null;
  ctx.listEl = null;

  if (ctx.view.recordCount === 0) {
    // 記録が1件もない：絞り込む相手がいないので、残っていた条件は初期値に戻す（あとで記録を足したとき、見えない条件で隠れないように）
    if (describeFilter(ctx.filter, ctx.now.getTime()).length > 0) {
      ctx.filter = defaultFilter();
      currentFilter = ctx.filter;
      persistFilter(ctx.filter);
    }
    ctx.content.replaceChildren(emptyNode());
    ctx.ready = true;
    syncFilterUi(ctx);
    return;
  }
  syncFilterUi(ctx);

  if (ctx.view.total === 0) {
    // 記録はあるが、条件に合うものが0件（design 14.3.9）。件数の「0件」と空状態を出す。チップは syncFilterUi が出したまま
    takeRowFlash(); // 預かっていたハイライトは、この描画では使えないので捨てる（あとの描画で急に光らないように）
    ctx.content.replaceChildren(h('p', { class: 'list-count num' }, '0件'), noMatchNode(ctx));
    ctx.ready = true;
    window.scrollTo(0, position.scrollY);
    return;
  }

  ctx.listEl = h('div', { class: 'trade-list' });
  ctx.sentinel = h('div', { class: 'loading list-more' }, spinner('続きを読み込み中'));
  ctx.content.replaceChildren(...summaryNodes(ctx.view).filter(Boolean), ctx.listEl, ctx.sentinel);

  appendChunk(ctx, Math.max(LIST_PAGE_SIZE, position.rows));
  ctx.ready = true;

  // 保存・決済から戻った直後なら、その行を1秒だけ目立たせる（預かりは1度で空になる）
  const flashId = takeRowFlash();
  if (flashId) flashRow(ctx.listEl, flashId);

  if (ctx.next < ctx.entries.length) {
    if (typeof IntersectionObserver === 'function') {
      ctx.observer = new IntersectionObserver((hits) => {
        if (hits.some((x) => x.isIntersecting)) loadMore(ctx);
      }, { rootMargin: '400px 0px' }); // 下端に着く少し手前で足し始める（待たせないため）
      ctx.observer.observe(ctx.sentinel);
    } else {
      appendChunk(ctx, Infinity); // 古いブラウザでは続き読み込みをやめて全部描く（件数が多くても動くことを優先）
    }
  }

  // router.js が先頭へ戻したあとなので、描き終わってから元の位置へ戻す
  window.scrollTo(0, position.scrollY);
}

/* ---------------------------------------------------------
   お知らせ行・読み込み
   --------------------------------------------------------- */

/**
 * お知らせ行を並べ直す。優先順は 読み込みエラー → 元の記録が変わったため破棄した下書きの知らせ → 入力途中の下書き
 * → 新しいバージョン → ホーム画面に未追加（design 14.3.8。同時に最大2行。破棄の知らせは一度きりの知らせなので、続きを開ける案内より先に出す）。
 * 入力途中の下書きの文言は draft-notice.js の buildDraftNotice（1件＝［続ける］、2件以上＝［選ぶ］）。
 */
function refreshNotices(ctx) {
  const items = [];
  if (ctx.loadError) {
    // 消えないお知らせ（× なし）。押すと同じ画面のまま読み込み直す
    items.push({
      iconName: 'warning',
      tone: 'error',
      text: 'データを読み込めませんでした',
      action: { label: '再読み込み', onClick: () => load(ctx, { scrollY: 0, rows: 0 }) },
    });
  }
  // 元の記録が下書きのあとに変更されたため破棄した（× のみ。1回だけ：この一覧を開いている間だけ出す）
  for (const kind of ctx.staleKinds) {
    items.push({
      iconName: 'pencil',
      text: DRAFT_STALE_TEXT[kind],
      onClose: () => { ctx.staleKinds = ctx.staleKinds.filter((k) => k !== kind); refreshNotices(ctx); },
    });
  }
  const draftNotice = draftNoticeClosed ? null : buildDraftNotice(ctx.draftItems);
  if (draftNotice) {
    items.push({
      iconName: 'pencil',
      text: draftNotice.text,
      subtext: draftNotice.subtext,
      action: draftNotice.mode === 'continue'
        ? { label: '続ける', onClick: () => ctx.nav.go(draftNotice.hash) }
        : { label: '選ぶ', onClick: () => chooseDraft(ctx, draftNotice) },
      onClose: () => { draftNoticeClosed = true; refreshNotices(ctx); },
    });
  }
  // 優先3：新しい版が待機中（js/sw-update.js）。［更新］で切り替えて再読み込み（architecture 12.3）
  if (!updateNoticeClosed && isUpdateWaiting()) {
    items.push({
      iconName: 'sync',
      text: '新しいバージョンがあります',
      action: { label: '更新', onClick: () => applyUpdate() },
      onClose: () => { updateNoticeClosed = true; refreshNotices(ctx); },
    });
  }
  // 優先4：iPhone をホーム画面版でなくブラウザで開いている（7日間使わないと記録が消えることがある：architecture 12.5）。
  // 判定は data-protection.js。× は「次に起動するまで出さない」（design 14.3.8）
  if (shouldShowInstallNotice({ ios: isIos(), standalone: isStandalone(), dismissed: installNoticeClosed })) {
    items.push({
      iconName: 'share',
      text: INSTALL_NOTICE.text,
      action: { label: INSTALL_NOTICE.actionLabel, onClick: () => ctx.nav.go(INSTALL_NOTICE.hash) },
      onClose: () => { installNoticeClosed = true; refreshNotices(ctx); },
    });
  }
  renderNotices(ctx.notices, items);
}

/** 入力途中の記録が2件以上のとき、アクションシートに新しい順に並べて選んでもらう（design 14.3.8）。選んだらその入力画面を開く */
async function chooseDraft(ctx, notice) {
  const hash = await actionSheet({
    title: '続ける記録を選んでください',
    actions: notice.choices.map((c) => ({ label: c.label, value: c.hash })),
  });
  if (hash && ctx.alive) ctx.nav.go(hash);
}

/**
 * 記録を読み込んで描く。読み込み中にもう一度呼ばれたら、終わってからやり直す（古い結果で上書きしないため）。
 * 失敗しても画面は出したまま、お知らせ行で知らせる。
 */
async function load(ctx, position) {
  if (ctx.loading) {
    ctx.dirty = true;
    return;
  }
  ctx.loading = true;
  // 0.3秒以上かかるときだけ回転アイコンを出す（すぐ終わるときにちらつかせない：design 9.15）。最初の読み込みだけ
  const loading = ctx.ready ? null : showLoadingAfter(ctx.content);
  try {
    const trades = await getAllTrades();
    if (!ctx.alive) return;
    renderList(ctx, trades, position);
    ctx.loadError = false;
  } catch (e) {
    console.error('記録を読み込めませんでした', e);
    ctx.loadError = true;
  } finally {
    ctx.loading = false;
    if (loading) loading.stop();
  }
  if (!ctx.alive) return;
  refreshNotices(ctx);
  // 詳細画面で削除して戻ってきたとき：一覧の表示が終わったここで、トースト「削除しました［取り消す］」を出す（deleted-toast.js）
  if (!ctx.toastChecked) {
    ctx.toastChecked = true;
    const deleted = takeDeletedToast();
    if (deleted) showDeletedToast(ctx, deleted);
  }
  if (ctx.dirty) {
    ctx.dirty = false;
    // 描き終えていれば今の位置のまま、まだなら最初に決めた位置で、描き直す
    load(ctx, ctx.ready ? { scrollY: window.scrollY, rows: ctx.shownRows } : position);
  }
}

/**
 * 削除した直後のトースト「削除しました［取り消す］」を出す（6秒。design 14.7.5）。
 * 一覧の表示が終わってから出す必要がある（ui/toast.js は「取り消す」付きのトーストを、画面を移ったときに消すため）。
 */
function showDeletedToast(ctx, { id, deletedAt }) {
  showToast('削除しました', { action: { label: '取り消す', onClick: () => undoDelete(ctx, id, deletedAt) } });
}

/**
 * 「取り消す」：undoDeleteTrade で元に戻す（architecture 10章）。
 * ・削除日時が変わっていた（すでに取り消し済み・別の操作で変わった）ときは null が返る。何もしない（トーストも出さない）
 * ・戻したら、トースト「削除を取り消しました」（3秒）と、その行の1秒ハイライト（row-flash.js。一覧は記録の変更の通知で描き直し、
 *   描き終えたところで受け取る。通知より前に預ける必要はなく、描き直しは IndexedDB の読み込みを待つので、戻り値を受け取った直後に預けて間に合う）
 * ・失敗はアラート（design 14.7.3：記録がない／保存の失敗）。保存の失敗は［もう一度］で試し直せる
 */
async function undoDelete(ctx, id, deletedAt) {
  let restored;
  try {
    restored = await undoDeleteTrade(id, deletedAt);
  } catch (e) {
    console.error('削除を取り消せませんでした', e);
    const message = isAppError(e, 'NOT_FOUND') ? '記録が見つかりません。' : '保存中に問題が起きました。もう一度試してください。';
    const buttons = isAppError(e, 'NOT_FOUND')
      ? [{ label: '閉じる', value: 'close' }]
      : [{ label: '閉じる', value: 'close' }, { label: 'もう一度', value: 'retry', primary: true }];
    const choice = await showAlert({ title: '削除を取り消せませんでした', message, buttons });
    if (choice === 'retry') await undoDelete(ctx, id, deletedAt);
    return;
  }
  if (!restored) return;
  if (ctx.alive) requestRowFlash(id);
  showToast('削除を取り消しました');
}

/**
 * 入力途中の下書き（エントリー・決済・編集）を確かめて、お知らせ行に出す（一覧の表示は待たせない）。
 * 下書きごとに対象の記録を見て、draft-notice.js の judgeDraftTarget で判定する：
 *   ok    … お知らせ行の対象にする
 *   gone  … 対象が削除・決済済みなど。お知らせを出す前に黙って消す（design 14.2.10・14.3.8）
 *   stale … 元の記録が下書きのあとに変更された。消して、種類ごとに「破棄しました」の知らせを出す（architecture 9.3）
 * 記録を読めなかった下書きは、消さずに何も出さない（読めるようになってから案内する）。
 */
async function loadDrafts(ctx) {
  let drafts = [];
  try {
    drafts = await getAllDrafts();
  } catch (e) {
    console.error('下書きを確認できませんでした', e);
    return;
  }
  const items = [];
  const staleKinds = [];
  for (const draft of drafts) {
    if (!Object.values(DRAFT_KIND).includes(draft.kind)) continue; // 知らない種類（壊れた下書き）には触らない
    let trade = null;
    try {
      if (draft.kind !== DRAFT_KIND.NEW) trade = await getTrade(draft.tradeId);
    } catch (e) {
      console.error('下書きの対象の記録を確認できませんでした', e);
      continue;
    }
    const verdict = judgeDraftTarget(draft, trade);
    if (verdict === 'ok') {
      items.push({ draft, trade });
      continue;
    }
    try {
      await discardDraft(draft.key);
    } catch (e) {
      console.error('下書きを消せませんでした', e);
      continue; // 消せなかったものは知らせない（次に開いたとき、もう一度試す）
    }
    if (verdict === 'stale' && !staleKinds.includes(draft.kind)) staleKinds.push(draft.kind);
  }
  if (!ctx.alive) return;
  ctx.draftItems = items;
  ctx.staleKinds = staleKinds;
  refreshNotices(ctx);
}

export default {
  layout: 'tab',
  tab: 'list',
  title: '一覧',

  mount(root, { nav }) {
    const notices = h('div', { class: 'list-notices' });
    const chipsEl = h('div', { class: 'filter-chips' });
    const content = h('div', { class: 'screen__body list-content' });
    const filterButton = createFilterButton(() => openFilter(ctx));
    root.append(
      largeTitle('一覧', filterButton.el),
      notices,
      chipsEl,
      content,
      // ＋新規エントリーボタン：右下・タブバーの上に浮かぶ（design.md 9.10。部品は ui/bars.js）
      newEntryButton(),
    );

    const ctx = {
      alive: true, nav, notices, content, chipsEl, filterButton,
      ready: false, loading: false, dirty: false, loadError: false, draftItems: [], staleKinds: [], toastChecked: false,
      filter: getCurrentFilter(), trades: null, sheetOpen: false,
      view: null, entries: [], next: 0, shownRows: 0, now: new Date(),
      listEl: null, body: null, sentinel: null, observer: null,
      stopWatching: null, stopUpdateWatch: null, onVisible: null,
    };
    current = ctx;
    syncFilterUi(ctx); // 記録を読み込む前から、復元した条件のチップを出しておく（読み込み後に急に現れて内容が動かないように）

    ctx.onVisible = () => onBecameVisible(ctx);
    document.addEventListener('visibilitychange', ctx.onVisible);

    // 他の画面で記録が変わったとき（例：削除の取り消しのトーストから「取り消す」を押した）は、今の位置のまま描き直す
    ctx.stopWatching = on(TRADES_CHANGED, () => {
      load(ctx, ctx.ready ? { scrollY: window.scrollY, rows: ctx.shownRows } : savedPosition);
    });

    // 一覧を開いている間に新しい版が待機中になったら、お知らせ行を出し直す
    ctx.stopUpdateWatch = on(UPDATE_READY, () => { if (ctx.alive) refreshNotices(ctx); });

    // 読み込みは待たずに画面を出す（DB が開くのを待っている間も画面が真っ白にならないように）
    load(ctx, savedPosition);
    loadDrafts(ctx);
  },

  unmount() {
    const ctx = current;
    if (!ctx) return;
    current = null;
    // 描き終わっていない（読み込み中に離れた）ときは、前回の位置を残す。0 で上書きすると戻ったときに先頭になってしまうため
    if (ctx.ready) savedPosition = { scrollY: window.scrollY, rows: ctx.shownRows };
    ctx.alive = false;
    if (ctx.observer) ctx.observer.disconnect();
    if (ctx.stopWatching) ctx.stopWatching();
    if (ctx.stopUpdateWatch) ctx.stopUpdateWatch();
    document.removeEventListener('visibilitychange', ctx.onVisible);
    if (ctx.sheetOpen) closeOpenDialog(); // 絞り込みシートが開いたまま次の画面に残らないように
  },

  hasUnsavedChanges() {
    return false;
  },
};
