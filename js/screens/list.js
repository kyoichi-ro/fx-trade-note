/* =========================================================
   js/screens/list.js
   S-01 一覧（ホーム）。型A（タブ画面）。URL：#/

   【T-10】画面の入れ物。
   【T-17】お知らせ行「入力途中のエントリーがあります［続ける］」（design 14.3.8）。
     × は「次に起動するまで出さない」だけで、下書きは消さない（一覧には破棄の操作を置かない）。
     決済・編集の下書き（T-21・T-22）と2件以上の［選ぶ］は、それぞれのタスクで足す。
   【T-19】記録の一覧（design 14.3.1・14.3.4〜14.3.6・14.3.9）：
     ・サマリー（件数・合計損益。デモと本番が混在なら口座別2行）とその直下の pips の注記
     ・「保有中 n件」のグループ（エントリー日時の新しい順。行の右端に［決済］）
     ・決済済みを決済日ごとの見出しの下に新しい順で。見出しの日計はサマリーが1口座のときだけ
     ・最初の約50行を描き、下までスクロールしたら続きを足す（analytics 4.9 #5）
     ・0件のときは空状態の案内
     ・タブ切替・詳細から戻ったときのスクロール位置の復元（architecture 5.2・5.5）
     ・読み込みに失敗したときのお知らせ行［再読み込み］（design 14.3.8 の優先1）
   絞り込み（条件チップ・シート）は T-23、詳細・決済画面は T-20・T-21。
   集計・並び順・日付のまとめは js/filter.js（画面に依存しない純粋な関数）、文字の整形は js/format.js。
   ========================================================= */
import { h } from '../ui/dom.js';
import { largeTitle, newEntryButton } from '../ui/bars.js';
import { listGroup, badge, emptyState, spinner, showLoadingAfter } from '../ui/parts.js';
import { renderNotices } from '../ui/notice.js';
import { getAllTrades, TRADES_CHANGED } from '../trades.js';
import { on } from '../events.js';
import { getDraft, draftKeyOf, DRAFT_KIND } from '../drafts.js';
import { buildListView, flattenView, nextChunkEnd, summaryRows } from '../filter.js';
import { formatPrice, formatYen, formatPips, formatPipsTenths, formatLots, formatTime, formatDateTime, formatDraftTime,
  toneOf, toTenths, speakYen, speakPips, speakDateTime } from '../format.js';
import { LIST_PAGE_SIZE } from '../config.js';

/** お知らせ行を × で閉じたか（次に起動するまで出さない：design 14.3.8。アプリを開き直すと元に戻る） */
let draftNoticeClosed = false;

/**
 * 一覧を離れたときのスクロール位置と、そこまでに描いていた行数。
 * router.js は画面を切り替えるたびにページの先頭へスクロールするので、戻ってきたときはここから復元する
 * （architecture 5.5）。アプリを閉じて開き直したら変数ごと消えて先頭に戻る（design 14.3.11）。
 * 行数も覚えるのは、下の方までスクロールしていたとき、続きの行を描き足さないと位置まで届かないため。
 */
let savedPosition = { scrollY: 0, rows: 0 };

/** 今表示している一覧の状態（unmount で後片付けするために1つだけ持つ） */
let current = null;

/* ---------------------------------------------------------
   入力途中のお知らせ行（T-17）
   --------------------------------------------------------- */

/** 2行目「USD/JPY ▲買い・21:32」（選んでいない項目は省く。今日でなければ「10/14 21:32」：design 14.3.8） */
function draftSummary(draft) {
  const f = draft.fields || {};
  const words = [];
  if (typeof f.pair === 'string' && f.pair) words.push(f.pair);
  if (f.side === 'buy') words.push('▲買い');
  if (f.side === 'sell') words.push('▼売り');
  const time = formatDraftTime(draft.updatedAt);
  return words.length ? `${words.join(' ')}・${time}` : time;
}

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

  return h('div', { class: `trade-row${closed ? '' : ' trade-row--open'}` }, link, action);
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

