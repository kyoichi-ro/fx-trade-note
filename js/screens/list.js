/* =========================================================
   js/screens/list.js
   S-01 一覧（ホーム）。型A（タブ画面）。URL：#/

   【T-10 の段階】画面の入れ物（大タイトル・＋新規エントリーボタン）。
   【T-17 で足したもの（最小限）】
   ・お知らせ行「入力途中のエントリーがあります［続ける］」（30分を過ぎた新規エントリーの下書き：design 14.3.8）。
     × は「次に起動するまで出さない」だけで、下書きは消さない（一覧には破棄の操作を置かない）。
     決済・編集の下書き（T-21・T-22）と2件以上の［選ぶ］は、それぞれのタスクで足す。
   ・保存できたことを確かめるための件数の行（記録 N件・保有中 N件）。記録の一覧・サマリー・絞り込みは T-19・T-23 で作る。
   ========================================================= */
import { h } from '../ui/dom.js';
import { largeTitle, newEntryButton } from '../ui/bars.js';
import { listGroup, listRow } from '../ui/parts.js';
import { renderNotices } from '../ui/notice.js';
import { getAllTrades } from '../trades.js';
import { getDraft, draftKeyOf, DRAFT_KIND } from '../drafts.js';
import { jstParts } from '../datetime.js';

/** お知らせ行を × で閉じたか（次に起動するまで出さない：design 14.3.8。アプリを開き直すと元に戻る） */
let draftNoticeClosed = false;

/** 2行目「USD/JPY ▲買い・21:32」（選んでいない項目は省く。今日でなければ「10/14 21:32」：design 14.3.8） */
function draftSummary(draft) {
  const f = draft.fields || {};
  const words = [];
  if (typeof f.pair === 'string' && f.pair) words.push(f.pair);
  if (f.side === 'buy') words.push('▲買い');
  if (f.side === 'sell') words.push('▼売り');
  const p = jstParts(draft.updatedAt);
  const today = jstParts(new Date());
  let time = '';
  if (p) {
    time = `${p.hour}:${String(p.minute).padStart(2, '0')}`;
    if (!today || today.year !== p.year || today.month !== p.month || today.day !== p.day) time = `${p.month}/${p.day} ${time}`;
  }
  return words.length ? `${words.join(' ')}・${time}` : time;
}

export default {
  layout: 'tab',
  tab: 'list',
  title: '一覧',

  mount(root, { nav }) {
    const notices = h('div', { class: 'list-notices' });
    const counts = listRow({ label: '記録', value: '…', numeric: true });
    root.append(
      largeTitle('一覧'),
      notices,
      h('div', { class: 'screen__body' },
        listGroup({
          rows: [counts],
          footer: '記録の一覧は T-19 で表示します。',
        }),
      ),
      // ＋新規エントリーボタン：右下・タブバーの上に浮かぶ（design.md 9.10。部品は ui/bars.js）
      newEntryButton(),
    );

    // 読み込みは待たずに画面を出す（DB が開くのを待っている間も画面が真っ白にならないように）
    loadSummary(counts, notices, nav);
  },

  unmount() {
    // T-19 でスクロール位置・絞り込み条件の保持（architecture.md 5.5）をここに足す
  },

  hasUnsavedChanges() {
    return false;
  },
};

/** 件数の行と、入力途中のお知らせ行を埋める。読み込みに失敗しても画面は出したまま（一覧の読み込みエラーの表示は T-19 で作る） */
async function loadSummary(counts, notices, nav) {
  try {
    const trades = (await getAllTrades()).filter((t) => t.deletedAt == null);
    const open = trades.filter((t) => t.status === 'open').length;
    counts.querySelector('.list-row__value').textContent = `${trades.length}件（保有中 ${open}件）`;
  } catch (e) {
    console.error('記録を読み込めませんでした', e);
    counts.querySelector('.list-row__value').textContent = '読み込めませんでした';
  }

  if (draftNoticeClosed) return;
  let draft = null;
  try {
    draft = await getDraft(draftKeyOf(DRAFT_KIND.NEW));
  } catch (e) {
    console.error('下書きを確認できませんでした', e);
  }
  if (!draft || !notices.isConnected) return;
  renderNotices(notices, [{
    iconName: 'pencil',
    text: '入力途中のエントリーがあります',
    subtext: draftSummary(draft),
    action: { label: '続ける', onClick: () => nav.go('#/new') },
    onClose: () => { draftNoticeClosed = true; renderNotices(notices, []); },
  }]);
}