/**
 * 読み込んだ記録で一覧を描き直す。
 * @param {object} ctx
 * @param {object[]} trades
 * @param {{ scrollY: number, rows: number }} position 描き終えたあとに戻すスクロール位置と、最低限描いておく行数
 */
function renderList(ctx, trades, position) {
  if (ctx.observer) ctx.observer.disconnect();
  ctx.now = new Date(); // 「今年」の判定に使う（日時の整形は Date を受け取る）
  ctx.view = buildListView(trades, ctx.now.getTime());
  ctx.entries = flattenView(ctx.view);
  ctx.next = 0;
  ctx.shownRows = 0;
  ctx.body = null;

  if (ctx.view.total === 0) {
    ctx.content.replaceChildren(emptyNode());
    ctx.ready = true;
    return;
  }

  ctx.listEl = h('div', { class: 'trade-list' });
  ctx.sentinel = h('div', { class: 'loading list-more' }, spinner('続きを読み込み中'));
  ctx.content.replaceChildren(...summaryNodes(ctx.view).filter(Boolean), ctx.listEl, ctx.sentinel);

  appendChunk(ctx, Math.max(LIST_PAGE_SIZE, position.rows));
  ctx.ready = true;

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

/** お知らせ行を並べ直す。優先順は 読み込みエラー → 入力途中の下書き（design 14.3.8。同時に最大2行） */
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
  if (ctx.draft && !draftNoticeClosed) {
    items.push({
      iconName: 'pencil',
      text: '入力途中のエントリーがあります',
      subtext: draftSummary(ctx.draft),
      action: { label: '続ける', onClick: () => ctx.nav.go('#/new') },
      onClose: () => { draftNoticeClosed = true; refreshNotices(ctx); },
    });
  }
  renderNotices(ctx.notices, items);
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
  if (ctx.dirty) {
    ctx.dirty = false;
    // 描き終えていれば今の位置のまま、まだなら最初に決めた位置で、描き直す
    load(ctx, ctx.ready ? { scrollY: window.scrollY, rows: ctx.shownRows } : position);
  }
}

/** 入力途中の下書きを確かめて、あればお知らせ行に出す（一覧の表示は待たせない） */
async function loadDraft(ctx) {
  try {
    ctx.draft = await getDraft(draftKeyOf(DRAFT_KIND.NEW));
  } catch (e) {
    console.error('下書きを確認できませんでした', e);
  }
  if (ctx.alive) refreshNotices(ctx);
}

export default {
  layout: 'tab',
  tab: 'list',
  title: '一覧',

  mount(root, { nav }) {
    const notices = h('div', { class: 'list-notices' });
    const content = h('div', { class: 'screen__body list-content' });
    root.append(
      largeTitle('一覧'),
      notices,
      content,
      // ＋新規エントリーボタン：右下・タブバーの上に浮かぶ（design.md 9.10。部品は ui/bars.js）
      newEntryButton(),
    );

    const ctx = {
      alive: true, nav, notices, content,
      ready: false, loading: false, dirty: false, loadError: false, draft: null,
      view: null, entries: [], next: 0, shownRows: 0, now: new Date(),
      listEl: null, body: null, sentinel: null, observer: null,
      stopWatching: null,
    };
    current = ctx;

    // 他の画面で記録が変わったとき（例：削除の取り消しのトーストから「取り消す」を押した）は、今の位置のまま描き直す
    ctx.stopWatching = on(TRADES_CHANGED, () => {
      load(ctx, ctx.ready ? { scrollY: window.scrollY, rows: ctx.shownRows } : savedPosition);
    });

    // 読み込みは待たずに画面を出す（DB が開くのを待っている間も画面が真っ白にならないように）
    load(ctx, savedPosition);
    loadDraft(ctx);
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
  },

  hasUnsavedChanges() {
    return false;
  },
};
